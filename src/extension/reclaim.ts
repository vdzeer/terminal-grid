// Some extensions give focus "back to the terminal" with `activeTerminal.show()`
// right after they open or close an editor tab: AI coding agents do it whenever
// they show a proposed edit as a diff, and again when the edit is accepted,
// rejected or its tab closed. With the grid in the bottom panel the active terminal is
// usually the Terminal-tab twin of a grid shell, so that call switches the panel
// to the Terminal tab and hides the grid while the user works in it. A switch
// that close to a tab change is not the user's, so the grid takes the panel back.
// The two events can arrive in either order; whichever comes second decides.
// Kept free of `vscode` so it can be unit tested.

/** How far apart a tab change and the grid being hidden may be to count as one push. */
export const RECLAIM_WINDOW_MS = 1500;
/** At most this many times per tab change, so the grid never fights in a loop. */
export const RECLAIM_LIMIT = 3;

export interface ReclaimState {
  /** When an editor tab last opened or closed while the grid was on screen (or had just left it). */
  tabChangeAt: number | undefined;
  /** When the grid in the bottom panel was last hidden. */
  hiddenAt: number | undefined;
  /** Times the grid was already brought back after that tab change. */
  reclaims: number;
  /** When the extension itself last closed the panel (leaving grid mode for an editor). */
  ownHideAt: number | undefined;
}

export const noReclaim = (): ReclaimState => ({ tabChangeAt: undefined, hiddenAt: undefined, reclaims: 0, ownHideAt: undefined });

/** A tab change counts while the grid is on screen or was hidden moments ago. */
export function tabChangeCounts(gridVisible: boolean, hiddenAt: number | undefined, now: number): boolean {
  return gridVisible || (hiddenAt !== undefined && now - hiddenAt <= RECLAIM_WINDOW_MS);
}

export function shouldReclaim(state: ReclaimState, gridVisible: boolean, activeTerminalInGrid: boolean): boolean {
  const { tabChangeAt, hiddenAt, reclaims, ownHideAt } = state;
  if (gridVisible || !activeTerminalInGrid || tabChangeAt === undefined || hiddenAt === undefined) return false;
  if (reclaims >= RECLAIM_LIMIT) return false;
  if (Math.abs(hiddenAt - tabChangeAt) > RECLAIM_WINDOW_MS) return false;
  // The grid was hidden on purpose: opening a file in grid mode closes the panel.
  if (ownHideAt !== undefined && Math.abs(hiddenAt - ownHideAt) <= RECLAIM_WINDOW_MS) return false;
  return true;
}
