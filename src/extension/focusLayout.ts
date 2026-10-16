import * as vscode from 'vscode';
import { looksMaximized, sideBarWasOpen, type Viewport } from '../shared/viewport';

// "Grid mode": while the grid is shown in the bottom panel, the panel is
// maximized and only the Explorer stays next to it; going back to an editor
// brings the usual layout back.
//
// The editor API cannot read layout state (is the panel maximized, is the
// secondary side bar open), so it is measured: the webview reports its own
// size and the window size, and a part that opens or closes shows up as a
// change in those numbers.

const SETTLE_MS = 140;
const SETTLE_LIMIT_MS = 900;

export class FocusLayout implements vscode.Disposable {
  private active = false;
  private busy = false;
  private auxClosedByUs = false;
  /** Panel height right after it was maximized, to tell later whether it still is. */
  private maximizedHeight = 0;
  private viewport: Viewport | undefined;
  private lastViewportAt = 0;
  /** Editor changes caused by the extension itself (closing its own tab) are not the user leaving. */
  private ignoreEditorChangesUntil = 0;

  constructor(
    private readonly enabled: () => boolean,
    private readonly gridVisibleInPanel: () => boolean,
    private readonly focusGrid: () => Thenable<unknown>,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  get lastViewport(): Viewport | undefined {
    return this.viewport;
  }

  ignoreEditorChanges(ms: number): void {
    this.ignoreEditorChangesUntil = Date.now() + ms;
  }

  /** The board webview was replaced; wait for its own measurements. */
  forgetViewport(): void {
    this.viewport = undefined;
  }

  onViewport(viewport: Viewport): void {
    this.viewport = viewport;
    this.lastViewportAt = Date.now();
  }

  /** Waits until the webview size stops changing after a layout command. */
  private async settled(): Promise<Viewport | undefined> {
    const start = Date.now();
    await sleep(SETTLE_MS);
    while (Date.now() - this.lastViewportAt < SETTLE_MS && Date.now() - start < SETTLE_LIMIT_MS) await sleep(40);
    return this.viewport;
  }

  /** The grid just became visible in the bottom panel. */
  async enter(): Promise<void> {
    if (this.active || this.busy || !this.enabled() || !this.gridVisibleInPanel()) return;
    this.busy = true;
    try {
      // The webview reports its size once it has loaded.
      for (let waited = 0; !this.viewport && waited < 3000; waited += 50) await sleep(50);
      if (!this.viewport || !this.gridVisibleInPanel()) return;
      // Only the center alignment can be maximized; the others would hide the editor for good.
      const center = vscode.workspace.getConfiguration('workbench.panel').get<string>('defaultAlignment', 'center') === 'center';
      await vscode.commands.executeCommand('workbench.view.explorer');
      const before = await this.settled();
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      const after = await this.settled();
      this.auxClosedByUs = center && sideBarWasOpen(before, after);
      if (center) await this.ensureMaximized(after);
      this.setActive(true);
      await this.focusGrid();
    } finally {
      this.busy = false;
    }
  }

  private async ensureMaximized(current: Viewport | undefined): Promise<void> {
    const known = looksMaximized(current);
    if (known === true) {
      this.maximizedHeight = current?.height ?? 0;
      return;
    }
    await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    const after = await this.settled();
    if (known === undefined && current && after && after.height < current.height - 20) {
      // It was maximized already and the toggle restored it: maximize again.
      await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
      this.maximizedHeight = current.height;
      return;
    }
    this.maximizedHeight = after?.height ?? 0;
  }

  /** Still maximized, as far as the measurements tell. */
  private stillMaximized(): boolean {
    const known = looksMaximized(this.viewport);
    if (known !== undefined) return known;
    return !!this.viewport && this.maximizedHeight > 0 && this.viewport.height >= this.maximizedHeight - 30;
  }

  /** The user went to an editor: close the maximized grid and bring the layout back. */
  async leaveForEditor(): Promise<void> {
    if (!this.active || this.busy || Date.now() < this.ignoreEditorChangesUntil) return;
    this.setActive(false);
    // When the user restored the panel size on purpose, keep the grid next to the editor.
    if (this.stillMaximized()) {
      // Hiding a maximized panel un-maximizes it; the editor reopens it maximized next time.
      await vscode.commands.executeCommand('workbench.action.closePanel');
    }
    await this.restoreSideBar();
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }

  /** The grid was hidden: the panel closed or another panel tab was picked. */
  async onGridHidden(): Promise<void> {
    if (!this.active || this.busy) return;
    this.setActive(false);
    await this.restoreSideBar();
  }

  private async restoreSideBar(): Promise<void> {
    if (!this.auxClosedByUs) return;
    this.auxClosedByUs = false;
    await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar');
  }

  private setActive(active: boolean): void {
    this.active = active;
    void vscode.commands.executeCommand('setContext', 'terminalGrid.gridMode', active);
  }

  dispose(): void {
    this.active = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
