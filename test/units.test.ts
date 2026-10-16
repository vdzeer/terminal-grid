import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { parseLsof } from '../src/extension/cwd';
import { buildEnv, defaultShellArgs, hasChildProcess, processLabel, resolveShell, unixLocale } from '../src/extension/env';
import { loadNodePty, nodePtyCandidates } from '../src/extension/nodePty';
import { PROFILE_NAME, platformKey, shouldOfferDefaultProfile } from '../src/extension/profile';
import { readState } from '../src/extension/store';
import { RECLAIM_LIMIT, RECLAIM_WINDOW_MS, shouldReclaim, tabChangeCounts } from '../src/extension/reclaim';
import { dictionaries, languageFor, translator } from '../src/shared/i18n';
import { matchShortcut } from '../src/shared/keys';
import { findFileLinks } from '../src/shared/links';
import { looksMaximized, sideBarWasOpen } from '../src/shared/viewport';

describe('file links', () => {
  const paths = (text: string) => findFileLinks(text).map((l) => [l.path, l.line, l.column]);

  it('finds relative paths with positions', () => {
    assert.deepEqual(paths('error in src/app.ts:12:5 here'), [['src/app.ts', 12, 5]]);
    assert.deepEqual(paths('src/app.ts(3,7): error TS2322'), [['src/app.ts', 3, 7]]);
  });

  it('finds explicit paths without an extension', () => {
    assert.deepEqual(paths('cd /usr/local/bin'), [['/usr/local/bin', undefined, undefined]]);
    assert.deepEqual(paths('see ~/Projects and ./run.sh.'), [
      ['~/Projects', undefined, undefined],
      ['./run.sh', undefined, undefined],
    ]);
  });

  it('accepts bare names only for known extensions or with a line', () => {
    assert.deepEqual(paths('edit package.json now'), [['package.json', undefined, undefined]]);
    assert.deepEqual(paths('e.g. this, v1.2.3 and example.com'), []);
    assert.deepEqual(paths('thing.weird:4'), [['thing.weird', 4, undefined]]);
  });

  it('skips URLs', () => {
    assert.deepEqual(paths('open https://example.com/docs/page.html now'), []);
  });

  it('reports string ranges that include the position suffix', () => {
    const [link] = findFileLinks('at lib/x.py:10');
    assert.equal(link?.start, 3);
    assert.equal(link?.end, 14);
  });
});

describe('shell environment', () => {
  const options = { locale: 'uk-UA', appVersion: '1.107.0', overrides: {} };

  it('drops editor internals and sets terminal variables', () => {
    const env = buildEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', VSCODE_IPC_HOOK: 'x', HOME: '/h' }, options);
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(env.VSCODE_IPC_HOOK, undefined);
    assert.equal(env.PATH, '/bin');
    assert.equal(env.TERM, 'xterm-256color');
    assert.equal(env.COLORTERM, 'truecolor');
    assert.equal(env.LANG, 'uk_UA.UTF-8');
  });

  it('keeps an existing UTF-8 LANG', () => {
    assert.equal(buildEnv({ LANG: 'en_GB.UTF-8' }, options).LANG, 'en_GB.UTF-8');
  });

  it('applies overrides, with null removing and ${env:} expanding', () => {
    const env = buildEnv({ PATH: '/bin', FOO: 'x' }, { ...options, overrides: { FOO: null, PATH: '/opt:${env:PATH}' } });
    assert.equal(env.FOO, undefined);
    assert.equal(env.PATH, '/opt:/bin');
  });

  it('maps locales', () => {
    assert.equal(unixLocale('en-US'), 'en_US.UTF-8');
    assert.equal(unixLocale('weird'), 'en_US.UTF-8');
  });

  it('picks the shell and login arguments', () => {
    assert.equal(resolveShell(' /bin/bash ', '/bin/zsh', undefined, 'darwin'), '/bin/bash');
    assert.equal(resolveShell('', '/bin/zsh', '/bin/sh', 'darwin'), '/bin/zsh');
    assert.equal(resolveShell('', undefined, undefined, 'darwin'), '/bin/zsh');
    assert.deepEqual(defaultShellArgs('/bin/zsh', 'darwin'), ['-l']);
    assert.deepEqual(defaultShellArgs('/opt/homebrew/bin/nu', 'darwin'), []);
    assert.deepEqual(defaultShellArgs('/bin/bash', 'linux'), []);
  });

  it('labels processes and spots child processes', () => {
    assert.equal(processLabel('-zsh', '/bin/zsh'), 'zsh');
    assert.equal(processLabel('', '/bin/zsh'), 'zsh');
    assert.equal(processLabel('/bin/zsh', '/bin/zsh'), 'zsh');
    assert.equal(hasChildProcess('/bin/zsh', '/bin/zsh'), false);
    assert.equal(hasChildProcess('zsh', '/bin/zsh'), false);
    assert.equal(hasChildProcess('-zsh', '/bin/zsh'), false);
    assert.equal(hasChildProcess('node', '/bin/zsh'), true);
  });
});

