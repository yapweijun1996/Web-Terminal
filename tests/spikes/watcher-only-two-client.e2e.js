'use strict';
// Run on the execution host: node tests/spikes/collaborative-enforcement.js
// All tmux servers, processes and sockets below belong exclusively to this run.
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function stopWatcher(w) { w.socket.destroy(); if (w.child.exitCode === null && w.child.signalCode === null) { const exited = new Promise(resolve => w.child.once('exit', resolve)); w.child.kill('SIGTERM'); await Promise.race([exited, sleep(2000).then(() => { throw Error('ttyd did not exit'); })]); } }
const until = async (predicate, label, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (predicate()) return; await sleep(25); }
  throw Error(`timeout: ${label}`);
};
const dir = fs.mkdtempSync('/tmp/mba-spike-');
fs.chmodSync(dir, 0o700);
process.env.TMUX_TMPDIR = dir;
const children = new Set();
const sockets = new Set();
const servers = new Set();
const checks = [];
const { WatcherOwner } = require('../../runtime/candidates/watcher-owner.js');
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => { checks.push([name, true]); console.log(`PASS ${name}`); }, e => { checks.push([name, false]); console.error(`FAIL ${name}: ${e.message}`); });
}
function tmux(name, ...args) { return execFileSync('tmux', ['-L', name, '-f', '/dev/null', ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }); }
function frame(payload) {
  payload = Buffer.from(payload); if (payload.length >= 126) throw Error('frame too long');
  const mask = randomBytes(4), out = Buffer.alloc(6 + payload.length);
  out[0] = 0x82; out[1] = 0x80 | payload.length; mask.copy(out, 2);
  for (let i = 0; i < payload.length; i++) out[6 + i] = payload[i] ^ mask[i % 4];
  return out;
}
async function fixture(name, columns, rows, writable = false) {
  const geometry = () => tmux(name, 'display-message', '-p', '-t', '=workspace:', '#{pane_width}x#{pane_height}').trim();
  const pane = () => tmux(name, 'capture-pane', '-p', '-t', '=workspace:');
  const state = () => tmux(name, 'display-message', '-p', '-t', '=workspace:', '#{pane_pid}:#{pane_current_command}:#{pane_dead}').trim();
  const before = { geometry: geometry(), state: state() };
  const sock = path.join(dir, `${name}-${randomBytes(5).toString('hex')}.sock`);
  const args = ['-i', sock, ...(writable ? ['-W'] : []), 'tmux', '-L', name, '-f', '/dev/null', 'attach-session', '-t', '=workspace'];
  const child = spawn('ttyd', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  children.add(child); let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  child.on('error', e => { stderr += e.message; });
  await until(() => fs.existsSync(sock) || child.exitCode !== null, 'ttyd socket');
  if (!fs.existsSync(sock)) throw Error(`ttyd exited ${child.exitCode}: ${stderr.slice(-500)}`);
  const socket = net.createConnection(sock); sockets.add(socket); await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  let data = Buffer.alloc(0), upgraded = false, output = Buffer.alloc(0), failure;
  const key = randomBytes(16).toString('base64');
  socket.on('error', e => { failure = e; });
  socket.on('data', chunk => {
    data = Buffer.concat([data, chunk]);
    if (!upgraded) {
      const end = data.indexOf('\r\n\r\n'); if (end < 0) return;
      const header = data.subarray(0, end).toString();
      const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (!header.startsWith('HTTP/1.1 101 ') || !header.toLowerCase().includes(`sec-websocket-accept: ${expected}`.toLowerCase())) { failure = Error('invalid WebSocket upgrade'); return; }
      data = data.subarray(end + 4); upgraded = true;
      socket.write(frame(JSON.stringify({ AuthToken: '', columns, rows })));
    }
    while (data.length >= 2) {
      let len = data[1] & 127, off = 2;
      if (len === 126) { if (data.length < 4) break; len = data.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (data.length < 10) break; const n = data.readBigUInt64BE(2); if (n > 1048576n) { failure = Error('oversized frame'); return; } len = Number(n); off = 10; }
      if (data.length < off + len) break;
      if ((data[0] & 15) === 2 || (data[0] & 15) === 1) output = Buffer.concat([output, data.subarray(off, off + len)]);
      data = data.subarray(off + len);
    }
  });
  socket.write(`GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: tty\r\n\r\n`);
  await until(() => upgraded || failure, 'WebSocket upgrade'); if (failure) throw failure;
  await sleep(500);
  return { name, socket, before, geometry, pane, state, send: s => socket.write(frame(s)), output: () => output.toString('utf8'), child };
}
async function main() {
  const name = `candidate_${randomBytes(6).toString('hex')}`;
  const owner = new WatcherOwner(dir, name); try { owner.start(); } finally { if (owner.created) servers.add(name); }
  const prior = owner.localPrior;
  const lease1 = owner.acquire(), lease2 = owner.acquire();
  const w1 = await fixture(name, 101, 37), w2 = await fixture(name, 132, 45);
  console.log('CHECKPOINT two real WebSockets connected');
  assert.equal(w1.geometry(), '80x24'); assert.equal(w2.geometry(), '80x24');
  await check('both handshakes preserve geometry', () => assert.equal(w1.geometry(), '80x24'));
  const { createInputGateway } = await import(pathToFileURL(path.resolve(__dirname, '../../mcp/input-gateway.js')).href);
  const gateway = createInputGateway({ server: name, session: 'workspace' });
  const [target] = await gateway.controller.list();
  const writer = gateway.broker.connect({ principal: 'trusted-fixture', write: true });
  const lease = await gateway.broker.claim(writer, target);
  async function write(marker) {
    await gateway.broker.mutate(writer, target, lease, { type: 'text', text: marker });
    await gateway.broker.mutate(writer, target, lease, { type: 'key', key: 'Enter' });
  }
  await check('both independent watchers see shared authorized output', async () => {
    await write('MBA_TWO_WATCHER_MARKER');
    await until(() => w1.output().includes('MBA_TWO_WATCHER_MARKER') && w2.output().includes('MBA_TWO_WATCHER_MARKER'), 'both outputs');
    assert.match(w1.pane(), /MBA_TWO_WATCHER_MARKER/);
  });
  const baseline = { pane: w1.pane(), geometry: w1.geometry(), state: w1.state() };
  await check('both watchers cannot input, paste, control or resize', async () => {
    for (const w of [w1,w2]) for (const msg of ['0MBA_FORBIDDEN_INPUT', '0\r', '0\x1b[200~MBA_FORBIDDEN_PASTE\x1b[201~', '0\x03', '1{"columns":150,"rows":50}', '2', '3']) w.send(msg);
    await sleep(700); assert.equal(w1.pane(), baseline.pane); assert.equal(w1.geometry(), baseline.geometry); assert.equal(w1.state(), baseline.state);
  });
  await check('trusted resize works', () => { tmux(name, 'resize-window', '-t', owner.window, '-x', '90', '-y', '30'); assert.equal(w1.geometry(), '90x30'); });
  await check('first disconnect retains manual and refuses restoration', async () => {
    await stopWatcher(w1); await sleep(200); owner.release(lease1);
    assert.equal(w2.geometry(), '90x30'); assert.throws(() => owner.close(), /Watchers remain/); assert.equal(tmux(name,'show-window-options','-v','-t',owner.window,'window-size').trim(), 'manual');
  });
  await check('reconnect sees writer and does not resize', async () => {
    const l = owner.acquire(); const w3 = await fixture(name, 120, 40); assert.equal(w3.geometry(), '90x30'); await write('MBA_RECONNECT_MARKER');
    await until(() => w2.output().includes('MBA_RECONNECT_MARKER') && w3.output().includes('MBA_RECONNECT_MARKER'), 'reconnect outputs');
    await stopWatcher(w3); await sleep(200); owner.release(l); assert.equal(w2.geometry(), '90x30');
  });
  await check('final disconnect restores exact local option', async () => {
    await stopWatcher(w2); await sleep(200); owner.release(lease2); owner.close();
    assert.equal(tmux(name,'show-window-options','-t',owner.window,'window-size'), prior); assert.equal(owner.state,'RESTORED'); assert.throws(() => owner.close());
  });
  await check('writable negative control admits input', async () => {
    const control = await fixture(name, 101, 37, true); control.send('0MBA_NEGATIVE_CONTROL\r');
    await until(() => control.pane().includes('MBA_NEGATIVE_CONTROL') && control.output().includes('MBA_NEGATIVE_CONTROL'), 'writable negative control'); control.socket.destroy(); control.child.kill('SIGTERM');
  });
  await check('unsafe directory and duplicate owner fail closed', () => {
    const unsafe = path.join(dir, 'unsafe'); fs.mkdirSync(unsafe, { mode: 0o755 }); fs.chmodSync(unsafe, 0o755);
    assert.throws(() => new WatcherOwner(unsafe, `candidate_${randomBytes(6).toString('hex')}`), /Unsafe/);
    const other = `candidate_${randomBytes(6).toString('hex')}`; const first = new WatcherOwner(dir, other);
    assert.throws(() => new WatcherOwner(dir, other), /EEXIST/);
    // Simulate restart with a stale lock: there is deliberately no automatic recovery.
    assert.equal(fs.existsSync(first.lock), true);
  });
  await check('external option change becomes ambiguous and is not restored', () => {
    const other = `candidate_${randomBytes(6).toString('hex')}`;
    const candidate = new WatcherOwner(dir, other); try { candidate.start(); } finally { if (candidate.created) servers.add(other); } const l = candidate.acquire();
    tmux(other, 'set-window-option', '-t', candidate.window, 'window-size', 'largest');
    assert.throws(() => candidate.release(l), /changed/); assert.equal(candidate.state, 'AMBIGUOUS');
    assert.throws(() => candidate.close());
    assert.equal(tmux(other,'show-window-options','-v','-t',candidate.window,'window-size').trim(), 'largest');
  });
  await gateway.broker.disconnect(writer);
  process.exitCode = checks.every(([,passed]) => passed) ? 0 : 1;
  console.log(`RESULT ${process.exitCode === 0 ? 'LOCAL_TEST_PASS' : 'FAIL'} checks=${checks.length}`);
}
main().catch(e => { console.error(`ERROR ${e.stack}`); process.exitCode = 2; }).finally(async () => {
  for (const socket of sockets) socket.destroy();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(r => child.once('exit', r)), sleep(1500)]); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  for (const name of servers) { try { tmux(name, 'kill-server'); } catch (_) {} }
  fs.rmSync(dir, { recursive: true, force: true });
  if (fs.existsSync(dir)) { console.error('FAIL temporary directory cleanup'); process.exitCode = 1; }
  else console.log('PASS temporary directory cleanup');
});
