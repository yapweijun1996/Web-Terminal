'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startDemo } = require('../collaboration-mvp/server.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) {
  const end = Date.now() + 8000;
  while (Date.now() < end) { if (fn()) return; await sleep(25); }
  throw Error(`timeout: ${label}`);
}
async function client(demo, token) {
  const ws = new WebSocket(demo.url.replace('http:', 'ws:') + '/ws?token=' + token);
  const messages = [];
  ws.onmessage = e => messages.push(JSON.parse(e.data));
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = m => ws.send(JSON.stringify(m));
  const wait = async (fn, label) => { await until(() => messages.some(fn), label); return messages.findLast(fn); };
  const selected = pane => wait(m => m.type === 'selected' && m.pane === pane, 'selected ' + pane);
  const output = async marker => until(() => messages.filter(m => m.type === 'output').map(m => m.data).join('').includes(marker), marker);
  await wait(m => m.type === 'hello', 'identity');
  return { ws, messages, send, wait, selected, output };
}
test('Golden E2E: real ttyd watchers, independent selections, bound writer lease', { timeout: 45000 }, async () => {
  const demo = await startDemo({ leaseMs: 3000 });
  const peers = [];
  try {
    const a = await client(demo, demo.tokens.writer); peers.push(a);
    const b = await client(demo, demo.tokens.observer); peers.push(b);
    const html = await (await fetch(demo.url)).text();
    assert.match(html, /LOCAL DEMO NOT AUTHENTICATED PRODUCTION/);
    assert.match(html, /data-pane="1"/); assert.match(html, /data-pane="2"/);
    a.send({ type: 'select', pane: '1' }); b.send({ type: 'select', pane: '1' });
    await Promise.all([a.selected('1'), b.selected('1')]);
    await until(() => demo.watchCount() === 2, 'two real upstream watchers');
    const before = demo.snapshot();
    a.send({ type: 'claim' });
    const lease = (await a.wait(m => m.type === 'lease', 'lease')).lease;
    a.send({ type: 'input', lease, operation: { type: 'text', text: 'GOLDEN_LIVE_MARKER' } });
    await Promise.all([a.output('GOLDEN_LIVE_MARKER'), b.output('GOLDEN_LIVE_MARKER')]);
    b.send({ type: 'input', lease, principal: 'writer', operation: { type: 'text', text: 'FORBIDDEN' } });
    await b.wait(m => m.type === 'error', 'observer denied');
    b.send({ type: 'select', pane: '2' }); await b.selected('2');
    a.messages.length = 0;
    a.send({ type: 'input', lease, operation: { type: 'key', key: 'Enter' } });
    await a.wait(m => m.type === 'ack', 'writer still pane 1');
    assert.deepEqual(demo.snapshot(), before, 'selection and dimensions unchanged');
    assert.doesNotMatch(demo.capture('1'), /FORBIDDEN/);
    a.messages.length = 0;
    await sleep(3100);
    a.send({ type: 'input', lease, operation: { type: 'text', text: 'STALE_LEASE' } });
    await a.wait(m => m.type === 'error', 'stale lease denied');
    assert.doesNotMatch(demo.capture('1'), /STALE_LEASE/);
    console.log('CHECKPOINT runnable Golden E2E: two ttyd streams, live output, independent selection, observer/stale denied');
  } finally { for (const p of peers) p.ws.close(); await demo.close(); }
  assert.equal(fs.existsSync(demo.dir), false);
  await until(() => demo.ownedPids.every(pid => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } }), 'own ttyd, tmux and cat processes exited');
});

