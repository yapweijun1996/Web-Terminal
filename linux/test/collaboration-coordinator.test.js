'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCoordinator } = require('../ui/collaboration');
const { operationDigest, privateCall } = require('../../runtime/gateway/collaboration-contract.cjs');
const base = { serverPid: '123', sessionId: '$1', windowId: '@1', paneId: '%1', sessionName: 'shared' };
const owner = () => ({ authorized: true, ownerId: 'test-owner', expires: Date.now() + 60000 });
const code = expected => error => error.code === expected;
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-'));
  const writes = [], socket = path.join(root, 'coord.sock');
  const panes = [base, { ...base, paneId: '%2' }];
  const controller = { list: async () => panes.map(p => ({ ...p })), validate: async target => {
    const p = panes.find(p => ['serverPid', 'sessionId', 'windowId', 'paneId'].every(k => target?.[k] === p[k]));
    if (!p) throw Object.assign(Error('target'), { code: 'STALE_TARGET' }); return p;
  }, type: async (target, text, options) => { await options.beforeDispatch(); writes.push({ target, text }); return { sent: true, submitted: false }; },
  key: async (target, key, options) => { await options.beforeDispatch(); writes.push({ target, key }); return { sent: true, submitted: key === 'Enter' }; } };
  controller.run = async values => { const paneId = /%\d+/.exec(values[values.indexOf('-t') + 1])?.[0]; const p = panes.find(p => p.paneId === paneId); return `${p.serverPid}|${p.sessionId}|${p.windowId}|${p.paneId}|1000|0\n`; };
  Object.assign(controller, options.controller);
  const coordinator = await createCoordinator({ verifyGrant: async grant => ({ active: true, expires: grant.expires }), verifyAutoOwner: async saved => saved, ...options, socket, controller });
  t.after(async () => { await coordinator.close(); fs.rmSync(root, { recursive: true, force: true }); });
  if (options.startPaused !== true) for (const pane of panes) await coordinator.control(pane.sessionName, 'resume', owner());
  const args = async (overrides = {}) => ({ target: (await coordinator.list()).panes[0], text: 'literal 中文', ...overrides });
  const defaultGrant = { id: 'test-grant', expires: Date.now() + 60000 };
  const admit = (tool, args, grant = defaultGrant) => coordinator.admit({ grant, tool, digest: operationDigest(tool, args) });
  return { coordinator, writes, controller, panes, socket, args, admit };
}
test('private coordinator admits exact one-use requests; nonce/digest/grant/generation cannot be forged', async t => {
  const f = await fixture(t), args = await f.args();
  const grant = { id: 'grant-one', expires: Date.now() + 60000 };
  const admitted = f.admit('terminal_type', args, grant);
  const request = { ...admitted, tool: 'terminal_type', arguments: args };
  assert.deepEqual(await privateCall(f.socket, '/v1/execute', request), { sent: true, submitted: false });
  assert.equal(f.writes.length, 1);
  assert.equal((await privateCall(f.socket, '/v1/execute', request)).error.code, 'AUTHORITY_UNAVAILABLE');
  const changed = { ...args, text: 'different' };
  assert.equal((await privateCall(f.socket, '/v1/execute', { ...f.admit('terminal_type', args, grant), tool: 'terminal_type', arguments: changed })).error.code, 'AUTHORITY_UNAVAILABLE');
  const keys = { target: args.target, key: 'Enter' };
  assert.deepEqual(await f.coordinator.execute({ ...f.admit('terminal_send_key', keys, grant), tool: 'terminal_send_key', arguments: keys }), { sent: true, submitted: true });
  assert.equal(f.writes.length, 2);
  await f.coordinator.revoke({ grantId: grant.id });
  assert.throws(() => f.admit('terminal_type', args, grant), code('AUTHORITY_UNAVAILABLE'));
  assert.rejects(f.coordinator.execute({ admission: 'forged', tool: 'terminal_type', arguments: args }), code('AUTHORITY_UNAVAILABLE'));
});
test('owner activity pauses an entire session; delayed AI Enter stays stale after explicit resume', async t => {
  const f = await fixture(t), args = await f.args();
  const grant = { id: 'grant-one', expires: Date.now() + 60000 };
  const enter = { target: args.target, key: 'Enter' };
  const old = f.admit('terminal_send_key', enter, grant);
  let delivered = 0;
  await f.coordinator.human('shared', owner(), () => { delivered++; });
  assert.equal(delivered, 1);
  const listed = (await f.coordinator.list()).panes;
  assert.equal(listed[0].collaboration.paused, true);
  assert.equal(listed[1].collaboration.paused, true);
  assert.equal(listed[0].inputGeneration, listed[1].inputGeneration);
  await f.coordinator.control('shared', 'resume', owner());
  await assert.rejects(f.coordinator.execute({ ...old, tool: 'terminal_send_key', arguments: enter }), code('STALE_INPUT_GENERATION'));
  assert.equal(f.writes.length, 0);
  const fresh = await f.args();
  assert.deepEqual(await f.coordinator.execute({ ...f.admit('terminal_type', fresh, grant), tool: 'terminal_type', arguments: fresh }), { sent: true, submitted: false });
});
test('pause invalidates admission immediately but confirms only after real in-flight write drains', async t => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { controller: { type: async () => { started(); await new Promise(resolve => { release = resolve; }); return { sent: true, submitted: false }; } } });
  const args = await f.args(), grant = { id: 'grant-one', expires: Date.now() + 60000 };
  const writing = f.coordinator.execute({ ...f.admit('terminal_type', args, grant), tool: 'terminal_type', arguments: args });
  await began;
  let confirmed = false;
  const pause = f.coordinator.control('shared', 'pause', owner()).then(value => { confirmed = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmed, false);
  const current = await f.args();
  await assert.rejects(f.coordinator.execute({ ...f.admit('terminal_type', current, grant), tool: 'terminal_type', arguments: current }), code('INPUT_PAUSED'));
  release(); await writing;
  assert.equal((await pause).state, 'manual-paused');
  assert.equal(confirmed, true);
});
test('uncertain delivery remains paused and cannot falsely confirm resume or human dispatch', async t => {
  const f = await fixture(t, { controller: { type: async () => { throw Error('secret upstream command details'); } } });
  const args = await f.args();
  const result = await privateCall(f.socket, '/v1/execute', { ...f.admit('terminal_type', args), tool: 'terminal_type', arguments: args });
  assert.equal(result.error.code, 'OPERATION_UNAVAILABLE'); assert.doesNotMatch(JSON.stringify(result), /secret|upstream command/);
  await assert.rejects(f.coordinator.control('shared', 'resume', owner()), code('OPERATION_UNAVAILABLE'));
  await assert.rejects(f.coordinator.human('shared', owner(), () => assert.fail('uncertain input must not claim safely drained')), code('OPERATION_UNAVAILABLE'));
});
test('admission TTL/expiry, missing generation and unauthenticated owner controls fail closed', async t => {
  let now = 0, wall = Date.now();
  const f = await fixture(t, { now: () => now, wallNow: () => wall });
  const args = await f.args(), grant = { id: 'grant-one', expires: wall + 20000 };
  const admission = f.admit('terminal_type', args, grant); now = 15001;
  await assert.rejects(f.coordinator.execute({ ...admission, tool: 'terminal_type', arguments: args }), code('AUTHORITY_UNAVAILABLE'));
  now = 0;
  const expired = f.admit('terminal_type', args, grant); wall = grant.expires;
  await assert.rejects(f.coordinator.execute({ ...expired, tool: 'terminal_type', arguments: args }), code('AUTHORITY_UNAVAILABLE'));
  await assert.rejects(f.coordinator.control('shared', 'resume', { authorized: true, ownerId: 'forged', expires: 1 }), code('AUTHORITY_UNAVAILABLE'));
  const missing = { ...args, target: { ...args.target, inputGeneration: undefined } };
  const freshGrant = { id: 'grant-two', expires: wall + 20000 };
  await assert.rejects(f.coordinator.execute({ ...f.admit('terminal_type', missing, freshGrant), tool: 'terminal_type', arguments: missing }), code('STALE_INPUT_GENERATION'));
  assert.equal(f.writes.length, 0);
});

