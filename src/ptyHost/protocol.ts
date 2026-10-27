import type { Socket } from 'node:net';

// The pty host and the extension talk over a local socket, one JSON message per line.

/** Bumped on incompatible changes. The socket name carries it, so an older host is left to end on its own. */
export const PROTOCOL = 1;

export interface SessionState {
  id: string;
  pid: number;
  cols: number;
  rows: number;
  /** Foreground process name. */
  process: string;
  /** The last title the program set (OSC 0/2). */
  title: string;
}

export type ToHost =
  | { t: 'hello' }
  | { t: 'attach'; id: string }
  | {
      t: 'spawn';
      id: string;
      file: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
      cols: number;
      rows: number;
      scrollback: number;
    }
  | { t: 'input'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'pause' | 'resume' | 'kill' | 'detach'; id: string };

export type FromHost =
  | { t: 'sessions'; sessions: SessionState[] }
  | { t: 'attached'; session: SessionState; screen: string }
  | { t: 'missing'; id: string }
  | { t: 'spawned'; session: SessionState }
  | { t: 'spawnFailed'; id: string; message: string }
  | { t: 'data'; id: string; data: string }
  | { t: 'process'; id: string; name: string }
  | { t: 'exit'; id: string; code: number };

/** Calls `onMessage` for every complete line; a line that is not JSON is skipped. */
export function readMessages(socket: Socket, onMessage: (message: unknown) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      onMessage(message);
    }
  });
}

/** False when the socket buffer is full; the caller should wait for `drain`. */
export function writeMessage(socket: Socket, message: ToHost | FromHost): boolean {
  if (socket.destroyed) return true;
  return socket.write(`${JSON.stringify(message)}\n`);
}
