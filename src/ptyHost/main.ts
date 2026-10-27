import { appendFileSync, chmodSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { loadNodePty } from '../extension/nodePty';
import { servePtyHost } from './server';

// Entry of the pty host process: `ptyHost.js <socket> <editor appRoot>`,
// started detached by the extension with the editor's own Electron as Node.
// See server.ts.

const [socketPath, appRoot] = process.argv.slice(2);
if (!socketPath || !appRoot) process.exit(2);

const logFile = socketPath.replace(/\.sock$/, '') + '.log';
try {
  if (statSync(logFile).size > 256 * 1024) writeFileSync(logFile, '');
} catch {
  // No log yet.
}
const log = (line: string) => {
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${process.pid} ${line}\n`);
  } catch {
    // Logging is best effort.
  }
};

process.title = 'Terminal Grid pty host';
// One bad message must not take every shell down with it.
process.on('uncaughtException', (error) => log(`uncaught: ${error.stack ?? String(error)}`));

const nodePty = loadNodePty(appRoot);
// Only started after a connect failed, so a socket file left here belongs to a host that is gone.
rmSync(socketPath, { force: true });
const server = servePtyHost({
  spawn: (file, args, options) => nodePty.spawn(file, args, options),
  exit: () => {
    rmSync(socketPath, { force: true });
    process.exit(0);
  },
  log,
});
server.listen(socketPath, () => {
  chmodSync(socketPath, 0o600);
  log(`listening on ${socketPath}`);
});
