import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import type { Pty, SpawnOptions } from '../src/extension/nodePty';
import { PtyHostClient } from '../src/extension/ptyHostClient';
import { servePtyHost } from '../src/ptyHost/server';

// The pty host and its client over a real socket, with fake shells.

class FakePty implements Pty {
  static last: FakePty | undefined;
  readonly pid = 4242;
  process = 'zsh';
  written = '';
  killed = false;
  paused = false;
  private data = new Set<(data: string) => void>();
  private exit = new Set<(event: { exitCode: number }) => void>();
  constructor(readonly options: SpawnOptions) {
    FakePty.last = this;
  }
  onData(listener: (data: string) => void) {
    this.data.add(listener);
    return { dispose: () => void this.data.delete(listener) };
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.exit.add(listener);
    return { dispose: () => void this.exit.delete(listener) };
  }
  emit(data: string) {
    for (const listener of this.data) listener(data);
  }
  end(exitCode: number) {
    for (const listener of this.exit) listener({ exitCode });
  }
  write(data: string) {
    this.written += data;
  }
  resize() {}
  kill() {
    this.killed = true;
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
}

const dir = mkdtempSync(path.join(tmpdir(), 'tg-host-'));
const servers: { close(): void }[] = [];
after(() => {
  for (const server of servers) server.close();
  rmSync(dir, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, check: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = check();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`timed out: ${what}`);
}

function startHost(name: string, graceMs = 5000) {
  const socket = path.join(dir, `${name}.sock`);
  const state = { exited: false };
  const server = servePtyHost({ spawn: (_file, _args, options) => new FakePty(options), graceMs, exit: () => (state.exited = true) });
  server.listen(socket);
  servers.push(server);
  FakePty.last = undefined;
  return { socket, state };
}

const options = { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp', env: { HOME: '/tmp' } };

describe('pty host', () => {
  it('keeps a shell running and its screen while no window is connected', async () => {
    const { socket } = startHost('keep');
    const first = await PtyHostClient.open(socket, () => assert.fail('the host is already running'));
    assert.ok(first);
    const pty = first.spawn('a1', '/bin/zsh', ['-l'], options, 1000);
    let seen = '';
    pty.onData((data) => (seen += data));
    const shell = await until('spawn', () => FakePty.last);
    await until('pid', () => pty.pid === 4242);
    pty.write('ls\r');
    await until('input', () => shell.written === 'ls\r');
    shell.emit('\x1b]0;✳ Fix it\x07hello ');
    await until('output', () => seen.includes('hello'));

    first.release();
    await sleep(50);
    shell.emit('while away');
    assert.equal(shell.killed, false);

    const second = await PtyHostClient.open(socket, () => assert.fail('the host should still run'));
    assert.ok(second);
    const survivor = second.takeSurvivors().get('a1');
    assert.ok(survivor, 'the shell comes back');
    assert.match(survivor.screen, /hello while away/);
    assert.equal(survivor.title, '✳ Fix it');
    assert.equal(survivor.pty.pid, 4242);
    let later = '';
    survivor.pty.onData((data) => (later += data));
    shell.emit('after');
    await until('live output', () => later.includes('after'));
    let exitCode: number | undefined;
    survivor.pty.onExit((event) => (exitCode = event.exitCode));
    shell.end(3);
    await until('exit', () => exitCode === 3);
    second.release();
  });

  it('ends the shells when no window comes back in time, then exits', async () => {
    const { socket, state } = startHost('grace', 100);
    const client = await PtyHostClient.open(socket, () => {});
    assert.ok(client);
    client.spawn('b1', '/bin/zsh', [], options, 1000);
    const shell = await until('spawn', () => FakePty.last);
    client.release();
    await until('killed', () => shell.killed);
    await until('exit', () => state.exited);
  });

  it('a newer window takes over and gets the output from then on', async () => {
    const { socket } = startHost('takeover');
    const old = await PtyHostClient.open(socket, () => {});
    assert.ok(old);
    old.spawn('c1', '/bin/zsh', [], options, 1000);
    const shell = await until('spawn', () => FakePty.last);
    await sleep(30);
    const fresh = await PtyHostClient.open(socket, () => {});
    assert.ok(fresh);
    const survivor = fresh.takeSurvivors().get('c1');
    assert.ok(survivor);
    let seen = '';
    survivor.pty.onData((data) => (seen += data));
    survivor.pty.pause();
    await until('paused', () => shell.paused);
    survivor.pty.resume();
    await until('resumed', () => !shell.paused);
    shell.emit('to the new one');
    await until('output', () => seen.includes('to the new one'));
    survivor.pty.kill();
    await until('killed', () => shell.killed);
    old.release();
    fresh.release();
  });
});
