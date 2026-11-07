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

test('Agent opt-in rejects other modes, commands, flags and fixture CLI without launching Codex', async () => {
  const { spawnSync } = require('node:child_process');
  for (const args of [['--agent', 'fixture'], ['--agent', 'sh'], ['--agent', 'codex', '--full-auto'], ['--agent=codex'], ['--agent', 'codex', '--dangerously-bypass-approvals-and-sandbox']]) {
    const result = spawnSync(process.execPath, ['collaboration-mvp/server.js', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /Usage:/); assert.equal(result.stdout, '');
  }
  await assert.rejects(startDemo({ agentMode: 'sh' }), /Unsupported agent mode/);
});

test('Agent Golden E2E: isolated fixture session, exact text + Enter, two live watchers and independent views', { timeout: 45000 }, async () => {
  const demo = await startDemo({ agentMode: 'fixture' }); const peers = [];
  try {
    const { execFileSync } = require('node:child_process');
    const [agent, cat] = demo.targetInfo();
    assert.equal(fs.statSync(demo.dir + '/agent').mode & 0o777, 0o700);
    assert.equal(fs.realpathSync(execFileSync('tmux', ['-S', demo.dir + '/tmux.sock', 'display-message', '-p', '-t', agent.paneId, '#{pane_start_path}'], { encoding: 'utf8' }).trim()), fs.realpathSync(demo.dir + '/agent'));
    assert.equal(agent.agent, true); assert.equal(cat.agent, false);
    assert.equal(agent.serverPid, cat.serverPid);
    assert.notEqual(agent.sessionId, cat.sessionId, 'agent owns a different disposable session');
    assert.notEqual(agent.windowId, cat.windowId); assert.notEqual(agent.paneId, cat.paneId);
    const a = await client(demo, demo.tokens.writer), b = await client(demo, demo.tokens.observer); peers.push(a, b);
    assert.equal(a.messages.find(m => m.type === 'hello').agentMode, 'fixture');
    a.send({ type: 'select', pane: '1' }); b.send({ type: 'select', pane: '1' });
    await Promise.all([a.selected('1'), b.selected('1'), a.output('FIXTURE_AGENT_READY'), b.output('FIXTURE_AGENT_READY')]);
    await until(() => demo.watchCount() === 2, 'two actual agent watchers');
    const geometry = demo.snapshot();
    a.send({ type: 'claim' }); const lease = (await a.wait(m => m.type === 'lease', 'agent lease')).lease;
    b.send({ type: 'claim', takeover: true, write: true, principal: 'writer' });
    await b.wait(m => m.type === 'error', 'observer cannot steal agent lease'); b.messages.length = 0;
    b.send({ type: 'input', lease, operation: { type: 'text', text: 'FORBIDDEN_AGENT' } });
    await b.wait(m => m.type === 'error', 'observer cannot input with owner proof');
    const text = 'exact "雪"; $() \\';
    const generated = 'FIXTURE_AGENT_GENERATED ' + JSON.stringify(text);
    a.messages.length = 0;
    a.send({ type: 'input', lease, operation: { type: 'text', text } });
    await a.wait(m => m.type === 'ack', 'agent literal text accepted');
    await sleep(150);
    assert.doesNotMatch(demo.capture('1'), /FIXTURE_AGENT_GENERATED/, 'text alone must not submit a line');
    a.messages.length = 0;
    a.send({ type: 'input', lease, operation: { type: 'key', key: 'Enter' } });
    await Promise.all([a.output(generated), b.output(generated)]);
    assert.ok(demo.capture('1').includes(generated), 'fixture generated exact input');
    assert.doesNotMatch(demo.capture('1'), /FORBIDDEN_AGENT/);
    assert.doesNotMatch(demo.capture('2'), /FIXTURE_AGENT|exact/);
    b.messages.length = 0; b.send({ type: 'select', pane: '2' }); await b.selected('2');
    a.messages.length = 0;
    a.send({ type: 'input', lease, operation: { type: 'text', text: 'OWNER_STILL_AGENT' } });
    await a.wait(m => m.type === 'ack', 'observer selection leaves owner lease intact'); a.messages.length = 0;
    a.send({ type: 'input', lease, operation: { type: 'key', key: 'Enter' } });
    await a.output('FIXTURE_AGENT_GENERATED "OWNER_STILL_AGENT"'); await sleep(150);
    assert.equal(b.messages.some(m => m.type === 'output' && m.pane === '1'), false);
    b.messages.length = 0; b.send({ type: 'select', pane: '1' }); await b.selected('1');
    await b.output('FIXTURE_AGENT_GENERATED "OWNER_STILL_AGENT"');
    a.messages.length = 0; a.send({ type: 'select', pane: '2' }); await a.selected('2');
    a.send({ type: 'input', lease, operation: { type: 'text', text: 'WRONG_AGENT_LEASE' } });
    await a.wait(m => m.type === 'error', 'owner switching revokes agent proof');
    assert.doesNotMatch(demo.capture('2'), /WRONG_AGENT_LEASE/);
    assert.deepEqual(demo.snapshot(), geometry, 'view switching preserves tmux selection and geometry');
    // Recreate the process in the SAME pane: four tmux IDs alone must not authorize it.
    execFileSync('tmux', ['-S', demo.dir + '/tmux.sock', 'respawn-pane', '-k', '-t', agent.paneId, '/bin/cat', '-']);
    await until(() => peers.every(p => p.ws.readyState === WebSocket.CLOSED), 'replaced initial pane PID fails closed');
    await deniedUpgrade(demo, '/ws?token=' + demo.tokens.writer);
  } finally { for (const p of peers) p.ws.close(); await demo.close(); }
  assert.equal(fs.existsSync(demo.dir), false);
  await until(() => demo.ownedPids.every(pid => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } }), 'agent demo processes exited');
});

