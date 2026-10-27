import * as vscode from 'vscode';
import { languageFor, translator, type Translate } from '../shared/i18n';
import { BoardController, PANEL_VIEW_ID, VIEW_TYPE } from './controller';
import { resolveShell } from './env';
import { renderNotice } from './html';
import { loadNodePty, type NodePty } from './nodePty';
import { LEGACY_PROFILE_KEY, PROFILE_ASKED_KEY, PROFILE_NAME, platformKey, shouldOfferDefaultProfile } from './profile';
import { launchPtyHost, localBackend, ptyHostSocket, PtyHostClient, type PtyBackend } from './ptyHostClient';
import { runtimeDir } from './runtimeDir';

let controller: BoardController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<ReturnType<BoardController['testApi']> | undefined> {
  const t = translator(languageFor(vscode.env.language));
  let nodePty: NodePty;
  try {
    nodePty = loadNodePty(vscode.env.appRoot);
  } catch (error) {
    activateWithoutPty(context, t('ptyMissing', vscode.env.appName, error instanceof Error ? error.message : String(error)));
    return undefined;
  }
  // Everything is registered at once; the board waits for the pty host behind it (see openBackend).
  const board = openBackend(context, nodePty).then((backend) => {
    const ready = new BoardController(context, backend);
    controller = ready;
    context.subscriptions.push(ready);
    return ready;
  });
  const on =
    <A extends unknown[], R>(run: (ready: BoardController, ...args: A) => R) =>
    async (...args: A): Promise<Awaited<R>> =>
      await run(await board, ...args);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      PANEL_VIEW_ID,
      { resolveWebviewView: on((ready, view: vscode.WebviewView) => ready.resolvePanelView(view)) },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: on((ready, panel: vscode.WebviewPanel) => ready.adoptEditorPanel(panel)),
    }),
    vscode.commands.registerCommand('terminalGrid.open', on((ready) => ready.open())),
    vscode.commands.registerCommand('terminalGrid.toggle', on((ready) => ready.toggle())),
    vscode.commands.registerCommand('terminalGrid.showHidden', on((ready) => ready.showHidden())),
    // "Terminal Grid" in the + menu of the Terminal tab (and the default
    // profile): a terminal that shows in the Terminal tab and in the grid.
    vscode.window.registerTerminalProfileProvider('terminalGrid.profile', {
      provideTerminalProfile: on((ready) => ready.profileTerminal()),
    }),
    vscode.commands.registerCommand('terminalGrid.openInEditor', on((ready) => ready.openInEditor())),
    vscode.commands.registerCommand('terminalGrid.moveToPanel', on((ready) => ready.moveToPanel())),
    // Not in the manifest: for other extensions, which pass a process id.
    vscode.commands.registerCommand('terminalGrid.revealProcess', on((ready, pid: unknown) => ready.revealProcess(pid))),
    vscode.commands.registerCommand(
      'terminalGrid.newTerminal',
      on((ready) => {
        void ready.open();
        ready.createSession({ cwd: ready.defaultCwd(), focus: true });
      }),
    ),
    vscode.commands.registerCommand('terminalGrid.newAgent', on((ready) => ready.newAgent('plain'))),
    vscode.commands.registerCommand('terminalGrid.newAgentWorktree', on((ready) => ready.newAgent('worktree'))),
    vscode.commands.registerCommand('terminalGrid.focusAttention', on((ready) => ready.focusAttention())),
    vscode.commands.registerCommand('terminalGrid.arrange', on((ready) => ready.arrange())),
    vscode.commands.registerCommand('terminalGrid.killAll', on((ready) => ready.killAll())),
    vscode.commands.registerCommand(
      'terminalGrid.openFolder',
      on((ready, uri?: vscode.Uri) => {
        void ready.open();
        ready.createSession({ cwd: uri?.scheme === 'file' ? uri.fsPath : ready.defaultCwd(), focus: true });
      }),
    ),
    vscode.commands.registerCommand('terminalGrid.makeDefaultProfile', () => makeDefaultProfile(t)),
  );
  void offerDefaultProfile(context, t);
  const ready = await board;
  return context.extensionMode === vscode.ExtensionMode.Production ? undefined : ready.testApi();
}

