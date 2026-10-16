// The "Terminal Grid" terminal profile as the editor's default. It is never
// set without asking: the extension asks once, and a command does it later.

/** The profile title in package.json, which is what the setting stores. */
export const PROFILE_NAME = 'Terminal Grid';
/** globalState: the question was asked (or did not need asking). */
export const PROFILE_ASKED_KEY = 'terminalGrid.defaultProfileAsked';
/** globalState of 0.2.x, which set the profile without asking. Its users are not asked again. */
export const LEGACY_PROFILE_KEY = 'terminalGrid.defaultProfileSet';

/** Suffix of `terminal.integrated.defaultProfile.<key>` for a platform. */
export function platformKey(platform: NodeJS.Platform): 'osx' | 'windows' | 'linux' {
  return platform === 'darwin' ? 'osx' : platform === 'win32' ? 'windows' : 'linux';
}

/** Asked on the first start only; `legacy` users already had it set without a question. */
export function shouldOfferDefaultProfile(state: {
  legacy: boolean;
  /** The user's current `terminal.integrated.defaultProfile.<platform>`. */
  current: string | undefined;
}): boolean {
  return !state.legacy && state.current !== PROFILE_NAME;
}
