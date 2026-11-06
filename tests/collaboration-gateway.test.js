'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { randomBytes, generateKeyPairSync } = require('node:crypto');
const { createLocalIssuer, createVerifier, proofFor } = require('../collaboration-gateway/auth');
const { startGateway } = require('../collaboration-gateway/server');
const { startFixture } = require('../collaboration-gateway/fixture');
const { frame, watch } = require('../collaboration-mvp/websocket');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { if (fn()) return; await sleep(20); }
  throw Error('Timeout: ' + label);
}
// Native browser WebSocket cannot set these authentication headers. This is an
// explicit headless adapter test, not a claimed browser login integration.
async function connect(url, credential, { origin = url, path = '/ws', extra = {} } = {}) {
  const headers = { origin, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), ...extra };
  if (credential) {
    headers.authorization = `Bearer ${credential.token}`;
    headers['x-gateway-proof'] = proofFor(credential.token, { method: 'GET', url: path, headers }, credential.privateKey);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(url + path, { headers, timeout: 3000 });
    req.on('error', reject); req.on('timeout', () => req.destroy(Error('Timeout')));
    req.on('response', res => { res.resume(); reject(Error('HTTP ' + res.statusCode)); });
    req.on('upgrade', (res, socket, head) => {
      const c = { messages: [], closed: false, close: () => socket.destroy(), send: m => socket.write(frame(JSON.stringify(m), true, 1)) };
      let pending = Buffer.alloc(0);
      function receive(b) {
        pending = Buffer.concat([pending, b]);
        while (pending.length >= 2) {
          const op = pending[0] & 15; let n = pending[1] & 127, off = 2;
          if (n === 126) { if (pending.length < 4) return; n = pending.readUInt16BE(2); off = 4; }
          if (n === 127) { if (pending.length < 10) return; n = Number(pending.readBigUInt64BE(2)); off = 10; }
          if (pending.length < off + n) return;
          const data = pending.subarray(off, off + n); pending = pending.subarray(off + n);
          if (op === 9) socket.write(frame(data, true, 10));
          else if (op === 1) c.messages.push(JSON.parse(data.toString()));
        }
      }
      socket.on('error', () => {}); socket.on('close', () => { c.closed = true; }); socket.on('data', receive);
      c.wait = async type => { await until(() => c.messages.some(m => m.type === type), type); return c.messages.findLast(m => m.type === type); };
      c.output = marker => until(() => c.messages.filter(m => m.type === 'output').map(m => m.data).join('').includes(marker), marker);
      c.action = async (message, type) => { c.messages.length = 0; c.send(message); return c.wait(type); };
      resolve(c); if (head.length) receive(head);
    }); req.end();
  });
}
async function setup({ leaseMs = 3000 } = {}) {
  const fixture = await startFixture(); let gateway;
  try {
    const issuer = createLocalIssuer(); let now = Date.now();
    const verifier = createVerifier({ publicKey: issuer.publicKey, issuer: 'local-test', audience: 'gateway-test', session: fixture.id, now: () => now });
    gateway = await startGateway({ backend: fixture, verifier, leaseMs });
    const peers = [];
    function credential(patch = {}) {
      const keys = generateKeyPairSync('ed25519'), n = Math.floor(now / 1000);
      const token = issuer.issue({ iss: 'local-test', aud: 'gateway-test', sub: 'trusted-test-user', role: 'writer', panes: ['1'], session: fixture.id, iat: n, nbf: n, exp: n + 30, ...patch }, keys.publicKey);
      return { token, privateKey: keys.privateKey };
    }
    return { fixture, gateway, verifier, credential, advance: ms => { now += ms; },
      async peer(patch) { const cred = credential(patch), c = await connect(gateway.url, cred); peers.push(c); c.credential = cred; await c.wait('hello'); return c; },
      async close() { peers.forEach(c => c.close()); await gateway.close(); await fixture.close(); },
    };
  } catch (e) { await gateway?.close(); await fixture.close(); throw e; }
}
async function cleaned(f) {
  assert.equal(fs.existsSync(f.dir), false);
  await until(() => f.ownedPids.every(pid => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } }), 'all fixture processes exited');
}
test('Golden: authenticated writer and watcher, real ttyd output, independent views, manual size and cleanup', { timeout: 30000 }, async () => {
  const s = await setup(); const { fixture: f } = s;
  try {
    const a = await s.peer(), b = await s.peer({ role: 'watcher', panes: ['1', '2'] });
    await Promise.all([a.action({ type: 'select', pane: '1' }, 'selected'), b.action({ type: 'select', pane: '1' }, 'selected')]);
    const geometry = f.snapshot();
    assert.ok(geometry.every(row => row.endsWith(':80x24:manual')));
    const { lease } = await a.action({ type: 'claim' }, 'lease');
    await a.action({ type: 'input', lease, operation: { type: 'text', text: 'AUTH_GOLDEN_你好' } }, 'ack');
    await a.action({ type: 'input', lease, operation: { type: 'key', key: 'Enter' } }, 'ack');
    await Promise.all([a.output('AUTH_GOLDEN_你好'), b.output('AUTH_GOLDEN_你好')]);
    await b.action({ type: 'input', lease, principal: 'writer', role: 'writer', uid: process.getuid(), operation: { type: 'text', text: 'WATCHER_FORBIDDEN' } }, 'error');
    await b.action({ type: 'select', pane: '2' }, 'selected');
    await a.action({ type: 'input', lease, operation: { type: 'text', text: 'A_STAYS_PANE_ONE' } }, 'ack');
    await a.output('A_STAYS_PANE_ONE');
    assert.doesNotMatch(f.capture('2'), /A_STAYS_PANE_ONE/);
    assert.doesNotMatch(f.capture('1'), /WATCHER_FORBIDDEN/);
    assert.deepEqual(f.snapshot(), geometry);
    console.log('Golden verified: signed holder-bound writer -> lease -> cat -> two real ttyd clients; independent view and 80x24 manual sizing');
  } finally { await s.close(); }
  await cleaned(f);
});
test('upgrade denies forged/stolen/replayed/invalid assertions, origins, routes and unwired verifier', { timeout: 30000 }, async () => {
  const s = await setup(); const { gateway: g } = s;
  try {
    for (const patch of [{ aud: 'other' }, { session: 'other' }, { role: 'admin' }, { iss: 'other' }, { exp: 1 }, { nbf: Math.floor(Date.now() / 1000) + 100 }]) await assert.rejects(connect(g.url, s.credential(patch)), /HTTP 401/);
    await assert.rejects(connect(g.url, null, { extra: { authorization: 'Bearer {"role":"writer"}', 'x-forwarded-user': 'owner' } }), /HTTP 401/);
    await assert.rejects(connect(g.url, null), /HTTP 401/);
    const cred = s.credential();
    await assert.rejects(connect(g.url, { ...cred, token: cred.token.slice(0, -10) + 'AAAAAAAAAA' }), /HTTP 401/);
    await assert.rejects(connect(g.url, { ...cred, privateKey: generateKeyPairSync('ed25519').privateKey }), /HTTP 401/);
    await assert.rejects(connect(g.url, cred, { origin: 'http://evil.example' }), /HTTP 401/);
    await assert.rejects(connect(g.url, cred, { origin: '' }), /HTTP 401/);
    await assert.rejects(connect(g.url, cred, { path: '/ws?token=anything' }), /HTTP 401/);
    const a = await connect(g.url, cred); await a.wait('hello'); a.close();
    await assert.rejects(connect(g.url, cred), /HTTP 401/);
    await assert.rejects(startGateway({ backend: s.fixture }), /verifier/i);
    const missing = await startGateway({ backend: s.fixture, verifier: { verifyUpgrade() {}, assertActive() {} } });
    try { await assert.rejects(connect(missing.url, s.credential()), /HTTP 401/); } finally { await missing.close(); }
    for (const path of ['/upload', '/__terminal_upload', '/mcp', '/watch1.sock', '/tmux.sock', '/ws?role=writer']) {
      assert.equal((await fetch(g.url + path, { method: 'POST', body: 'WRITE_FORBIDDEN' })).status, 404);
      await assert.rejects(connect(g.url, s.credential(), { path }), /HTTP 401/);
    }
  } finally { await s.close(); }
  await cleaned(s.fixture);
});
test('lease scope, stolen lease, release/expiry/disconnect, active revocation and backend death deny writes', { timeout: 30000 }, async () => {
  const s = await setup({ leaseMs: 1000 }); const f = s.fixture;
  try {
    const a = await s.peer(), b = await s.peer();
    await a.action({ type: 'select', pane: '2' }, 'error');
    for (const c of [a, b]) await c.action({ type: 'select', pane: '1' }, 'selected');
    await a.action({ type: 'input', operation: { type: 'text', text: 'NO_LEASE' } }, 'error');
    let { lease } = await a.action({ type: 'claim' }, 'lease');
    await b.action({ type: 'input', lease, operation: { type: 'text', text: 'STOLEN_LEASE' } }, 'error');
    await b.action({ type: 'claim' }, 'error');
    for (const operation of [{ type: 'resize' }, { type: 'command', command: 'id' }, { type: 'key', key: 'C-d' }, { type: 'text', text: 'CONTROL\n' }]) await a.action({ type: 'input', lease, operation }, 'error');
    await a.action({ type: 'input', pane: '2', lease, operation: { type: 'text', text: 'WRONG_PANE' } }, 'error');
    await a.action({ type: 'release', lease }, 'released');
    await a.action({ type: 'input', lease, operation: { type: 'text', text: 'RELEASED' } }, 'error');
    ({ lease } = await a.action({ type: 'claim' }, 'lease'));
    await sleep(1050);
    await a.action({ type: 'input', lease, operation: { type: 'text', text: 'STALE_LEASE' } }, 'error');
    ({ lease } = await a.action({ type: 'claim' }, 'lease')); a.close(); await until(() => a.closed && s.gateway.connectionCount() === 1, 'peer FIN revokes connection before lease expiry');
    const fresh = (await b.action({ type: 'claim' }, 'lease')).lease;
    await b.action({ type: 'input', lease, operation: { type: 'text', text: 'OLD_CONNECTION' } }, 'error');
    await b.action({ type: 'input', lease: fresh, operation: { type: 'text', text: 'AFTER_DISCONNECT' } }, 'ack'); await b.output('AFTER_DISCONNECT');
    s.advance(31000); b.send({ type: 'input', lease: fresh, operation: { type: 'text', text: 'EXPIRED_AUTH' } });
    await until(() => b.closed, 'active auth expiry');
    assert.doesNotMatch(f.capture('1'), /NO_LEASE|STOLEN_LEASE|CONTROL|WRONG_PANE|RELEASED|STALE_LEASE|OLD_CONNECTION|EXPIRED_AUTH/);
    const c = await s.peer(); await c.action({ type: 'select', pane: '1' }, 'selected');
    const revokedLease = (await c.action({ type: 'claim' }, 'lease')).lease;
    const nonce = JSON.parse(Buffer.from(c.credential.token.split('.')[1], 'base64url')).nonce;
    s.verifier.revoke(nonce); c.send({ type: 'input', lease: revokedLease, operation: { type: 'text', text: 'REVOKED_AUTH' } });
    await until(() => c.closed, 'nonce revocation');
    assert.doesNotMatch(f.capture('1'), /REVOKED_AUTH/);
    const e = await s.peer(); s.verifier.revokeSession(); e.send({ type: 'select', pane: '1' }); await until(() => e.closed, 'session revocation');
  } finally { await s.close(); }
  await cleaned(f);
  const d = await setup();
  try { const c = await d.peer(); await c.action({ type: 'select', pane: '1' }, 'selected'); d.fixture.loseFixture('1'); await until(() => c.closed, 'backend death'); await assert.rejects(connect(d.gateway.url, d.credential()), /HTTP 401/); }
  finally { await d.close(); }
  await cleaned(d.fixture);
});
test('bypass audit: no ttyd TCP listener, readonly backend rejects raw input; same-UID tmux control proves P0 remains open', { timeout: 30000 }, async () => {
  const s = await setup(), f = s.fixture;
  try {
    assert.equal(fs.statSync(f.dir).mode & 0o777, 0o700);
    assert.equal(f.hasTcpListener(), false, 'ttyd must only listen on private Unix sockets');
    const geometry = f.snapshot(), raw = await watch(f.watchSocket('1'), () => {});
    try {
      for (const value of ['0RAW_TTYD_FORBIDDEN', '0\r', '1{"columns":170,"rows":55}', '0\x03']) raw.send(value);
      await sleep(200);
      assert.doesNotMatch(f.capture('1'), /RAW_TTYD_FORBIDDEN/); assert.deepEqual(f.snapshot(), geometry);
    } finally { raw.close(); }
    // An intentionally honest control: the test runner has the backend UID and
    // CAN bypass the gateway. 0700 is not isolation from that same UID.
    f.sameUidControl('SAME_UID_BYPASS_PROVEN');
    assert.match(f.capture('1'), /SAME_UID_BYPASS_PROVEN/);
    assert.equal(s.gateway.releaseStatus, 'P0 RELEASE BLOCKED');
    console.log('P0 RELEASE BLOCKED: same-UID direct tmux write succeeded; cross-UID socket/MCP/upload denial and durable fencing unproven');
  } finally { await s.close(); }
  await cleaned(f);
});
