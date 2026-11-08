'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createFixture, sleep } = require('./collaboration-fixture');
const { privateCall, operationDigest } = require('../../runtime/gateway/collaboration-contract.cjs');
async function until(read, match) { let value; for (let i = 0; i < 100; i++) { value = await read(); if (match(value)) return value; await sleep(25); } assert.fail('Fixture condition timed out'); }
test('real ttyd raw binary/fragmented human input and coordinated MCP handoff preserve terminal bytes', async t => {
  const f = await createFixture(); t.after(() => f.close());
  assert.equal(fs.statSync(f.collaborationSocket).mode & 0o777, 0o600);
  await assert.rejects(f.connect({ owner: false }));
  const { client, output } = await f.connect();
  await until(output, text => text.length > 0);
  const [target] = await f.list();
  const typed = await f.mutate('terminal_type', { target, text: 'AI_中文_quoted' });
  assert.deepEqual(typed, { sent: true, submitted: false });
  await until(output, text => text.includes('AI_中文_quoted'));
  assert.deepEqual(await f.mutate('terminal_send_key', { target, key: 'Enter' }), { sent: true, submitted: true });
  // RFC6455 fragmentation is reassembled without converting raw terminal control bytes.
  client.send(Buffer.from('0HUMAN_'), { binary: true, fin: false });
  client.send(Buffer.from('中文\r'), { binary: true, fin: true });
  await until(output, text => text.includes('HUMAN_中文'));
  await until(() => f.request('GET', '/api/collaboration/state'), r => r.data?.sessions?.shared?.state === 'paused');
  assert.equal((await f.mutate('terminal_send_key', { target, key: 'Enter' })).error.code, 'STALE_INPUT_GENERATION');
  assert.equal((await f.control('resume')).status, 200);
  assert.equal((await f.mutate('terminal_send_key', { target, key: 'Enter' })).error.code, 'STALE_INPUT_GENERATION');
  const [fresh] = await f.list();
  assert.deepEqual(await f.mutate('terminal_type', { target: fresh, text: 'AFTER_RESUME' }), { sent: true, submitted: false });
  await until(output, text => text.includes('AFTER_RESUME'));
  // Native flow-control/resize are not human input and must not pause sharing.
  client.send(Buffer.from('2')); client.send(Buffer.from('3')); client.send(Buffer.from('1{"columns":90,"rows":28}'));
  await sleep(50);
  assert.equal((await f.request('GET', '/api/collaboration/state')).data.sessions.shared.state, 'sharing');
  assert.ok(f.verifierRequests() >= 4, 'owner verified for upgrade, controls and human input');
});
test('owner controls require independent owner verification and CSRF; image insert also invalidates AI generation', async t => {
  const f = await createFixture(); t.after(() => f.close());
  assert.equal((await f.request('GET', '/api/collaboration/state', { owner: false })).status >= 400, true);
  assert.equal((await f.control('pause', 'shared', false)).status >= 400, true);
  const denied = await f.request('POST', '/api/collaboration/control', { body: { session: 'shared', action: 'pause' }, headers: { Origin: 'http://other.invalid', 'Content-Type': 'application/json', 'X-Terminal-Request': f.tokens.token } });
  assert.equal(denied.status, 403);
  const secondaryName = 'web-abcdef012345';
  f.tmux('new-session', '-d', '-s', secondaryName, '/bin/cat');
  await f.control('resume', secondaryName);
  const all = await f.list(), target = all.find(p => p.sessionName === 'shared'), secondary = all.find(p => p.sessionName === secondaryName);
  assert.deepEqual(await f.mutate('terminal_type', { target: secondary, text: 'SECONDARY_AI_DRAFT' }), { sent: true, submitted: false });
  const headers = { Origin: 'http://fixture.invalid', 'Content-Type': 'application/json', 'X-Terminal-Request': f.tokens.token,
    'X-Terminal-Session': 'shared', 'X-Terminal-Session-Id': target.sessionId, 'X-Terminal-Pane': target.paneId, 'X-Terminal-Server-Pid': target.serverPid };
  const receipt = (await f.request('POST', '/api/images/prepare', { headers })).data;
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl6sAAAAASUVORK5CYII=', 'base64');
  const uploaded = await f.request('POST', '/api/images', { body: image, headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Image-Receipt': receipt.ticket } });
  assert.equal(uploaded.status, 201);
  assert.equal((await f.request('POST', '/api/images/insert', { headers: { ...headers, 'X-Image-Receipt': receipt.ticket } })).status, 200);
  const state = (await f.request('GET', '/api/collaboration/state')).data.sessions;
  assert.equal(state.shared.state, 'paused');
  assert.equal(state[secondaryName].paused, true, 'image insertion fences writers outside its captured session too');
  assert.equal((await f.mutate('terminal_send_key', { target: secondary, key: 'Enter' })).error.code, 'STALE_INPUT_GENERATION');
  assert.equal((await f.mutate('terminal_type', { target, text: 'OLD' })).error.code, 'STALE_INPUT_GENERATION');
  assert.match(f.tmux('capture-pane', '-p', '-t', target.paneId), /uploads/);
});
test('same-pane respawn rotates server-owned generation; direct private admission replay is denied', async t => {
  const f = await createFixture(); t.after(() => f.close());
  const [target] = await f.list();
  f.tmux('respawn-pane', '-k', '-t', target.paneId, '/bin/cat');
  const stale = await f.mutate('terminal_type', { target, text: 'MUST_NOT_ARRIVE' });
  assert.equal(stale.error.code, 'STALE_INPUT_GENERATION');
  assert.doesNotMatch(f.tmux('capture-pane', '-p', '-t', target.paneId), /MUST_NOT_ARRIVE/);
  await f.control('resume');
  const [fresh] = await f.list(), args = { target: fresh, text: 'ONCE' };
  const admission = await privateCall(f.collaborationSocket, '/v1/admit', { grant: f.grant, tool: 'terminal_type', digest: operationDigest('terminal_type', args) });
  const request = { ...admission, tool: 'terminal_type', arguments: args };
  assert.deepEqual(await privateCall(f.collaborationSocket, '/v1/execute', request), { sent: true, submitted: false });
  assert.equal((await privateCall(f.collaborationSocket, '/v1/execute', request)).error.code, 'AUTHORITY_UNAVAILABLE');
});

test('full signed-owner OAuth gateway to coordinated MCP to UI broker delivers actual terminal input', async t => {
  const f = await createFixture({ realGateway: true }); t.after(() => f.close());
  assert.equal((await f.rpc('tools/list', {}, false)).status, 401);
  assert.equal((await f.rpc('tools/list')).data.result.tools.length, 6);
  const { client, output } = await f.connect();
  const [target] = await f.list();
  assert.deepEqual(await f.mutate('terminal_type', { target, text: 'SIGNED_OAUTH_中文' }), { sent: true, submitted: false });
  await until(output, text => text.includes('SIGNED_OAUTH_中文'));
  assert.deepEqual(await f.mutate('terminal_send_key', { target, key: 'Enter' }), { sent: true, submitted: true });
  client.send(Buffer.from('0OWNER_EDIT\r'));
  await until(output, text => text.includes('OWNER_EDIT'));
  await until(() => f.request('GET', '/api/collaboration/state'), r => r.data?.sessions?.shared?.state === 'paused');
  assert.equal((await f.control('resume')).status, 200);
  assert.equal((await f.mutate('terminal_send_key', { target, key: 'Enter' })).error.code, 'STALE_INPUT_GENERATION');
  const [fresh] = await f.list();
  assert.deepEqual(await f.mutate('terminal_type', { target: fresh, text: 'FRESH_AFTER_OWNER' }), { sent: true, submitted: false });
  assert.equal((await f.revoke()).status, 200);
  assert.equal((await f.mutate('terminal_type', { target: fresh, text: 'REVOKED_MUST_NOT_ARRIVE' })).error.code, 'AUTHORITY_UNAVAILABLE');
  assert.doesNotMatch(f.tmux('capture-pane', '-p', '-t', target.paneId), /REVOKED_MUST_NOT_ARRIVE/);
});


test('native tmux next-session switching cannot leave the destination AI writer active', async t => {
  const f = await createFixture(); t.after(() => f.close());
  const webName = 'web-012345abcdef';
  f.tmux('new-session', '-d', '-s', webName, '/bin/cat');
  const { client } = await f.connect();
  await f.control('resume', webName);
  const web = (await f.list()).find(p => p.sessionName === webName);
  assert.deepEqual(await f.mutate('terminal_type', { target: web, text: 'AI_WEB_DRAFT_' }), { sent: true, submitted: false });
  // Native tmux C-b ')' switches the existing ttyd client away from its URL's
  // original shared session. Subsequent owner input really edits the web pane.
  client.send(Buffer.from([48, 2, 41]));
  await until(() => f.tmux('list-clients', '-F', '#{session_name}').trim(), name => name === webName);
  client.send(Buffer.from('0HUMAN_WEB_EDIT'));
  await until(() => f.tmux('capture-pane', '-p', '-t', web.paneId), text => text.includes('HUMAN_WEB_EDIT'));
  assert.equal((await f.request('GET', '/api/collaboration/state')).data.sessions[webName].paused, true);
  const oldEnter = await f.mutate('terminal_send_key', { target: web, key: 'Enter' });
  assert.equal(oldEnter.error.code, 'STALE_INPUT_GENERATION');
  const freshPaused = (await f.list()).find(p => p.sessionName === webName);
  assert.equal((await f.mutate('terminal_type', { target: freshPaused, text: 'NO_IMPLICIT_RESUME' })).error.code, 'INPUT_PAUSED');
  assert.doesNotMatch(f.tmux('capture-pane', '-p', '-t', web.paneId), /NO_IMPLICIT_RESUME/);
  assert.equal((await f.control('resume', webName)).status, 200);
  const fresh = (await f.list()).find(p => p.sessionName === webName);
  assert.deepEqual(await f.mutate('terminal_type', { target: fresh, text: '_EXPLICIT_RESUME' }), { sent: true, submitted: false });
  assert.equal((await f.request('GET', '/api/collaboration/state')).data.sessions.shared.paused, true);
});
