'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFixture, sleep } = require('./collaboration-fixture');
const { createContextPaste, validateText, digest } = require('../ui/context-paste');
const owner = () => ({ authorized: true, ownerId: 'test', expires: Date.now() + 60000 });
async function fixture(t) {
  const f = await createFixture(); t.after(() => f.close());
  const connection = await f.connect();
  const headers = { Origin: 'http://fixture.invalid', 'Content-Type': 'application/json', 'X-Terminal-Request': f.tokens.token };
  const call = (action, body, extra = {}) => f.request('POST', '/api/context/' + action, { body, headers, ...extra });
  const prepare = async (text, purpose = 'insert', more = {}) => {
    const result = await call('prepare', { session: 'shared', digest: digest(text), bytes: Buffer.byteLength(text), purpose, ...more });
    assert.equal(result.status, 200, result.body); return result.data;
  };
  return { ...f, connection, call, prepare, headers };
}
test('signed owner literal input has no Enter; once-only receipt globally pauses AI and survives replay safely', async t => {
  const f = await fixture(t), [target] = await f.list();
  f.tmux('new-session', '-d', '-s', 'web-111111111111', '/bin/cat');
  await f.control('resume', 'web-111111111111');
  const prepared = await f.prepare('中文_CONTEXT_🙂');
  const [one, two] = await Promise.all([f.call('insert', { receipt: prepared.receipt, text: '中文_CONTEXT_🙂' }), f.call('insert', { receipt: prepared.receipt, text: '中文_CONTEXT_🙂' })]);
  assert.deepEqual([one.status, two.status].sort(), [200, 409]);
  const output = f.tmux('capture-pane', '-p', '-t', target.paneId);
  assert.equal(output.split('中文_CONTEXT_🙂').length - 1, 1, 'cat echoes once until explicit Enter');
  assert.equal((await f.request('GET', '/api/collaboration/state')).data.sessions.shared.paused, true);
  assert.equal((await f.request('GET', '/api/collaboration/state')).data.sessions['web-111111111111'].paused, true);
  assert.equal((await f.mutate('terminal_send_key', { target, key: 'Enter' })).error.code, 'STALE_INPUT_GENERATION');
  assert.equal((await f.call('insert', { receipt: prepared.receipt, text: '中文_CONTEXT_🙂' })).status, 409);
  await f.control('resume');
  const [fresh] = await f.list();
  assert.deepEqual(await f.mutate('terminal_send_key', { target: fresh, key: 'Enter' }), { sent: true, submitted: true });
});
test('owner verification, Origin and CSRF required; content/purpose binding and controls reject whole input', async t => {
  const f = await fixture(t);
  const body = { session: 'shared' };
  assert.equal((await f.call('prepare', body, { owner: false })).status, 401);
  assert.equal((await f.call('prepare', body, { headers: { ...f.headers, Origin: 'http://bad.invalid' } })).status, 403);
  assert.equal((await f.call('prepare', body, { headers: { ...f.headers, 'X-Terminal-Request': 'wrong' } })).status, 403);
  for (const text of ['first\nSECOND', 'first\rSECOND', 'first\x1bSECOND', 'first\tSECOND', 'x'.repeat(8193)]) {
    const r = await f.prepare(text);
    assert.equal((await f.call('insert', { receipt: r.receipt, text })).status, 400);
  }
  const r = await f.prepare('original');
  assert.equal((await f.call('insert', { receipt: r.receipt, text: 'changed' })).status, 409);
  const fileOnly = await f.prepare('file-only', 'file');
  assert.equal((await f.call('insert', { receipt: fileOnly.receipt, text: 'file-only' })).status, 409);
  assert.doesNotMatch(f.tmux('capture-pane', '-p', '-t', 'shared:'), /first|SECOND|changed|original|file-only/);
});
test('explicit multiline file uses private bounded storage, separate path receipt and early delete', async t => {
  const f = await fixture(t), text = '中文 context\ncode\tblock\r\n🙂';
  const r = await f.prepare(text, 'file');
  const saved = await f.call('file', { receipt: r.receipt, text });
  assert.equal(saved.status, 200, saved.body);
  assert.equal(fs.readFileSync(saved.data.path, 'utf8'), text);
  assert.equal(fs.statSync(saved.data.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(saved.data.path)).mode & 0o777, 0o700);
  assert.doesNotMatch(f.tmux('capture-pane', '-p', '-t', 'shared:'), /code|contexts/);
  const p = await f.prepare(saved.data.path);
  assert.equal((await f.call('insert', { receipt: p.receipt, text: saved.data.path })).status, 200);
  assert.equal((await f.call('file', { receipt: r.receipt, text })).status, 409);
  assert.equal((await f.call('delete', { fileId: saved.data.fileId })).status, 200);
  assert.equal(fs.existsSync(saved.data.path), false);
  const oversized = '中'.repeat(21846);
  const big = await f.call('prepare', { session: 'shared', digest: digest(oversized), bytes: Buffer.byteLength(oversized), purpose: 'file' });
  assert.equal(big.status, 400);
  assert.throws(() => validateText('bad\0text'));
});
test('pane selection, process respawn, disconnect and native session switch invalidate initial and final receipts', async t => {
  const f = await fixture(t);
  const initial = (await f.call('prepare', { session: 'shared' })).data;
  const r = await f.prepare('STALE_MUST_NOT_ARRIVE');
  f.tmux('split-window', '-d', '-t', 'shared:', '/bin/cat');
  f.tmux('select-pane', '-t', 'shared:.1');
  assert.equal((await f.call('insert', { receipt: r.receipt, text: 'STALE_MUST_NOT_ARRIVE' })).status, 409);
  assert.equal((await f.call('prepare', { session: 'shared', previous: initial.receipt, digest: digest('x'), bytes: 1, purpose: 'insert' })).status, 409);
  f.tmux('select-pane', '-t', 'shared:.0');
  const respawn = await f.prepare('RESPAWN_NO');
  f.tmux('respawn-pane', '-k', '-t', 'shared:.0', '/bin/cat');
  assert.equal((await f.call('insert', { receipt: respawn.receipt, text: 'RESPAWN_NO' })).status, 409);
  const switched = (await f.call('prepare', { session: 'shared' })).data;
  f.tmux('new-session', '-d', '-s', 'web-abcdef012345', '/bin/cat');
  const client = f.tmux('list-clients', '-F', '#{client_name}').trim();
  f.tmux('switch-client', '-c', client, '-t', 'web-abcdef012345');
  assert.equal((await f.call('prepare', { session: 'shared', previous: switched.receipt, digest: digest('x'), bytes: 1, purpose: 'insert' })).status, 409);
});
test('expiry during async drain, owner binding, symlink directory and TTL cleanup fail closed', async t => {
  const f = await fixture(t);
  const { TerminalController } = await import('../../mcp/terminal.js');
  const server = f.tmux('display-message', '-p', '#{socket_path}');
  let time = 1;
  const directory = path.join(f.root, 'test-contexts');
  const module = createContextPaste({ tmux: args => f.tmux(...args), controller: { input: async (target, dispatch) => dispatch() }, coordinator: { human: async (session, authority, dispatch) => { time += 60001; return dispatch(); } }, directory, now: () => time });
  // No actual controller dispatch occurs: expiry is rechecked before buffer creation.
  t.after(() => module.close());
  const r = module.prepare({ session: 'shared', digest: digest('NO_EXPIRED'), bytes: 10, purpose: 'insert' }, owner());
  await assert.rejects(module.insert({ receipt: r.receipt, text: 'NO_EXPIRED' }, { ...owner(), ownerId: 'other' }), e => e.code === 'STALE_CONTEXT');
  await assert.rejects(module.insert({ receipt: r.receipt, text: 'NO_EXPIRED' }, owner()), e => e.code === 'STALE_CONTEXT');
  const external = path.join(f.root, 'external'); fs.mkdirSync(external, { mode: 0o700 }); fs.symlinkSync(external, directory);
  assert.throws(() => module.prepare({ session: 'shared', digest: digest('file'), bytes: 4, purpose: 'file' }, owner()), e => e.code === 'CONTEXT_UNAVAILABLE');
  assert.deepEqual(fs.readdirSync(external), []);
});
test('actual one-hour cleanup, old orphan cleanup and exclusive random filename collision preserve unrelated files', async t => {
  const f = await fixture(t), crypto = require('node:crypto');
  let clock = Date.now();
  const directory = path.join(f.root, 'expiry-contexts');
  const module = createContextPaste({ tmux: args => f.tmux(...args), controller: { input: async (target, dispatch) => dispatch() }, coordinator: {}, directory, wallNow: () => clock });
  t.after(() => module.close());
  const prep = () => module.prepare({ session: 'shared', digest: digest('private'), bytes: 7, purpose: 'file' }, owner());
  const saved = module.createFile({ receipt: prep().receipt, text: 'private' }, owner());
  const orphan = path.join(directory, 'a'.repeat(48) + '.txt'); fs.writeFileSync(orphan, 'orphan', { mode: 0o600 });
  const old = new Date(clock - 3600001); fs.utimesSync(orphan, old, old);
  const unrelated = path.join(directory, 'notes.txt'); fs.writeFileSync(unrelated, 'keep', { mode: 0o600 }); fs.utimesSync(unrelated, old, old);
  clock += 3600001; prep();
  assert.equal(fs.existsSync(saved.path), false); assert.equal(fs.existsSync(orphan), false); assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
  const original = crypto.randomBytes;
  try {
    crypto.randomBytes = n => Buffer.alloc(n, 0xab);
    const collision = path.join(directory, 'ab'.repeat(24) + '.txt');
    fs.symlinkSync(unrelated, collision);
    const receipt = prep();
    assert.throws(() => module.createFile({ receipt: receipt.receipt, text: 'private' }, owner()), error => error.code === 'EEXIST');
    assert.equal(fs.lstatSync(collision).isSymbolicLink(), true); assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
  } finally { crypto.randomBytes = original; }
});
test('owner expiry during drain prevents all input and consumes the attempted receipt', async t => {
  const f = await fixture(t);
  const module = createContextPaste({ tmux: args => f.tmux(...args), controller: { input: async (target, dispatch) => dispatch() }, coordinator: { human: async (session, authority, dispatch) => { authority.expires = Date.now() - 1; return dispatch(); } }, directory: path.join(f.root, 'owner-expiry-contexts') });
  t.after(() => module.close());
  const authority = owner(), prepared = module.prepare({ session: 'shared', digest: digest('EXPIRED_OWNER'), bytes: 13, purpose: 'insert' }, authority);
  await assert.rejects(module.insert({ receipt: prepared.receipt, text: 'EXPIRED_OWNER' }, authority), error => error.code === 'AUTHORITY_UNAVAILABLE');
  assert.doesNotMatch(f.tmux('capture-pane', '-p', '-t', 'shared:'), /EXPIRED_OWNER/);
});

test('disconnect invalidates receipt without reading or writing another pane', async t => {
  const f = await fixture(t), prepared = await f.prepare('DISCONNECTED_NO');
  f.connection.client.terminate();
  for (let i = 0; i < 100 && f.tmux('list-clients', '-F', '#{client_pid}').trim(); i++) await sleep(10);
  assert.equal((await f.call('insert', { receipt: prepared.receipt, text: 'DISCONNECTED_NO' })).status, 409);
  assert.doesNotMatch(f.tmux('capture-pane', '-p', '-t', 'shared:'), /DISCONNECTED_NO/);
});
