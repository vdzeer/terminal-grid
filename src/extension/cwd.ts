import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';

/** Current working directory of each process, read from the OS. */
export async function cwdOf(pids: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (pids.length === 0) return result;
  if (process.platform === 'linux') {
    await Promise.all(
      pids.map(async (pid) => {
        try {
          result.set(pid, await readlink(`/proc/${pid}/cwd`));
        } catch {
          // The process is gone or not ours.
        }
      }),
    );
    return result;
  }
  if (process.platform === 'darwin') {
    // One lsof call for all shells. lsof exits with 1 when some pid is gone,
    // but still prints the others.
    const out = await new Promise<string>((resolve) => {
      execFile('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fn'], { timeout: 4000 }, (_error, stdout) =>
        resolve(typeof stdout === 'string' ? stdout : ''),
      );
    });
    return parseLsof(out);
  }
  return result;
}

/** Parses `lsof -Fn` output: `p<pid>` lines followed by `n<path>` lines. */
export function parseLsof(out: string): Map<number, string> {
  const result = new Map<number, string>();
  let pid: number | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      const value = Number(line.slice(1));
      pid = Number.isInteger(value) ? value : undefined;
    } else if (line.startsWith('n') && pid !== undefined && !result.has(pid)) {
      result.set(pid, line.slice(1));
    }
  }
  return result;
}
