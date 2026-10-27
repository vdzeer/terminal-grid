// Bundles the extension (Node, CommonJS) and the webview (browser, IIFE).
import * as esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'linked',
  legalComments: 'none',
  logLevel: 'info',
};

const builds = [
  {
    ...common,
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['src/ptyHost/main.ts'],
    outfile: 'dist/ptyHost.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
  },
  {
    ...common,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
  },
  {
    ...common,
    sourcemap: false,
    entryPoints: ['src/webview/style.css'],
    outfile: 'dist/webview.css',
  },
];

await mkdir('dist', { recursive: true });
await copyFile('node_modules/@xterm/xterm/css/xterm.css', 'dist/xterm.css');

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
