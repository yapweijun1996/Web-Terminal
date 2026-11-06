'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const worker = path.join(__dirname, '../staging-gate/worker.js');
function start(dir, action, lease) {
  return new Promise((resolve, reject) => {
    const p = fork(worker, [dir, action, lease || ''], { silent: true });
    p.once('message', m => resolve({p, m}));
    p.once('error', reject);
    p.once('exit', (code, signal) => { if (code !== null && code !== 0) reject(new Error(`worker exited ${code} ${signal}`)); });
  });
}
test('SIGKILL leaves durable quarantine; restarted child cannot acquire or renew', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'staging-golden-'));
  const control = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'staging-control-'));
  const sentinel = path.join(control, 'sentinel');
  fs.writeFileSync(sentinel, 'unchanged', {flag:'wx',mode:0o600});
  let child;
  try {
    const first = await start(dir, 'acquire');
    child = first.p;
    assert.equal(first.m.status, 'ACTIVE');
    const concurrent = await start(dir, 'acquire');
    assert.equal(concurrent.m.status, 'QUARANTINED');
    assert.equal(fs.readFileSync(path.join(dir, 'output'), 'utf8'), 'authorized scratch write\n');
    const done = new Promise(resolve => first.p.once('exit', resolve));
    first.p.kill('SIGKILL'); await done;
    const second = await start(dir, 'acquire');
    assert.equal(second.m.status, 'QUARANTINED');
    const third = await start(dir, 'renew', first.m.lease);
    assert.equal(third.m.status, 'QUARANTINED');
    assert.equal(fs.readFileSync(path.join(dir, 'output'), 'utf8'), 'authorized scratch write\n');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['fence','journal','output']);
  } finally { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(control, { recursive: true, force: true }); }
});
