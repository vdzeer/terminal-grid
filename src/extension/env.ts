import * as path from 'node:path';

// Pure helpers for starting a shell: which binary, which arguments, which
// environment. Kept free of `vscode` so they can be unit tested.

const DROPPED_KEYS = [/^ELECTRON_/, /^VSCODE_/, /^CHROME_CRASHPAD/, /^APPLICATION_INSIGHTS/, /^ORIGINAL_XDG_CURRENT_DESKTOP$/];

export interface EnvOptions {
  /** Locale like `uk-UA`, used only when `LANG` is missing. */
  locale: string;
  appVersion: string;
  /** `terminal.integrated.env.<platform>`: a `null` value removes the variable. */
  overrides: Record<string, string | null>;
}

export function buildEnv(base: Record<string, string | undefined>, options: EnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || DROPPED_KEYS.some((re) => re.test(key))) continue;
    env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'vscode';
  env.TERM_PROGRAM_VERSION = options.appVersion;
  if (!env.LANG || !/utf-?8/i.test(env.LANG)) env.LANG = unixLocale(options.locale);
  for (const [key, value] of Object.entries(options.overrides)) {
    if (value === null) delete env[key];
    else env[key] = expandVariables(value, env);
  }
  return env;
}

/** `uk-UA` → `uk_UA.UTF-8`; anything unusual falls back to `en_US.UTF-8`. */
export function unixLocale(locale: string): string {
  const match = /^([a-z]{2})[-_]([A-Z]{2})/.exec(locale);
  return match ? `${match[1]}_${match[2]}.UTF-8` : 'en_US.UTF-8';
}

/** Supports `${env:NAME}` the way the integrated terminal settings do. */
function expandVariables(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{env:([^}]+)\}/g, (_m, name: string) => env[name] ?? '');
}

export function resolveShell(configured: string, detected: string | undefined, envShell: string | undefined, platform: string): string {
  if (configured.trim()) return configured.trim();
  if (detected && detected.trim()) return detected;
  if (envShell) return envShell;
  return platform === 'win32' ? 'powershell.exe' : '/bin/zsh';
}

/** macOS terminals start login shells, like Terminal.app and VS Code do. */
export function defaultShellArgs(shell: string, platform: string): string[] {
  if (platform !== 'darwin') return [];
  const name = path.basename(shell);
  return ['zsh', 'bash', 'fish', 'sh'].includes(name) ? ['-l'] : [];
}

/** The tile title falls back to the shell name; `-zsh` style login names are cleaned. */
export function processLabel(name: string, shell: string): string {
  const clean = path.basename(name.replace(/^-/, '').trim());
  return clean || path.basename(shell);
}

/** True when something other than the shell itself is in the foreground. */
export function hasChildProcess(foreground: string, shell: string): boolean {
  const name = path.basename(foreground.replace(/^-/, '').trim());
  if (!name) return false;
  return name !== path.basename(shell) && name !== path.basename(shell, '.exe');
}
