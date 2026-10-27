import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Snapshot, TerminalInfo } from '../shared/protocol';
import { readTitle } from './agentTitle';
import { cwdOf } from './cwd';
import { hasChildProcess, processLabel } from './env';
import type { Pty } from './nodePty';
import type { PtyBackend, Survivor } from './ptyHostClient';

// A grid terminal is either a shell the extension started ("pty", run by the
// pty host or in the extension host, see ptyHostClient.ts), or a mirror of a
// Terminal-tab terminal the extension did not start ("mirror"), fed with that
// terminal's output. Either way the output also goes
// into a headless xterm, so the screen can be repainted when the webview is
// recreated, and saved for the next window reload.

/** Pause the pty when this many characters are waiting for the webview. */
const HIGH_WATERMARK = 200_000;
const LOW_WATERMARK = 40_000;
/** A pty paused this long without acks is resumed anyway, so a stuck webview never stalls a program. */
const MAX_PAUSE_MS = 5000;
const FLUSH_DELAY_MS = 5;
const POLL_MS = 1500;
/** Lines kept when a snapshot is saved for the next window reload. */
const PERSIST_LINES = 1000;
const PERSIST_MAX_CHARS = 400_000;
/** A command for a new shell is typed once the shell has been quiet this long after its first output. */
const PROMPT_QUIET_MS = 300;
const PROMPT_WAIT_MS = 5000;

export interface ShellConfig {
  shell: string;
  args: string[];
  env: Record<string, string>;
}

export interface SessionEvents {
  /** Batched output for the webview. */
  output(chunks: [string, string][]): void;
  /** Every chunk as it arrives, for the Terminal-tab twin. */
  data(session: Session, data: string): void;
  changed(session: Session): void;
  exited(session: Session): void;
  spawnFailed(session: Session, message: string): void;
  /** The program started or stopped working (from its title), or rang the bell. */
  activity(session: Session, kind: 'working' | 'idle' | 'bell'): void;
}

export class Session {
  pty: Pty | undefined;
  processName = '';
  customTitle = '';
  /** Title set by the program in the foreground, without its status mark. */
  title = '';
  /** The program's title says it is working. */
  working = false;
  /** It stopped working or rang while the user was looking elsewhere; cleared once they come back. */
  attention = false;
  attentionAt = 0;
  exitCode: number | undefined;
  cols = 80;
  rows = 24;
  unacked = 0;
  paused = false;
  pausedAt = 0;
  /** Output arrived since the last saved snapshot. */
  dirty = false;
  shell = '';
  /** Size the grid tile wants; the pty follows it while the grid is visible. */
  gridSize: { cols: number; rows: number } | undefined;
  /** Called after every chunk of pty output (see `typeWhenReady`). */
  afterOutput: (() => void) | undefined;
  readonly headless: HeadlessTerminal;
  private readonly serializer = new SerializeAddon();

  constructor(
    readonly id: string,
    public cwd: string,
    scrollback: number,
    cols = 80,
    rows = 24,
    readonly kind: 'pty' | 'mirror' = 'pty',
  ) {
    this.cols = cols;
    this.rows = rows;
    this.headless = new HeadlessTerminal({ cols: this.cols, rows: this.rows, scrollback, allowProposedApi: true });
    // The addon is typed against the browser build; the headless one has the same surface.
    this.headless.loadAddon(this.serializer as unknown as Parameters<HeadlessTerminal['loadAddon']>[0]);
  }

  info(): TerminalInfo {
    return {
      id: this.id,
      process: this.processName,
      customTitle: this.customTitle,
      ...(this.title ? { title: this.title } : {}),
      ...(this.working ? { working: true } : {}),
      ...(this.attention ? { attention: true } : {}),
      cwd: this.cwd,
      kind: this.kind,
      ...(this.kind === 'mirror' ? { fixedSize: { cols: this.cols, rows: this.rows } } : {}),
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
    };
  }

  get running(): boolean {
    return this.pty !== undefined;
  }

  /** A program other than the shell is in the foreground. */
  get busy(): boolean {
    return this.pty !== undefined && hasChildProcess(this.pty.process, this.shell);
  }

  serialize(forStorage: boolean): string {
    if (!forStorage) return this.serializer.serialize();
    const full = this.serializer.serialize({ scrollback: PERSIST_LINES });
    if (full.length <= PERSIST_MAX_CHARS) return full;
    const short = this.serializer.serialize({ scrollback: 200 });
    return short.length <= PERSIST_MAX_CHARS ? short : '';
  }

  dispose(): void {
    const pty = this.pty;
    this.pty = undefined;
    try {
      pty?.kill();
    } catch {
      // Already gone.
    }
    this.headless.dispose();
  }

