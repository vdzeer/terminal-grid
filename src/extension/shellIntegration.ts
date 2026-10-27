import { copyFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

// Shell integration for grid shells: the editor's own scripts, started the way
// the editor starts them for its terminals. They mark every prompt and the
// exit code of every command (OSC 633), which the tiles turn into marks in the
// gutter and jumps between commands. Kept free of `vscode` so it can be tested.

const SCRIPTS = 'out/vs/workbench/contrib/terminal/common/scripts';
const ZSH_FILES: [string, string][] = [
  ['shellIntegration-rc.zsh', '.zshrc'],
  ['shellIntegration-profile.zsh', '.zprofile'],
  ['shellIntegration-env.zsh', '.zshenv'],
  ['shellIntegration-login.zsh', '.zlogin'],
];

export interface Launch {
  args: string[];
  env: Record<string, string>;
}

/**
 * Arguments and environment that start the shell with the scripts, or
 * undefined for shells and arguments they do not cover (as in the editor).
 */
export function withShellIntegration(
  shell: string,
  args: string[],
  env: Record<string, string>,
  appRoot: string,
  zdotdir: string | undefined,
): Launch | undefined {
  const login = args.length === 1 && (args[0] === '-l' || args[0] === '--login');
  if (args.length > 0 && !login) return undefined;
  const injected = { ...env, VSCODE_INJECTION: '1' };
  switch (path.basename(shell)) {
    case 'zsh': {
      // The scripts read the user's own dotfiles from here.
      const userZdotdir = env.ZDOTDIR || env.HOME;
      if (!zdotdir || !userZdotdir) return undefined;
      return { args: [login ? '-il' : '-i'], env: { ...injected, ZDOTDIR: zdotdir, USER_ZDOTDIR: userZdotdir } };
    }
    case 'bash':
      return {
        args: ['--init-file', path.join(appRoot, SCRIPTS, 'shellIntegration-bash.sh')],
        env: login ? { ...injected, VSCODE_SHELL_LOGIN: '1' } : injected,
      };
    default:
      return undefined;
  }
}

/** Puts the zsh scripts, under their dotfile names, into `<dir>/zsh`. */
export function prepareZdotdir(appRoot: string, dir: string): string | undefined {
  const zdotdir = path.join(dir, 'zsh');
  try {
    mkdirSync(zdotdir, { recursive: true, mode: 0o700 });
    for (const [from, to] of ZSH_FILES) copyFileSync(path.join(appRoot, SCRIPTS, from), path.join(zdotdir, to));
    return zdotdir;
  } catch {
    return undefined;
  }
}
