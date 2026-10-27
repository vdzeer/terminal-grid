import { spawn as spawnProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as net from 'node:net';
import * as path from 'node:path';
import { PROTOCOL, readMessages, writeMessage, type FromHost, type SessionState, type ToHost } from '../ptyHost/protocol';
import type { Disposable, NodePty, Pty, SpawnOptions } from './nodePty';

// Where grid shells run: in the pty host (src/ptyHost), which keeps them
// through a window reload, or, when it cannot be started, in the extension
// host itself as before. Kept free of `vscode` so it can be tested.

/** How long a new pty host gets to start listening, and an answer may take. */
const CONNECT_TIMEOUT_MS = 5000;

/** A shell that outlived the last extension host, with its screen at the moment it was taken back. */
export interface Survivor {
  pty: Pty;
  screen: string;
  cols: number;
  rows: number;
  title: string;
}

export interface PtyBackend {
  /** True when shells outlive the extension host. */
  readonly persistent: boolean;
  /** Starts a shell; `id` names it in the pty host. */
  spawn(id: string, file: string, args: string[], options: SpawnOptions, scrollback: number): Pty;
  /** Shells kept through the last reload, by id. Handed out once. */
  takeSurvivors(): Map<string, Survivor>;
  /** Stops following a shell without ending it. */
  detach(id: string): void;
  /** Connects again as a new window would, to take the shells back (a reload, in tests). */
  reconnect(): Promise<void>;
  /** Lets go of every shell: the pty host keeps them for the next window. */
  release(): void;
}

export function localBackend(nodePty: NodePty): PtyBackend {
  return {
    persistent: false,
    spawn: (_id, file, args, options) => nodePty.spawn(file, args, options),
    takeSurvivors: () => new Map(),
    detach: () => {},
    reconnect: async () => {},
    release: () => {},
  };
}

/** One socket per workspace (and protocol version), in a folder only the user can reach. */
export function ptyHostSocket(dir: string, workspaceKey: string): string {
  const hash = createHash('sha256').update(workspaceKey).digest('hex').slice(0, 16);
  return path.join(dir, `pty${PROTOCOL}-${hash}.sock`);
}

/** Starts the pty host detached, with the editor's Electron running as Node. */
export function launchPtyHost(script: string, socketPath: string, appRoot: string): void {
  spawnProcess(process.execPath, [script, socketPath, appRoot], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).unref();
}

/** A shell in the pty host, driven over the socket. */
class HostPty implements Pty {
  pid = 0;
  process = '';
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number }) => void>();
  /** Output and exit that came before anyone listened: a survivor is taken back a moment after it is attached. */
  private early: string[] = [];
  private exitCode: number | undefined;

  constructor(
    private readonly host: PtyHostClient,
    readonly id: string,
  ) {}

  onData(listener: (data: string) => void): Disposable {
    this.dataListeners.add(listener);
    for (const data of this.early.splice(0)) listener(data);
    return { dispose: () => void this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number }) => void): Disposable {
    this.exitListeners.add(listener);
    if (this.exitCode !== undefined) listener({ exitCode: this.exitCode });
    return { dispose: () => void this.exitListeners.delete(listener) };
  }

  write(data: string): void {
    this.host.send({ t: 'input', id: this.id, data });
  }

  resize(cols: number, rows: number): void {
    this.host.send({ t: 'resize', id: this.id, cols, rows });
  }

  kill(): void {
    this.host.forget(this.id);
    this.host.send({ t: 'kill', id: this.id });
  }

  pause(): void {
    this.host.send({ t: 'pause', id: this.id });
  }

  resume(): void {
    this.host.send({ t: 'resume', id: this.id });
  }

  update(session: SessionState): void {
    this.pid = session.pid;
    this.process = session.process;
  }

  emitData(data: string): void {
    if (this.dataListeners.size === 0) this.early.push(data);
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode: number): void {
    if (this.exitCode !== undefined) return;
    this.exitCode = exitCode;
    for (const listener of this.exitListeners) listener({ exitCode });
  }
}

