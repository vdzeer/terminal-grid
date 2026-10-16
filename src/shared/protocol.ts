import type { LayoutNode, Placement } from './layout';

export type Language = 'en' | 'uk';

export interface TerminalInfo {
  id: string;
  /**
   * `pty`: a shell the extension runs (it also shows in the Terminal tab).
   * `mirror`: a Terminal-tab terminal the extension did not start, shown here.
   */
  kind: 'pty' | 'mirror';
  /** Foreground process name (pty) or terminal name (mirror), such as `zsh` or `node`. */
  process: string;
  /** Name the user gave the tile; empty when they did not rename it. */
  customTitle: string;
  cwd: string;
  /** Mirrors keep the size of the real terminal; the tile scales its text to fit. */
  fixedSize?: { cols: number; rows: number };
  exitCode?: number;
}

export interface ViewSettings {
  language: Language;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  scrollback: number;
  macOptionIsMeta: boolean;
  minimumContrastRatio: number;
  drawBoldTextInBrightColors: boolean;
  gpu: boolean;
  /** Sent for Shift+Enter (ESC+CR, the same as Alt+Enter: a new line in many command line programs); empty keeps a plain Enter. */
  shiftEnter: string;
  /** `process.platform` of the extension host. */
  platform: string;
}

export interface Snapshot {
  data: string;
  /** Size the screen was serialized at; the tile starts at it, then fits. */
  cols: number;
  rows: number;
}

/** Messages from the extension to the webview. */
export type HostMessage =
  | {
      type: 'init';
      terminals: TerminalInfo[];
      layout: LayoutNode | null;
      settings: ViewSettings;
      /** Serialized screen and scrollback per terminal, to repaint after a reload. */
      snapshots: Record<string, Snapshot>;
    }
  | { type: 'output'; chunks: [id: string, data: string][] }
  | { type: 'created'; terminal: TerminalInfo; placement?: Placement; focus: boolean; snapshot?: Snapshot }
  | { type: 'updated'; terminal: TerminalInfo }
  | { type: 'removed'; id: string }
  | { type: 'settings'; settings: ViewSettings }
  | { type: 'arrange' }
  | { type: 'focus'; id: string };

/** Messages from the webview to the extension. */
export type ViewMessage =
  | { type: 'ready' }
  | { type: 'input'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'ack'; id: string; chars: number }
  | { type: 'create'; placement?: Placement; cwdFrom?: string }
  | { type: 'close'; id: string }
  | { type: 'restart'; id: string }
  | { type: 'rename'; id: string; title: string }
  | { type: 'layout'; layout: LayoutNode | null }
  | { type: 'openUrl'; url: string }
  | { type: 'openFile'; id: string; path: string; line?: number; column?: number }
  /** From the placeholder page in the bottom panel. */
  | { type: 'bringHere' }
  /** The webview's size and the window's, for measuring the editor layout. */
  | { type: 'viewport'; width: number; height: number; outerWidth: number; outerHeight: number };
