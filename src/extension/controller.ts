import { stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { languageFor, translator, type Translate } from '../shared/i18n';
import { remove, sanitize, type LayoutNode, type Placement } from '../shared/layout';
import type { HostMessage, ViewMessage, ViewSettings } from '../shared/protocol';
import { buildEnv, defaultShellArgs, resolveShell } from './env';
import { ancestorsOf } from './ancestry';
import { droppedPaths, shellQuote } from './drop';
import { FocusLayout } from './focusLayout';
import { RECLAIM_WINDOW_MS, noReclaim, reclaimCause, tabChangeCounts, type ReclaimState } from './reclaim';
import { renderHtml, renderPlaceholder } from './html';
import type { PtyBackend } from './ptyHostClient';
import { Mirrors } from './mirrors';
import { SessionManager, type Session, type ShellConfig } from './sessions';
import { runtimeDir } from './runtimeDir';
import { prepareZdotdir, withShellIntegration } from './shellIntegration';
import { readState, STATE_KEY, type StoredTerminal } from './store';
import { Twin } from './twins';

/** Editor-tab webview type, for restoring the tab after a reload. */
export const VIEW_TYPE = 'terminalGrid.board';
/** The view in the bottom panel; `<id>.focus` is the editor's built-in reveal command. */
export const PANEL_VIEW_ID = 'terminalGrid.view';
const SNAPSHOT_EVERY_MS = 15_000;
const MIRROR_POLL_MS = 1500;
/** How long the Terminal tab gets to lay itself out after the grid hides (see `settleNativeSizes`). */
const NATIVE_SETTLE_MS = 300;
/** globalState: the notice about turning mirrors on was shown. It is shown once, ever. */
const MIRROR_NOTICE_KEY = 'terminalGrid.mirrorNoticeShown';

/** Puts a restored screen back into a sane state before the new shell starts. */
const RESET_MODES = '\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1l\x1b[?25h\x1b[0m';

/** A diff in front: a proposed edit, answered in the terminal, not the user leaving the grid for a file. */
function isBoardTab(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(VIEW_TYPE);
}

function activeTabIsDiff(): boolean {
  return vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff;
}

/** Where the board can be shown: the bottom panel view, or an editor tab. */
export type HostKind = 'panel' | 'editor';

export class BoardController implements vscode.Disposable {
  private editorPanel: vscode.WebviewPanel | undefined;
  private editorSubscriptions: vscode.Disposable[] = [];
  private panelView: vscode.WebviewView | undefined;
  /** Which webview shows the board now. Only one does, so a pty never has two sizes. */
  private host: HostKind | undefined;
  /** Bumped on every host change, so a slow init never lands in the wrong webview. */
  private hostGeneration = 0;
  private ready = false;
  private layout: LayoutNode | null = null;
  private restored = false;
  private focusAfterInit: string | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private nativeSettleTimer: NodeJS.Timeout | undefined;
  private readonly snapshotTimer: NodeJS.Timeout;
  private readonly mirrorPollTimer: NodeJS.Timeout;
  private readonly manager: SessionManager;
  /** Terminal-tab side of each grid shell, by session id. */
  private readonly twins = new Map<string, Twin>();
  /** Mirror tiles the user closed; the terminals keep running in the Terminal tab. */
  private readonly hidden = new Set<string>();
  private readonly mirrors: Mirrors;
  private readonly focusLayout: FocusLayout;
  private readonly status: vscode.StatusBarItem;
  /** Tab changes and prompts sent that may push the grid out of the panel (see reclaim.ts). */
  private reclaim: ReclaimState = noReclaim();
  /** The last tab change, for the integration run's diagnostics. */
  private lastTabEvent = '';
  /** The tile that last had the keyboard focus in the board. */
  private focusedTile: string | undefined;
  /** zsh startup files for shell integration, copied once per start from the editor install. */
  private zdotdir: string | null | undefined;
  private readonly t: Translate;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: PtyBackend,
  ) {
    this.t = translator(languageFor(vscode.env.language));
    this.manager = new SessionManager(
      backend,
      () => this.shellConfig(),
      {
        output: (chunks) => this.post({ type: 'output', chunks: chunks.filter(([id]) => !this.hidden.has(id)) }),
        data: (session, data) => this.twins.get(session.id)?.write(data),
        changed: (session) => {
          this.post({ type: 'updated', terminal: session.info() });
          this.twins.get(session.id)?.rename(titleOf(session));
        },
        exited: (session) => this.onExited(session),
        activity: (session, kind) => this.onActivity(session, kind),
        spawnFailed: (session, message) => {
          this.manager.print(session.id, `\r\n\x1b[31m${this.t('spawnFailed', message)}\x1b[0m\r\n`);
          this.post({ type: 'updated', terminal: session.info() });
        },
      },
      () => this.viewSettings().scrollback,
    );
    this.focusLayout = new FocusLayout(
      () => vscode.workspace.getConfiguration('terminalGrid').get<boolean>('focusLayout', true),
      () => this.host === 'panel' && this.panelView?.visible === true,
      () => vscode.commands.executeCommand(`${PANEL_VIEW_ID}.focus`),
    );
    this.status = vscode.window.createStatusBarItem('terminalGrid.status', vscode.StatusBarAlignment.Left, 50);
    this.status.name = 'Terminal Grid';
    this.status.command = 'terminalGrid.open';
    this.snapshotTimer = setInterval(() => {
      if (this.manager.all().some((s) => s.dirty)) void this.save();
    }, SNAPSHOT_EVERY_MS);
    this.mirrorPollTimer = setInterval(() => this.pollMirrors(), MIRROR_POLL_MS);
    this.subscriptions.push(
      this.status,
      this.focusLayout,
      // Opening a file while the grid fills the window brings the editor back.
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) void this.focusLayout.leaveForEditor({ keepGrid: activeTabIsDiff() });
      }),
      vscode.window.onDidOpenTerminal((terminal) => {
        if (this.isTwin(terminal)) this.showTwinInGrid(terminal);
      }),
      // Closing a twin in the Terminal tab (or through the API) ends the shell and the tile.
      // A reload or a closing window closes it too: then the pty host keeps the shell for the next window.
      vscode.window.onDidCloseTerminal((terminal) => {
        const options = terminal.creationOptions;
        if (!('pty' in options) || terminal.exitStatus?.reason === vscode.TerminalExitReason.Shutdown) return;
        for (const [id, twin] of this.twins) if (twin === options.pty) this.removeSession(id);
      }),
      vscode.window.tabGroups.onDidChangeTabs((event) => {
        const now = Date.now();
        const visible = this.host === 'panel' && this.panelView?.visible === true;
        // The board's own editor tab coming or going is the extension's doing, not a tool's.
        const others = [...event.opened, ...event.closed].filter((tab) => !isBoardTab(tab));
        if (others.length > 0 && this.host === 'panel' && tabChangeCounts(visible, this.reclaim.hiddenAt, now)) {
          this.reclaim = { ...this.reclaim, tabChangeAt: now, reclaims: 0 };
          // The grid may already be gone: the terminal was shown before this event arrived.
          if (!visible) this.reclaimPanel();
        }
        this.lastTabEvent = `+${event.opened.map((t) => t.label).join('|')} -${event.closed.map((t) => t.label).join('|')}`;
        const opened = event.opened.find((tab) => tab.isActive);
        if (opened) void this.focusLayout.leaveForEditor({ keepGrid: opened.input instanceof vscode.TabInputTextDiff });
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('terminal.integrated') ||
          e.affectsConfiguration('editor.fontFamily') ||
          e.affectsConfiguration('editor.fontSize') ||
          e.affectsConfiguration('terminalGrid.shiftEnterSequence')
        ) {
          this.post({ type: 'settings', settings: this.viewSettings() });
        }
        if (e.affectsConfiguration('terminalGrid.restoreSessions')) void this.save();
      }),
    );
    // Shells from the last session come back right away, so their Terminal-tab twins do too.
    this.ensureRestored();
    this.mirrors = new Mirrors({
      isTwin: (terminal) => this.isTwin(terminal),
      added: (terminal, id) => this.onMirrorAdded(terminal, id),
      data: (id, data) => this.manager.feed(id, data),
      resized: (id, cols, rows) => {
        const session = this.manager.get(id);
        if (!session) return;
        this.manager.resize(id, cols, rows);
        this.post({ type: 'updated', terminal: session.info() });
      },
      removed: (id) => this.removeSession(id),
    });
    this.subscriptions.push(this.mirrors);
  }

  // ---- hosts ----

  /** Shows the board where it lives: the editor tab when there is one, the bottom panel otherwise. */
  async open(): Promise<void> {
    if (this.editorPanel) {
      this.editorPanel.reveal(undefined, false);
      return;
    }
    await this.revealInPanel();
  }

  /**
   * Shows and focuses the tile running this process, or one of its
   * ancestors. For other extensions that know a pid (Lookout uses it to go
   * to a Claude Code session). False when no tile runs it.
   */
  async revealProcess(pid: unknown): Promise<boolean> {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return false;
    const chain = await ancestorsOf(pid);
    let id = this.manager.all().find((session) => session.kind === 'pty' && session.pty && chain.includes(session.pty.pid))?.id;
    if (!id) {
      for (const [terminal, mirrorId] of this.mirrors.all()) {
        const shell = await terminal.processId;
        if (shell && chain.includes(shell) && !this.hidden.has(mirrorId)) {
          id = mirrorId;
          break;
        }
      }
    }
    if (!id) return false;
    await this.open();
    if (this.ready) this.post({ type: 'focus', id });
    else this.focusAfterInit = id;
    return true;
  }

  private async revealInPanel(): Promise<void> {
    await vscode.commands.executeCommand(`${PANEL_VIEW_ID}.focus`);
    // Already visible means no visibility event, so grid mode is entered here too.
    await this.focusLayout.enter();
  }

  /** The shortcut: shows the grid, or, when it already fills the window, goes back to the editor. */
  toggle(): void {
    if (this.focusLayout.isActive && this.host === 'panel' && this.panelView?.visible) void this.focusLayout.leaveForEditor();
    else void this.open();
  }

  openInEditor(): void {
    if (this.editorPanel) {
      this.editorPanel.reveal(undefined, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      this.t('panelTitle'),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: this.resourceRoots() },
    );
    this.adoptEditorPanel(panel);
  }

  /** Moves the board from the editor tab back to the bottom panel. */
  moveToPanel(): void {
    // Closing the tab hands the board to the panel view (see onEditorPanelDisposed).
    // It also activates another editor, which must not end grid mode right away.
    this.focusLayout.ignoreEditorChanges(1500);
    this.editorPanel?.dispose();
    void this.revealInPanel();
  }

  /** Takes over a new editor tab, or one the editor restored after a reload. */
  adoptEditorPanel(panel: vscode.WebviewPanel): void {
    if (this.editorPanel && this.editorPanel !== panel) {
      const old = this.editorPanel;
      this.releaseEditorPanel();
      old.dispose();
    }
    this.editorPanel = panel;
    panel.title = this.t('panelTitle');
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'tab-light.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'tab-dark.svg'),
    };
    panel.webview.options = { enableScripts: true, localResourceRoots: this.resourceRoots() };
    this.editorSubscriptions = [
      panel.webview.onDidReceiveMessage((message: ViewMessage) => {
        if (this.host === 'editor') void this.onMessage(message);
      }),
      panel.onDidDispose(() => this.onEditorPanelDisposed(panel)),
      panel.onDidChangeViewState(() => this.applyAllSizes()),
    ];
    this.showBoard('editor');
    this.showPlaceholder();
  }

  private releaseEditorPanel(): void {
    for (const s of this.editorSubscriptions) s.dispose();
    this.editorSubscriptions = [];
    this.editorPanel = undefined;
  }

  private onEditorPanelDisposed(panel: vscode.WebviewPanel): void {
    if (this.editorPanel !== panel) return;
    this.releaseEditorPanel();
    if (this.host !== 'editor') return;
    this.hideBoard();
    if (this.panelView) this.showBoard('panel');
  }

  /** Called by the editor when the bottom panel view is first shown (or shown again after disposal). */
  resolvePanelView(view: vscode.WebviewView): void {
    this.panelView = view;
    view.webview.options = { enableScripts: true, localResourceRoots: this.resourceRoots() };
    const subscriptions = [
      view.webview.onDidReceiveMessage((message: ViewMessage) => {
        if (this.host === 'panel' && this.panelView === view) void this.onMessage(message);
        else if (message.type === 'bringHere') this.moveToPanel();
      }),
    ];
    subscriptions.push(
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          this.applyAllSizes();
          void this.focusLayout.enter();
        } else {
          this.reclaim.hiddenAt = Date.now();
          this.settleNativeSizes();
          // Taken back at once after a prompt: grid mode and the layout around it stay as they were.
          if (this.reclaimPanel() !== 'submit') void this.focusLayout.onGridHidden();
        }
      }),
    );
    view.onDidDispose(() => {
      for (const s of subscriptions) s.dispose();
      if (this.panelView !== view) return;
      this.panelView = undefined;
      if (this.host === 'panel') this.hideBoard();
    });
    if (this.host === 'editor') this.showPlaceholder();
    else this.showBoard('panel');
    if (view.visible) void this.focusLayout.enter();
  }

  private showBoard(kind: HostKind): void {
    this.ensureRestored();
    const webview = kind === 'editor' ? this.editorPanel?.webview : this.panelView?.webview;
    if (!webview) return;
    this.host = kind;
    this.hostGeneration++;
    this.ready = false;
    this.manager.setAttached(false);
    this.focusLayout.forgetViewport();
    webview.html = renderHtml(webview, this.context.extensionUri, languageFor(vscode.env.language), kind);
    this.updateStatus();
    this.applyAllSizes();
    void this.explainMirrorsOnce();
  }

  /** Without the proposed APIs there are no mirrors: say once how to turn them on. */
  private async explainMirrorsOnce(): Promise<void> {
    if (this.mirrors?.available !== false || this.context.globalState.get<boolean>(MIRROR_NOTICE_KEY)) return;
    if (!vscode.workspace.getConfiguration('terminalGrid').get<boolean>('mirrorTerminals', true)) return;
    await this.context.globalState.update(MIRROR_NOTICE_KEY, true);
    const open = this.t('openArgv');
    const choice = await vscode.window.showInformationMessage(this.t('mirrorsOff', vscode.env.appName), open);
    if (choice !== open) return;
    try {
      await vscode.commands.executeCommand('workbench.action.configureRuntimeArguments');
    } catch {
      await vscode.env.openExternal(vscode.Uri.parse('https://github.com/vdzeer/terminal-grid#enabling-mirrors-proposed-apis'));
    }
  }

  private hideBoard(): void {
    this.host = undefined;
    this.hostGeneration++;
    this.ready = false;
    this.manager.setAttached(false);
    this.updateStatus();
    this.applyAllSizes();
    void this.save();
  }

  /** While the board is in an editor tab, the panel view offers to bring it back. */
  private showPlaceholder(): void {
    if (!this.panelView || this.host === 'panel') return;
    this.panelView.webview.html = renderPlaceholder(this.panelView.webview, languageFor(vscode.env.language), this.t);
  }

  private boardWebview(): vscode.Webview | undefined {
    if (this.host === 'editor') return this.editorPanel?.webview;
    if (this.host === 'panel') return this.panelView?.webview;
    return undefined;
  }

  private resourceRoots(): vscode.Uri[] {
    return [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media')];
  }

  private post(message: HostMessage): void {
    if (!this.ready) return;
    void this.boardWebview()?.postMessage(message);
  }

  private async sendInit(): Promise<void> {
    const generation = this.hostGeneration;
    const snapshots = await this.manager.snapshotAll();
    if (generation !== this.hostGeneration || !this.boardWebview()) {
      this.manager.release();
      return;
    }
    this.ready = true;
    this.post({
      type: 'init',
      terminals: this.visibleSessions().map((s) => s.info()),
      layout: this.layout,
      settings: this.viewSettings(),
      snapshots,
    });
    this.manager.release();
    if (this.focusAfterInit) {
      this.post({ type: 'focus', id: this.focusAfterInit });
      this.focusAfterInit = undefined;
    }
  }

  // ---- messages from the webview ----

  private async onMessage(message: ViewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        if (this.visibleSessions().length === 0) this.createSession({ cwd: this.defaultCwd(), focus: true });
        await this.sendInit();
        return;
      case 'input': {
        if (typeof message.data !== 'string') return;
        const session = this.manager.get(message.id);
        if (session?.kind === 'mirror') this.mirrors.terminalOf(message.id)?.sendText(message.data, false);
        else this.manager.write(message.id, message.data);
        if (session) this.clearAttention(session);
        // Enter sends a prompt, and some agents show the terminal in answer (see reclaim.ts).
        if (session && message.data === '\r' && this.host === 'panel' && this.panelView?.visible) {
          this.reclaim = { ...this.reclaim, submitAt: Date.now(), submitId: session.id };
        }
        return;
      }
      case 'resize': {
        const session = this.manager.get(message.id);
        if (session?.kind !== 'pty' || !Number.isInteger(message.cols) || !Number.isInteger(message.rows)) return;
        session.gridSize = { cols: message.cols, rows: message.rows };
        this.applySize(session);
        return;
      }
      case 'ack':
        this.manager.ack(message.id, message.chars);
        return;
      case 'create':
        await this.createFromView(message.placement, message.cwdFrom, message.agent);
        return;
      case 'focused': {
        this.focusedTile = message.id;
        const session = this.manager.get(message.id);
        if (session) this.clearAttention(session);
        return;
      }
      case 'close':
        await this.closeFromView(message.id);
        return;
      case 'restart':
        if (this.manager.get(message.id)?.kind === 'pty') this.manager.restart(message.id);
        return;
      case 'rename': {
        const session = this.manager.get(message.id);
        if (!session || typeof message.title !== 'string') return;
        session.customTitle = message.title.trim().slice(0, 60);
        this.post({ type: 'updated', terminal: session.info() });
        this.twins.get(session.id)?.rename(titleOf(session));
        this.saveSoon();
        return;
      }
      case 'layout':
        this.layout = sanitize(message.layout, new Set(this.manager.all().map((s) => s.id)));
        this.saveSoon();
        return;
      case 'openUrl':
        await this.openUrl(message.url);
        return;
      case 'openFile':
        await this.openFile(message.id, message.path, message.line, message.column);
        return;
      case 'drop': {
        if (!this.manager.get(message.id) || !Array.isArray(message.uris) || !Array.isArray(message.names)) return;
        const paths = await droppedPaths(message.uris, message.names, process.platform);
        if (paths.length > 0) this.post({ type: 'paste', id: message.id, text: paths.map((file) => shellQuote(file, process.platform)).join(' ') });
        return;
      }
      case 'viewport':
        if (this.host === 'panel') this.focusLayout.onViewport(message);
        return;
    }
  }

  // ---- terminals ----

  createSession(options: { cwd: string; focus: boolean; placement?: Placement; twin?: 'create' | 'none' }): Session {
    this.ensureRestored();
    const session = this.manager.create({ cwd: options.cwd });
    if ((options.twin ?? 'create') === 'create') this.createTwin(session);
    if (this.ready) this.post({ type: 'created', terminal: session.info(), placement: options.placement, focus: options.focus });
    else if (options.focus) this.focusAfterInit = session.id;
    this.updateStatus();
    this.saveSoon();
    return session;
  }

  // ---- Terminal-tab twins ----

  private makeTwin(session: Session): Twin {
    const twin = new Twin(session.id, titleOf(session), {
      screen: () => session.serialize(false),
      input: (data) => this.manager.write(session.id, data),
      resized: () => this.applySize(session),
    });
    this.twins.set(session.id, twin);
    return twin;
  }

  private createTwin(session: Session): void {
    const twin = this.makeTwin(session);
    vscode.window.createTerminal({ name: titleOf(session), pty: twin, iconPath: new vscode.ThemeIcon('layout'), isTransient: true });
  }

  /**
   * Tools give focus back with `activeTerminal.show()` (see reclaim.ts) at
   * moments the grid cannot predict, such as the start of every turn of an AI
   * agent, including turns the user did not start with Enter. The editor hands
   * every extension the same terminal object, so a twin's `show` is ours to
   * change: while the grid is on screen the twin is already in view there, and
   * the board takes focus (on the tile last used) instead of the Terminal tab.
   */
  private showTwinInGrid(terminal: vscode.Terminal): void {
    const show = terminal.show.bind(terminal);
    terminal.show = (preserveFocus?: boolean) => {
      if (this.host !== 'panel' || this.panelView?.visible !== true) return show(preserveFocus);
      if (!preserveFocus) void vscode.commands.executeCommand(`${PANEL_VIEW_ID}.focus`);
    };
  }

  /**
   * The "Terminal Grid" profile in the + menu of the Terminal tab: the editor
   * creates the Terminal-tab side itself, and the grid gets the same shell.
   */
  profileTerminal(): vscode.TerminalProfile {
    this.ensureRestored();
    const session = this.manager.create({ cwd: this.defaultCwd() });
    const twin = this.makeTwin(session);
    if (this.ready) this.post({ type: 'created', terminal: session.info(), focus: false });
    this.updateStatus();
    this.saveSoon();
    return new vscode.TerminalProfile({ name: titleOf(session), pty: twin, iconPath: new vscode.ThemeIcon('layout'), isTransient: true });
  }

  /** Takes the panel back when a tool showed a grid terminal in the Terminal tab (see reclaim.ts). */
  private reclaimPanel(): 'tabChange' | 'submit' | undefined {
    if (this.host !== 'panel') return undefined;
    const active = vscode.window.activeTerminal;
    const id = active ? this.sessionIdOf(active) : undefined;
    const state = { ...this.reclaim, ownHideAt: this.focusLayout.closedPanelAt };
    const cause = reclaimCause(state, this.panelView?.visible === true, id !== undefined);
    if (!cause) return undefined;
    let focusId = id;
    if (cause === 'submit') {
      // Back to the tile the prompt was typed in, which need not be the active terminal.
      if (this.reclaim.submitId && this.manager.get(this.reclaim.submitId)) focusId = this.reclaim.submitId;
      this.reclaim.submitAt = undefined;
    } else {
      this.reclaim.reclaims += 1;
      this.focusLayout.holdLayout(RECLAIM_WINDOW_MS);
    }
    void vscode.commands.executeCommand(`${PANEL_VIEW_ID}.focus`).then(() => {
      if (focusId && this.ready) this.post({ type: 'focus', id: focusId });
    });
    return cause;
  }

  /** The grid tile that shows this terminal: a grid shell's twin, or a mirror that is not hidden. */
  private sessionIdOf(terminal: vscode.Terminal): string | undefined {
    const options = terminal.creationOptions;
    if ('pty' in options) {
      for (const [id, twin] of this.twins) if (twin === options.pty) return id;
    }
    const mirror = this.mirrors.all().find(([candidate]) => candidate === terminal)?.[1];
    return mirror && !this.hidden.has(mirror) ? mirror : undefined;
  }

  private isTwin(terminal: vscode.Terminal): boolean {
    const options = terminal.creationOptions;
    if (!('pty' in options)) return false;
    for (const twin of this.twins.values()) if (twin === options.pty) return true;
    return false;
  }

  private gridVisible(): boolean {
    if (this.host === 'panel') return this.panelView?.visible === true;
    if (this.host === 'editor') return this.editorPanel?.visible === true;
    return false;
  }

  /**
   * One shell, two views, one size: the grid tile while the grid is on screen,
   * the Terminal tab otherwise. Programs redraw when the size changes.
   */
  private applySize(session: Session): void {
    if (session.kind !== 'pty') return;
    const visible = this.gridVisible();
    if (!visible && this.nativeSettleTimer) return;
    const native = this.twins.get(session.id)?.nativeSize;
    const size = visible ? (session.gridSize ?? native) : (native ?? session.gridSize);
    if (size) this.manager.resize(session.id, size.cols, size.rows);
  }

  private applyAllSizes(): void {
    for (const session of this.manager.all()) this.applySize(session);
  }

  /**
   * Right after the grid hides, the Terminal tab is still laying itself out:
   * its size passes through a few values (one only about 11 columns wide), and
   * a twin's last known size may be long out of date. Programs redraw on every
   * resize, so the shells wait for the layout to settle, and a grid that is
   * taken straight back never resizes them at all.
   */
  private settleNativeSizes(): void {
    if (this.nativeSettleTimer) clearTimeout(this.nativeSettleTimer);
    this.nativeSettleTimer = setTimeout(() => {
      this.nativeSettleTimer = undefined;
      this.applyAllSizes();
    }, NATIVE_SETTLE_MS);
  }

  // ---- mirrors ----

  private visibleSessions(): Session[] {
    return this.manager.all().filter((s) => !this.hidden.has(s.id));
  }

  private onMirrorAdded(terminal: vscode.Terminal, id: string): void {
    if (!vscode.workspace.getConfiguration('terminalGrid').get<boolean>('mirrorTerminals', true)) return;
    let dims: vscode.TerminalDimensions | undefined;
    try {
      dims = terminal.dimensions;
    } catch {
      dims = undefined;
    }
    const session = this.manager.createMirror({
      id,
      name: terminal.name,
      cwd: mirrorCwd(terminal),
      cols: dims?.columns ?? 80,
      rows: dims?.rows ?? 24,
    });
    if (this.ready) this.post({ type: 'created', terminal: session.info(), focus: false });
    this.updateStatus();
  }

  private pollMirrors(): void {
    for (const [terminal, id] of this.mirrors?.all() ?? []) {
      const session = this.manager.get(id);
      if (!session) continue;
      const cwd = mirrorCwd(terminal);
      if (terminal.name !== session.processName || (cwd && cwd !== session.cwd)) {
        session.processName = terminal.name;
        if (cwd) session.cwd = cwd;
        if (!this.hidden.has(id)) this.post({ type: 'updated', terminal: session.info() });
      }
    }
  }

  /** Brings back the mirror tiles the user closed. */
  async showHidden(): Promise<void> {
    if (this.hidden.size === 0) return;
    this.hidden.clear();
    void vscode.commands.executeCommand('setContext', 'terminalGrid.hasHidden', false);
    this.updateStatus();
    void this.open();
    if (this.boardWebview()) await this.sendInit();
  }

  private async createFromView(placement: Placement | undefined, cwdFrom: string | undefined, agent: 'plain' | 'worktree' | undefined): Promise<void> {
    let cwd = this.defaultCwd();
    const source = cwdFrom ? this.manager.get(cwdFrom) : undefined;
    if (source) {
      await this.manager.refreshCwd([source.id]);
      cwd = source.cwd;
    }
    const session = this.createSession({ cwd, focus: true, placement });
    if (agent === 'plain' || agent === 'worktree') this.startAgent(session, agent);
  }

  /** A new grid shell that starts the configured agent (`terminalGrid.agentCommand`). */
  newAgent(mode: 'plain' | 'worktree'): void {
    void this.open();
    this.startAgent(this.createSession({ cwd: this.defaultCwd(), focus: true }), mode);
  }

  private startAgent(session: Session, mode: 'plain' | 'worktree'): void {
    const command = vscode.workspace.getConfiguration('terminalGrid').get<string>('agentCommand', 'claude').trim();
    if (!command) return;
    this.manager.typeWhenReady(session.id, `${command}${mode === 'worktree' ? ' --worktree' : ''}\r`);
  }

  // ---- what the programs in the tiles are doing ----

  /** The user sees this tile now: the grid is on screen, the tile has the focus and the window too. */
  private looking(id: string): boolean {
    return this.gridVisible() && this.focusedTile === id && vscode.window.state.focused;
  }

  private onActivity(session: Session, kind: 'working' | 'idle' | 'bell'): void {
    if (kind === 'working') session.attention = false;
    else if (!this.looking(session.id) && !this.hidden.has(session.id)) {
      session.attention = true;
      session.attentionAt = Date.now();
    }
    this.post({ type: 'updated', terminal: session.info() });
    this.updateStatus();
  }

  private clearAttention(session: Session): void {
    if (!session.attention) return;
    session.attention = false;
    this.post({ type: 'updated', terminal: session.info() });
    this.updateStatus();
  }

  /** Shows the grid and focuses the terminal that has waited for the user the longest. */
  async focusAttention(): Promise<void> {
    const next = this.visibleSessions()
      .filter((s) => s.attention)
      .sort((a, b) => a.attentionAt - b.attentionAt)[0];
    await this.open();
    if (!next) return;
    if (this.ready) this.post({ type: 'focus', id: next.id });
    else this.focusAfterInit = next.id;
  }

  private async closeFromView(id: string): Promise<void> {
    const session = this.manager.get(id);
    if (!session) return;
    if (session.kind === 'mirror') {
      this.hideMirror(id);
      return;
    }
    if (session.busy) {
      const button = this.t('confirmCloseButton');
      const choice = await vscode.window.showWarningMessage(this.t('confirmClose', session.pty?.process ?? ''), { modal: true }, button);
      if (choice !== button) return;
    }
    this.removeSession(id);
  }

  /** Closing a mirror tile only hides it: the grid never ends a terminal it did not start. */
  private hideMirror(id: string): void {
    this.hidden.add(id);
    void vscode.commands.executeCommand('setContext', 'terminalGrid.hasHidden', true);
    this.layout = remove(this.layout, id);
    this.post({ type: 'removed', id });
    this.updateStatus();
  }

  private removeSession(id: string): void {
    const twin = this.twins.get(id);
    this.twins.delete(id);
    twin?.dispose();
    this.hidden.delete(id);
    this.manager.close(id);
    this.layout = remove(this.layout, id);
    this.post({ type: 'removed', id });
    this.updateStatus();
    this.saveSoon();
  }

  private onExited(session: Session): void {
    // `exit` in a shell closes the tile; a failure stays visible with its code.
    if (session.exitCode === 0) this.removeSession(session.id);
    else this.post({ type: 'updated', terminal: session.info() });
  }

  /** Ends every grid shell and hides every mirror tile, the same as closing each tile. */
  async killAll(): Promise<void> {
    const sessions = this.visibleSessions();
    const shells = sessions.filter((s) => s.kind === 'pty').length;
    if (shells > 0) {
      const button = this.t('killAllButton');
      const message = shells < sessions.length ? this.t('confirmKillAllMirrors') : this.t('confirmKillAll');
      const choice = await vscode.window.showWarningMessage(message, { modal: true }, button);
      if (choice !== button) return;
    }
    this.closeAll();
  }

  private closeAll(): void {
    for (const session of this.visibleSessions()) {
      if (session.kind === 'mirror') this.hideMirror(session.id);
      else this.removeSession(session.id);
    }
  }

  arrange(): void {
    void this.open();
    this.post({ type: 'arrange' });
  }

  defaultCwd(): string {
    const active = vscode.window.activeTextEditor?.document.uri;
    const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.scheme === 'file' ? folder.uri.fsPath : os.homedir();
  }

  private shellConfig(): ShellConfig {
    const config = vscode.workspace.getConfiguration('terminalGrid');
    const shell = resolveShell(config.get<string>('shell', ''), vscode.env.shell, process.env.SHELL, process.platform);
    const configuredArgs = config.get<unknown>('shellArgs', null);
    const args = Array.isArray(configuredArgs)
      ? configuredArgs.filter((a): a is string => typeof a === 'string')
      : defaultShellArgs(shell, process.platform);
    const platformKey = process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'windows' : 'linux';
    const overrides = vscode.workspace.getConfiguration('terminal.integrated').get<Record<string, string | null>>(`env.${platformKey}`) ?? {};
    const env = buildEnv(process.env, {
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      appVersion: vscode.version,
      overrides,
    });
    if (vscode.workspace.getConfiguration('terminal.integrated').get<boolean>('shellIntegration.enabled', true)) {
      if (this.zdotdir === undefined) {
        const dir = runtimeDir();
        this.zdotdir = (dir && prepareZdotdir(vscode.env.appRoot, dir)) ?? null;
      }
      const launch = withShellIntegration(shell, args, env, vscode.env.appRoot, this.zdotdir ?? undefined);
      if (launch) return { shell, ...launch };
    }
    return { shell, args, env };
  }

  private viewSettings(): ViewSettings {
    const terminal = vscode.workspace.getConfiguration('terminal.integrated');
    const editor = vscode.workspace.getConfiguration('editor');
    const cursor = terminal.get<string>('cursorStyle', 'block');
    return {
      language: languageFor(vscode.env.language),
      fontFamily: terminal.get<string>('fontFamily') || editor.get<string>('fontFamily') || 'Menlo, Monaco, "Courier New", monospace',
      fontSize: terminal.get<number>('fontSize') || editor.get<number>('fontSize') || 12,
      lineHeight: terminal.get<number>('lineHeight') || 1,
      letterSpacing: terminal.get<number>('letterSpacing') ?? 0,
      cursorStyle: cursor === 'line' ? 'bar' : cursor === 'underline' ? 'underline' : 'block',
      cursorBlink: terminal.get<boolean>('cursorBlinking', false),
      scrollback: Math.min(100_000, Math.max(100, terminal.get<number>('scrollback') ?? 1000)),
      macOptionIsMeta: terminal.get<boolean>('macOptionIsMeta', false),
      minimumContrastRatio: terminal.get<number>('minimumContrastRatio') ?? 4.5,
      drawBoldTextInBrightColors: terminal.get<boolean>('drawBoldTextInBrightColors', true),
      gpu: terminal.get<string>('gpuAcceleration', 'auto') !== 'off',
      shiftEnter: vscode.workspace.getConfiguration('terminalGrid').get<string>('shiftEnterSequence', '\x1b\r'),
      platform: process.platform,
    };
  }

  // ---- links ----

  private async openUrl(url: string): Promise<void> {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(url, true);
    } catch {
      return;
    }
    if (['http', 'https', 'mailto'].includes(uri.scheme)) await vscode.env.openExternal(uri);
  }

  private async openFile(id: string, raw: string, line?: number, column?: number): Promise<void> {
    if (typeof raw !== 'string' || !raw) return;
    const session = this.manager.get(id);
    if (session) await this.manager.refreshCwd([id]);
    const expanded = raw.replace(/^~(?=\/|$)/, os.homedir());
    const bases = [session?.cwd, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)].filter((b): b is string => !!b);
    const candidates = path.isAbsolute(expanded) ? [expanded] : bases.map((base) => path.resolve(base, expanded));
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate);
        const uri = vscode.Uri.file(candidate);
        if (info.isDirectory()) {
          await vscode.commands.executeCommand('revealInExplorer', uri);
          return;
        }
        if (info.isFile()) {
          const position = new vscode.Position(Math.max(0, (line ?? 1) - 1), Math.max(0, (column ?? 1) - 1));
          await vscode.window.showTextDocument(uri, {
            selection: new vscode.Range(position, position),
            preview: false,
            viewColumn: this.fileColumn(),
          });
          return;
        }
      } catch {
        // Try the next base folder.
      }
    }
    void vscode.window.showInformationMessage(this.t('fileNotFound', raw));
  }

  /** Files open next to the grid, never on top of it. */
  private fileColumn(): vscode.ViewColumn {
    if (this.host !== 'editor') return vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active;
    const own = this.editorPanel?.viewColumn;
    const other = vscode.window.tabGroups.all.find((g) => g.viewColumn !== own);
    return other?.viewColumn ?? vscode.ViewColumn.Beside;
  }

  // ---- persistence ----

  private ensureRestored(): void {
    if (this.restored) return;
    this.restored = true;
    // Shells the pty host kept through the reload are taken back as they are, still running.
    const survivors = this.backend.takeSurvivors();
    const state = vscode.workspace.getConfiguration('terminalGrid').get<boolean>('restoreSessions', true)
      ? readState(this.context.workspaceState.get(STATE_KEY))
      : undefined;
    const note = `\r\n${RESET_MODES}\x1b[2m${this.t('historyRestored')}: ${new Date().toLocaleString()}\x1b[0m\r\n`;
    for (const stored of state?.terminals ?? []) {
      const survivor = survivors.get(stored.id);
      survivors.delete(stored.id);
      const session = survivor
        ? this.manager.adopt({ id: stored.id, cwd: stored.cwd, customTitle: stored.customTitle, survivor })
        : this.manager.create({
            id: stored.id,
            cwd: stored.cwd || this.defaultCwd(),
            customTitle: stored.customTitle,
            history: stored.snapshot ? stored.snapshot + note : undefined,
            cols: stored.cols,
            rows: stored.rows,
          });
      this.createTwin(session);
    }
    // Started too shortly before the reload to be saved, or saved with restoring turned off.
    for (const [id, survivor] of survivors) this.createTwin(this.manager.adopt({ id, cwd: '', survivor }));
    this.layout = sanitize(state?.layout ?? null, new Set(this.manager.all().map((s) => s.id)));
    this.updateStatus();
  }

  private saveSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), 1000);
  }

  private save(): Thenable<void> {
    if (!this.restored) return Promise.resolve();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const previous = new Map((readState(this.context.workspaceState.get(STATE_KEY))?.terminals ?? []).map((t) => [t.id, t.snapshot]));
    // Screens can hold secrets; with restoring turned off they are not written to disk at all.
    const keepScreens = vscode.workspace.getConfiguration('terminalGrid').get<boolean>('restoreSessions', true);
    const terminals: StoredTerminal[] = this.manager.all().filter((session) => session.kind === 'pty').map((session) => {
      if (!keepScreens) {
        session.dirty = false;
        return { id: session.id, cwd: session.cwd, customTitle: session.customTitle, snapshot: '', cols: session.cols, rows: session.rows };
      }
      let snapshot = previous.get(session.id);
      if (session.dirty || snapshot === undefined) {
        snapshot = session.serialize(true);
        session.dirty = false;
      }
      return { id: session.id, cwd: session.cwd, customTitle: session.customTitle, snapshot, cols: session.cols, rows: session.rows };
    });
    return this.context.workspaceState.update(STATE_KEY, { version: 1, layout: this.layout, terminals });
  }

  private updateStatus(): void {
    const sessions = this.visibleSessions();
    if (sessions.length === 0) {
      this.status.hide();
      return;
    }
    const waiting = sessions.filter((s) => s.attention).length;
    this.status.text = waiting ? `$(layout) ${sessions.length}  $(bell-dot) ${waiting}` : `$(layout) ${sessions.length}`;
    this.status.tooltip = this.t('statusTooltip', sessions.length) + (waiting ? `\n${this.t('statusWaitingCount', waiting)}` : '');
    // With someone waiting, the click goes straight to them.
    this.status.command = waiting ? 'terminalGrid.focusAttention' : 'terminalGrid.open';
    this.status.show();
  }

  /** Read-only view for the integration test; only returned outside production. */
  testApi() {
    return {
      terminals: () => this.manager.all().map((s) => ({ ...s.info(), cols: s.cols, rows: s.rows, pid: s.pty?.pid })),
      write: (id: string, data: string) => this.manager.write(id, data),
      screen: (id: string) => this.manager.get(id)?.serialize(false) ?? '',
      layout: () => this.layout,
      ready: () => this.ready,
      host: () => this.host,
      gridMode: () => this.focusLayout.isActive,
      panelVisible: () => this.panelView?.visible === true,
      reclaimState: () => ({ ...this.reclaim, ownHideAt: this.focusLayout.closedPanelAt, active: vscode.window.activeTerminal?.name, tabs: this.lastTabEvent }),
      twinTerminals: () => vscode.window.terminals.filter((t) => this.isTwin(t)).length,
      twinTerminal: (id: string) => vscode.window.terminals.find((t) => 'pty' in t.creationOptions && t.creationOptions.pty === this.twins.get(id)),
      /** Same routing as typing in a tile. */
      input: (id: string, data: string) => this.onMessage({ type: 'input', id, data }),
      /** As if the tile got the keyboard focus. */
      focused: (id: string) => this.onMessage({ type: 'focused', id }),
      close: (id: string) => this.onMessage({ type: 'close', id }),
      /** "Close All Terminals" after its confirmation. */
      closeAll: () => this.closeAll(),
      hidden: () => [...this.hidden],
      showHidden: () => this.showHidden(),
      mirrorsAvailable: () => this.mirrors.available,
      viewport: () => this.focusLayout.lastViewport,
      /** Saves, stops every shell and restores from the saved state, like a window reload. */
      /** Whether grid shells run in the pty host and outlive a reload. */
      persistent: () => this.backend.persistent,
      /**
       * Saves, lets go of every shell and takes them back like the window
       * after a reload: from the pty host when it runs them, otherwise from
       * the saved state with new shells.
       */
      simulateReload: async () => {
        await this.save();
        for (const session of this.manager.all()) if (session.kind === 'pty') this.removeSessionKeepState(session.id);
        await this.backend.reconnect();
        this.restored = false;
        this.layout = null;
        this.ensureRestored();
        if (this.boardWebview()) await this.sendInit();
      },
    };
  }

  /** Saves the final state, then stops every shell. */
  async shutdown(): Promise<void> {
    clearInterval(this.snapshotTimer);
    try {
      await this.save();
    } finally {
      this.manager.dispose();
    }
  }

  /** Test helper: lets go of a shell and its twin without touching the saved state. */
  private removeSessionKeepState(id: string): void {
    const twin = this.twins.get(id);
    this.twins.delete(id);
    twin?.dispose();
    this.manager.detach(id);
  }

  dispose(): void {
    clearInterval(this.snapshotTimer);
    clearInterval(this.mirrorPollTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.nativeSettleTimer) clearTimeout(this.nativeSettleTimer);
    for (const s of this.editorSubscriptions) s.dispose();
    for (const s of this.subscriptions) s.dispose();
    this.manager.dispose();
  }
}

function titleOf(session: Session): string {
  return session.customTitle || session.title || session.processName || 'shell';
}

function mirrorCwd(terminal: vscode.Terminal): string {
  const fromShell = terminal.shellIntegration?.cwd;
  if (fromShell?.scheme === 'file') return fromShell.fsPath;
  const options = terminal.creationOptions;
  const cwd = 'cwd' in options ? options.cwd : undefined;
  if (typeof cwd === 'string') return cwd;
  if (cwd?.scheme === 'file') return cwd.fsPath;
  return '';
}
