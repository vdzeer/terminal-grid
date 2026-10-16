# Changelog

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