describe('node-pty from the editor install', () => {
  it('tries the plain folder, then the asar archive, then the unpacked folder', () => {
    const root = path.join('/', 'app');
    assert.deepEqual(nodePtyCandidates(root), [
      path.join(root, 'node_modules', 'node-pty'),
      path.join(root, 'node_modules.asar', 'node-pty'),
      path.join(root, 'node_modules.asar.unpacked', 'node-pty'),
    ]);
  });

  it('skips an incomplete copy and explains what it tried', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tg-pty-'));
    try {
      assert.throws(() => loadNodePty(root), (error: Error) => error.message.includes('not found') && error.message.includes(root));
      // Like VS Code's node_modules.asar.unpacked: native parts only, no JavaScript entry.
      const unpacked = path.join(root, 'node_modules.asar.unpacked', 'node-pty');
      mkdirSync(path.join(unpacked, 'build'), { recursive: true });
      writeFileSync(path.join(unpacked, 'package.json'), JSON.stringify({ name: 'node-pty', main: './lib/index.js' }));
      assert.throws(() => loadNodePty(root), (error: Error) => error.message.includes(unpacked));
      const plain = path.join(root, 'node_modules', 'node-pty');
      mkdirSync(plain, { recursive: true });
      writeFileSync(path.join(plain, 'index.js'), 'exports.spawn = () => "fake";');
      assert.equal(typeof loadNodePty(root).spawn, 'function');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('default terminal profile', () => {
  it('maps platforms to setting keys', () => {
    assert.equal(platformKey('darwin'), 'osx');
    assert.equal(platformKey('win32'), 'windows');
    assert.equal(platformKey('linux'), 'linux');
  });

  it('asks only when the profile is not the default yet and 0.2.x did not set it', () => {
    assert.equal(shouldOfferDefaultProfile({ legacy: false, current: undefined }), true);
    assert.equal(shouldOfferDefaultProfile({ legacy: false, current: 'zsh' }), true);
    assert.equal(shouldOfferDefaultProfile({ legacy: false, current: PROFILE_NAME }), false);
    assert.equal(shouldOfferDefaultProfile({ legacy: true, current: 'zsh' }), false);
  });

  it('uses the title the manifest gives the profile', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { contributes: { terminal: { profiles: { title: string }[] } } };
    assert.equal(manifest.contributes.terminal.profiles[0]?.title, PROFILE_NAME);
  });
});

describe('lsof parsing', () => {
  it('maps pids to their cwd', () => {
    const out = 'p101\nfcwd\nn/Users/me/a\np202\nfcwd\nn/tmp/b c\n';
    assert.deepEqual([...parseLsof(out)], [
      [101, '/Users/me/a'],
      [202, '/tmp/b c'],
    ]);
  });
});

describe('stored state', () => {
  it('reads valid state and drops broken entries', () => {
    const state = readState({
      version: 1,
      layout: { kind: 'leaf', id: 'a' },
      terminals: [{ id: 'a', cwd: '/x', customTitle: 'api', snapshot: 's', cols: 120, rows: 40 }, { id: 'a' }, null, { cwd: '/y' }, { id: 'b', cols: 1e9 }],
    });
    assert.equal(state?.terminals.length, 2);
    assert.deepEqual(state?.terminals[0], { id: 'a', cwd: '/x', customTitle: 'api', snapshot: 's', cols: 120, rows: 40 });
    assert.deepEqual(state?.terminals[1], { id: 'b', cwd: '', customTitle: '', snapshot: '', cols: 80, rows: 24 });
  });

  it('rejects unknown versions', () => {
    assert.equal(readState({ version: 2, terminals: [] }), undefined);
    assert.equal(readState(undefined), undefined);
  });
});

describe('i18n', () => {
  it('has the same keys and placeholders in every language', () => {
    const en = dictionaries.en;
    for (const [language, dict] of Object.entries(dictionaries)) {
      assert.deepEqual(Object.keys(dict).sort(), Object.keys(en).sort(), language);
      for (const key of Object.keys(en) as (keyof typeof en)[]) {
        const placeholders = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort();
        assert.deepEqual(placeholders(dict[key]), placeholders(en[key]), `${language}.${key}`);
      }
    }
  });

  it('follows the Ukrainian copy rules', () => {
    for (const [key, value] of Object.entries(dictionaries.uk)) {
      assert.ok(!value.includes('!'), `uk.${key} has an exclamation mark`);
      assert.ok(!value.includes("'"), `uk.${key} uses ' instead of ʼ`);
      assert.ok(!/\p{Extended_Pictographic}/u.test(value), `uk.${key} has an emoji`);
    }
  });

  it('manifest strings have the same keys', () => {
    const en = JSON.parse(readFileSync('package.nls.json', 'utf8')) as Record<string, string>;
    const uk = JSON.parse(readFileSync('package.nls.uk.json', 'utf8')) as Record<string, string>;
    assert.deepEqual(Object.keys(uk).sort(), Object.keys(en).sort());
    const manifest = readFileSync('package.json', 'utf8');
    for (const key of manifest.match(/%([\w.]+)%/g) ?? []) assert.ok(key.slice(1, -1) in en, key);
  });

  it('names no particular editor', () => {
    for (const [language, dict] of Object.entries(dictionaries)) {
      for (const [key, value] of Object.entries(dict)) assert.ok(!/Antigravity|VS Code|Cursor/.test(value), `${language}.${key}`);
    }
  });

  it('formats placeholders and picks the language', () => {
    assert.equal(translator('uk')('resultCount', 2, 9), '2 з 9');
    assert.equal(languageFor('uk'), 'uk');
    assert.equal(languageFor('en-us'), 'en');
    assert.equal(languageFor(undefined), 'en');
  });
});

describe('shortcuts', () => {
  const key = (k: Partial<Parameters<typeof matchShortcut>[0]>) => ({ key: '', code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...k });

  it('uses Cmd on macOS', () => {
    assert.equal(matchShortcut(key({ code: 'KeyD', metaKey: true }), true), 'splitRight');
    assert.equal(matchShortcut(key({ code: 'KeyD', metaKey: true, shiftKey: true }), true), 'splitDown');
    assert.equal(matchShortcut(key({ key: 'Enter', metaKey: true, shiftKey: true }), true), 'zoom');
    assert.equal(matchShortcut(key({ key: 'ArrowLeft', metaKey: true, altKey: true }), true), 'focusLeft');
    assert.equal(matchShortcut(key({ code: 'KeyC', metaKey: true }), true), undefined);
  });

  it('leaves plain Ctrl keys to the shell', () => {
    assert.equal(matchShortcut(key({ code: 'KeyD', ctrlKey: true }), true), undefined);
    assert.equal(matchShortcut(key({ code: 'KeyD', ctrlKey: true }), false), undefined);
    assert.equal(matchShortcut(key({ code: 'KeyD', ctrlKey: true, shiftKey: true }), false), 'splitRight');
  });
});

describe('grid mode measurements', () => {
  const view = (width: number, height: number) => ({ width, height, outerWidth: 1440, outerHeight: 900 });

  it('tells a maximized panel from a normal one', () => {
    assert.equal(looksMaximized(view(1000, 780)), true);
    assert.equal(looksMaximized(view(1000, 300)), false);
    assert.equal(looksMaximized(undefined), undefined);
    assert.equal(looksMaximized({ width: 1, height: 1, outerWidth: 0, outerHeight: 0 }), undefined);
  });

  it('notices the secondary side bar closing', () => {
    assert.equal(sideBarWasOpen(view(900, 300), view(1200, 300)), true);
    assert.equal(sideBarWasOpen(view(900, 300), view(905, 300)), false);
    assert.equal(sideBarWasOpen(undefined, view(1200, 300)), false);
  });
});

describe('taking the panel back after a tool showed a terminal', () => {
  const at = 10_000;
  const state = { tabChangeAt: at, hiddenAt: at + 50, reclaims: 0, ownHideAt: undefined };

  it('takes it back when the grid is hidden right after an editor tab opened or closed, in either order', () => {
    assert.equal(shouldReclaim(state, false, true), true);
    assert.equal(shouldReclaim({ ...state, hiddenAt: at - 400 }, false, true), true);
    assert.equal(shouldReclaim({ ...state, hiddenAt: at + RECLAIM_WINDOW_MS }, false, true), true);
  });

  it('leaves it when the grid is on screen, the terminal is not in the grid, or the events are far apart', () => {
    assert.equal(shouldReclaim(state, true, true), false);
    assert.equal(shouldReclaim(state, false, false), false);
    assert.equal(shouldReclaim({ ...state, hiddenAt: at + RECLAIM_WINDOW_MS + 1 }, false, true), false);
    assert.equal(shouldReclaim({ ...state, tabChangeAt: undefined }, false, true), false);
  });

  it('never fights a hide of its own or in a loop', () => {
    assert.equal(shouldReclaim({ ...state, ownHideAt: at + 40 }, false, true), false);
    assert.equal(shouldReclaim({ ...state, reclaims: RECLAIM_LIMIT }, false, true), false);
  });

  it('counts a tab change while the grid is on screen or just left it', () => {
    assert.equal(tabChangeCounts(true, undefined, at), true);
    assert.equal(tabChangeCounts(false, at - 200, at), true);
    assert.equal(tabChangeCounts(false, at - RECLAIM_WINDOW_MS - 1, at), false);
    assert.equal(tabChangeCounts(false, undefined, at), false);
  });
});
