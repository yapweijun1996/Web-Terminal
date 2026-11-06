import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
