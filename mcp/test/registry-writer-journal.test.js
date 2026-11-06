import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createOfflineJournal, openOfflineJournal, createSyntheticLifecycleSource, simulateConditionalDelete } from '../registry-writer-journal.js';

const job = '12345678-1234-4123-8123-123456789abc', instance = '22345678-1234-4123-8123-123456789abc';
const nonce = 'a'.repeat(64);
function fixture(t) { const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'registry-writer-sim-')); t.after(() => fs.rmSync(dir, { recursive:true, force:true })); return dir; }
const event = (seq = 1, n = nonce) => createSyntheticLifecycleSource().terminal(job, instance, seq, n, 'synthetic result');
const init = dir => createOfflineJournal(dir, { job, instance });

test('synthetic proof is bound and replay stays rejected after reopen', t => {
  const dir = fixture(t), j = init(dir), e = event();
  assert.throws(() => j.record({ ...e }), { code:'UNTRUSTED_EVENT' });
  const result = j.record(e); assert.equal(result.status, 'simulated-terminal'); assert.match(result.proofHash, /^[a-f0-9]{64}$/);
  const reopened = openOfflineJournal(dir); assert.deepEqual(reopened.inspect(), result);
  assert.throws(() => reopened.record(e), { code:'REPLAY_OR_ORDER' });
  assert.throws(() => reopened.record(event(2, nonce)), { code:'REPLAY_OR_ORDER' });
  assert.throws(() => reopened.record(event(2, 'b'.repeat(64))), { code:'TERMINAL_IMMUTABLE' });
});
for (const point of ['prepare', 'write', 'fsync', 'rename', 'afterRename']) test(`failure at ${point} fails closed after reopen`, t => {
  const dir = fixture(t), j = init(dir);
  assert.throws(() => j.record(event(), { fault(p) { if (p === point) { const e = new Error('injected'); e.code = 'ENOSPC'; throw e; } } }), { code:'ENOSPC' });
  const reopened = openOfflineJournal(dir), state = reopened.inspect();
  assert.equal(state.status, point === 'prepare' ? 'running' : 'unknown');
  if (point !== 'prepare') assert.throws(() => reopened.record(event()), { code:'RECOVERY_UNKNOWN' });
  assert.equal(fs.readdirSync(dir).some(x => x.startsWith('.journal-')), false);
});
test('missing, malformed, corrupted, symlink and mode drift fail closed', t => {
  const dir = fixture(t), file = path.join(dir, 'journal.json'); init(dir);
  fs.unlinkSync(file); assert.throws(() => openOfflineJournal(dir), { code:'MISSING_JOURNAL' });
  fs.writeFileSync(file, '{', { mode:0o600 }); assert.throws(() => openOfflineJournal(dir), { code:'CORRUPT_STATE' });
  fs.writeFileSync(file, JSON.stringify({ version:1 })); assert.throws(() => openOfflineJournal(dir), { code:'CORRUPT_STATE' });
  fs.unlinkSync(file); fs.symlinkSync('/dev/null', file); assert.throws(() => openOfflineJournal(dir), { code:'UNSAFE_FILE' });
  fs.unlinkSync(file); init(dir); fs.chmodSync(file, 0o644); assert.throws(() => openOfflineJournal(dir), { code:'UNSAFE_FILE' });
});
test('conditional deletion is unavailable and never removes fixture', t => {
  const dir = fixture(t), file = path.join(dir, 'candidate'); fs.writeFileSync(file, 'keep');
  assert.throws(() => simulateConditionalDelete(file, { inode:fs.statSync(file).ino, digest:'x' }), { code:'ATOMIC_CONDITIONAL_UNLINK_UNAVAILABLE' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
  fs.symlinkSync(file, path.join(dir, 'link')); assert.throws(() => simulateConditionalDelete(path.join(dir, 'link')), { code:'ATOMIC_CONDITIONAL_UNLINK_UNAVAILABLE' });
});
test('invalid IDs, private directory, links, size and pending marker fail closed', t => {
  const dir = fixture(t), file = path.join(dir, 'journal.json'), marker = path.join(dir, 'pending.json');
  assert.throws(() => createOfflineJournal(dir, { job:'-'.repeat(36), instance }), { code:'INVALID_ID' });
  assert.throws(() => createSyntheticLifecycleSource().terminal(job, '-'.repeat(36), 1, nonce, ''), { code:'INVALID_EVENT' });
  const j = init(dir); fs.writeFileSync(marker, 'tampered', { mode:0o600 });
  assert.equal(j.inspect().status, 'unknown'); assert.throws(() => j.record(event()), { code:'RECOVERY_UNKNOWN' });
  fs.chmodSync(marker, 0o644); assert.throws(() => j.inspect(), { code:'UNSAFE_FILE' });
  fs.unlinkSync(marker); fs.linkSync(file, path.join(dir, 'hardlink')); assert.throws(() => j.inspect(), { code:'UNSAFE_FILE' });
  fs.unlinkSync(path.join(dir, 'hardlink')); fs.truncateSync(file, 65537); assert.throws(() => j.inspect(), { code:'UNSAFE_FILE' });
  fs.chmodSync(dir, 0o755); assert.throws(() => openOfflineJournal(dir), { code:'UNSAFE_DIRECTORY' });
  assert.throws(() => openOfflineJournal(path.dirname(dir)), { code:'UNSAFE_DIRECTORY' });
});
test('marker removal demonstrates rollback is not authenticated', t => {
  const dir = fixture(t), j = init(dir), marker = path.join(dir, 'pending.json');
  assert.throws(() => j.record(event(), { fault(point) { if (point === 'write') throw Error('stop'); } }));
  assert.equal(openOfflineJournal(dir).inspect().status, 'unknown');
  fs.unlinkSync(marker);
  assert.equal(openOfflineJournal(dir).inspect().status, 'running');
  // This is the known failure of the simulation, never a retention authorization.
});
for (const point of ['prepare', 'write', 'fsync', 'rename', 'afterRename']) test(`SIGKILL at ${point} preserves an unknown or unstarted fixture`, { timeout:10000 }, async t => {
  const dir = fixture(t); init(dir);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./registry-writer-crash-child.mjs', import.meta.url)), dir, point], { stdio:['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdout.on('data', chunk => { output += chunk; if (output.includes('READY\n') && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  assert.equal(result.signal, 'SIGKILL', errors); assert.equal(output, 'READY\n');
  const reopened = openOfflineJournal(dir); assert.equal(reopened.inspect().status, point === 'prepare' ? 'running' : 'unknown');
  if (point !== 'prepare') assert.throws(() => reopened.record(event()), { code:'RECOVERY_UNKNOWN' });
});
