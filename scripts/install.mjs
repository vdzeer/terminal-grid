// Installs dist/terminal-grid.vsix into Antigravity IDE through its CLI.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

const candidates = [
  `${homedir()}/.antigravity-ide/antigravity-ide/bin/antigravity-ide`,
  '/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide',
];
const cli = candidates.find((path) => existsSync(path)) ?? 'antigravity-ide';
const result = spawnSync(cli, ['--install-extension', 'dist/terminal-grid.vsix', '--force'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