test('Agent fixture SIGTERM cleans only its own private processes; dead agent fails closed', { timeout: 45000 }, async () => {
  const { spawn, execFileSync } = require('node:child_process');
  // A second disposable demo stands in for unrelated work; no owner socket is accessed.
  const sentinel = await startDemo(); const peers = [];
  let child, exited, info;
  try {
    const code = `const {startDemo}=require('./collaboration-mvp/server.js');
      startDemo({agentMode:'fixture'}).then(d=>{
        process.on('SIGTERM',async()=>{await d.close();process.exit(0)});
        console.log(JSON.stringify({url:d.url,tokens:d.tokens,dir:d.dir,ownedPids:d.ownedPids}));
      }).catch(e=>{console.error(e.message);process.exitCode=1});`;
    child = spawn(process.execPath, ['-e', code], { cwd: require('node:path').resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    await until(() => stdout.includes('\n') || child.exitCode !== null, 'fixture child ready');
    assert.equal(child.exitCode, null, stderr); info = JSON.parse(stdout.trim());
    const a = await client(info, info.tokens.writer), b = await client(info, info.tokens.observer); peers.push(a, b);
    a.send({ type: 'select', pane: '1' }); b.send({ type: 'select', pane: '1' });
    await Promise.all([a.output('FIXTURE_AGENT_READY'), b.output('FIXTURE_AGENT_READY')]);
    child.kill('SIGTERM'); assert.deepEqual(await exited, { code: 0, signal: null });
    await assert.rejects(fetch(info.url)); assert.equal(fs.existsSync(info.dir), false);
    await until(() => info.ownedPids.every(pid => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } }), 'SIGTERM owns no remaining processes');
    assert.equal((await fetch(sentinel.url)).status, 200);
    for (const pid of sentinel.ownedPids) assert.doesNotThrow(() => process.kill(pid, 0), 'unrelated demo stays alive');
    assert.equal(sentinel.snapshot().length, 2);
  } finally {
    for (const p of peers) p.ws.close();
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
    await sentinel.close();
  }
  const dead = await startDemo({ agentMode: 'fixture' });
  try {
    const a = await client(dead, dead.tokens.writer); peers.push(a);
    a.send({ type: 'select', pane: '1' }); await a.output('FIXTURE_AGENT_READY');
    // Kill only the recorded fake process, retaining its dead pane (remain-on-exit).
    process.kill(Number(dead.targetInfo()[0].panePid), 'SIGTERM');
    await until(() => a.ws.readyState === WebSocket.CLOSED, 'dead agent closes watcher');
    assert.match(execFileSync('tmux', ['-S', dead.dir + '/tmux.sock', 'display-message', '-p', '-t', dead.targetInfo()[0].paneId, '#{pane_dead}'], { encoding: 'utf8' }), /^1/);
    await deniedUpgrade(dead, '/ws?token=' + dead.tokens.writer);
  } finally { for (const p of peers) p.ws.close(); await dead.close(); }
});