/**
 * Grid shells run in the workspace's pty host, so a window reload does not
 * end them. Without a workspace (no stable name to find the host again), on
 * Windows, or when the host does not start, they run in the extension host.
 */
async function openBackend(context: vscode.ExtensionContext, nodePty: NodePty): Promise<PtyBackend> {
  const dir = runtimeDir();
  const workspace = context.storageUri?.fsPath;
  if (dir && workspace) {
    const socket = ptyHostSocket(dir, workspace);
    const script = vscode.Uri.joinPath(context.extensionUri, 'dist', 'ptyHost.js').fsPath;
    const host = await PtyHostClient.open(socket, () => launchPtyHost(script, socket, vscode.env.appRoot));
    if (host) return host;
  }
  return localBackend(nodePty);
}

export async function deactivate(): Promise<void> {
  await controller?.shutdown();
  controller = undefined;
}

const COMMANDS = [
  'terminalGrid.open',
  'terminalGrid.toggle',
  'terminalGrid.showHidden',
  'terminalGrid.openInEditor',
  'terminalGrid.moveToPanel',
  'terminalGrid.newTerminal',
  'terminalGrid.newAgent',
  'terminalGrid.newAgentWorktree',
  'terminalGrid.focusAttention',
  'terminalGrid.arrange',
  'terminalGrid.killAll',
  'terminalGrid.openFolder',
  'terminalGrid.makeDefaultProfile',
];

/**
 * node-pty could not be loaded, so there are no grid shells. Everything the
 * manifest contributes still answers with the reason instead of failing, and
 * a default profile set to "Terminal Grid" opens a plain shell.
 */
function activateWithoutPty(context: vscode.ExtensionContext, message: string): void {
  const language = languageFor(vscode.env.language);
  const show = () => void vscode.window.showErrorMessage(message);
  show();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PANEL_VIEW_ID, {
      resolveWebviewView: (view) => {
        view.webview.html = renderNotice(view.webview, language, message);
      },
    }),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => {
        panel.webview.html = renderNotice(panel.webview, language, message);
      },
    }),
    vscode.window.registerTerminalProfileProvider('terminalGrid.profile', {
      provideTerminalProfile: () =>
        new vscode.TerminalProfile({ shellPath: resolveShell('', vscode.env.shell, process.env.SHELL, process.platform) }),
    }),
    ...COMMANDS.map((command) => vscode.commands.registerCommand(command, show)),
  );
}

function defaultProfileSetting(): string | undefined {
  return vscode.workspace.getConfiguration('terminal.integrated').inspect<string>(`defaultProfile.${platformKey(process.platform)}`)?.globalValue;
}

/**
 * Asks once whether "Terminal Grid" should be the default terminal profile.
 * Nothing changes without a yes; the command does the same later.
 */
async function offerDefaultProfile(context: vscode.ExtensionContext, t: Translate): Promise<void> {
  if (context.extensionMode !== vscode.ExtensionMode.Production || context.globalState.get<boolean>(PROFILE_ASKED_KEY)) return;
  // Remembered before the answer: a dismissed question counts as "not now", not as a question for every start.
  await context.globalState.update(PROFILE_ASKED_KEY, true);
  const legacy = context.globalState.get<boolean>(LEGACY_PROFILE_KEY) === true;
  if (!shouldOfferDefaultProfile({ legacy, current: defaultProfileSetting() })) return;
  const make = t('makeDefault');
  const choice = await vscode.window.showInformationMessage(t('askDefaultProfile'), make, t('notNow'));
  if (choice === make) await makeDefaultProfile(t);
}

async function makeDefaultProfile(t: Translate): Promise<void> {
  await vscode.workspace
    .getConfiguration('terminal.integrated')
    .update(`defaultProfile.${platformKey(process.platform)}`, PROFILE_NAME, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(t('defaultProfileDone'));
}
