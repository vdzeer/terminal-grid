import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Files dropped on a tile: their paths, quoted for the shell, the way the
// Terminal tab inserts them.

/** Local paths of `file:` URIs; other schemes have no path a local shell could use. */
export function filePaths(uris: unknown[]): string[] {
  const paths: string[] = [];
  for (const uri of uris) {
    if (typeof uri !== 'string' || !uri.startsWith('file:')) continue;
    try {
      paths.push(fileURLToPath(uri));
    } catch {
      // Not a valid file URI: skip it.
    }
  }
  return paths;
}

/**
 * Whether a path can go into a terminal as typed text. Control characters act
 * in the shell's line editor before any quoting counts (a file name can end a
 * bracketed paste, clear the line and press Enter), fish reads \' inside
 * single quotes, and PowerShell and cmd expand $( ), ` and %VAR% inside double
 * quotes. Such names are left out rather than quoted.
 */
export function pasteable(file: string, platform: NodeJS.Platform): boolean {
  if ([...file].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) return false;
  return platform === 'win32' ? !/[$`%]/.test(file) : !file.includes('\\');
}

/** The path as one shell word; only for paths that are `pasteable`. */
export function shellQuote(file: string, platform: NodeJS.Platform): string {
  if (/^[\w@%+=:,./-]+$/.test(file)) return file;
  if (platform === 'win32') return `"${file}"`;
  return `'${file.replace(/'/g, `'\\''`)}'`;
}

// A drag from Finder brings file names into a webview but no paths; on macOS
// the drag pasteboard still holds the file URLs after the drop.
const DRAG_PASTEBOARD = `ObjC.import("AppKit");
const urls = $.NSPasteboard.pasteboardWithName($.NSPasteboardNameDrag)
  .readObjectsForClassesOptions($([$.NSURL]), $({ NSPasteboardURLReadingFileURLsOnlyKey: true }));
const paths = [];
if (urls) for (let i = 0; i < urls.count; i++) paths.push(urls.objectAtIndex(i).path.js);
JSON.stringify(paths);`;

function dragPasteboardPaths(): Promise<string[]> {
  if (process.platform !== 'darwin') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', DRAG_PASTEBOARD], { timeout: 3000 }, (error, stdout) => {
      try {
        const paths: unknown = error ? [] : JSON.parse(stdout);
        resolve(Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []);
      } catch {
        resolve([]);
      }
    });
  });
}

export async function droppedPaths(uris: unknown[], names: unknown[], platform: NodeJS.Platform): Promise<string[]> {
  let paths = filePaths(uris);
  if (paths.length === 0) {
    const wanted = new Set(names.filter((name): name is string => typeof name === 'string'));
    // Only paths of this drop: the pasteboard keeps the last drag, which may be an older one.
    if (wanted.size > 0) paths = (await dragPasteboardPaths()).filter((file) => wanted.has(path.basename(file)));
  }
  return paths.filter((file) => pasteable(file, platform));
}