async function deniedUpgrade(demo, suffix, options) {
  const ws = new WebSocket(demo.url.replace('http:', 'ws:') + suffix, options);
  let opened = false;
  ws.onopen = () => { opened = true; ws.close(); };
  await new Promise(resolve => { ws.onerror = resolve; ws.onclose = resolve; });
  assert.equal(opened, false, 'upgrade must not open');
}
test('Credentials, raw ttyd bypass, lease binding, disconnect, fixture loss and cleanup', { timeout: 45000 }, async () => {
  const demo = await startDemo(); const peers = [];
  try {
    assert.equal(fs.statSync(demo.dir).mode & 0o777, 0o700);
    for (const suffix of ['/ws', '/ws?token=writer', '/ws?token=' + demo.tokens.writer.slice(0, -2) + 'zz', '/watch1.sock?token=' + demo.tokens.writer]) await deniedUpgrade(demo, suffix);
    const a = await client(demo, demo.tokens.writer); peers.push(a);
    const b = await client(demo, demo.tokens.observer); peers.push(b);
    a.send({ type: 'select', pane: '1' }); b.send({ type: 'select', pane: '1' });
    await Promise.all([a.selected('1'), b.selected('1')]);
    const geometry = demo.snapshot();
    b.send({ type: 'claim', principal: 'writer', uid: process.getuid(), write: true });
    await b.wait(m => m.type === 'error', 'forged identity denied'); b.messages.length = 0;
    a.send({ type: 'input', operation: { type: 'text', text: 'NO_LEASE' } });
    await a.wait(m => m.type === 'error', 'missing lease denied'); a.messages.length = 0;
    a.send({ type: 'claim' }); const lease = (await a.wait(m => m.type === 'lease', 'lease')).lease;
    b.send({ type: 'input', lease, operation: { type: 'text', text: 'CROSS_CONNECTION' } });
    await b.wait(m => m.type === 'error', 'stolen lease denied'); b.messages.length = 0;
    for (const msg of ['0RAW_BYPASS', '1{"columns":150,"rows":50}', '2', '3']) {
      b.send(msg); await b.wait(m => m.type === 'error', 'raw ttyd denied'); b.messages.length = 0;
    }
    for (const operation of [{ type: 'resize', columns: 150 }, { type: 'command', command: 'id' }, { type: 'key', key: 'C-d' }, { type: 'text', text: 'CONTROL\n' }]) {
      a.messages.length = 0; a.send({ type: 'input', lease, operation });
      await a.wait(m => m.type === 'error', 'operation allowlist');
    }
    assert.deepEqual(demo.snapshot(), geometry);
    assert.doesNotMatch(demo.capture('1'), /NO_LEASE|CROSS_CONNECTION|RAW_BYPASS|CONTROL/);
    // Verify the underlying private ttyd is itself read-only, not just the HTTP adapter.
    const { watch } = require('../collaboration-mvp/websocket.js');
    const raw = await watch(demo.dir + '/watch1.sock', () => {});
    for (const msg of ['0RAW_BACKEND', '0\r', '1{"columns":170,"rows":55}', '0\x03']) raw.send(msg);
    await sleep(150); raw.close();
    assert.doesNotMatch(demo.capture('1'), /RAW_BACKEND/); assert.deepEqual(demo.snapshot(), geometry);
    const second = await client(demo, demo.tokens.writer); peers.push(second);
    second.send({ type: 'select', pane: '1' }); await second.selected('1');
    second.send({ type: 'claim' }); await second.wait(m => m.type === 'error', 'competing writer denied');
    a.ws.close(); await until(() => a.ws.readyState === WebSocket.CLOSED, 'disconnect'); await sleep(100);
    second.messages.length = 0; second.send({ type: 'claim' });
    const lease2 = (await second.wait(m => m.type === 'lease', 'disconnect revoked lease')).lease;
    assert.notEqual(lease2.token, lease.token);
    second.messages.length = 0; second.send({ type: 'input', lease, operation: { type: 'text', text: 'DISCONNECTED_LEASE' } });
    await second.wait(m => m.type === 'error', 'old connection lease denied');
    second.send({ type: 'input', lease: lease2, operation: { type: 'text', text: 'AFTER_RECONNECT' } });
    await Promise.all([second.output('AFTER_RECONNECT'), b.output('AFTER_RECONNECT')]);
    second.messages.length = 0; second.send({ type: 'select', pane: '2' }); await second.selected('2');
    second.send({ type: 'input', lease: lease2, operation: { type: 'text', text: 'WRONG_PANE' } });
    await second.wait(m => m.type === 'error', 'selection revokes lease');
    assert.doesNotMatch(demo.capture('2'), /WRONG_PANE/);
    demo.loseFixture('1');
    await until(() => b.ws.readyState === WebSocket.CLOSED && second.ws.readyState === WebSocket.CLOSED, 'session loss closes all clients');
    await deniedUpgrade(demo, '/ws?token=' + demo.tokens.writer);
  } finally { for (const p of peers) p.ws.close(); await demo.close(); }
  assert.equal(fs.existsSync(demo.dir), false);
  await until(() => demo.ownedPids.every(pid => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } }), 'own ttyd, tmux and cat processes exited');
});

test('One-command CLI prints distinct URLs and SIGTERM cleans its fixtures', { timeout: 20000 }, async () => {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['collaboration-mvp/server.js'], { cwd: require('node:path').resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const peers = [];
  try {
    await until(() => stdout.includes('Client B (observer):') || child.exitCode !== null, 'CLI URLs');
    assert.equal(child.exitCode, null, stderr);
    const aURL = new URL(stdout.match(/Client A \(writer\): (http:\/\/[^\s]+)/)[1]);
    const bURL = new URL(stdout.match(/Client B \(observer\): (http:\/\/[^\s]+)/)[1]);
    const demo = { url: aURL.origin };
    assert.equal(aURL.hostname, '127.0.0.1'); assert.equal(aURL.origin, bURL.origin);
    const tokenA = new URLSearchParams(aURL.hash.slice(1)).get('token');
    const tokenB = new URLSearchParams(bURL.hash.slice(1)).get('token'); assert.notEqual(tokenA, tokenB);
    const a = await client(demo, tokenA), b = await client(demo, tokenB); peers.push(a, b);
    a.send({ type: 'select', pane: '1' }); b.send({ type: 'select', pane: '1' });
    await Promise.all([a.selected('1'), b.selected('1')]);
    a.send({ type: 'claim' }); const lease = (await a.wait(m => m.type === 'lease', 'CLI lease')).lease;
    a.send({ type: 'input', lease, operation: { type: 'text', text: 'ONE_COMMAND_LIVE' } });
    await Promise.all([a.output('ONE_COMMAND_LIVE'), b.output('ONE_COMMAND_LIVE')]);
    child.kill('SIGTERM'); const result = await exited; assert.deepEqual(result, { code: 0, signal: null });
    await assert.rejects(fetch(demo.url));
  } finally {
    for (const p of peers) p.ws.close();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
  }
});
