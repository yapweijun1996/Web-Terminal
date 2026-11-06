'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { createUploadTargets } = require('../runtime/upload-target');

const available = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

test('Mac window controls preserve identity, consent target and the last window', { skip: !available }, async t => {
  const server = `wt-window-test-${randomUUID()}`;
  const view = randomUUID();
  const session = `view-${view}-1`;
  const tmux = (...args) => execFileSync('tmux', ['-L', server, '-f', '/dev/null', ...args], { encoding: 'utf8' }).trim();
  let client;
  try {
    tmux('new-session', '-d', '-s', 'workspace');
    tmux('new-window', '-d', '-t', 'workspace', '-n', 'disposable');
    tmux('new-session', '-d', '-t', 'workspace', '-s', session);
    tmux('new-session', '-d', '-s', 'foreign');
    const foreignWindow = tmux('display-message', '-p', '-t', 'foreign', '#{window_id}');
    client = spawn('tmux', ['-L', server, '-C', 'attach-session', '-t', session]);
    client.stdout.resume(); client.stderr.resume();
    for (let i = 0; i < 100; i++) {
      if (tmux('display-message', '-p', '-t', session, '#{session_attached}') === '1') break;
      await delay(20);
    }
    assert.equal(tmux('display-message', '-p', '-t', session, '#{session_attached}'), '1');
    const [sessionId, pane, serverPid] = tmux('display-message', '-p', '-t', session, '#{session_id}|#{pane_id}|#{pid}').split('|');
    const survivorPid = tmux('display-message', '-p', '-t', pane, '#{pane_pid}');
    const targets = createUploadTargets(server);
    const invoke = (action = 'list', windowId, overrides = {}) => targets.windows(
      overrides.view ?? view, overrides.session ?? session, overrides.sessionId ?? sessionId,
      overrides.pane ?? pane, overrides.serverPid ?? serverPid, action, windowId, overrides.browserTabs ?? false);
    const original = (await invoke()).windows;
    const survivor = original.find(w => w.active);
    const disposable = original.find(w => !w.active);
    assert.equal(original.length, 2);

    await t.test('rejects stale server, stale session, foreign view and foreign window', async () => {
      for (const overrides of [{ serverPid: String(Number(serverPid) + 1) }, { sessionId: '$999999' }, { view: randomUUID() }]) {
        await assert.rejects(invoke('close', disposable.id, overrides));
      }
      await assert.rejects(invoke('close', foreignWindow));
      assert.equal((await invoke()).windows.length, 2);
      assert.equal(tmux('display-message', '-p', '-t', 'foreign', '#{window_id}'), foreignWindow);
    });

    await t.test('browser tabs hide only their view and native restore survives unavailable lists', async () => {
      await invoke('list', undefined, { browserTabs: true });
      assert.equal(tmux('show-options', '-Av', '-t', sessionId, 'status'), 'off');
      assert.equal(tmux('show-options', '-Av', '-t', 'workspace', 'status'), 'on');
      assert.equal(tmux('show-options', '-Av', '-t', 'foreign', 'status'), 'on');
      await invoke('native');
      tmux('set-option', '-t', sessionId, 'status', '2');
      await invoke('list', undefined, { browserTabs: true });
      await invoke('native');
      assert.equal(tmux('show-options', '-Av', '-t', sessionId, 'status'), '2');
      tmux('set-option', '-t', sessionId, 'status', 'on');
      await invoke('list', undefined, { browserTabs: true });
      const extra = [];
      try {
        for (let i = 0; i < 99; i++) extra.push(tmux('new-window', '-d', '-P', '-F', '#{window_id}', '-t', sessionId));
        await assert.rejects(invoke('list'));
        assert.deepEqual(await invoke('native'), { restored: true });
        assert.equal(tmux('show-options', '-Av', '-t', sessionId, 'status'), 'on');
      } finally { for (const id of extra) tmux('kill-window', '-t', id); }
    });

    await t.test('window names cannot create invented window rows', async () => {
      tmux('rename-window', '-t', disposable.id, 'fixture\n@999999|3|1|invented');
      const windows = (await invoke()).windows;
      assert.equal(windows.length, 2);
      assert.ok(windows.every(w => !/[\r\n]/.test(w.name)));
      const name = windows.find(w => w.id === disposable.id).name;
      assert.ok(name.startsWith('fixture'));
      assert.ok(name.endsWith('@999999|3|1|invented'));
    });

    await t.test('closes the captured inactive window and preserves another pane process', async () => {
      await invoke('select', disposable.id);
      await invoke('select', survivor.id);
      await invoke('close', disposable.id);
      assert.equal((await invoke()).windows.length, 1);
      assert.equal(tmux('display-message', '-p', '-t', pane, '#{pane_pid}'), survivorPid);
      assert.equal(tmux('list-windows', '-t', 'workspace', '-F', '#{window_id}'), survivor.id);
    });

    await t.test('a replacement at the same numeric index does not inherit consent', async () => {
      const replacement = tmux('new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${sessionId}:${disposable.index}`, '-n', 'replacement');
      assert.notEqual(replacement, disposable.id);
      await assert.rejects(invoke('close', disposable.id));
      assert.ok((await invoke()).windows.some(w => w.id === replacement));
      await invoke('close', replacement);
    });

    await t.test('concurrent closes leave at least one window and sole-window selection works', async () => {
      const other = tmux('new-window', '-d', '-P', '-F', '#{window_id}', '-t', sessionId);
      await Promise.allSettled([invoke('close', survivor.id), invoke('close', other)]);
      const windows = tmux('list-windows', '-t', sessionId, '-F', '#{window_id}').split('\n');
      assert.equal(windows.length, 1);
      const [currentPane] = tmux('list-panes', '-t', sessionId, '-F', '#{pane_id}').split('\n');
      const current = { pane: currentPane };
      await assert.rejects(invoke('close', windows[0], current));
      await invoke('select', windows[0], current);
    });
  } finally {
    client?.stdin.end();
    try { tmux('kill-server'); } catch { /* Only this disposable server is cleaned. */ }
  }
});
