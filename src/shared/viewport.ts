// Layout measurements from the webview's size, used by the grid mode.

export interface Viewport {
  width: number;
  height: number;
  outerWidth: number;
  outerHeight: number;
}

/**
 * A maximized panel takes almost the whole window height. `undefined` when
 * the window size is unknown (a window that is not on screen reports 0).
 */
export function looksMaximized(v: Viewport | undefined): boolean | undefined {
  if (!v || v.outerHeight <= 0) return undefined;
  return v.height / v.outerHeight > 0.7;
}

/** The secondary side bar was open if hiding it made the panel noticeably wider. */
export function sideBarWasOpen(before: Viewport | undefined, after: Viewport | undefined): boolean {
  return !!before && !!after && after.width - before.width > 40;
}
