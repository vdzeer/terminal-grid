import type { ITheme } from '@xterm/xterm';

// The editor exposes every theme color to webviews as a CSS variable, so the
// grid terminals follow the active color theme like the built-in ones do.

const ANSI = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

function cssVar(style: CSSStyleDeclaration, name: string): string | undefined {
  const value = style.getPropertyValue(`--vscode-${name}`).trim();
  return value || undefined;
}

/** In the bottom panel the built-in terminal falls back to the panel color, in an editor tab to the editor's. */
export function readTheme(host: 'panel' | 'editor'): ITheme {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string) => cssVar(style, name);
  const surface = host === 'panel' ? v('panel-background') : undefined;
  const background = v('terminal-background') ?? surface ?? v('editor-background') ?? '#1e1e1e';
  const foreground = v('terminal-foreground') ?? v('editor-foreground') ?? '#cccccc';
  const theme: ITheme = {
    background,
    foreground,
    cursor: v('terminalCursor-foreground') ?? foreground,
    cursorAccent: v('terminalCursor-background') ?? background,
    selectionBackground: v('terminal-selectionBackground') ?? v('editor-selectionBackground'),
    selectionInactiveBackground: v('terminal-inactiveSelectionBackground') ?? v('editor-inactiveSelectionBackground'),
    selectionForeground: v('terminal-selectionForeground'),
    scrollbarSliderBackground: v('scrollbarSlider-background'),
    scrollbarSliderHoverBackground: v('scrollbarSlider-hoverBackground'),
    scrollbarSliderActiveBackground: v('scrollbarSlider-activeBackground'),
    overviewRulerBorder: v('editorOverviewRuler-border'),
  };
  for (const name of ANSI) {
    const key = `terminal-ansi${name[0]?.toUpperCase()}${name.slice(1)}`;
    const value = v(key);
    if (value) theme[name] = value;
  }
  for (const key of Object.keys(theme) as (keyof ITheme)[]) {
    if (theme[key] === undefined) delete theme[key];
  }
  // On body: the html element's style is watched for theme changes.
  document.body.style.setProperty('--tg-terminal-background', background);
  return theme;
}

export interface SearchColors {
  matchBackground: string;
  activeMatchBackground: string;
  matchOverviewRuler: string;
  activeMatchColorOverviewRuler: string;
}

export function readSearchColors(): SearchColors {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string) => cssVar(style, name);
  return {
    matchBackground: v('terminal-findMatchHighlightBackground') ?? v('editor-findMatchHighlightBackground') ?? '#ea5c0055',
    activeMatchBackground: v('terminal-findMatchBackground') ?? v('editor-findMatchBackground') ?? '#515c6a',
    matchOverviewRuler: v('editorOverviewRuler-findMatchForeground') ?? '#d186167e',
    activeMatchColorOverviewRuler: v('editorOverviewRuler-findMatchForeground') ?? '#d186167e',
  };
}

/** Calls `listener` whenever the editor switches color theme. */
export function onThemeChange(listener: () => void): void {
  let timer: number | undefined;
  const observer = new MutationObserver(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(listener, 30);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