test('authoritative grant verifier failure or lost revoke notification never permits a cached admission', async t => {
  let valid = true;
  const f = await fixture(t, { verifyGrant: async grant => ({ active: valid, expires: grant.expires }) });
  const args = await f.args(), granted = f.admit('terminal_type', args);
  valid = false; // Gateway revoked grant; its best-effort notify was lost.
  await assert.rejects(f.coordinator.execute({ ...granted, tool: 'terminal_type', arguments: args }), code('AUTHORITY_UNAVAILABLE'));
  assert.equal(f.writes.length, 0);
});
test('admission TTL is rechecked after async target verification and at final controller dispatch', async t => {
  let now = 0, gate, began;
  const started = new Promise(resolve => { began = resolve; });
  const f = await fixture(t, { now: () => now });
  const args = await f.args(), original = f.controller.validate;
  f.controller.validate = async target => { began(); await new Promise(resolve => { gate = resolve; }); return original(target); };
  const admitted = f.admit('terminal_type', args);
  const pending = f.coordinator.execute({ ...admitted, tool: 'terminal_type', arguments: args });
  await started; now = 15001; gate();
  await assert.rejects(pending, code('AUTHORITY_UNAVAILABLE'));
  assert.equal(f.writes.length, 0);
  f.controller.validate = original; now = 0;
  f.controller.type = async (target, text, options) => { now = 15001; await options.beforeDispatch(); f.writes.push(text); };
  const next = f.admit('terminal_type', args);
  await assert.rejects(f.coordinator.execute({ ...next, tool: 'terminal_type', arguments: args }), code('AUTHORITY_UNAVAILABLE'));
  assert.equal(f.writes.length, 0);
});
test('revocation invalidates immediately but waits for in-flight delivery before confirmed acknowledgement', async t => {
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const f = await fixture(t, { controller: { type: async () => { began(); await new Promise(resolve => { release = resolve; }); return { sent: true, submitted: false }; } } });
  const args = await f.args(), grant = { id: 'pending-grant', expires: Date.now() + 60000 };
  const writing = f.coordinator.execute({ ...f.admit('terminal_type', args, grant), tool: 'terminal_type', arguments: args });
  await started;
  let confirmed = false;
  const revoked = f.coordinator.revoke({ grantId: grant.id }).then(value => { confirmed = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmed, false);
  assert.throws(() => f.admit('terminal_type', args, grant), code('AUTHORITY_UNAVAILABLE'));
  release(); await writing; assert.deepEqual(await revoked, { revoked: true }); assert.equal(confirmed, true);
});

test('expired writer generations cannot silently reacquire for an old Enter or overwrite another writer draft', async t => {
  let now = 0;
  const f = await fixture(t, { now: () => now });
  const a = { id: 'writer-a', expires: Date.now() + 120000 }, b = { id: 'writer-b', expires: Date.now() + 120000 };
  const initial = await f.args();
  assert.deepEqual(await f.coordinator.execute({ ...f.admit('terminal_type', initial, a), tool: 'terminal_type', arguments: initial }), { sent: true, submitted: false });
  now = 15001;
  const delayed = { target: initial.target, key: 'Enter' };
  await assert.rejects(f.coordinator.execute({ ...f.admit('terminal_send_key', delayed, a), tool: 'terminal_send_key', arguments: delayed }), code('STALE_INPUT_GENERATION'));
  const current = await f.args({ text: 'writer-b-draft' });
  assert.notEqual(current.target.inputGeneration, initial.target.inputGeneration);
  assert.deepEqual(await f.coordinator.execute({ ...f.admit('terminal_type', current, b), tool: 'terminal_type', arguments: current }), { sent: true, submitted: false });
  now = 30002;
  await assert.rejects(f.coordinator.execute({ ...f.admit('terminal_send_key', delayed, a), tool: 'terminal_send_key', arguments: delayed }), code('STALE_INPUT_GENERATION'));
  assert.deepEqual(f.writes.map(write => write.key || write.text), ['literal 中文', 'writer-b-draft']);
  const fresh = await f.args({ text: 'fresh-deliberate-action' });
  assert.notEqual(fresh.target.inputGeneration, current.target.inputGeneration);
  assert.deepEqual(await f.coordinator.execute({ ...f.admit('terminal_type', fresh, a), tool: 'terminal_type', arguments: fresh }), { sent: true, submitted: false });
});


test('human input fences all sessions, waits for cross-session writes and pauses newly discovered sessions', async t => {
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  let held = true;
  const f = await fixture(t, { controller: { type: async () => {
    if (held) { began(); await new Promise(resolve => { release = resolve; }); held = false; }
    return { sent: true, submitted: false };
  } } });
  const web = { ...base, sessionId: '$2', windowId: '@2', paneId: '%3', sessionName: 'web-012345abcdef' };
  f.panes.push(web);
  await f.coordinator.control(web.sessionName, 'resume', owner());
  const target = (await f.coordinator.list()).panes.find(p => p.sessionName === web.sessionName);
  const args = { target, text: 'AI_WEB_DRAFT' }, grant = { id: 'cross-session-grant', expires: Date.now() + 60000 };
  const writing = f.coordinator.execute({ ...f.admit('terminal_type', args, grant), tool: 'terminal_type', arguments: args });
  await started;
  const binding = await f.coordinator.binding('shared');
  let forwarded = false;
  const human = f.coordinator.human('shared', owner(), () => { forwarded = true; }, binding);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(forwarded, false, 'human bytes wait for a write in a different session');
  assert.equal((await f.coordinator.state(web.sessionName)).paused, true);
  await assert.rejects(f.coordinator.control(web.sessionName, 'resume', owner()), code('INPUT_BUSY'));
  release(); await writing; await human;
  assert.equal(forwarded, true);
  const delayed = { target, key: 'Enter' };
  await assert.rejects(f.coordinator.execute({ ...f.admit('terminal_send_key', delayed, grant), tool: 'terminal_send_key', arguments: delayed }), code('STALE_INPUT_GENERATION'));
  const next = { ...web, sessionId: '$3', windowId: '@3', paneId: '%4', sessionName: 'web-fedcba654321' };
  f.panes.push(next);
  const listed = (await f.coordinator.list()).panes;
  assert.equal(listed.find(p => p.sessionName === next.sessionName).collaboration.paused, true, 'a session first discovered after human activity must not reopen AI writing');
  await f.coordinator.control(web.sessionName, 'resume', owner());
  const fresh = (await f.coordinator.list()).panes.find(p => p.sessionName === web.sessionName);
  assert.equal(fresh.collaboration.paused, false);
  assert.equal((await f.coordinator.state('shared')).paused, true, 'resume is explicit and local, not an all-session grant');
  const current = { target: fresh, text: 'FRESH_DELIBERATE_WEB_ACTION' };
  assert.deepEqual(await f.coordinator.execute({ ...f.admit('terminal_type', current, grant), tool: 'terminal_type', arguments: current }), { sent: true, submitted: false });
});

test('new coordinator starts paused until explicit owner Resume', async t => {
  const f = await fixture(t, { startPaused: true });
  const args = await f.args();
  assert.equal((await f.coordinator.list()).panes[0].collaboration.paused, true);
  await assert.rejects(f.coordinator.execute({ ...f.admit('terminal_type', args), tool: 'terminal_type', arguments: args }), code('INPUT_PAUSED'));
  await f.coordinator.control('shared', 'resume', owner());
  assert.deepEqual(await f.coordinator.execute({ ...f.admit('terminal_type', await f.args()), tool: 'terminal_type', arguments: await f.args() }), { sent: true, submitted: false });
});

test('owner-authorized sharing resumes after 10s human idle and rejects stale Enter', async t => {
  const f = await fixture(t, { humanIdleMs: 45 });
  const previous = await f.args();
  await f.coordinator.human('shared', owner(), async () => {});
  assert.equal((await f.coordinator.state('shared')).paused, true);
  const stale = { target: previous.target, key: 'Enter' };
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal((await f.coordinator.state('shared')).state, 'sharing');
  await assert.rejects(f.coordinator.execute({ ...f.admit('terminal_send_key', stale), tool: 'terminal_send_key', arguments: stale }), code('STALE_INPUT_GENERATION'));
  assert.equal(f.writes.length, 0);
});

test('repeated human input resets idle clock; manual Pause never auto-resumes', async t => {
  const f = await fixture(t, { humanIdleMs: 90 });
  await f.coordinator.human('shared', owner(), async () => {});
  await new Promise(resolve => setTimeout(resolve, 55));
  await f.coordinator.human('shared', owner(), async () => {});
  await new Promise(resolve => setTimeout(resolve, 55));
  assert.equal((await f.coordinator.state('shared')).paused, true);
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal((await f.coordinator.state('shared')).state, 'sharing');
  await f.coordinator.control('shared', 'pause', owner());
  await new Promise(resolve => setTimeout(resolve, 125));
  assert.equal((await f.coordinator.state('shared')).state, 'manual-paused');
});

test('fresh coordinator starts paused and never auto-resumes without explicit owner consent', async t => {
  const f = await fixture(t, { startPaused: true, humanIdleMs: 25 });
  await f.coordinator.human('shared', owner(), async () => {});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await f.coordinator.state('shared')).paused, true);
});

