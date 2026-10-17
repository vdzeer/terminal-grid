import * as vscode from 'vscode';
import { languageFor, translator, type Translate } from '../shared/i18n';
import { BoardController, PANEL_VIEW_ID, VIEW_TYPE } from './controller';
import { resolveShell } from './env';
import { renderNotice } from './html';
import { loadNodePty, type NodePty } from './nodePty';
import { LEGACY_PROFILE_KEY, PROFILE_ASKED_KEY, PROFILE_NAME, platformKey, shouldOfferDefaultProfile } from './profile';

let controller: BoardController | undefined;

export function activate(context: vscode.ExtensionContext): ReturnType<BoardController['testApi']> | undefined {
  const t = translator(languageFor(vscode.env.language));
  let nodePty: NodePty;
  try {
    nodePty = loadNodePty(vscode.env.appRoot);
  } catch (error) {
    activateWithoutPty(context, t('ptyMissing', vscode.env.appName, error instanceof Error ? error.message : String(error)));
    return undefined;
  }
  const ready = new BoardController(context, nodePty);
  controller = ready;
  context.subscriptions.push(
    ready,
    vscode.window.registerWebviewViewProvider(
      PANEL_VIEW_ID,
      { resolveWebviewView: (view) => ready.resolvePanelView(view) },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => ready.adoptEditorPanel(panel),
    }),
    vscode.commands.registerCommand('terminalGrid.open', () => ready.open()),
    vscode.commands.registerCommand('terminalGrid.toggle', () => ready.toggle()),
    vscode.commands.registerCommand('terminalGrid.showHidden', () => ready.showHidden()),
    // "Terminal Grid" in the + menu of the Terminal tab (and the default
    // profile): a terminal that shows in the Terminal tab and in the grid.
    vscode.window.registerTerminalProfileProvider('terminalGrid.profile', {
      provideTerminalProfile: () => ready.profileTerminal(),
    }),
    vscode.commands.registerCommand('terminalGrid.openInEditor', () => ready.openInEditor()),
    vscode.commands.registerCommand('terminalGrid.moveToPanel', () => ready.moveToPanel()),
    // Not in the manifest: for other extensions, which pass a process id.
    vscode.commands.registerCommand('terminalGrid.revealProcess', (pid: unknown) => ready.revealProcess(pid)),
    vscode.commands.registerCommand('terminalGrid.newTerminal', () => {
      void ready.open();
      ready.createSession({ cwd: ready.defaultCwd(), focus: true });
    }),
    vscode.commands.registerCommand('terminalGrid.arrange', () => ready.arrange()),
    vscode.commands.registerCommand('terminalGrid.killAll', () => ready.killAll()),
    vscode.commands.registerCommand('terminalGrid.openFolder', (uri?: vscode.Uri) => {
      void ready.open();
      ready.createSession({ cwd: uri?.scheme === 'file' ? uri.fsPath : ready.defaultCwd(), focus: true });
    }),
    vscode.commands.registerCommand('terminalGrid.makeDefaultProfile', () => makeDefaultProfile(t)),
  );
  void offerDefaultProfile(context, t);
  return context.extensionMode === vscode.ExtensionMode.Production ? undefined : ready.testApi();
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