  /** Stops following the shell without ending it: the pty host keeps it. */
  release(): void {
    this.pty = undefined;
    this.headless.dispose();
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, string>();
  private flushTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private pollTick = 0;
  private attached = false;
  /** Output is queued but not sent while the webview is being initialised. */
  private holding = false;

  constructor(
    private readonly backend: PtyBackend,
    private readonly shellConfig: () => ShellConfig,
    private readonly events: SessionEvents,
    private readonly scrollback: () => number,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  create(options: { cwd: string; id?: string; customTitle?: string; history?: string; cols?: number; rows?: number }): Session {
    const id = options.id && !this.sessions.has(options.id) ? options.id : randomUUID().slice(0, 8);
    const session = new Session(id, usableDir(options.cwd), this.scrollback(), options.cols, options.rows);
    session.customTitle = options.customTitle ?? '';
    if (options.history) session.headless.write(options.history);
    this.sessions.set(id, session);
    this.watch(session);
    this.spawn(session);
    this.ensurePolling();
    return session;
  }

  /** A shell the pty host kept through a reload: the process runs on, its screen comes back as it was. */
  adopt(options: { id: string; cwd: string; customTitle?: string; survivor: Survivor }): Session {
    const { survivor } = options;
    const session = new Session(options.id, options.cwd || homedir(), this.scrollback(), survivor.cols, survivor.rows);
    session.customTitle = options.customTitle ?? '';
    session.shell = this.shellConfig().shell;
    this.sessions.set(session.id, session);
    this.watch(session);
    this.bind(session, survivor.pty);
    session.headless.write(survivor.screen);
    // The title is not part of the screen; set it again so the tile shows it.
    if (survivor.title) session.headless.write(`\x1b]0;${survivor.title}\x07`);
    this.ensurePolling();
    return session;
  }

  /** A grid tile for a terminal the extension did not start; output arrives through `feed`. */
  createMirror(options: { id: string; name: string; cwd: string; cols: number; rows: number }): Session {
    const session = new Session(options.id, options.cwd, this.scrollback(), options.cols, options.rows, 'mirror');
    session.processName = options.name;
    this.sessions.set(session.id, session);
    this.watch(session);
    return session;
  }

  feed(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session || session.kind !== 'mirror') return;
    session.headless.write(data);
    session.dirty = true;
    this.queue(id, data);
  }

  /** What the program says about itself: its title, and the bell. */
  private watch(session: Session): void {
    session.headless.onTitleChange((raw) => {
      // The title can come before the next poll notices the program that set it.
      const moved = session.kind === 'pty' && this.updateProcess(session);
      const { label, working } = readTitle(raw);
      // A shell's own title (often its folder) would hide the process name: only programs it runs count.
      const title = session.kind === 'pty' && !session.busy ? '' : label;
      if (title !== session.title || moved) {
        session.title = title;
        this.events.changed(session);
      }
      if (working !== undefined && working !== session.working) {
        session.working = working;
        this.events.activity(session, working ? 'working' : 'idle');
      }
    });
    session.headless.onBell(() => this.events.activity(session, 'bell'));
  }

  /** Reads the foreground process. Back at the shell, the program's title and status go with it. */
  private updateProcess(session: Session): boolean {
    if (!session.pty) return false;
    let foreground: string;
    try {
      foreground = session.pty.process;
    } catch {
      return false;
    }
    const name = processLabel(foreground, session.shell);
    if (name === session.processName) return false;
    session.processName = name;
    if (!hasChildProcess(foreground, session.shell)) {
      session.title = '';
      session.working = false;
    }
    return true;
  }

  private spawn(session: Session): void {
    const config = this.shellConfig();
    session.shell = config.shell;
    session.exitCode = undefined;
    try {
      const pty = this.backend.spawn(
        session.id,
        config.shell,
        config.args,
        { name: 'xterm-256color', cols: session.cols, rows: session.rows, cwd: usableDir(session.cwd), env: config.env },
        this.scrollback(),
      );
      this.bind(session, pty);
    } catch (error) {
      session.pty = undefined;
      session.exitCode = -1;
      this.events.spawnFailed(session, error instanceof Error ? error.message : String(error));
    }
  }

  private bind(session: Session, pty: Pty): void {
    session.pty = pty;
    session.processName = processLabel(pty.process, session.shell);
    pty.onData((data) => {
      if (session.pty !== pty) return;
      session.headless.write(data);
      session.dirty = true;
      this.events.data(session, data);
      this.queue(session.id, data);
      session.afterOutput?.();
    });
    pty.onExit(({ exitCode }) => {
      if (session.pty !== pty) return;
      this.flush();
      session.pty = undefined;
      session.paused = false;
      session.exitCode = exitCode;
      this.events.exited(session);
    });
  }

  /** Types a command into a new shell once it has drawn its prompt: some output, then a quiet spell. */
  typeWhenReady(id: string, text: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    let quiet: NodeJS.Timeout | undefined;
    const type = () => {
      clearTimeout(quiet);
      clearTimeout(fallback);
      session.afterOutput = undefined;
      this.write(id, text);
    };
    const fallback = setTimeout(type, PROMPT_WAIT_MS);
    session.afterOutput = () => {
      clearTimeout(quiet);
      quiet = setTimeout(type, PROMPT_QUIET_MS);
    };
  }

  /** Writes text into the terminal display only (not to the shell). */
  print(id: string, text: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.headless.write(text);
    this.events.data(session, text);
    this.queue(id, text);
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1) return;
    if (session.cols === cols && session.rows === rows) return;
    session.cols = Math.min(cols, 2000);
    session.rows = Math.min(rows, 1000);
    session.headless.resize(session.cols, session.rows);
    try {
      session.pty?.resize(session.cols, session.rows);
    } catch {
      // The pty can close between the check and the call.
    }
  }

