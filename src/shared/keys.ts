// Grid shortcuts. On macOS they use Cmd like iTerm2; elsewhere Ctrl+Shift so
// that plain Ctrl keys keep reaching the shell.

export type Shortcut =
  | 'new'
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
  if (isMac) {
    if (!e.metaKey || e.ctrlKey) return undefined;
    if (arrow) return e.altKey && !e.shiftKey ? arrow : undefined;
    if (e.altKey) return undefined;
    if (e.code === 'KeyT' && !e.shiftKey) return 'new';
    if (e.code === 'KeyD') return e.shiftKey ? 'splitDown' : 'splitRight';
    if (e.key === 'Enter' && e.shiftKey) return 'zoom';
    if (e.code === 'KeyK' && !e.shiftKey) return 'clear';
    if (e.code === 'KeyF' && !e.shiftKey) return 'find';
    return undefined;
  }
  if (arrow) return e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey ? arrow : undefined;
  if (!e.ctrlKey || !e.shiftKey || e.metaKey) return undefined;
  if (e.code === 'KeyT' && !e.altKey) return 'new';
  if (e.code === 'KeyD') return e.altKey ? 'splitDown' : 'splitRight';
  if (e.key === 'Enter' && !e.altKey) return 'zoom';
  if (e.code === 'KeyK' && !e.altKey) return 'clear';
  if (e.code === 'KeyF' && !e.altKey) return 'find';
  return undefined;
}

export function shortcutLabel(shortcut: Shortcut, isMac: boolean): string {
  const mac: Record<Shortcut, string> = {
    new: '⌘T',
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
