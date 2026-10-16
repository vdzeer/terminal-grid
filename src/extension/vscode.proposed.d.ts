// Proposed APIs this extension uses (VS Code 1.107), enabled through
// `enable-proposed-api` in the editor's argv.json. Accessing them without
// that throws, so every use is guarded.

declare module 'vscode' {
  // terminalDataWriteEvent
  export interface TerminalDataWriteEvent {
    readonly terminal: Terminal;
    readonly data: string;
  }

  // terminalDimensions
  export interface TerminalDimensionsChangeEvent {
    readonly terminal: Terminal;
    readonly dimensions: TerminalDimensions;
  }

  export interface Terminal {
    readonly dimensions: TerminalDimensions | undefined;
  }

  export namespace window {
    /** Fires when any terminal writes output, including terminals other extensions created. */
    export const onDidWriteTerminalData: Event<TerminalDataWriteEvent>;
    export const onDidChangeTerminalDimensions: Event<TerminalDimensionsChangeEvent>;
  }
}