function connect(socketPath: string): Promise<net.Socket | undefined> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', () => resolve(undefined));
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class PtyHostClient implements PtyBackend {
  readonly persistent = true;
  private socket: net.Socket;
  private readonly ptys = new Map<string, HostPty>();
  private survivors = new Map<string, Survivor>();
  /** Answers being waited for: `sessions`, and `attached`/`missing` by id. */
  private readonly waiting = new Map<string, (message: FromHost | undefined) => void>();
  private released = false;

  private constructor(
    socket: net.Socket,
    private readonly socketPath: string,
  ) {
    this.socket = socket;
    this.listen(socket);
  }

  /** Connects to the workspace's pty host, starting it when there is none, and takes back what it kept. */
  static async open(socketPath: string, start: () => void): Promise<PtyHostClient | undefined> {
    let socket = await connect(socketPath);
    if (!socket) {
      start();
      const until = Date.now() + CONNECT_TIMEOUT_MS;
      while (!socket && Date.now() < until) {
        await sleep(100);
        socket = await connect(socketPath);
      }
    }
    if (!socket) return undefined;
    const client = new PtyHostClient(socket, socketPath);
    if (!(await client.adoptAll())) {
      client.release();
      return undefined;
    }
    return client;
  }

  private listen(socket: net.Socket): void {
    readMessages(socket, (message) => {
      if (this.socket === socket) this.receive(message as FromHost);
    });
    socket.on('error', () => {
      // 'close' follows.
    });
    socket.on('close', () => {
      if (this.socket !== socket || this.released) return;
      // The pty host is gone, and its shells with it.
      for (const resolve of this.waiting.values()) resolve(undefined);
      this.waiting.clear();
      for (const pty of this.ptys.values()) pty.emitExit(-1);
      this.ptys.clear();
    });
  }

  private receive(message: FromHost): void {
    switch (message.t) {
      case 'sessions':
        this.answer('sessions', message);
        return;
      case 'attached': {
        // Registered right away: the shell's output follows in the same read.
        const pty = new HostPty(this, message.session.id);
        pty.update(message.session);
        this.ptys.set(pty.id, pty);
        const { cols, rows, title } = message.session;
        this.survivors.set(pty.id, { pty, screen: message.screen, cols, rows, title });
        this.answer(`attach:${pty.id}`, message);
        return;
      }
      case 'missing':
        this.answer(`attach:${message.id}`, message);
        return;
      case 'spawned':
        this.ptys.get(message.session.id)?.update(message.session);
        return;
      case 'spawnFailed': {
        const pty = this.ptys.get(message.id);
        this.ptys.delete(message.id);
        pty?.emitData(`\r\n\x1b[31m${message.message}\x1b[0m\r\n`);
        pty?.emitExit(-1);
        return;
      }
      case 'data':
        this.ptys.get(message.id)?.emitData(message.data);
        return;
      case 'process': {
        const pty = this.ptys.get(message.id);
        if (pty) pty.process = message.name;
        return;
      }
      case 'exit': {
        const pty = this.ptys.get(message.id);
        this.ptys.delete(message.id);
        pty?.emitExit(message.code);
        return;
      }
    }
  }

  private answer(key: string, message: FromHost): void {
    const resolve = this.waiting.get(key);
    this.waiting.delete(key);
    resolve?.(message);
  }

  private request(key: string, message: ToHost): Promise<FromHost | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(key);
        resolve(undefined);
      }, CONNECT_TIMEOUT_MS);
      this.waiting.set(key, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      this.send(message);
    });
  }

  /** Takes back every shell the pty host has. False when it does not answer. */
  private async adoptAll(): Promise<boolean> {
    const answer = await this.request('sessions', { t: 'hello' });
    if (answer?.t !== 'sessions') return false;
    await Promise.all(answer.sessions.map((session) => this.request(`attach:${session.id}`, { t: 'attach', id: session.id })));
    return true;
  }

  send(message: ToHost): void {
    writeMessage(this.socket, message);
  }

  forget(id: string): void {
    this.ptys.delete(id);
  }

  spawn(id: string, file: string, args: string[], options: SpawnOptions, scrollback: number): Pty {
    const pty = new HostPty(this, id);
    this.ptys.set(id, pty);
    this.send({ t: 'spawn', id, file, args, cwd: options.cwd, env: options.env, cols: options.cols, rows: options.rows, scrollback });
    return pty;
  }

  takeSurvivors(): Map<string, Survivor> {
    const survivors = this.survivors;
    this.survivors = new Map();
    return survivors;
  }

  detach(id: string): void {
    this.ptys.delete(id);
    this.send({ t: 'detach', id });
  }

  async reconnect(): Promise<void> {
    const socket = await connect(this.socketPath);
    if (!socket) return;
    const old = this.socket;
    this.socket = socket;
    this.ptys.clear();
    this.listen(socket);
    old.destroy();
    await this.adoptAll();
  }

  release(): void {
    this.released = true;
    this.socket.end();
  }
}
