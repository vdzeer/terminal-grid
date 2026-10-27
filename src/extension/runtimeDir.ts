import { lstatSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A folder only this user can use, for the pty host socket and the zsh
 * startup files. Undefined where that cannot be ensured (Windows, or a shared
 * temp folder where someone else made it first).
 */
export function runtimeDir(): string | undefined {
  const uid = process.getuid?.();
  if (process.platform === 'win32' || uid === undefined) return undefined;
  const dir = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `terminal-grid-${uid}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) return undefined;
    return dir;
  } catch {
    return undefined;
  }
}
