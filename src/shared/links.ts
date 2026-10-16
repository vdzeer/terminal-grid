// Finds file paths in a line of terminal output, such as `src/app.ts:12:5`,
// `./run.sh`, `/Users/me/notes.md` or `main.py(3,1)`. Whether the file really
// exists is checked by the extension when the link is clicked.

export interface FileLink {
  /** String index where the link starts (inclusive). */
  start: number;
  /** String index where the link ends (exclusive), suffix included. */
  end: number;
  path: string;
  line?: number;
  column?: number;
}

const KNOWN_EXTENSIONS = new Set(
  (
    'ts tsx js jsx mjs cjs json jsonc md mdx py go rs java kt kts swift rb php c h cc cpp hpp cs css scss sass less ' +
    'html htm vue svelte astro yml yaml toml ini cfg conf sh bash zsh fish txt lock xml sql env gradle dart m mm ' +
    'plist log csv tsv graphql gql proto lua ex exs erl hs ml scala clj r jl tf hcl nix dockerfile makefile'
  ).split(' '),
);

const TOKEN = /[~\w@.+\-/]+/g;
const EXTENSION = /\.([A-Za-z][A-Za-z0-9]{0,9})$/;

function acceptToken(token: string, hasPosition: boolean): boolean {
  if (token.startsWith('//')) return false; // the rest of a URL
  if (!/[A-Za-z0-9]/.test(token)) return false;
  const ext = EXTENSION.exec(token)?.[1]?.toLowerCase();
  if (token.includes('/')) {
    if (/^(?:\/|\.{1,2}\/|~\/)/.test(token)) return token.replace(/^[~.]*\/+/, '').length > 0;
    return ext !== undefined;
  }
  if (ext === undefined) return false;
  if (!/[A-Za-z_]/.test(token.slice(0, token.length - ext.length - 1))) return false;
  return hasPosition || KNOWN_EXTENSIONS.has(ext);
}

export function findFileLinks(text: string): FileLink[] {
  const links: FileLink[] = [];
  const urls = [...text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi)].map((m) => [m.index, m.index + m[0].length] as const);
  for (const match of text.matchAll(TOKEN)) {
    let token = match[0];
    const start = match.index;
    // Sentence punctuation after a path is not part of it.
    const trimmed = token.replace(/[.,;:]+$/, '');
    token = trimmed;
    let end = start + token.length;
    if (urls.some(([from, to]) => start < to && end > from)) continue;

    const rest = text.slice(end);
    const colon = /^:(\d+)(?::(\d+))?/.exec(rest);
    const paren = colon ? null : /^\((\d+)(?:,\s*(\d+))?\)/.exec(rest);
    const position = colon ?? paren;
    if (!acceptToken(token, position !== null)) continue;

    const link: FileLink = { start, end, path: token };
    if (position) {
      link.line = Number(position[1]);
      if (position[2] !== undefined) link.column = Number(position[2]);
      end += position[0].length;
      link.end = end;
    }
    links.push(link);
  }
  return links;
}
