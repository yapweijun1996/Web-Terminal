'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { DurableWatcherOwner } = require('../../runtime/candidates/watcher-owner-durable');
const name = () => `candidate_${randomBytes(6).toString('hex')}`;
const makeDir = () => fs.mkdtempSync('/tmp/wr-');
const cleanup = dir => fs.rmSync(dir, { recursive: true, force: true });

test('stale and concurrent locks never grant reentry or recover leases', () => {
  const dir = makeDir(), server = name();
  try {
    const owner = new DurableWatcherOwner(dir, server);
    assert.throws(() => new DurableWatcherOwner(dir, server));
    assert.throws(() => DurableWatcherOwner.recover(dir, server, 'opaque'));
    assert.ok(fs.existsSync(owner.lock));
    assert.equal(owner.decision, 'NEEDS_OPERATOR');
  } finally { cleanup(dir); }
});

test('corrupt, truncated, symlinked, tampered and generation mismatch journals deny', () => {
  for (const kind of ['corrupt', 'truncated', 'symlink', 'tampered', 'generation']) {
    const dir = makeDir(), server = name();
    try {
      const owner = new DurableWatcherOwner(dir, server), journal = owner.journal;
      const contents = fs.readFileSync(journal, 'utf8');
      if (kind === 'corrupt') fs.writeFileSync(journal, 'not json');
      if (kind === 'truncated') fs.writeFileSync(journal, contents.slice(0, 8));
      if (kind === 'symlink') { fs.unlinkSync(journal); fs.symlinkSync('/dev/null', journal); }
      if (kind === 'tampered') fs.writeFileSync(journal, contents.replace('NEEDS_OPERATOR', 'RESTORE_ALLOWED'));
      if (kind === 'generation') { const value = JSON.parse(contents); value.generation++; fs.writeFileSync(journal, JSON.stringify(value)); }
      assert.throws(() => owner.check());
      assert.throws(() => DurableWatcherOwner.recover(dir, server, 'opaque'));
      assert.ok(fs.existsSync(owner.lock));
    } finally { cleanup(dir); }
  }
});

test('interrupted restoration and ABA cannot be accepted as restored', () => {
  const dir = makeDir(), server = name();
  try {
    const owner = new DurableWatcherOwner(dir, server);
    owner.record.lifecycle = 'RESTORING'; owner.record.generation++; owner.write();
    assert.throws(() => DurableWatcherOwner.recover(dir, server, 'opaque'));
    assert.throws(() => owner.close(), /NEEDS_OPERATOR/);
    assert.notEqual(owner.state, 'RESTORED');
    // Same-UID ABA is not observable by this candidate; restoration is always denied.
    assert.equal(owner.decision, 'NEEDS_OPERATOR');
  } finally { cleanup(dir); }
});

test('unsafe directories and path traversal are rejected', () => {
  const dir = makeDir();
  try {
    assert.throws(() => new DurableWatcherOwner(dir, '../escape'));
    fs.chmodSync(dir, 0o755);
    assert.throws(() => new DurableWatcherOwner(dir, name()));
  } finally { cleanup(dir); }
});

test('real disposable tmux: crash, reentry, live lease and external change fail closed', async () => {
  const dir = makeDir(), server = name();
  const env = { ...process.env, TMUX_TMPDIR: dir };
  const tmux = (...args) => execFileSync('tmux', ['-L', server, '-f', '/dev/null', ...args], { env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const child = spawn(process.execPath, ['-e', `const {DurableWatcherOwner}=require(${JSON.stringify(path.resolve(__dirname, '../../runtime/candidates/watcher-owner-durable'))}); const o=new DurableWatcherOwner(process.argv[1],process.argv[2]); o.start(); o.acquire(process.pid); try { o.close(); throw Error('unexpected restore'); } catch (e) { if (!/Watchers remain/.test(e.message)) throw e; } process.stdout.write('READY\\n'); setInterval(()=>{},1000);`, dir, server], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stderr.on('data', b => { errors += b; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('child timeout')), 10000);
      child.stdout.on('data', b => { output += b; if (output.includes('READY')) { clearTimeout(timer); resolve(); } });
      child.on('exit', code => { clearTimeout(timer); reject(Error(`child exited ${code}: ${errors}`)); });
    });
    assert.equal(tmux('show-window-options', '-v', '-t', '=workspace:', 'window-size'), 'manual');
    child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve));
    assert.throws(() => new DurableWatcherOwner(dir, server));
    assert.throws(() => DurableWatcherOwner.recover(dir, server, 'opaque'));
    assert.equal(tmux('show-window-options', '-v', '-t', '=workspace:', 'window-size'), 'manual');
    tmux('set-window-option', '-t', '=workspace:', 'window-size', 'largest');
    assert.throws(() => DurableWatcherOwner.recover(dir, server, 'opaque'));
    assert.equal(tmux('show-window-options', '-v', '-t', '=workspace:', 'window-size'), 'largest');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try { tmux('kill-server'); } catch (_) {}
    cleanup(dir); assert.equal(fs.existsSync(dir), false);
  }
});


test('real disposable tmux: option drift is ambiguous and ABA never restores', () => {
  const dir = makeDir(), server = name(), env = { ...process.env, TMUX_TMPDIR: dir };
  const tmux = (...args) => execFileSync('tmux', ['-L', server, '-f', '/dev/null', ...args], { env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const owner = new DurableWatcherOwner(dir, server); owner.start();
    const lease = owner.acquire(process.pid);
    assert.throws(() => owner.close(), /Watchers remain/);
    tmux('set-window-option', '-t', '=workspace:', 'window-size', 'largest');
    assert.throws(() => owner.release(lease)); assert.equal(owner.state, 'AMBIGUOUS');
    tmux('set-window-option', '-t', '=workspace:', 'window-size', 'manual');
    assert.throws(() => owner.close());
    assert.equal(tmux('show-window-options', '-v', '-t', '=workspace:', 'window-size'), 'manual');
    assert.notEqual(owner.state, 'RESTORED');
  } finally { try { tmux('kill-server'); } catch (_) {} cleanup(dir); assert.equal(fs.existsSync(dir), false); }
});
