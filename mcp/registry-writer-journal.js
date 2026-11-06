// OFFLINE, UNTRUSTED simulation only. Never connect to a service or retention.
// Hashes detect accidental corruption, not same-UID tampering. No secrets exist.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const hex = /^[a-f0-9]{64}$/;
const id = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX = 128;
const minted = new WeakSet();
const fail = code => { const e = new Error(code); e.code = code; throw e; };
const canonical = value => JSON.stringify(value);

// A test-only source, not an OS supervisor or evidence of real completion.
export function createSyntheticLifecycleSource() {
  return Object.freeze({ terminal(job, instance, sequence, nonce, content) {
    if (typeof job !== 'string' || !id.test(job) || typeof instance !== 'string' || !id.test(instance) || !Number.isSafeInteger(sequence) || sequence < 1 || typeof nonce !== 'string' || !hex.test(nonce) || typeof content !== 'string' || Buffer.byteLength(content) > 4096) fail('INVALID_EVENT');
    const event = Object.freeze({ job, instance, sequence, nonce, phase: 'terminal', contentHash: hash(content) });
    minted.add(event); return event;
  } });
}
function checkedFile(file) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o7777) !== 0o600 || s.nlink !== 1 || s.size > 65536) fail('UNSAFE_FILE');
  return s;
}
function read(file) {
  const initial = checkedFile(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const check = s => {
      if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o7777) !== 0o600 || s.nlink !== 1 || s.size > 65536 || s.dev !== initial.dev || s.ino !== initial.ino || s.size !== initial.size || s.mtimeMs !== initial.mtimeMs || s.ctimeMs !== initial.ctimeMs) fail('UNSAFE_FILE');
    };
    check(fs.fstatSync(fd));
    const buffer = Buffer.alloc(initial.size + 1); let offset = 0;
    while (offset < buffer.length) { const n = fs.readSync(fd, buffer, offset, buffer.length - offset, offset); if (!n) break; offset += n; }
    check(fs.fstatSync(fd)); if (offset !== initial.size) fail('UNSAFE_FILE');
    try { return new TextDecoder('utf-8', { fatal:true, ignoreBOM:true }).decode(buffer.subarray(0, offset)); } catch { fail('CORRUPT_STATE'); }
  } finally { fs.closeSync(fd); }
}
function validate(s) {
  if (!s || Object.keys(s).sort().join(',') !== 'checksum,events,instance,job,version' || s.version !== 1 || typeof s.job !== 'string' || !id.test(s.job) || typeof s.instance !== 'string' || !id.test(s.instance) || !Array.isArray(s.events) || s.events.length > MAX || typeof s.checksum !== 'string') fail('CORRUPT_STATE');
  const { checksum, ...body } = s;
  if (hash(canonical(body)) !== checksum) fail('CORRUPT_STATE');
  const nonces = new Set();
  for (const [i, e] of s.events.entries()) {
    if (!e || Object.keys(e).sort().join(',') !== 'contentHash,eventHash,nonce,phase,sequence' || e.sequence !== i + 1 || e.phase !== 'terminal' || typeof e.nonce !== 'string' || !hex.test(e.nonce) || nonces.has(e.nonce) || typeof e.contentHash !== 'string' || !hex.test(e.contentHash) || e.eventHash !== hash(canonical({ job:s.job, instance:s.instance, sequence:e.sequence, nonce:e.nonce, phase:e.phase, contentHash:e.contentHash }))) fail('CORRUPT_STATE');
    nonces.add(e.nonce);
  }
  if (s.events.length > 1) fail('CORRUPT_STATE'); // terminal is immutable
  return s;
}
function sealed(job, instance, events) { const body = { version:1, job, instance, events }; return { ...body, checksum:hash(canonical(body)) }; }
function syncDir(dir) { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function atomic(dir, name, data, fault = () => {}) {
  const target = path.join(dir, name), temp = path.join(dir, `.journal-${crypto.randomBytes(16).toString('hex')}`);
  let fd;
  try {
    try { checkedFile(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fault('write'); fs.writeFileSync(fd, data); fault('fsync'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fault('rename'); fs.renameSync(temp, target); syncDir(dir); fault('afterRename');
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
function directory(dir) {
  const real = fs.realpathSync(dir), tmp = fs.realpathSync(os.tmpdir());
  const s = fs.lstatSync(dir);
  if (real !== path.resolve(dir) || path.dirname(real) !== tmp || !path.basename(real).startsWith('registry-writer-sim-') || !s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o7777) !== 0o700) fail('UNSAFE_DIRECTORY');
  return real;
}
export function createOfflineJournal(dir, { job, instance } = {}) {
  dir = directory(dir);
  if (typeof job !== 'string' || !id.test(job) || typeof instance !== 'string' || !id.test(instance)) fail('INVALID_ID');
  const file = path.join(dir, 'journal.json');
  // Exclusive initialization: missing existing journal never silently resets replay state.
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, canonical(sealed(job, instance, []))); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDir(dir);
  return openOfflineJournal(dir);
}
export function openOfflineJournal(dir) {
  dir = directory(dir);
  const file = path.join(dir, 'journal.json'), marker = path.join(dir, 'pending.json');
  function load() { try { return validate(JSON.parse(read(file))); } catch (e) { if (e.code === 'ENOENT') fail('MISSING_JOURNAL'); if (e instanceof SyntaxError) fail('CORRUPT_STATE'); throw e; } }
  function pending() { try { read(marker); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
  load();
  return Object.freeze({
    inspect() { const s = load(); return Object.freeze({ status:pending() ? 'unknown' : (s.events.length ? 'simulated-terminal' : 'running'), sequence:s.events.length, proofHash:s.events[0]?.eventHash ?? null }); },
    record(event, { fault = () => {} } = {}) {
      if (!minted.has(event)) fail('UNTRUSTED_EVENT');
      const s = load(); if (pending()) fail('RECOVERY_UNKNOWN');
      if (event.job !== s.job || event.instance !== s.instance) fail('INSTANCE_CONFLICT');
      if (event.sequence !== s.events.length + 1 || s.events.some(x => x.nonce === event.nonce)) fail('REPLAY_OR_ORDER');
      if (s.events.length) fail('TERMINAL_IMMUTABLE');
      fault('prepare');
      // Persistent marker makes any interrupted transaction ambiguous on reopen.
      const fd = fs.openSync(marker, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, 'pending'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      syncDir(dir);
      const { job, instance, ...rest } = event;
      const entry = { ...rest, eventHash:hash(canonical(event)) };
      atomic(dir, 'journal.json', canonical(sealed(job, instance, [entry])), fault);
      fs.unlinkSync(marker); syncDir(dir);
      return this.inspect();
    }
  });
}
// JavaScript has no atomic compare-inode-and-digest unlink primitive here.
export function simulateConditionalDelete() { fail('ATOMIC_CONDITIONAL_UNLINK_UNAVAILABLE'); }
