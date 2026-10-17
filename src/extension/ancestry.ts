import { execFile } from 'node:child_process';

// Which grid tile runs a process: walk up from the process to a grid shell.

/** `pid ppid` lines of `ps -A -o pid=,ppid=`. */
export function parseParents(output: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
}

/** The pid, its parent, and so on up to the root. */
export function chainOf(parents: Map<number, number>, pid: number): number[] {
  const chain: number[] = [];
  let current: number | undefined = pid;
  while (current !== undefined && current > 1 && !chain.includes(current)) {
    chain.push(current);
    current = parents.get(current);
  }
  return chain;
}

export function ancestorsOf(pid: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid='], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? [pid] : chainOf(parseParents(stdout), pid)),
    );
  });
}
