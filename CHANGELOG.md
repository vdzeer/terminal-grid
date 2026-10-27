# Changelog

## 0.5.0

- Grid shells survive a window reload. They run in a small background process
  (the pty host), one per workspace; programs keep running through the
  reload, and the grid takes them back with everything they printed
  meanwhile. After the window closes, the pty host waits a minute for it
  before it ends the shells.
- Tiles take the title their program sets, and show what an AI agent is
  doing: a spinner while it works, a mark once it waits for you while you
  look elsewhere. "Go to the Terminal Waiting for You" (`⌃⌥⌘J`) and the status
  bar item go there.
- "New Agent Session" (also in a git worktree) opens a grid shell running
  `terminalGrid.agentCommand`, `claude` by default.
- Shell integration in grid shells (zsh and bash, the editor's own scripts):
  command marks in the gutter, `⌘↑`/`⌘↓` to jump between commands.
- Dragging a file over a tile says where its path goes, or that Shift has to
  be held.
- A tool showing a grid shell's terminal no longer switches the panel to the
  Terminal tab while the grid is on screen: the grid stays and takes focus.
  Before, the grid was only taken back after a tab change or Enter in a tile,
  so turns an AI agent started on its own (queued prompts, finished
  background tasks) still pushed it out.
- Line editing keys send what the Terminal tab sends: `⌘⌫` deletes to the
  start of the line, `⌘←`/`⌘→` go to its start and end, `⌥⌫`/`⌥⌦` delete a
  word, `⌥←`/`⌥→` move by word (Ctrl+Backspace and Ctrl+Delete on Windows
  and Linux).
- Files dropped on a tile go in as their paths, quoted for the shell. The
  editor lets a drop into the grid through only while Shift is held.

## 0.4.0

- New command for other extensions, `terminalGrid.revealProcess` (not in the
  Command Palette): given a process id, it shows the grid and focuses the
  tile whose shell runs that process, and returns whether it found one.
  [Lookout](https://github.com/vdzeer/lookout) uses it to go to a Claude Code
  session running in a tile.

## 0.3.2

- The grid also stays in front when a tool shows the active terminal right
  after a prompt is sent from a tile, as AI coding agents do for every prompt
  (about half a second after Enter, with no editor tab involved). The grid
  takes the panel back at once, keeps grid mode and the layout around it, and
  focuses the tile the prompt was typed in.
- When the grid gives way to the Terminal tab, the shells wait for the tab to
  settle before taking its size. Before, they followed every step of its
  layout (one only about 11 columns wide) and a stale size, and programs such
  as AI agents redrew at each one, leaving a narrow, broken screen.

## 0.3.1

- The grid no longer gives way to the Terminal tab when a tool shows the
  active terminal right after opening or closing an editor tab, as AI coding
  agents do for every proposed edit and when it is accepted, rejected or closed.
  The grid takes the panel back and focuses that terminal's tile.
- In grid mode a diff opened by a tool only un-maximizes the panel instead of
  closing it, so the diff and the grid are on screen together.

## 0.3.0

First public release, for VS Code and the editors that install from Open VSX
(Antigravity, Cursor, VSCodium, Windsurf).

- The default terminal profile is no longer changed silently. The extension
  asks once whether "Terminal Grid" should be the default; the new command
  "Terminal Grid: Make Default Terminal Profile" does it later.
- Works out of the box without the proposed APIs: grid shells and their
  Terminal-tab twins work, mirrors stay off, and a one-time notice explains
  how to turn them on in the editor's `argv.json`. The notice names the
  editor that is running instead of always saying "Antigravity".
- node-pty is looked up in the editor's `node_modules`, then
  `node_modules.asar` (VS Code, VSCodium), then `node_modules.asar.unpacked`.
  If it cannot be loaded, the panel and every command say why, and a default
  profile set to "Terminal Grid" opens a plain shell.
- "Close All Terminals" ends the grid shells and only hides mirror tiles, the
  same as closing each tile; the warning says so when mirrors are shown.
- `terminalGrid.shell`, `terminalGrid.shellArgs` and
  `terminalGrid.shiftEnterSequence` are machine settings: a repository's
  `.vscode/settings.json` cannot set them. Untrusted workspaces are declared
  as supported.
- Icon, gallery metadata and a release workflow for GitHub Releases and
  Open VSX.

## 0.2.1 and earlier

Development versions, installed from source only.
