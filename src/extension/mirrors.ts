import * as vscode from 'vscode';

// Terminals the extension did not start (opened in the Terminal tab before,
// or by other extensions) are mirrored into the grid. Their output comes from
// the proposed `onDidWriteTerminalData` event; input goes back with
// `sendText`. The real terminal keeps its own size, so the tile scales.

export interface MirrorHooks {
  isTwin(terminal: vscode.Terminal): boolean;
  added(terminal: vscode.Terminal, id: string): void;
  data(id: string, data: string): void;
  resized(id: string, cols: number, rows: number): void;
  removed(id: string): void;
}

const MAX_PENDING_CHARS = 200_000;

export class Mirrors implements vscode.Disposable {
  /** `''` while the id is being worked out (the process id is async). */
  private readonly ids = new Map<vscode.Terminal, string>();
  private readonly pending = new Map<vscode.Terminal, string[]>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private counter = 0;
  /** False when the editor did not enable the proposed API for this extension. */
  readonly available: boolean;

  constructor(private readonly hooks: MirrorHooks) {
    let available = false;
    try {
      this.subscriptions.push(vscode.window.onDidWriteTerminalData((event) => this.onData(event.terminal, event.data)));
      available = true;
    } catch {
      // Not enabled: argv.json lacks `enable-proposed-api`, or the editor was not restarted yet.
    }
    this.available = available;
    if (!available) return;
    this.subscriptions.push(
      vscode.window.onDidOpenTerminal((terminal) => void this.track(terminal)),
      vscode.window.onDidCloseTerminal((terminal) => this.untrack(terminal)),
      vscode.window.onDidChangeTerminalDimensions((event: vscode.TerminalDimensionsChangeEvent) => {
        const id = this.ids.get(event.terminal);
        if (id) this.hooks.resized(id, event.dimensions.columns, event.dimensions.rows);
      }),
    );
    for (const terminal of vscode.window.terminals) void this.track(terminal);
  }

  terminalOf(id: string): vscode.Terminal | undefined {
    for (const [terminal, value] of this.ids) if (value === id) return terminal;
    return undefined;
  }

  all(): [vscode.Terminal, string][] {
    return [...this.ids.entries()].filter(([, id]) => id !== '');
  }

  private async track(terminal: vscode.Terminal): Promise<void> {
    if (this.ids.has(terminal) || this.hooks.isTwin(terminal) || isHiddenFromUser(terminal)) return;
    this.ids.set(terminal, '');
    const pid = await Promise.race([terminal.processId, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000))]);
    if (!this.ids.has(terminal)) return; // closed meanwhile
    // The process id survives a window reload, so the tile keeps its identity.
    const id = pid ? `m${pid}` : `mx${++this.counter}`;
    this.ids.set(terminal, id);
    this.hooks.added(terminal, id);
    const queued = this.pending.get(terminal);
    this.pending.delete(terminal);
    if (queued) this.hooks.data(id, queued.join(''));
  }

  private untrack(terminal: vscode.Terminal): void {
    const id = this.ids.get(terminal);
    this.ids.delete(terminal);
    this.pending.delete(terminal);
    if (id) this.hooks.removed(id);
  }

  private onData(terminal: vscode.Terminal, data: string): void {
    const id = this.ids.get(terminal);
    if (id) {
      this.hooks.data(id, data);
      return;
    }
    if (this.hooks.isTwin(terminal) || isHiddenFromUser(terminal)) return;
    const queue = this.pending.get(terminal) ?? [];
    queue.push(data);
    // Keep the queue bounded in case the process id never resolves.
    let size = queue.reduce((n, chunk) => n + chunk.length, 0);
    while (size > MAX_PENDING_CHARS && queue.length > 1) size -= queue.shift()?.length ?? 0;
    this.pending.set(terminal, queue);
    if (id === undefined) void this.track(terminal);
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.ids.clear();
    this.pending.clear();
  }
}

/** Background terminals that tools keep out of the Terminal tab are not shown in the grid either. */
function isHiddenFromUser(terminal: vscode.Terminal): boolean {
  const options = terminal.creationOptions;
  return 'hideFromUser' in options && options.hideFromUser === true;
}
