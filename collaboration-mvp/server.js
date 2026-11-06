#!/usr/bin/env node
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { randomBytes, createHmac, timingSafeEqual } = require('node:crypto');
const { InputBroker } = require('../runtime/gateway/broker.js');
const { upgrade, watch } = require('./websocket.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function startDemo({ leaseMs = 15000 } = {}) {
  if (!/^tmux 3\.6a\s*$/.test(execFileSync('tmux', ['-V'], { encoding: 'utf8' }))) throw Error('Requires tmux 3.6a');
  if (!/ttyd version 1\.7\.7(?:-|\s|$)/.test(execFileSync('ttyd', ['--version'], { encoding: 'utf8' }))) throw Error('Requires ttyd 1.7.7');
  const dir = fs.mkdtempSync('/tmp/mba-collab-'); fs.chmodSync(dir, 0o700);
  const tmuxSocket = path.join(dir, 'tmux.sock'), children = [], connections = new Set(), targets = new Map();
  const env = { ...process.env, TMUX: '', TMUX_TMPDIR: dir };
  const tmux = (...args) => execFileSync('tmux', ['-S', tmuxSocket, '-f', '/dev/null', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 }).trim();
  let server, monitor, closing = false, healthy = true, created = false, upstreams = 0;
  const secret = randomBytes(32), issued = new Map();
  function provision(role) {
    const body = Buffer.from(JSON.stringify({ id: randomBytes(16).toString('hex'), role, expires: Date.now() + 8 * 3600000 })).toString('base64url');
    const token = body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
    issued.set(token, JSON.parse(Buffer.from(body, 'base64url'))); return token;
  }
  const tokens = { writer: provision('writer'), observer: provision('observer') };
  function identity(token) {
    if (typeof token !== 'string' || token.length > 512) throw Error('Credentials required');
    const [body, sig, extra] = token.split('.');
    const expected = createHmac('sha256', secret).update(body || '').digest('base64url');
    if (extra || !sig || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw Error('Credentials required');
    const record = issued.get(token);
    if (!record || record.expires <= Date.now()) throw Error('Credentials expired');
    return record;
  }
  function verify(t) {
    if (!healthy || closing) throw Error('Fixture unavailable');
    const actual = tmux('display-message', '-p', '-t', t.paneId, '#{pid}:#{session_id}:#{window_id}:#{pane_id}:#{pane_dead}:#{pane_current_command}');
    if (actual !== `${t.serverPid}:${t.sessionId}:${t.windowId}:${t.paneId}:0:cat` || tmux('show-window-options', '-v', '-t', t.windowId, 'window-size') !== 'manual') throw Error('Fixture lost');
  }
  const broker = new InputBroker({ ttlMs: leaseMs, verifyTarget: verify, execute(t, op) {
    verify(t);
    if (!op || !['text', 'key'].includes(op.type)) throw Error('Unsupported operation');
    let command;
    if (op.type === 'text') {
      if (typeof op.text !== 'string' || !op.text.length || Buffer.byteLength(op.text) > 4096 || /[\x00-\x1f\x7f]/.test(op.text)) throw Error('Invalid text');
      // Encode every byte as hex; user text never enters tmux command syntax.
      command = `send-keys -H -t ${t.paneId} ${Buffer.from(op.text).toString('hex').match(/../g).join(' ')}`;
    } else {
      if (!['Enter', 'BSpace', 'Tab'].includes(op.key)) throw Error('Unsupported key');
      command = `send-keys -t ${t.paneId} ${op.key}`;
    }
    const checks = [
      `#{==:#{pid},${t.serverPid}}`, `#{==:#{session_id},${t.sessionId}}`,
      `#{==:#{window_id},${t.windowId}}`, `#{==:#{pane_id},${t.paneId}}`,
      '#{==:#{pane_dead},0}', '#{==:#{pane_current_command},cat}',
    ];
    const cond = checks.reduce((a, b) => `#{&&:${a},${b}}`);
    if (tmux('if-shell', '-F', '-t', t.paneId, cond, command + ' ; display-message -p OK', 'display-message -p STALE') !== 'OK') throw Error('Fixture lost');
  } });
  async function close() {
    if (closing) return; closing = true; healthy = false; clearInterval(monitor);
    for (const c of connections) c.bus.close();
    if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
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
      const session = `pane${pane}`;
      tmux('new-session', '-d', '-s', session, '-x', '80', '-y', '24', '/bin/cat', '-'); created = true;
      const [serverPid, sessionId, windowId, paneId] = tmux('display-message', '-p', '-t', `=${session}:`, '#{pid}:#{session_id}:#{window_id}:#{pane_id}').split(':');
      if (!/^\d+:\$\d+:@\d+:%\d+$/.test([serverPid, sessionId, windowId, paneId].join(':'))) throw Error('Invalid fixture identity');
      tmux('set-window-option', '-t', windowId, 'window-size', 'manual');
      tmux('resize-window', '-t', windowId, '-x', '80', '-y', '24');
      const socket = path.join(dir, `watch${pane}.sock`);
      const child = spawn('ttyd', ['-i', socket, 'tmux', '-S', tmuxSocket, '-f', '/dev/null', 'attach-session', '-r', '-t', `=${session}`], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      children.push(child); let failure = ''; child.stderr.on('data', b => { failure = (failure + b).slice(-2000); }); child.on('error', e => { failure = e.message; });
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(socket) && child.exitCode === null && !child.signalCode && Date.now() < deadline) await sleep(20);
      if (!fs.existsSync(socket)) throw Error('ttyd socket unavailable: ' + failure);
      targets.set(pane, { serverPid, sessionId, windowId, paneId, socket });
      child.on('exit', () => { if (!closing) { healthy = false; for (const c of connections) c.bus.close(); } });
    }
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    const js = fs.readFileSync(path.join(__dirname, 'client.js'));
    server = http.createServer((req, res) => {
      if (closing || !server.address()) { res.writeHead(503).end(); return; }
      if (req.headers.host !== server.address().address + ':' + server.address().port) { res.writeHead(403).end(); return; }
      const route = req.url;
      if (req.method !== 'GET' || !['/', '/client.js'].includes(route)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': route === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" });
      res.end(route === '/' ? html : js);
    });
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {});
      try {
        const host = `127.0.0.1:${server.address().port}`;
        if (!healthy || closing || req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`)) throw Error('Denied origin');
        const url = new URL(req.url, `http://${host}`);
        if (url.pathname !== '/ws') throw Error('Unknown route');
        const who = identity(url.searchParams.get('token'));
        const bus = upgrade(req, socket, head), connection = broker.connect({ principal: who.id, write: who.role === 'writer' });
        const c = { bus, connection, pane: null, upstream: null, live: true, generation: 0, queued: 0, lastPong: Date.now(), expires: who.expires }; connections.add(c);
        const send = m => bus.send(JSON.stringify(m));
        bus.on('pong', () => { c.lastPong = Date.now(); });
        bus.on('close', () => { c.live = false; c.generation++; c.upstream?.close(); broker.disconnect(connection); connections.delete(c); });
        bus.on('message', (data, opcode) => {
          if (++c.queued > 32 || opcode !== 1) { bus.close(); return; }
          // One queue per browser preserves ordering across asynchronous attach and broker operations.
          c.queue = (c.queue || Promise.resolve()).then(async () => {
            try {
              if (!c.live || who.expires <= Date.now() || !healthy) throw Error('Connection unavailable');
              const m = JSON.parse(data.toString());
              if (!m || typeof m !== 'object') throw Error('Invalid message');
              if (m.type === 'select') {
                if (!targets.has(m.pane)) throw Error('Invalid pane');
                await broker.disconnect(c.connection); // Selection invalidates any previous proof.
                if (!c.live) return;
                c.connection = broker.connect({ principal: who.id, write: who.role === 'writer' });
                c.upstream?.close(); c.upstream = null; c.pane = m.pane; const generation = ++c.generation;
                const t = targets.get(m.pane); verify(t);
                const upstream = await watch(t.socket, data => { if (c.live && c.generation === generation) send({ type: 'output', pane: m.pane, data }); });
                if (!c.live || c.generation !== generation) { upstream.close(); return; }
                c.upstream = upstream; upstreams++;
                upstream.once('close', () => { upstreams--; if (c.live && c.generation === generation) bus.close(); });
                send({ type: 'selected', pane: c.pane });
              } else {
                const t = targets.get(c.pane); if (!t || !c.upstream) throw Error('Select a pane first'); verify(t);
                if (m.type === 'claim') send({ type: 'lease', lease: await broker.claim(c.connection, t) });
                else if (m.type === 'renew') { await broker.renew(c.connection, t, m.lease); send({ type: 'renewed' }); }
                else if (m.type === 'release') { await broker.release(c.connection, t, m.lease); send({ type: 'released' }); }
                else if (m.type === 'input') { await broker.mutate(c.connection, t, m.lease, m.operation); send({ type: 'ack' }); }
                else throw Error('Unsupported message');
              }
            } catch { send({ type: 'error', message: 'Denied or unavailable; select a pane and claim a fresh lease.' }); }
            finally { c.queued--; if (!c.live) broker.disconnect(c.connection); }
          });
        });
        bus.once('close', () => broker.disconnect(c.connection));
        send({ type: 'hello', role: who.role, selectedPane: null, leaseMs });
      } catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    monitor = setInterval(() => {
      try { for (const t of targets.values()) verify(t); }
      catch { healthy = false; for (const c of connections) c.bus.close(); }
      for (const c of connections) { if (!c.live || c.expires <= Date.now() || Date.now() - c.lastPong > 10000) c.bus.close(); else c.bus.send('', 9); }
    }, 500); monitor.unref();
    const url = `http://127.0.0.1:${server.address().port}`;
    const ownedPids = [...new Set([...children.map(c => c.pid), ...[...targets.values()].flatMap(t => [Number(t.serverPid), Number(tmux('display-message', '-p', '-t', t.paneId, '#{pane_pid}'))])])];
    return { url, tokens, dir, close, ownedPids, watchCount: () => upstreams,
      snapshot: () => [...targets.values()].map(t => tmux('display-message', '-p', '-t', t.paneId, '#{session_id}:#{window_id}:#{window_active}:#{pane_width}x#{pane_height}')),
      capture: pane => tmux('capture-pane', '-p', '-t', targets.get(pane).paneId),
      loseFixture: pane => tmux('kill-session', '-t', targets.get(pane).sessionId),
    };
  } catch (e) { await close(); throw e; }
}
module.exports = { startDemo };
if (require.main === module) startDemo().then(demo => {
  console.log('LOCAL DEMO NOT AUTHENTICATED PRODUCTION');
  console.log(`Client A (writer): ${demo.url}/#token=${demo.tokens.writer}`);
  console.log(`Client B (observer): ${demo.url}/#token=${demo.tokens.observer}`);
  console.log('Private disposable /bin/cat fixtures. Ctrl-C cleans up this demo.');
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (stopping) return; stopping = true; await demo.close(); process.exit(0); });
}).catch(e => { console.error(e.message); process.exitCode = 1; });
