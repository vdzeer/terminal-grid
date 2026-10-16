import * as vscode from 'vscode';

// Every shell the grid runs also shows in the Terminal tab: a pseudoterminal
// fed with the same output and writing its input into the same process.

export interface TwinHooks {
  /** The current screen, painted when the Terminal-tab side opens. */
  screen(): string;
  input(data: string): void;
  /** The Terminal-tab size changed (or became known). */
  resized(): void;
  /** The user closed the terminal in the Terminal tab. */
  closedByUser(): void;
}

export class Twin implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  private readonly nameEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  readonly onDidChangeName = this.nameEmitter.event;
  /** Size of the Terminal-tab view; the shell follows it while the grid is hidden. */
  nativeSize: { cols: number; rows: number } | undefined;
  private opened = false;
  private closed = false;

  constructor(
    readonly sessionId: string,
    private name: string,
    private readonly hooks: TwinHooks,
  ) {}

  open(dimensions: vscode.TerminalDimensions | undefined): void {
    this.opened = true;
    const screen = this.hooks.screen();
    if (screen) this.writeEmitter.fire(screen);
    if (dimensions) this.nativeSize = { cols: dimensions.columns, rows: dimensions.rows };
    this.hooks.resized();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.hooks.closedByUser();
  }

  handleInput(data: string): void {
    this.hooks.input(data);
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.nativeSize = { cols: dimensions.columns, rows: dimensions.rows };
    this.hooks.resized();
  }

  write(data: string): void {
    // Output before `open` would be dropped by the editor; `open` paints the screen instead.
    if (this.opened && !this.closed) this.writeEmitter.fire(data);
  }

  rename(name: string): void {
    if (!name || name === this.name || this.closed) return;
    this.name = name;
    this.nameEmitter.fire(name);
  }

  /** The grid closed the shell: close the Terminal-tab side too. */
  dispose(): void {
    if (!this.closed) {
      this.closed = true;
      this.closeEmitter.fire();
    }
    setTimeout(() => {
      this.writeEmitter.dispose();
      this.closeEmitter.dispose();
      this.nameEmitter.dispose();
    }, 0);
  }
}
