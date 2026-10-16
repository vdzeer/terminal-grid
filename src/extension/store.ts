// What survives a window reload: the layout, and for each terminal its
// folder, its custom name and a snapshot of the screen.

export interface StoredTerminal {
  id: string;
  cwd: string;
  customTitle: string;
  snapshot: string;
  cols: number;
  rows: number;
}

export interface StoredState {
  version: 1;
  layout: unknown;
  terminals: StoredTerminal[];
}

export const STATE_KEY = 'terminalGrid.state';

export function readState(raw: unknown): StoredState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || !Array.isArray(value.terminals)) return undefined;
  const terminals: StoredTerminal[] = [];
  const seen = new Set<string>();
  for (const item of value.terminals) {
    if (typeof item !== 'object' || item === null) continue;
    const t = item as Record<string, unknown>;
    if (typeof t.id !== 'string' || !t.id || seen.has(t.id)) continue;
    seen.add(t.id);
    terminals.push({
      id: t.id,
      cwd: typeof t.cwd === 'string' ? t.cwd : '',
      customTitle: typeof t.customTitle === 'string' ? t.customTitle : '',
      snapshot: typeof t.snapshot === 'string' ? t.snapshot : '',
      cols: dimension(t.cols, 80, 2000),
      rows: dimension(t.rows, 24, 1000),
    });
  }
  return { version: 1, layout: value.layout, terminals };
}

function dimension(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= max ? value : fallback;
}
