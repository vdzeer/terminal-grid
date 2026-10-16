import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

// node-pty is a native module. Instead of shipping a build for every editor
// release, we load the copy the editor itself uses for its terminals; it is
// always built for the right Electron version.

export interface Disposable {
  dispose(): void;
}

export interface Pty {
  readonly pid: number;
  /** Name of the foreground process (unix only), such as `zsh` or `vim`. */
  readonly process: string;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

export interface SpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export interface NodePty {
  spawn(file: string, args: string[], options: SpawnOptions): Pty;
}

/**
 * Where editors keep node-pty under `vscode.env.appRoot`. Cursor, Antigravity
 * and the remote servers ship a plain folder; VS Code and VSCodium pack the
 * JavaScript into `node_modules.asar` and the native parts into
 * `node_modules.asar.unpacked`, which Electron resolves on its own. The
 * unpacked folder alone is the last resort: it is complete only in some builds.
 */
export function nodePtyCandidates(appRoot: string): string[] {
  return [
    path.join(appRoot, 'node_modules', 'node-pty'),
    path.join(appRoot, 'node_modules.asar', 'node-pty'),
    path.join(appRoot, 'node_modules.asar.unpacked', 'node-pty'),
  ];
}

export function loadNodePty(appRoot: string): NodePty {
  // Every candidate is an absolute path, so the base only has to be absolute.
  const load = createRequire(path.join(path.resolve(appRoot), 'package.json'));
  const errors: string[] = [];
  for (const candidate of nodePtyCandidates(appRoot)) {
    if (!existsSync(candidate)) continue;
    try {
      const module = load(candidate) as Partial<NodePty> | undefined;
      if (typeof module?.spawn === 'function') return module as NodePty;
      errors.push(`${candidate}: no spawn function`);
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(errors.length ? errors.join('; ') : `node-pty not found under ${appRoot}`);
}
