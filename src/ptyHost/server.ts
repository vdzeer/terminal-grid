import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import * as net from 'node:net';
import type { Pty, SpawnOptions } from '../extension/nodePty';
import { readMessages, writeMessage, type FromHost, type SessionState } from './protocol';

// The pty host: a small background process that owns the grid shells, so they
// outlive a window reload. The extension (re)connects to it; while it is away,
// output still goes into a headless terminal per shell, so the screen is there
// when it comes back. A newer connection replaces an older one (the reloaded
// window). With no extension for `graceMs` (the window was closed), it ends
// every shell; once no shell is left and no one is connected, it exits.

export const GRACE_MS = 60_000;
const PROCESS_POLL_MS = 1000;
/** After output, the foreground process is read again at most this often. */
const PROCESS_AFTER_DATA_MS = 200;

export type Spawn = (file: string, args: string[], options: SpawnOptions) => Pty;

interface Entry {
  pty: Pty;
  headless: HeadlessTerminal;
  serializer: SerializeAddon;
  cols: number;
  rows: number;
  process: string;
  title: string;
  checkedAt: number;
  /** Output goes to the extension. */
  attached: boolean;
  /** Output held back while the screen is serialized for `attach`. */
  held: string[] | undefined;
  /** Paused by the extension's flow control. */
  paused: boolean;
}

