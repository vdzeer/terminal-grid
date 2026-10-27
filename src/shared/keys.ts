// Grid shortcuts. On macOS they use Cmd like iTerm2; elsewhere Ctrl+Shift so
// that plain Ctrl keys keep reaching the shell.

export type Shortcut =
  | 'new'
  | 'newAgent'
  | 'previousCommand'
  | 'nextCommand'
  | 'splitRight'
  | 'splitDown'
  | 'zoom'
  | 'clear'
  | 'find'
  | 'focusLeft'
  | 'focusRight'
  | 'focusUp'
  | 'focusDown';

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const ARROWS: Record<string, Shortcut> = {
  ArrowLeft: 'focusLeft',
  ArrowRight: 'focusRight',
  ArrowUp: 'focusUp',
  ArrowDown: 'focusDown',
};

export function matchShortcut(e: KeyLike, isMac: boolean): Shortcut | undefined {
  const arrow = ARROWS[e.key];
  // Jumps between the commands that shell integration marked, like the Terminal tab.
  const command = e.key === 'ArrowUp' ? 'previousCommand' : e.key === 'ArrowDown' ? 'nextCommand' : undefined;
  if (isMac) {
    if (!e.metaKey || e.ctrlKey) return undefined;
    if (arrow) return e.altKey && !e.shiftKey ? arrow : !e.altKey && !e.shiftKey ? command : undefined;
    if (e.altKey) return undefined;
    if (e.code === 'KeyT') return e.shiftKey ? 'newAgent' : 'new';
    if (e.code === 'KeyD') return e.shiftKey ? 'splitDown' : 'splitRight';
    if (e.key === 'Enter' && e.shiftKey) return 'zoom';
    if (e.code === 'KeyK' && !e.shiftKey) return 'clear';
    if (e.code === 'KeyF' && !e.shiftKey) return 'find';
    return undefined;
  }
  if (arrow) {
    if (!e.ctrlKey || e.shiftKey || e.metaKey) return undefined;
    return e.altKey ? arrow : command;
  }
  if (!e.ctrlKey || !e.shiftKey || e.metaKey) return undefined;
  if (e.code === 'KeyT' && !e.altKey) return 'new';
  if (e.code === 'KeyA' && !e.altKey) return 'newAgent';
  if (e.code === 'KeyD') return e.altKey ? 'splitDown' : 'splitRight';
  if (e.key === 'Enter' && !e.altKey) return 'zoom';
  if (e.code === 'KeyK' && !e.altKey) return 'clear';
  if (e.code === 'KeyF' && !e.altKey) return 'find';
  return undefined;
}

// The editor's own terminal turns these keys into shell sequences with its
// default `workbench.action.terminal.sendSequence` keybindings, which never
// fire in a webview, so tiles send the same bytes themselves.
const MAC_SEQUENCES: Record<string, string> = {
  'meta+Backspace': '\x15', // delete to line start
  'meta+ArrowLeft': '\x01', // line start
  'meta+ArrowRight': '\x05', // line end
  'alt+Backspace': '\x17', // delete word left
  'alt+Delete': '\x1bd', // delete word right
  'alt+ArrowLeft': '\x1bb', // word left
  'alt+ArrowRight': '\x1bf', // word right
  'alt+ArrowUp': '\x1b[1;5A',
  'alt+ArrowDown': '\x1b[1;5B',
  'ctrl+Slash': '\x1f',
};
const OTHER_SEQUENCES: Record<string, string> = {
  'ctrl+Backspace': '\x17',
  'ctrl+Delete': '\x1bd',
  'alt+ArrowLeft': '\x1b[1;5D',
  'alt+ArrowRight': '\x1b[1;5C',
  'alt+ArrowUp': '\x1b[1;5A',
  'alt+ArrowDown': '\x1b[1;5B',
  'ctrl+Slash': '\x1f',
};

export function terminalSequence(e: KeyLike, isMac: boolean): string | undefined {
  const modifiers = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta'].filter(Boolean);
  return (isMac ? MAC_SEQUENCES : OTHER_SEQUENCES)[[...modifiers, e.code].join('+')];
}

export function shortcutLabel(shortcut: Shortcut, isMac: boolean): string {
  const mac: Record<Shortcut, string> = {
    new: '⌘T',
    newAgent: '⇧⌘T',
    previousCommand: '⌘↑',
    nextCommand: '⌘↓',
    splitRight: '⌘D',
    splitDown: '⇧⌘D',
    zoom: '⇧⌘↩',
    clear: '⌘K',
    find: '⌘F',
    focusLeft: '⌥⌘←',
    focusRight: '⌥⌘→',
    focusUp: '⌥⌘↑',
    focusDown: '⌥⌘↓',
  };
  const other: Record<Shortcut, string> = {
    new: 'Ctrl+Shift+T',
    newAgent: 'Ctrl+Shift+A',
    previousCommand: 'Ctrl+↑',
    nextCommand: 'Ctrl+↓',
    splitRight: 'Ctrl+Shift+D',
    splitDown: 'Ctrl+Shift+Alt+D',
    zoom: 'Ctrl+Shift+Enter',
    clear: 'Ctrl+Shift+K',
    find: 'Ctrl+Shift+F',
    focusLeft: 'Ctrl+Alt+←',
    focusRight: 'Ctrl+Alt+→',
    focusUp: 'Ctrl+Alt+↑',
    focusDown: 'Ctrl+Alt+↓',
  };
  return (isMac ? mac : other)[shortcut];
}
