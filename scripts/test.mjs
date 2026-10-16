// Bundles test/*.test.ts with esbuild and runs them with the Node test runner.
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';

const files = (await readdir('test')).filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`);
await rm('.test-out', { recursive: true, force: true });
await esbuild.build({
  entryPoints: files,
  outdir: '.test-out',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  logLevel: 'warning',
});
const outputs = (await readdir('.test-out')).filter((f) => f.endsWith('.test.mjs')).map((f) => `.test-out/${f}`);
const result = spawnSync(process.execPath, ['--test', ...outputs], { stdio: 'inherit' });
process.exit(result.status ?? 1);