test('expired owner approval prevents automatic resumption', async t => {
  const f = await fixture(t, { startPaused: true, humanIdleMs: 50 });
  await f.coordinator.control('shared', 'resume', { ...owner(), expires: Date.now() + 15 });
  await f.coordinator.human('shared', owner(), async () => {});
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal((await f.coordinator.state('shared')).paused, true);
});

test('auto sharing resumes previously authorized sessions but not unapproved sessions', async t => {
  const f = await fixture(t, { startPaused: true, humanIdleMs: 35 });
  const second = { ...base, sessionId: '$2', windowId: '@2', paneId: '%3', sessionName: 'web-012345abcdef' };
  f.panes.push(second);
  await f.coordinator.control('shared', 'resume', owner());
  await f.coordinator.human('shared', owner(), async () => {});
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal((await f.coordinator.state('shared')).state, 'sharing');
  assert.equal((await f.coordinator.state(second.sessionName)).paused, true);
});

test('unknown delivery cannot auto resume after idle', async t => {
  const f = await fixture(t, { humanIdleMs: 35, controller: { type: async () => { throw Error('uncertain dispatch'); } } });
  const args = await f.args();
  await assert.rejects(f.coordinator.execute({ ...f.admit('terminal_type', args), tool: 'terminal_type', arguments: args }), code('OPERATION_UNAVAILABLE'));
  await assert.rejects(f.coordinator.human('shared', owner(), async () => {}), code('OPERATION_UNAVAILABLE'));
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal((await f.coordinator.state('shared')).state, 'unknown');
});