export interface PtyHostOptions {
  spawn: Spawn;
  graceMs?: number;
  /** Called once no shell is left and no one is connected. */
  exit: () => void;
  log?: (line: string) => void;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isSize = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0 && (value as number) <= 5000;

export function servePtyHost(options: PtyHostOptions): net.Server {
  const sessions = new Map<string, Entry>();
  let client: net.Socket | undefined;
  /** The socket buffer is full: every shell waits until it drains. */
  let blocked = false;
  let grace: NodeJS.Timeout | undefined;
  const log = options.log ?? (() => {});

  const send = (message: FromHost) => {
    const socket = client;
    if (!socket || writeMessage(socket, message) || blocked) return;
    blocked = true;
    for (const entry of sessions.values()) entry.pty.pause();
    socket.once('drain', () => {
      if (client !== socket) return;
      blocked = false;
      for (const entry of sessions.values()) if (!entry.paused) entry.pty.resume();
    });
  };

  const state = (id: string, entry: Entry): SessionState => ({
    id,
    pid: entry.pty.pid,
    cols: entry.cols,
    rows: entry.rows,
    process: entry.process,
    title: entry.title,
  });

  const readProcess = (id: string, entry: Entry) => {
    entry.checkedAt = Date.now();
    let name: string;
    try {
      name = entry.pty.process;
    } catch {
      return;
    }
    if (name === entry.process) return;
    entry.process = name;
    if (entry.attached) send({ t: 'process', id, name });
  };

  const shutdown = () => {
    clearInterval(poll);
    clearTimeout(grace);
    log('exit');
    // First, so a window that connects meanwhile starts a new host instead of finding this one closing.
    options.exit();
    server.close();
  };

  const endAll = () => {
    log(`no window for ${options.graceMs ?? GRACE_MS} ms: ending ${sessions.size} shell(s)`);
    for (const entry of sessions.values()) {
      try {
        entry.pty.kill();
      } catch {
        // Already gone.
      }
      entry.headless.dispose();
    }
    sessions.clear();
    shutdown();
  };

  const spawn = (message: Record<string, unknown>) => {
    const { id, file, args, cwd, env, cols, rows, scrollback } = message;
    if (!isString(id) || !isString(file) || !Array.isArray(args) || !args.every(isString) || !isString(cwd)) return;
    if (typeof env !== 'object' || env === null || !isSize(cols) || !isSize(rows)) return;
    const old = sessions.get(id);
    if (old) {
      sessions.delete(id);
      old.pty.kill();
      old.headless.dispose();
    }
    let pty: Pty;
    try {
      pty = options.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env: env as Record<string, string> });
    } catch (error) {
      send({ t: 'spawnFailed', id, message: error instanceof Error ? error.message : String(error) });
      return;
    }
    const headless = new HeadlessTerminal({ cols, rows, scrollback: isSize(scrollback) ? scrollback : 1000, allowProposedApi: true });
    const serializer = new SerializeAddon();
    // The addon is typed against the browser build; the headless one has the same surface.
    headless.loadAddon(serializer as unknown as Parameters<HeadlessTerminal['loadAddon']>[0]);
    const entry: Entry = { pty, headless, serializer, cols, rows, process: '', title: '', checkedAt: 0, attached: true, held: undefined, paused: false };
    headless.onTitleChange((title) => (entry.title = title));
    sessions.set(id, entry);
    pty.onData((data) => {
      if (sessions.get(id) !== entry) return;
      headless.write(data);
      // The process before its output, so a title it sets (OSC 0/2) is matched to it.
      if (Date.now() - entry.checkedAt > PROCESS_AFTER_DATA_MS || data.includes('\x1b]0;') || data.includes('\x1b]2;')) readProcess(id, entry);
      if (entry.held) entry.held.push(data);
      else if (entry.attached) send({ t: 'data', id, data });
    });
    pty.onExit(({ exitCode }) => {
      if (sessions.get(id) !== entry) return;
      sessions.delete(id);
      headless.dispose();
      if (entry.attached) send({ t: 'exit', id, code: exitCode });
      if (sessions.size === 0 && !client) shutdown();
    });
    readProcess(id, entry);
    send({ t: 'spawned', session: state(id, entry) });
  };

  const attach = (id: string) => {
    const entry = sessions.get(id);
    if (!entry) {
      send({ t: 'missing', id });
      return;
    }
    const owner = client;
    entry.held = [];
    // The empty write calls back once everything before it is parsed: the
    // screen is serialized at that point and the output after it follows.
    entry.headless.write('', () => {
      if (client !== owner || sessions.get(id) !== entry) return;
      send({ t: 'attached', session: state(id, entry), screen: entry.serializer.serialize() });
      const held = entry.held ?? [];
      entry.held = undefined;
      entry.attached = true;
      for (const data of held) send({ t: 'data', id, data });
    });
  };

  const handle = (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return;
    const message = raw as Record<string, unknown>;
    if (message.t === 'hello') {
      send({ t: 'sessions', sessions: [...sessions].map(([id, entry]) => state(id, entry)) });
      return;
    }
    if (message.t === 'spawn') {
      spawn(message);
      return;
    }
    const id = message.id;
    if (!isString(id)) return;
    if (message.t === 'attach') {
      attach(id);
      return;
    }
    const entry = sessions.get(id);
    if (!entry) return;
    switch (message.t) {
      case 'input':
        if (isString(message.data)) entry.pty.write(message.data);
        return;
      case 'resize':
        if (!isSize(message.cols) || !isSize(message.rows)) return;
        entry.cols = message.cols;
        entry.rows = message.rows;
        entry.headless.resize(entry.cols, entry.rows);
        try {
          entry.pty.resize(entry.cols, entry.rows);
        } catch {
          // The pty can close between the check and the call.
        }
        return;
      case 'pause':
        entry.paused = true;
        entry.pty.pause();
        return;
      case 'resume':
        entry.paused = false;
        if (!blocked) entry.pty.resume();
        return;
      case 'kill':
        sessions.delete(id);
        entry.headless.dispose();
        try {
          entry.pty.kill();
        } catch {
          // Already gone.
        }
        return;
      case 'detach':
        entry.attached = false;
        entry.held = undefined;
        return;
    }
  };

  const server = net.createServer((socket) => {
    // A newer window (the one after a reload) takes over from the old one.
    client?.destroy();
    client = socket;
    blocked = false;
    clearTimeout(grace);
    for (const entry of sessions.values()) {
      entry.attached = false;
      entry.held = undefined;
      entry.paused = false;
      entry.pty.resume();
    }
    log(`connected, ${sessions.size} shell(s)`);
    readMessages(socket, (message) => {
      try {
        handle(message);
      } catch (error) {
        log(`message failed: ${error instanceof Error ? error.stack : String(error)}`);
      }
    });
    socket.on('error', () => {
      // 'close' follows.
    });
    socket.on('close', () => {
      if (client !== socket) return;
      client = undefined;
      for (const entry of sessions.values()) entry.attached = false;
      log(`disconnected, ${sessions.size} shell(s)`);
      if (sessions.size === 0) shutdown();
      else grace = setTimeout(endAll, options.graceMs ?? GRACE_MS);
    });
  });

  // A window that gave up waiting for this host never connects: then it exits on its own.
  grace = setTimeout(endAll, options.graceMs ?? GRACE_MS);
  const poll = setInterval(() => {
    for (const [id, entry] of sessions) readProcess(id, entry);
  }, PROCESS_POLL_MS);
  // The listening socket keeps the process alive; the poll alone should not.
  poll.unref();
  return server;
}
