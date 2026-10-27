// Some extensions give focus "back to the terminal" with `activeTerminal.show()`
// at moments the user did not ask for. AI coding agents do it whenever they
// show a proposed edit as a diff, again when the edit is accepted, rejected or
// its tab closed, and about half a second after every prompt the user sends
// (they close leftover diffs then, even when there are none). With the grid in
// the bottom panel the active terminal is usually the Terminal-tab twin of a
// grid shell, so that call switches the panel to the Terminal tab and hides the
// grid while the user works in it. A switch that close to a tab change, or
// right after Enter in a tile, is not the user's, so the grid takes the panel back.
// A tab change and the hide can arrive in either order; whichever comes second decides.
// A twin's own `show` no longer leaves the grid at all (`showTwinInGrid` in
// controller.ts); this still covers mirrors, and editors where that cannot work.
// Kept free of `vscode` so it can be unit tested.

/** How far apart a tab change and the grid being hidden may be to count as one push. */
export const RECLAIM_WINDOW_MS = 1500;
/** At most this many times per tab change, so the grid never fights in a loop. */
export const RECLAIM_LIMIT = 3;
/** How long after Enter in a tile a hide still counts: the agent's own prompt hooks run first. */
export const SUBMIT_WINDOW_MS = 3000;

export interface ReclaimState {
  /** When an editor tab last opened or closed while the grid was on screen (or had just left it). */
  tabChangeAt: number | undefined;
  /** When Enter was last typed into a tile while the grid was on screen; one push per Enter. */
  submitAt: number | undefined;
  /** The tile that Enter went to. */
  submitId: string | undefined;
  /** When the grid in the bottom panel was last hidden. */
  hiddenAt: number | undefined;
  /** Times the grid was already brought back after that tab change. */
  reclaims: number;
  /** When the extension itself last closed the panel (leaving grid mode for an editor). */
  ownHideAt: number | undefined;
}

export const noReclaim = (): ReclaimState => ({
  tabChangeAt: undefined,
  submitAt: undefined,
  submitId: undefined,
  hiddenAt: undefined,
  reclaims: 0,
  ownHideAt: undefined,
});

/** A tab change counts while the grid is on screen or was hidden moments ago. */
export function tabChangeCounts(gridVisible: boolean, hiddenAt: number | undefined, now: number): boolean {
  return gridVisible || (hiddenAt !== undefined && now - hiddenAt <= RECLAIM_WINDOW_MS);
}

/** What pushed the grid out, if it was not the user. */
export function reclaimCause(state: ReclaimState, gridVisible: boolean, activeTerminalInGrid: boolean): 'tabChange' | 'submit' | undefined {
  const { tabChangeAt, submitAt, hiddenAt, reclaims, ownHideAt } = state;
  if (gridVisible || !activeTerminalInGrid || hiddenAt === undefined) return undefined;
  // The grid was hidden on purpose: opening a file in grid mode closes the panel.
  if (ownHideAt !== undefined && Math.abs(hiddenAt - ownHideAt) <= RECLAIM_WINDOW_MS) return undefined;
  // Only a hide after the Enter: the tool answers the prompt being sent.
  if (submitAt !== undefined && hiddenAt >= submitAt && hiddenAt - submitAt <= SUBMIT_WINDOW_MS) return 'submit';
  if (tabChangeAt !== undefined && reclaims < RECLAIM_LIMIT && Math.abs(hiddenAt - tabChangeAt) <= RECLAIM_WINDOW_MS) return 'tabChange';
  return undefined;
}
