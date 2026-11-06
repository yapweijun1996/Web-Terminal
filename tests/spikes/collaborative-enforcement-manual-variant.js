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
async function fixture(writable) {
  const name = `spike_${randomBytes(6).toString('hex')}`;
  servers.add(name);
  tmux(name, 'new-session', '-d', '-x', '80', '-y', '24', '-s', 'workspace', '/bin/cat');
  tmux(name, 'set-window-option', '-t', '=workspace:', 'window-size', 'manual');
  const geometry = () => tmux(name, 'display-message', '-p', '-t', '=workspace:', '#{pane_width}x#{pane_height}').trim();
  const pane = () => tmux(name, 'capture-pane', '-p', '-t', '=workspace:');
  const state = () => tmux(name, 'display-message', '-p', '-t', '=workspace:', '#{pane_pid}:#{pane_current_command}:#{pane_dead}').trim();
  const before = { geometry: geometry(), state: state() };
  const sock = path.join(dir, `${name}.sock`);
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
      socket.write(frame(JSON.stringify({ AuthToken: '', columns: 132, rows: 45 })));
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
  const { createInputGateway } = await import(pathToFileURL(path.resolve(__dirname, '../../mcp/input-gateway.js')).href);
  let watcher;
  try { watcher = await fixture(false); } catch (e) { console.error(`FIXTURE ERROR: ${e.message}`); process.exitCode = 2; return; }
  await check('attach-time geometry unchanged (handshake 101x37)', async () => {
    const after = watcher.geometry(); console.log(`GEOMETRY before=${watcher.before.geometry} after_attach=${after}`);
    assert.equal(after, watcher.before.geometry, 'BLOCK: watcher attach changed pane geometry');
  });
  const gateway = createInputGateway({ server: watcher.name, session: 'workspace' });
  const [target] = await gateway.controller.list();
  // These credentials are in-memory test fixtures; no real authentication is claimed.
  const identities = new Map([['watcher-token', { principal: 'watcher', write: false }], ['writer-token', { principal: 'writer', write: true }]]);
  const connect = token => { const identity = identities.get(token); if (!identity) throw Error('unauthenticated'); return gateway.broker.connect(identity); };
  const reader = connect('watcher-token'), writer = connect('writer-token');
  await check('watcher principal cannot claim write lease', async () => { await assert.rejects(gateway.broker.claim(reader, target), /Permission/); });
  const lease = await gateway.broker.claim(writer, target);
  await check('authorized broker writer output visible in watcher stream', async () => {
    await gateway.broker.mutate(writer, target, lease, { type: 'text', text: 'MBA_WRITER_MARKER' });
    await gateway.broker.mutate(writer, target, lease, { type: 'key', key: 'Enter' });
    await until(() => watcher.output().includes('MBA_WRITER_MARKER'), 'writer marker');
    assert.match(watcher.pane(), /MBA_WRITER_MARKER/);
  });
  const baseline = { pane: watcher.pane(), geometry: watcher.geometry(), state: watcher.state() };
  await check('read-only backend rejects input, Enter, paste, resize, controls and malformed messages', async () => {
    for (const msg of ['0MBA_FORBIDDEN_INPUT', '0\r', '0\x1b[200~MBA_FORBIDDEN_PASTE\x1b[201~', '1{"columns":132,"rows":45}', '2', '3', '9garbage', '1{bad-json']) watcher.send(msg);
    await sleep(700);
    assert.equal(watcher.pane(), baseline.pane, 'pane contents changed');
    assert.equal(watcher.geometry(), baseline.geometry, 'pane geometry changed');
    assert.equal(watcher.state(), baseline.state, 'pane process changed');
    assert.doesNotMatch(watcher.output(), /MBA_FORBIDDEN_(INPUT|PASTE)/);
  });
  await check('writer remains usable after forbidden frames', async () => {
    await gateway.broker.mutate(writer, target, lease, { type: 'text', text: 'MBA_AFTER_DENIAL' });
    await gateway.broker.mutate(writer, target, lease, { type: 'key', key: 'Enter' });
    await until(() => watcher.output().includes('MBA_AFTER_DENIAL'), 'post-denial output');
  });
  await check('trusted explicit resize permitted with manual policy', async () => {
    tmux(watcher.name, 'resize-window', '-t', '=workspace:', '-x', '90', '-y', '30');
    assert.equal(watcher.geometry(), '90x30');
  });
  watcher.socket.destroy();
  await check('negative control: separate writable ttyd permits WebSocket input', async () => {
    const control = await fixture(true);
    try { control.send('0MBA_NEGATIVE_CONTROL\r'); await until(() => control.pane().includes('MBA_NEGATIVE_CONTROL') && control.output().includes('MBA_NEGATIVE_CONTROL'), 'writable control'); }
    finally { control.socket.destroy(); }
  });
  await gateway.broker.disconnect(writer); await gateway.broker.disconnect(reader);
  process.exitCode = checks.every(([, passed]) => passed) ? 0 : 1;
  console.log(`RESULT ${process.exitCode === 0 ? 'LOCAL_TEST_PASS (manager independent run still required)' : 'ARCHITECTURE_BLOCKED'} checks=${checks.length}`);
}
main().catch(e => { console.error(`ERROR ${e.stack}`); process.exitCode = 2; }).finally(async () => {
  for (const socket of sockets) socket.destroy();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(r => child.once('exit', r)), sleep(1500)]); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  for (const name of servers) { try { tmux(name, 'kill-server'); } catch (_) {} }
  fs.rmSync(dir, { recursive: true, force: true });
});