  ack(id: string, chars: number): void {
    const session = this.sessions.get(id);
    if (!session || !Number.isFinite(chars) || chars < 0) return;
    session.unacked = Math.max(0, session.unacked - chars);
    if (session.paused && session.unacked < LOW_WATERMARK) {
      session.paused = false;
      session.pty?.resume();
    }
  }

  restart(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const old = session.pty;
    session.pty = undefined;
    try {
      old?.kill();
    } catch {
      // Already gone.
    }
    this.print(id, '\r\n');
    this.spawn(session);
    this.events.changed(session);
  }

  close(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.pending.delete(id);
    session.dispose();
    if (this.sessions.size === 0) this.stopPolling();
  }

  /** Lets go of a shell without ending it, where the backend can keep it (a reload). */
  detach(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.pending.delete(id);
    if (this.backend.persistent && session.kind === 'pty') {
      this.backend.detach(id);
      session.release();
    } else {
      session.dispose();
    }
  }

  /** Whether a webview is listening. Without one, output is only recorded. */
  setAttached(attached: boolean): void {
    this.attached = attached;
    for (const session of this.sessions.values()) {
      session.unacked = 0;
      if (session.paused) {
        session.paused = false;
        session.pty?.resume();
      }
    }
  }

  private queue(id: string, data: string): void {
    if (!this.attached) return;
    this.pending.set(id, (this.pending.get(id) ?? '') + data);
    if (!this.holding) this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_DELAY_MS);
  }

  /**
   * Snapshots every screen for a (re)loading webview. Output that arrives
   * after the snapshot point is queued and sent once `release()` is called,
   * so nothing is shown twice or lost.
   */
  async snapshotAll(): Promise<Record<string, Snapshot>> {
    this.setAttached(true);
    this.holding = true;
    this.pending.clear();
    const snapshots: Record<string, Snapshot> = {};
    await Promise.all(
      this.all().map(
        (session) =>
          new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              if (this.sessions.has(session.id)) {
                snapshots[session.id] = { data: session.serialize(false), cols: session.cols, rows: session.rows };
              }
              resolve();
            };
            // The empty write resolves once everything written before it is parsed.
            session.headless.write('', finish);
            setTimeout(finish, 1000);
          }),
      ),
    );
    return snapshots;
  }

  release(): void {
    this.holding = false;
    if (this.pending.size > 0) this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_DELAY_MS);
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.holding || this.pending.size === 0) return;
    const chunks = [...this.pending.entries()];
    this.pending.clear();
    for (const [id, data] of chunks) {
      const session = this.sessions.get(id);
      if (!session) continue;
      session.unacked += data.length;
      if (!session.paused && session.unacked > HIGH_WATERMARK && session.pty) {
        session.paused = true;
        session.pausedAt = Date.now();
        session.pty.pause();
      }
    }
    this.events.output(chunks);
  }

  /** Re-reads the working directory of the given terminals right now. */
  async refreshCwd(ids: string[]): Promise<void> {
    // A shell the pty host has not reported a pid for yet is skipped.
    const live = ids.map((id) => this.sessions.get(id)).filter((s): s is Session => !!s?.pty && s.pty.pid > 0);
    const cwds = await cwdOf(live.map((s) => s.pty?.pid ?? -1));
    for (const session of live) {
      const cwd = session.pty ? cwds.get(session.pty.pid) : undefined;
      if (cwd && cwd !== session.cwd) {
        session.cwd = cwd;
        this.events.changed(session);
      }
    }
  }

  private ensurePolling(): void {
    this.pollTimer ??= setInterval(() => void this.poll(), POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async poll(): Promise<void> {
    this.pollTick++;
    for (const session of this.sessions.values()) {
      if (!session.pty) continue;
      if (session.paused && Date.now() - session.pausedAt > MAX_PAUSE_MS) {
        session.paused = false;
        session.unacked = 0;
        session.pty.resume();
      }
      if (this.updateProcess(session)) this.events.changed(session);
    }
    if (this.pollTick % 2 === 0) await this.refreshCwd([...this.sessions.keys()]);
  }

  /** The extension host is going away: the pty host keeps its shells for the next window, others end. */
  dispose(): void {
    this.stopPolling();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const session of this.sessions.values()) {
      if (this.backend.persistent && session.kind === 'pty') session.release();
      else session.dispose();
    }
    this.sessions.clear();
    this.pending.clear();
    this.backend.release();
  }
}

/** Falls back to the home folder when a saved folder no longer exists. */
export function usableDir(dir: string): string {
  try {
    if (dir && existsSync(dir) && statSync(dir).isDirectory()) return dir;
  } catch {
    // Unreadable: fall through.
  }
  return homedir();
}
