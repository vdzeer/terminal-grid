# Terminal Grid

[![Open VSX version](https://img.shields.io/open-vsx/v/vdzeer/terminal-grid)](https://open-vsx.org/extension/vdzeer/terminal-grid)
[![Open VSX downloads](https://img.shields.io/open-vsx/dt/vdzeer/terminal-grid)](https://open-vsx.org/extension/vdzeer/terminal-grid)
[![License: MIT](https://img.shields.io/github/license/vdzeer/terminal-grid)](https://github.com/vdzeer/terminal-grid/blob/main/LICENSE)

An editor extension that shows every terminal of the window as a grid in its
own tab of the bottom panel, next to "Terminal". Tiles are rearranged with drag
and drop, split, resized and maximized like editor groups. It runs in VS Code
1.105 or later and in editors built on it, such as Antigravity, Cursor,
VSCodium and Windsurf. Tested on macOS with VS Code 1.142 and Antigravity IDE
1.107.

## Features

- **A tab in the bottom panel.** "Terminal Grid" sits next to "Terminal".
  `⌃⌥⌘T` (Ctrl+Alt+Shift+T on Windows and Linux) opens it; pressed again while
  the grid fills the window, it goes back to the editor. A status bar item
  shows how many terminals the grid holds and opens the grid.
- **Grid mode.** While the grid is open in the panel, the panel is maximized,
  the Explorer is shown and the secondary side bar (the Agent side bar in
  Antigravity) is closed. Opening a file brings the previous layout back. A
  diff opened by a tool (a proposed edit from an AI agent) only un-maximizes
  the panel, so the diff and the grid are on screen together.
  Maximizing only happens when `workbench.panel.defaultAlignment` is `center`.
  Setting: `terminalGrid.focusLayout`.
- **The grid stays in front.** Some extensions show "the terminal" right after
  they open or close an editor tab; AI coding agents do it for every proposed
  edit, and some also after every prompt sent. That would switch the panel to
  the Terminal tab, so when it happens within a moment of a tab change or of
  Enter in a tile, and the terminal is one the grid shows, the grid takes the
  panel back and focuses the tile. After a prompt nothing else moves: grid mode
  stays on and the shells keep their size. Switching to the Terminal tab
  yourself works as usual.
- **Grid shells are also in the Terminal tab.** A shell started by the grid
  shows in both places: one process, two views. Typing in either reaches it,
  closing it in either closes both, and the shell takes the size of whichever
  view is on screen.
- **Mirrors of other terminals.** Terminals the grid did not start (opened
  earlier in the Terminal tab, or by other extensions) appear as mirror tiles:
  their output at their real size, with the text scaled to fit the tile.
  Typing in a mirror goes to the real terminal. Closing a mirror tile only
  hides it; "Show Hidden Terminals" (the eye button in the panel title) brings
  it back. Terminals that other tools hide from the user are not mirrored.
  Mirrors are off until you allow two proposed APIs, see
  [Enabling mirrors](#enabling-mirrors-proposed-apis).
- **Drag and drop.** Drag a tile by its header onto another tile: an edge puts
  it on that side, the middle swaps the two. In the editor-tab version the
  "New terminal" button can be dragged onto a tile to place a new terminal
  there.
- **Split and resize.** The header buttons and the split shortcuts open a
  shell in the same folder. Drag the gaps to resize, double-click a gap to
  even out. "Arrange as Grid" lays all tiles out evenly.
- **Terminal basics.** Find, clear, maximize a tile, move focus between tiles,
  `⌘`-click (Ctrl-click) on URLs and file paths such as `src/app.ts:12:5`.
  Double-click a title to rename a tile. Fonts, cursor and colors follow
  `terminal.integrated.*` and the color theme, and
  `terminal.integrated.env.<platform>` is applied to grid shells.
- **Survives window reloads.** Grid shells are started again after a reload
  in their last folder, with their last screen restored (the programs that
  were running are not, see [Known limitations](#known-limitations)).
- **Editor tab.** "Open in Editor Tab" moves the grid into an editor tab;
  "Move to Bottom Panel" moves it back.
- **Explorer.** "Open in Terminal Grid" in the context menu of a folder opens
  a grid shell in that folder.
- **Shift+Enter.** In grid terminals Shift+Enter sends ESC followed by Enter,
  the same as Alt+Enter, which many command line programs read as a new line
  instead of sending the input. Configurable with
  `terminalGrid.shiftEnterSequence`.
- The UI is in English and Ukrainian and follows the editor's display
  language.

## Requirements

- VS Code 1.105 or later, or an editor built on it.
- The editor must ship `node-pty` in its install folder, as VS Code and the
  editors above do. The extension does not bundle it: it loads the copy under
  the editor's `appRoot` (`node_modules`, `node_modules.asar` or
  `node_modules.asar.unpacked`), so it always matches the editor's Electron
  version. If it cannot be loaded, the grid panel and every command say why,
  and no grid terminals start.
- To build from source: Node.js 22.13 or later and npm.

## Install

The extension ID is `vdzeer.terminal-grid`. Releases go to Open VSX
(Antigravity, Cursor, VSCodium, Windsurf and other editors that use it) and, as
a `.vsix` file, to GitHub Releases. It is not on the Visual Studio Marketplace:
in VS Code, install the `.vsix`.

- **Extensions view** (editors that use Open VSX): search for "Terminal Grid"
  and click Install.
- **Command line** (editors that use Open VSX): use the editor's command line
  tool, for example `codium --install-extension vdzeer.terminal-grid` (also
  `cursor`, `windsurf`, `antigravity-ide`).
- **From GitHub Releases** (any editor, VS Code included): download
  `terminal-grid-<version>.vsix` from the
  [releases page](https://github.com/vdzeer/terminal-grid/releases). In the
  Extensions view, open the `...` menu, choose "Install from VSIX..." and pick
  the file, or run `code --install-extension terminal-grid-<version>.vsix`.

The grid works right after installing. On the first start the extension asks
whether "Terminal Grid" should be the default terminal profile (see
[Default terminal profile](#default-terminal-profile)). Terminals opened
outside the grid show up in it only after the step below.

### From source

```sh
git clone https://github.com/vdzeer/terminal-grid.git
cd terminal-grid
npm ci
npm run package        # production build, writes dist/terminal-grid.vsix
```

Install `dist/terminal-grid.vsix` as above. On macOS with Antigravity IDE,
`npm run install-ext` packages and installs in one step through the
`antigravity-ide` command line tool.

## Enabling mirrors (proposed APIs)

Mirrors read the output of terminals the extension did not start. That needs
two proposed editor APIs, `terminalDataWriteEvent` and `terminalDimensions`,
which an editor only grants to extensions listed in its `argv.json`:

1. Run "Preferences: Configure Runtime Arguments" from the Command Palette. It
   opens the editor's `argv.json`.
2. Add this entry inside the outer braces (with a comma after the entry
   before it):

   ```jsonc
   "enable-proposed-api": ["vdzeer.terminal-grid"]
   ```

3. Quit the editor completely and start it again. A window reload is not
   enough.

Where the file is, if you prefer to open it yourself (`%USERPROFILE%` instead
of `~` on Windows):

| Editor | File |
|---|---|
| VS Code | `~/.vscode/argv.json` |
| VS Code Insiders | `~/.vscode-insiders/argv.json` |
| VSCodium | `~/.vscode-oss/argv.json` |
| Cursor | `~/.cursor/argv.json` |
| Antigravity IDE | `~/.antigravity-ide/argv.json` |

For other editors, use the command in step 1. For a single run, the command
line flag `--enable-proposed-api vdzeer.terminal-grid` does the same.

Without this, everything except mirrors works: grid shells, their
Terminal-tab twins and the "Terminal Grid" profile. Terminals started outside
the grid stay only in the Terminal tab. The first time the grid opens, the
extension shows a notice with these steps, once. Set
`terminalGrid.mirrorTerminals` to `false` to turn mirrors and the notice off.
The editor also writes one line about the proposals to its log at every start
while they are not enabled; that line is expected.

## Default terminal profile

The extension contributes a terminal profile named "Terminal Grid". With it as
the default, `+` in the Terminal tab and the editor's "Create New Terminal"
command open shells that also show in the grid.

The extension never changes the default on its own. On its first start it asks
once ("Make default" or "Not now") and remembers the answer. To make it the
default later, run "Terminal Grid: Make Default Terminal Profile". It writes
`"Terminal Grid"` to `terminal.integrated.defaultProfile.osx` (`.linux`,
`.windows` on those platforms) in your user settings.

To go back, run "Terminal: Select Default Profile" and pick your shell, or
remove the `terminal.integrated.defaultProfile.<platform>` line from your user
`settings.json`.

## Uninstall

1. If "Terminal Grid" is your default terminal profile, pick another one first
   (see above). Otherwise the setting keeps pointing at a profile that no
   longer exists.
2. Uninstall from the Extensions view, or run
   `code --uninstall-extension vdzeer.terminal-grid`.
3. Optionally remove the `enable-proposed-api` line from `argv.json`.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `terminalGrid.restoreSessions` | `true` | Start grid shells again after a window reload, in the same folders and with their last screen. |
| `terminalGrid.shell` | `""` | Shell for grid terminals. Empty uses the editor's default shell. User or remote settings only. |
| `terminalGrid.shellArgs` | `null` | Shell arguments. `null` starts a login shell on macOS (`-l` for zsh, bash, fish and sh), like Terminal.app. User or remote settings only. |
| `terminalGrid.focusLayout` | `true` | Grid mode: maximize the panel and keep only the Explorer next to it while the grid is open. |
| `terminalGrid.newTerminalShortcut` | `true` | `` Ctrl+Shift+` `` opens a new grid terminal instead of the editor's own "Create New Terminal". |
| `terminalGrid.mirrorTerminals` | `true` | Show terminals opened outside the grid as mirror tiles. Needs the proposed APIs. |
| `terminalGrid.shiftEnterSequence` | `"\u001b\r"` | What Shift+Enter sends in grid terminals. Empty sends a plain Enter. User or remote settings only. |

The settings marked "user or remote settings only" decide what runs in your
shells, so a workspace's `.vscode/settings.json` cannot set them.

## Commands

All commands are in the "Terminal Grid" category of the Command Palette.

| Command | Where else |
|---|---|
| Open | Button in the Terminal panel title |
| Show Grid or Go Back to the Editor | `⌃⌥⌘T` / Ctrl+Alt+Shift+T |
| New Terminal | Panel title, `` Ctrl+Shift+` `` |
| Arrange as Grid | Panel title |
| Show Hidden Terminals | Panel title, while a mirror is hidden |
| Open in Editor Tab | Panel title |
| Move to Bottom Panel | Editor title of the grid tab |
| Close All Terminals | Panel title `...` menu, asks first. Ends grid shells; mirror tiles are only hidden |
| Make Default Terminal Profile | |
| Open in Terminal Grid | Explorer context menu on a folder |

For other extensions, `terminalGrid.revealProcess` takes a process id, shows
the grid and focuses the tile whose shell runs that process. It returns
`true` when it found one. It is not in the Command Palette.

## Keyboard shortcuts

Editor-wide:

| Action | macOS | Windows and Linux |
|---|---|---|
| Show the grid, or go back to the editor | `⌃⌥⌘T` | Ctrl+Alt+Shift+T |
| New grid terminal (`terminalGrid.newTerminalShortcut`) | `` ⌃⇧` `` | `` Ctrl+Shift+` `` |

Inside the grid:

| Action | macOS | Windows and Linux |
|---|---|---|
| New terminal | `⌘T` | Ctrl+Shift+T |
| Split right | `⌘D` | Ctrl+Shift+D |
| Split down | `⇧⌘D` | Ctrl+Shift+Alt+D |
| Maximize or restore the tile | `⇧⌘↩` | Ctrl+Shift+Enter |
| Clear | `⌘K` | Ctrl+Shift+K |
| Find | `⌘F` | Ctrl+Shift+F |
| Move focus | `⌥⌘` + arrow | Ctrl+Alt + arrow |
| Open a link or path | `⌘`-click | Ctrl-click |

## Known limitations

- A mirror cannot resize the real terminal, so a wide and short panel
  terminal shows small text in a tile. Output written before the extension
  started is not in a mirror; it is still in the Terminal tab.
- Grid shells run in the extension host. A window reload ends them: they are
  started again with the last screen restored, but running programs are gone.
  The editor's own terminals do not have this limitation.
- The Terminal-tab side of a grid shell is an extension pseudoterminal, so
  shell integration (command decorations, sticky scroll) is not available
  there.
- One grid per window.
- The current folder of a grid shell is read with `lsof` on macOS and from
  `/proc` on Linux. On Windows it is not tracked, so a split opens in the
  folder the shell started in.
- Tested on macOS only. The Windows and Linux code paths and keybindings
  exist but have not been tried.
- Mirrors depend on proposed APIs, which every user has to enable in
  `argv.json` and which a future editor version may change.

## Privacy

With `terminalGrid.restoreSessions` on, the last screen and up to 1000 lines
of scrollback of each grid shell are saved in the editor's workspace storage,
so that they can be shown again after a reload. Anything printed in a grid
terminal, secrets included, can end up there. With the setting off, no screen
content is saved. Mirrors are never saved.

## Development

```sh
npm ci
npm run lint      # TypeScript checks for the extension and the webview, then ESLint
npm test          # unit tests with the Node test runner, no editor needed
npm run build     # development build with source maps into dist/
npm run watch     # the same, rebuilding on change
npm run package   # production build and dist/terminal-grid.vsix
```

To debug, start the editor with
`--extensionDevelopmentPath=<path to this folder>` (and
`--enable-proposed-api vdzeer.terminal-grid` for mirrors). In that mode the
extension does not ask about the default terminal profile.

`dev/` holds two manual checks, both outside `npm test`: a browser harness for
the webview (`dev/harness.html`) and an integration run in a throwaway editor
instance (`dev/run-integration.sh`).

Releases: pushing a tag `v<version>` that matches `package.json` runs
`.github/workflows/release.yml`. It lints, tests and packages, attaches the
`.vsix` to a GitHub Release, and publishes it to Open VSX when the `OVSX_PAT`
repository secret is set.

## License

[MIT](LICENSE)