test('revoked active grant prevents idle auto-resume', async t => {
  const f = await fixture(t, { humanIdleMs: 35 });
  const args = await f.args();
  await f.coordinator.execute({ ...f.admit('terminal_type', args), tool: 'terminal_type', arguments: args });
  await f.coordinator.human('shared', owner(), async () => {});
  await f.coordinator.revoke({ grantId: 'test-grant' });
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal((await f.coordinator.state('shared')).paused, true);
});

test('owner authority revoked before idle deadline never auto resumes', async t => {
  let active = true;
  const f = await fixture(t, { humanIdleMs: 35, verifyAutoOwner: async saved => active ? saved : null });
  await f.coordinator.human('shared', owner(), async () => {});
  active = false;
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal((await f.coordinator.state('shared')).paused, true);
  assert.equal((await f.coordinator.state('shared')).idleRemainingMs, null);
});

test('authority verifier failure stays closed and does not retry automatically', async t => {
  let checks = 0;
  const f = await fixture(t, { humanIdleMs: 30, verifyAutoOwner: async () => { checks++; throw Error('verifier offline'); } });
  await f.coordinator.human('shared', owner(), async () => {});
  await new Promise(resolve => setTimeout(resolve, 85));
  assert.equal((await f.coordinator.state('shared')).paused, true);
  assert.equal(checks, 1);
});

