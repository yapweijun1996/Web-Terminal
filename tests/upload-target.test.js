'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { createUploadTargets } = require('../runtime/upload-target');

const available = typeof WebSocket === 'function' &&
  ['tmux', 'ttyd'].every(binary => spawnSync(binary, ['-V'], { stdio: 'ignore' }).status === 0 ||
    spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0);

test('attach rejects untrusted or multiple URL arguments before accessing tmux', () => {
  const attach = path.resolve(__dirname, '../runtime/attach.sh');
  const env = { ...process.env, WEB_TERMINAL_TMUX_SERVER: 'unused', WEB_TERMINAL_START_DIR: os.tmpdir(), TMUX_BIN: '/usr/bin/false' };
  const uuid = randomUUID();
  for (const args of [['--help'], [uuid + '\n' + uuid], [uuid, uuid], ['$(touch /tmp/not-run)']]) {
    const result = spawnSync(attach, args, { env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid view ID/);
  }
});

test('bound upload targets survive window switching and fail closed on pane or session loss', { skip: !available }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-terminal-target-'));
  const server = `wt006-test-${randomUUID()}`;
  const view = randomUUID();
  const attach = path.resolve(__dirname, '../runtime/attach.sh');
  const env = { ...process.env, WEB_TERMINAL_TMUX_SERVER: server, WEB_TERMINAL_START_DIR: root };
  const tmux = (...args) => execFileSync('tmux', ['-L', server, ...args], { env, encoding: 'utf8' }).trim();
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  let child, socket;
  try {
    tmux('new-session', '-d', '-s', 'workspace', '-c', root, 'sh');
    child = spawn('ttyd', ['--interface', '127.0.0.1', '--port', String(port), '--url-arg', '--writable', attach], { env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      const probe = net.connect(port, '127.0.0.1');
      const ready = await new Promise(resolve => { probe.once('connect', () => { probe.destroy(); resolve(true); }); probe.once('error', () => resolve(false)); });
      if (ready) break;
      if (child.exitCode !== null) throw Error('ttyd exited before listening');
      await delay(25);
    }
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws?arg=${view}`, ['tty']);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.send(JSON.stringify({ AuthToken: '', columns: 80, rows: 24 }));
    let session;
    for (let i = 0; i < 100; i++) {
      session = tmux('list-sessions', '-F', '#{session_name}|#{session_attached}')
        .split('\n').find(line => line.startsWith(`view-${view}-`) && line.endsWith('|1'))?.split('|')[0];
      if (session) break;
      await delay(25);
    }
    assert.ok(session, 'the view must correspond to an attached ttyd session');
    const [sessionId, pane, serverPid] = tmux('display-message', '-p', '-t', `=${session}:`, '#{session_id}|#{pane_id}|#{pid}').split('|');
    const other = tmux('new-window', '-d', '-P', '-F', '#{pane_id}', '-t', `=${session}`, 'sh');
    const target = createUploadTargets(server);
    assert.equal((await target.capture(view, session, sessionId, '%999999', serverPid)).target, null, 'unknown panes fail closed');
    assert.equal((await target.capture(randomUUID(), session, sessionId, pane, serverPid)).target, null, 'another view cannot select this session');
    assert.equal((await target.capture(view, session, sessionId, pane, '999999')).target, null, 'stale tmux server metadata fails closed');
    // The server receives the request after the active window has changed;
    // it must bind the pane the browser had already observed, not the new one.
    tmux('select-window', '-t', other);
    const captured = await target.capture(view, session, sessionId, pane, serverPid);
    assert.ok(captured.target, 'an attached view should have a captured pane');
    assert.equal(captured.target.windowIndex, '0');
    const savedPath = "/tmp/image with 'quotes'.png";
    assert.equal(target.bind(captured.ticket, savedPath), true);
    await target.insert(captured.ticket);
    let originalOutput = '';
    for (let i = 0; i < 100; i++) {
      originalOutput = tmux('capture-pane', '-p', '-t', pane);
      if (originalOutput.includes("'/tmp/image with '\\''quotes'\\''.png'")) break;
      await delay(10);
    }
    const otherOutput = tmux('capture-pane', '-p', '-t', other);
    const quoted = "'/tmp/image with '\\''quotes'\\''.png'";
    assert.ok(originalOutput.endsWith(quoted), 'the quoted path remains on the input line without Enter');
    assert.ok(!otherOutput.includes(savedPath), 'a newly active pane must not receive the path');
    await assert.rejects(target.insert(captured.ticket), /unavailable/, 'a ticket cannot insert twice');
    await target.returnToLive(view, session, sessionId, pane, serverPid);
    assert.equal(tmux('capture-pane', '-p', '-t', pane), originalOutput, 'returning to live outside copy mode must not change input');
    tmux('copy-mode', '-t', pane);
    assert.match(tmux('display-message', '-p', '-t', pane, '#{pane_mode}'), /^copy-mode/);
    await target.returnToLive(view, session, sessionId, pane, serverPid);
    assert.equal(tmux('display-message', '-p', '-t', pane, '#{pane_mode}'), '');
    assert.equal(tmux('capture-pane', '-p', '-t', pane), originalOutput, 'leaving copy mode preserves the unsubmitted input');

    const lost = await target.capture(view, session, sessionId, other, serverPid);
    assert.equal(target.bind(lost.ticket, savedPath), true);
    tmux('kill-pane', '-t', other);
    await assert.rejects(target.insert(lost.ticket), 'a deleted pane must not redirect insertion');
    assert.equal(tmux('capture-pane', '-p', '-t', pane), originalOutput, 'loss must not change another pane');

    const disconnected = await target.capture(view, session, sessionId, pane, serverPid);
    assert.equal(target.bind(disconnected.ticket, savedPath), true);
    socket.close();
    for (let i = 0; i < 100; i++) {
      if (!tmux('list-sessions', '-F', '#{session_name}').split('\n').includes(session)) break;
      await delay(25);
    }
    await assert.rejects(target.insert(disconnected.ticket), 'a disconnected view must not redirect insertion');
  } finally {
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    spawnSync('tmux', ['-L', server, 'kill-server'], { stdio: 'ignore' });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
