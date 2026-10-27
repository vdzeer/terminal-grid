// Runs inside a throwaway editor instance (see dev/run-integration.sh):
// opens the grid, runs commands in real shells, then simulates a window
// reload and checks that the terminals come back. With TG_EXPECT_MIRRORS=0
// the editor runs without the proposed APIs: no mirrors, everything else works.
const vscode = require('vscode');
const fs = require('fs');

const OUT = process.env.TG_OUT;
const HOLD = Number(process.env.TG_HOLD_MS || 0);
const EXPECT_MIRRORS = process.env.TG_EXPECT_MIRRORS !== '0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => fs.appendFileSync(OUT, `${line}\n`);

async function until(what, fn, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`timed out: ${what}`);
}

function check(name, ok, detail = '') {
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
}

async function hold() {
  if (!HOLD) return;
  log(`HOLD ${HOLD}`);
  await sleep(HOLD);
}

const find = (api, id) => api.terminals().find((t) => t.id === id);
// Grid shells only: the editor may have terminals of its own, which show up as mirrors.
const ptys = (api) => api.terminals().filter((t) => t.kind === 'pty');

async function run() {
  const api = await vscode.extensions.getExtension(process.env.TG_EXTENSION_ID || 'vdzeer.terminal-grid').activate();
  check('extension activates with node-pty', !!api);
  if (!api) return;

  await vscode.commands.executeCommand('terminalGrid.open');
  await until('webview ready', () => api.ready());
  check('board opens in the bottom panel', api.host() === 'panel');
  await until('grid mode', () => api.gridMode(), 10000).catch((error) => {
    log(`DIAG host=${api.host()} ready=${api.ready()} panelVisible=${api.panelVisible()} viewport=${JSON.stringify(api.viewport())} terminals=${vscode.window.terminals.map((t) => t.name).join('|')}`);
    throw error;
  });
  const vp = api.viewport();
  // A window off screen reports its own size as 0, so judge by the panel height alone.
  check('grid mode maximizes the panel', vp && vp.height > 450, vp && `${vp.width}x${vp.height} of ${vp.outerWidth}x${vp.outerHeight}`);
  await hold();
  const notes = vscode.Uri.file(require('path').join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'notes.md'));
  await vscode.window.showTextDocument(notes);
  await until('editor back', () => !api.gridMode() && !api.panelVisible(), 8000);
  check('opening a file brings the editor back and hides the grid', true);
  await vscode.commands.executeCommand('terminalGrid.open');
  await until('grid mode again', () => api.gridMode() && api.panelVisible(), 10000);
  check('opening the grid again fills the window', true);
  if (ptys(api).length === 0) await vscode.commands.executeCommand('terminalGrid.newTerminal');
  const [first] = await until('first terminal', () => (ptys(api).length ? ptys(api) : null));
  check('a terminal is created on open', !!first, `${first.process} in ${first.cwd}`);
  await until('twin', () => api.twinTerminal(first.id), 5000);
  check('it also shows in the Terminal tab', api.twinTerminals() === 1);

  await until('prompt', () => api.screen(first.id).length > 0, 10000);
  api.write(first.id, 'echo TG_OK_$((6*7))\r');
  await until('echo output', () => api.screen(first.id).includes('TG_OK_42'));
  check('shell runs commands', true);
  const size = find(api, first.id);
  check('terminal was resized by the webview', size.cols !== 80 || size.rows !== 24, `${size.cols}x${size.rows}`);

  // Shell integration: the editor's own scripts run in grid shells.
  api.write(first.id, 'echo TG_SI_$VSCODE_SHELL_INTEGRATION\r');
  await until('shell integration check', () => api.screen(first.id).includes('TG_SI_1'), 8000).catch(() => null);
  check('grid shells start with shell integration', api.screen(first.id).includes('TG_SI_1'), (api.screen(first.id).match(/TG_SI_\S*/g) || []).join(' '));

  api.write(first.id, 'cd /tmp\r');
  const cwd = await until('cwd update', () => (find(api, first.id).cwd.endsWith('/tmp') ? find(api, first.id).cwd : null));
  check('cwd follows cd', true, cwd);

  api.write(first.id, 'sleep 4\r');
  await until('process name', () => find(api, first.id).process === 'sleep');
  check('title follows the foreground process', true);
  await until('back to the shell', () => find(api, first.id).process === 'zsh', 10000);
  check('title returns to the shell name', true);

  await vscode.commands.executeCommand('terminalGrid.newTerminal');
  await until('second terminal', () => ptys(api).length === 2);
  await vscode.commands.executeCommand('terminalGrid.newTerminal');
  await until('third terminal', () => ptys(api).length === 3);
  await vscode.commands.executeCommand('terminalGrid.arrange');
  await sleep(1500);
  const layout = JSON.stringify(api.layout());
  check('layout holds all grid shells', ptys(api).every((t) => layout.includes(t.id)), layout);

  const second = ptys(api)[1];
  api.write(second.id, 'printf "\\033[1;32mgreen\\033[0m TG_SECOND\\n"\r');
  await until('second output', () => api.screen(second.id).includes('TG_SECOND'));
  check('second terminal runs commands', true);
  api.write(second.id, 'ls -laG\r');
  await hold();

  await vscode.commands.executeCommand('terminalGrid.openInEditor');
  await until('board in the editor tab', () => api.host() === 'editor' && api.ready());
  check('board moves to an editor tab', true);
  api.write(second.id, 'echo TG_IN_EDITOR\r');
  await until('output in editor tab', () => api.screen(second.id).includes('TG_IN_EDITOR'));
  check('terminals keep working in the editor tab', ptys(api).length === 3);
  await hold();
  await vscode.commands.executeCommand('terminalGrid.moveToPanel');
  await until('board back in the panel', () => api.host() === 'panel' && api.ready());
  check('board moves back to the bottom panel', ptys(api).length === 3);
  await until('grid mode after moving back', () => api.gridMode(), 8000).catch(() => null);
  check('grid mode is on again after moving back', api.gridMode());
  check('layout survives the moves', JSON.stringify(api.layout()) === layout, JSON.stringify(api.layout()));

  // Test runs keep workspace storage in memory, so a real restart would lose
  // it; the reload is simulated inside this window instead. With the pty host
  // the shells keep running through it, and what they print meanwhile shows.
  const persistent = api.persistent();
  check('grid shells run in the pty host', persistent);
  const before = ptys(api).map((t) => t.id).join(',');
  const pidBefore = find(api, first.id).pid;
  api.write(first.id, '(sleep 1; echo TG_DURING_$((3+4))) &\r');
  await sleep(300);
  await api.simulateReload();
  const terminals = await until('restored terminals', () => (ptys(api).length >= 3 ? ptys(api) : null));
  check('same terminals after reload', terminals.map((t) => t.id).join(',') === before, terminals.map((t) => `${t.process}@${t.cwd}`).join(', '));
  const restored = find(api, first.id);
  check('first terminal restored in /tmp', restored.cwd.endsWith('/tmp'), restored.cwd);
  await until('history', () => api.screen(first.id).includes('TG_OK_42'), 8000).catch(() => null);
  check('screen history restored', api.screen(first.id).includes('TG_OK_42'));
  if (persistent) {
    check('the same shell process runs on', find(api, first.id).pid === pidBefore, `${pidBefore} -> ${find(api, first.id).pid}`);
    await until('output from during the reload', () => api.screen(first.id).includes('TG_DURING_7'), 5000).catch(() => null);
    check('output printed during the reload shows', api.screen(first.id).includes('TG_DURING_7'));
  } else {
    check('restore note printed', /History restored|Історію відновлено/.test(api.screen(first.id)));
  }
  api.write(first.id, 'echo TG_AFTER_RESTORE\r');
  await until('new shell works', () => api.screen(first.id).includes('TG_AFTER_RESTORE'));
  check('restored terminal has a live shell', true);
  const restoredLayout = JSON.stringify(api.layout());
  check('layout restored', restoredLayout === layout, restoredLayout);

  // A program's title names the tile; a spinner mark says it works, and
  // stopping while the user looks elsewhere asks for attention.
  api.write(first.id, `sh -c 'printf "\\033]0;\u25d0 Busy task\\007"; sleep 2; printf "\\033]0;\u2733 Busy task\\007"; sleep 3'\r`);
  const busy = await until('working status', () => (find(api, first.id).working ? find(api, first.id) : null), 8000).catch(() => find(api, first.id));
  check('a spinner in the title shows the tile as working', !!busy.working && busy.title === 'Busy task', JSON.stringify({ title: busy.title, working: busy.working, process: busy.process }));
  // The user moves to another tile before the program is done.
  await api.focused(ptys(api).find((t) => t.id !== first.id).id);
  const done = await until('attention', () => (find(api, first.id).attention ? find(api, first.id) : null), 8000).catch(() => find(api, first.id));
  check('stopping while no one looks asks for attention', !!done.attention && !done.working, JSON.stringify({ title: done.title, working: done.working, attention: done.attention }));
  await api.focused(first.id);
  check('focusing the tile clears it', !find(api, first.id).attention);
  await until('title cleared', () => find(api, first.id).process === 'zsh' && !find(api, first.id).title, 8000).catch(() => null);
  check('the title goes with the program', !find(api, first.id).title, find(api, first.id).title);

  // Typing in the Terminal tab reaches the same shell.
  const twin = api.twinTerminal(first.id);
  twin.sendText('echo TG_FROM_TAB');
  await until('twin input', () => api.screen(first.id).includes('TG_FROM_TAB'));
  check('typing in the Terminal tab reaches the grid shell', true);

  // Tools show the active terminal at moments of their own: AI coding agents
  // after every diff and at the start of every turn, also turns the user did
  // not start with Enter. Showing a twin keeps the grid in front; the user
  // switching to the Terminal tab still leaves it there.
  await vscode.commands.executeCommand('terminalGrid.open');
  await until('grid mode for the show check', () => api.panelVisible() && api.gridMode(), 10000);
  twin.show();
  await sleep(1500);
  check('a tool showing a twin keeps the grid and grid mode', api.panelVisible() && api.gridMode(), JSON.stringify(api.reclaimState()));
  await vscode.commands.executeCommand('workbench.action.terminal.focus');
  await sleep(2500);
  check('the user switching to the Terminal tab leaves it in front', !api.panelVisible(), JSON.stringify(api.reclaimState()));
  await vscode.commands.executeCommand('terminalGrid.open');
  await until('grid back for the diff check', () => api.panelVisible() && api.gridMode(), 10000);
  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const proposed = vscode.Uri.file(require('path').join(folder, 'notes-proposed.md'));
  fs.writeFileSync(proposed.fsPath, '# notes\nchanged\n');
  await vscode.commands.executeCommand('vscode.diff', notes, proposed, 'notes.md (proposed)');
  vscode.window.activeTerminal?.show();
  await sleep(2500);
  check('a diff followed by showing the terminal keeps the grid in the panel', api.panelVisible() && !api.gridMode(), `panel ${api.panelVisible()} gridMode ${api.gridMode()} ${JSON.stringify(api.reclaimState())}`);
  const diffTab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((tab) => tab.input instanceof vscode.TabInputTextDiff);
  check('the diff stays open next to the grid', !!diffTab);
  if (diffTab) await vscode.window.tabGroups.close(diffTab);
  await sleep(500);
  vscode.window.activeTerminal?.show();
  await sleep(2500);
  check('closing the diff and showing the terminal keeps the grid too', api.panelVisible(), JSON.stringify(api.reclaimState()));

  // Agents also show the terminal about half a second after every prompt sent
  // from a tile. The grid stays, grid mode too, and the shell is never resized.
  await vscode.commands.executeCommand('terminalGrid.open');
  await until('grid mode for the prompt check', () => api.panelVisible() && api.gridMode(), 10000);
  await sleep(1000);
  const sizeOf = () => { const t = find(api, first.id); return `${t.cols}x${t.rows}`; };
  const sizes = new Set([sizeOf()]);
  api.input(first.id, '\r');
  await sleep(600);
  vscode.window.activeTerminal?.show();
  for (let i = 0; i < 100; i++) {
    await sleep(20);
    sizes.add(sizeOf());
  }
  check('showing the terminal right after Enter in a tile keeps the grid and grid mode', api.panelVisible() && api.gridMode(), `panel ${api.panelVisible()} gridMode ${api.gridMode()} ${JSON.stringify(api.reclaimState())}`);
  check('the shell keeps its size meanwhile', sizes.size === 1, [...sizes].join(' -> '));
  await sleep(3500);
  vscode.window.activeTerminal?.show();
  await sleep(1500);
  check('showing it again with no Enter before keeps the grid too', api.panelVisible() && api.gridMode(), JSON.stringify(api.reclaimState()));

  // Another extension (Lookout) can ask for the tile that runs a process.
  api.write(first.id, 'sleep 600 &\r');
  const shell = find(api, first.id).pid;
  const sleeper = await until('sleep in the grid shell', () => {
    try {
      return Number(require('child_process').execFileSync('pgrep', ['-P', String(shell), 'sleep']).toString().trim().split('\n')[0]) || undefined;
    } catch {
      return undefined;
    }
  });
  check('a process in a tile is found and shown', (await vscode.commands.executeCommand('terminalGrid.revealProcess', sleeper)) === true && api.panelVisible());
  check('a process elsewhere is not', (await vscode.commands.executeCommand('terminalGrid.revealProcess', process.pid)) === false);
  try {
    process.kill(sleeper);
  } catch {
    // Gone already.
  }

  // "New Agent Session" types the configured command into a new grid shell.
  await vscode.workspace.getConfiguration('terminalGrid').update('agentCommand', 'echo TG_AGENT_$((5*5))', vscode.ConfigurationTarget.Global);
  const beforeAgent = new Set(ptys(api).map((t) => t.id));
  await vscode.commands.executeCommand('terminalGrid.newAgent');
  const agent = await until('agent terminal', () => ptys(api).find((t) => !beforeAgent.has(t.id)));
  await until('agent command', () => api.screen(agent.id).includes('TG_AGENT_25'), 10000).catch(() => null);
  check('a new agent session runs the agent command', api.screen(agent.id).includes('TG_AGENT_25'));
  await api.close(agent.id);
  await until('agent closed', () => !find(api, agent.id), 8000).catch(() => null);

  // Closing a twin in the Terminal tab closes the grid terminal too.
  const before3 = ptys(api).length;
  await vscode.commands.executeCommand('terminalGrid.newTerminal');
  await until('extra terminal', () => ptys(api).length === before3 + 1);
  const extra = ptys(api)[before3];
  await until('extra twin', () => api.twinTerminal(extra.id), 5000);
  api.twinTerminal(extra.id).dispose();
  await until('extra gone', () => !api.terminals().some((t) => t.id === extra.id), 8000);
  check('closing it in the Terminal tab removes the tile', true);

  log(`INFO ${vscode.env.appName} ${vscode.version}, mirrors ${api.mirrorsAvailable() ? 'on' : 'off'}`);
  if (!EXPECT_MIRRORS) {
    check('proposed API is off in this run', !api.mirrorsAvailable());
    const native = vscode.window.createTerminal({ name: 'native', cwd: '/tmp' });
    native.show(true);
    await sleep(3000);
    check('a Terminal-tab terminal does not become a tile', !api.terminals().some((t) => t.kind === 'mirror'));
    api.closeAll();
    await until('grid shells closed', () => ptys(api).length === 0, 8000);
    check('Close All ends the grid shells', true);
    check('Close All leaves other terminals running', vscode.window.terminals.includes(native));
    return;
  }

  // A terminal opened outside the grid shows up as a mirror.
  check('proposed API is available in this run', api.mirrorsAvailable());
  const native = vscode.window.createTerminal({ name: 'native', cwd: '/tmp' });
  native.show(true);
  const mirror = await until('mirror tile', () => api.terminals().find((t) => t.kind === 'mirror' && t.process === 'native'), 10000);
  check('a Terminal-tab terminal appears in the grid as a mirror', !!mirror, `${mirror.id} ${mirror.fixedSize?.cols}x${mirror.fixedSize?.rows}`);
  native.sendText('echo TG_MIRROR_$((2+3))');
  await until('mirror output', () => api.screen(mirror.id).includes('TG_MIRROR_5'), 10000);
  check('mirror shows the terminal output', true);
  await api.input(mirror.id, 'echo TG_FROM_GRID\r');
  await until('grid input to native', () => api.screen(mirror.id).includes('TG_FROM_GRID'), 10000);
  check('typing in the mirror reaches the real terminal', true);
  await hold();
  await api.close(mirror.id);
  check('closing a mirror only hides it', !JSON.stringify(api.layout()).includes(mirror.id));
  check('the real terminal keeps running', vscode.window.terminals.includes(native));

  // Close All ends grid shells and only hides mirrors, like closing each tile.
  await api.showHidden();
  check('Show Hidden brings the mirror back', api.hidden().length === 0);
  api.closeAll();
  await until('grid shells closed', () => ptys(api).length === 0, 8000);
  check('Close All ends the grid shells', true);
  check('Close All hides the mirror instead of dropping it', api.hidden().includes(mirror.id) && !!find(api, mirror.id), api.hidden().join(','));
  check('Close All leaves the real terminal running', vscode.window.terminals.includes(native));
  await api.showHidden();
  check('the hidden mirror can be shown again', api.hidden().length === 0 && !!find(api, mirror.id));
}

exports.run = async () => {
  try {
    await run();
  } catch (error) {
    log(`FAIL exception: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  }
};