test('in-flight write draining after idle deadline re-arms auto resume', async t => {
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const f = await fixture(t, { humanIdleMs: 35, controller: { type: async (_target, _text, options) => {
    began(); await new Promise(resolve => { release = resolve; }); await options.beforeDispatch(); return { sent: true, submitted: false };
  } } });
  const args = await f.args();
  const writing = f.coordinator.execute({ ...f.admit('terminal_type', args), tool: 'terminal_type', arguments: args });
  await started;
  const human = f.coordinator.human('shared', owner(), async () => {});
  await new Promise(resolve => setTimeout(resolve, 55));
  assert.equal((await f.coordinator.state('shared')).paused, true);
  release();
  await assert.rejects(writing, code('STALE_INPUT_GENERATION'));
  await human;
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal((await f.coordinator.state('shared')).state, 'sharing');
});

test('server-side OAuth grant revocation cancels auto sharing even without active writer', async t => {
  const f = await fixture(t, { humanIdleMs: 35 });
  const args = await f.args();
  f.admit('terminal_type', args);
  await f.coordinator.human('shared', owner(), async () => {});
  await f.coordinator.revoke({ grantId: 'test-grant' });
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal((await f.coordinator.state('shared')).state, 'manual-paused');
  assert.equal((await f.coordinator.state('shared')).idleRemainingMs, null);
});

