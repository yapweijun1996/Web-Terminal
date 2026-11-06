'use strict';
// Disposable test backend only. Reuses Slice 1's pinned cat target, readonly
// ttyd transport and tmux queue guard. Never accepts caller socket paths.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { watch } = require('../collaboration-mvp/websocket');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function startFixture() {
  if (!/^tmux 3\.6a\s*$/.test(execFileSync('tmux', ['-V'], { encoding: 'utf8' }))) throw Error('Requires tmux 3.6a');
  if (!/ttyd version 1\.7\.7(?:-|\s|$)/.test(execFileSync('ttyd', ['--version'], { encoding: 'utf8' }))) throw Error('Requires ttyd 1.7.7');
  const dir = fs.mkdtempSync('/tmp/mba-auth-gateway-'); fs.chmodSync(dir, 0o700);
  const socketPath = path.join(dir, 'tmux.sock'), targets = new Map(), children = [], ownedPids = [];
  const env = { ...process.env, TMUX: '', TMUX_TMPDIR: dir };
  const tmux = (...args) => execFileSync('tmux', ['-S', socketPath, '-f', '/dev/null', ...args], { env, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let created = false, closing = false, healthy = true;
  function verify(t) {
    if (closing || !healthy || ![...targets.values()].includes(t)) throw Error('Backend unavailable');
    const state = tmux('display-message', '-p', '-t', t.paneId, '#{pid}:#{session_id}:#{window_id}:#{pane_id}:#{pane_dead}:#{pane_current_command}');
    if (state !== `${t.serverPid}:${t.sessionId}:${t.windowId}:${t.paneId}:0:cat` || tmux('show-window-options', '-v', '-t', t.windowId, 'window-size') !== 'manual') throw Error('Backend lost');
  }
  async function close() {
    if (closing) return; closing = true; healthy = false;
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM');
        await Promise.race([exited, sleep(1000)]);
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      }
    }
    if (created) { try { tmux('kill-server'); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  try {
    for (const pane of ['1', '2']) {
      const session = 'fixture' + pane;
      tmux('new-session', '-d', '-s', session, '-x', '80', '-y', '24', '/bin/cat', '-'); created = true;
      const [serverPid, sessionId, windowId, paneId] = tmux('display-message', '-p', '-t', `=${session}:`, '#{pid}:#{session_id}:#{window_id}:#{pane_id}').split(':');
      if (!/^\d+:\$\d+:@\d+:%\d+$/.test([serverPid, sessionId, windowId, paneId].join(':'))) throw Error('Invalid fixture');
      tmux('set-window-option', '-t', windowId, 'window-size', 'manual');
      tmux('resize-window', '-t', windowId, '-x', '80', '-y', '24');
      const socket = path.join(dir, `watch${pane}.sock`);
      const child = spawn('ttyd', ['-i', socket, 'tmux', '-S', socketPath, '-f', '/dev/null', 'attach-session', '-r', '-t', `=${session}`], { env, stdio: 'ignore' });
      children.push(child); child.on('error', () => { healthy = false; }); child.on('exit', () => { healthy = false; });
      const end = Date.now() + 5000;
      while (!fs.existsSync(socket) && child.exitCode === null && healthy && Date.now() < end) await sleep(20);
      if (!fs.existsSync(socket)) throw Error('ttyd socket unavailable');
      targets.set(pane, Object.freeze({ serverPid, sessionId, windowId, paneId, socket }));
      ownedPids.push(child.pid, Number(serverPid), Number(tmux('display-message', '-p', '-t', paneId, '#{pane_pid}')));
    }
    return {
      id: randomUUID(), dir, ownedPids: [...new Set(ownedPids)], targets, verify, close,
      async watch(t, onOutput) { verify(t); return watch(t.socket, onOutput); },
      execute(t, op) {
        verify(t); let command;
        if (op?.type === 'text' && typeof op.text === 'string' && op.text.length && Buffer.byteLength(op.text) <= 4096 && !/[\x00-\x1f\x7f]/.test(op.text) && Object.keys(op).sort().join(',') === 'text,type') {
          command = `send-keys -H -t ${t.paneId} ${Buffer.from(op.text).toString('hex').match(/../g).join(' ')}`;
        } else if (op?.type === 'key' && ['Enter', 'BSpace', 'Tab'].includes(op.key) && Object.keys(op).sort().join(',') === 'key,type') {
          command = `send-keys -t ${t.paneId} ${op.key}`;
        } else throw Error('Unsupported operation');
        const checks = [`#{==:#{pid},${t.serverPid}}`, `#{==:#{session_id},${t.sessionId}}`, `#{==:#{window_id},${t.windowId}}`, `#{==:#{pane_id},${t.paneId}}`, '#{==:#{pane_dead},0}', '#{==:#{pane_current_command},cat}', '#{==:#{window-size},manual}'];
        const cond = checks.reduce((a, b) => `#{&&:${a},${b}}`);
        if (tmux('if-shell', '-F', '-t', t.paneId, cond, command + ' ; display-message -p OK', 'display-message -p STALE') !== 'OK') throw Error('Backend lost');
      },
      snapshot: () => [...targets.values()].map(t => tmux('display-message', '-p', '-t', t.paneId, '#{session_id}:#{window_id}:#{window_active}:#{pane_width}x#{pane_height}:#{window-size}')),
      capture: pane => tmux('capture-pane', '-p', '-t', targets.get(pane).paneId),
      watchSocket: pane => targets.get(pane).socket,
      loseFixture: pane => tmux('kill-session', '-t', targets.get(pane).sessionId),
      sameUidControl: marker => tmux('send-keys', '-t', targets.get('1').paneId, '-l', marker),
      hasTcpListener() {
        // lsof returns 1 when there are no matching descriptors. Other failures
        // are not evidence of absence and must propagate.
        for (const child of children) {
          try { if (execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim()) return true; }
          catch (e) { if (e.status !== 1) throw e; }
        }
        return false;
      },
    };
  } catch (e) { await close(); throw e; }
}
module.exports = { startFixture };