test('diagnostics capture successful resume, human pause and manual pause without session identifiers', async t => {
  const events = [];
  const f = await fixture(t, { startPaused: true, diagnostic: event => events.push(event) });
  await f.coordinator.control('shared', 'resume', owner());
  await f.coordinator.human('shared', owner(), async () => {});
  await f.coordinator.control('shared', 'pause', owner());
  assert.ok(events.some(e => e.event === 'resume' && e.action === 'resume' && e.reason === 'accepted' && e.state === 'sharing' && !e.status));
  assert.ok(events.some(e => e.event === 'pause' && e.reason === 'human_input'));
  assert.ok(events.some(e => e.event === 'pause' && e.reason === 'manual'));
  assert.doesNotMatch(JSON.stringify(events), /shared|test-owner|sessionId|inputGeneration|token/);
});

test('diagnostics capture auto-resume authority failure and never reopen sharing', async t => {
  const events = [];
  const f = await fixture(t, { humanIdleMs: 20, diagnostic: event => events.push(event), verifyAutoOwner: async () => null });
  await f.coordinator.human('shared', owner(), async () => {});
  await new Promise(resolve => setTimeout(resolve, 55));
  assert.equal((await f.coordinator.state('shared')).paused, true);
  assert.ok(events.some(e => e.event === 'auto_resume' && e.reason === 'owner_unavailable'));
  assert.ok(!events.some(e => e.event === 'auto_resume' && e.reason === 'accepted'));
});
