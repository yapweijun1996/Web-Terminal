'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { InputBroker } = require('../runtime/gateway/broker');
const target = { serverPid: '123', sessionId: '$1', windowId: '@1', paneId: '%1' };

test('leases serialize contention, fence takeover, expiry, disconnect and restart', async () => {
  let now = 0; const writes = [];
  const options = { verifyTarget: async t => { if (t.windowId !== '@1') throw Error('Target changed'); }, execute: async (_, op) => writes.push(op), now: () => now, ttlMs: 10 };
  const b = new InputBroker(options);
  const a = b.connect({ principal: 'a', write: true });
  const c = b.connect({ principal: 'c', write: true, takeover: true });
  const watcher = b.connect({ principal: 'watcher' });
  await assert.rejects(b.claim(watcher, target), /Permission/);
  await assert.rejects(b.claim(a, { ...target, paneId: '%1;evil' }), /Invalid/);
  const results = await Promise.allSettled([b.claim(a, target), b.claim(c, target)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const lease = results[0].value;
  await b.mutate(a, target, lease, 'first');
  const next = await b.claim(c, target, { takeover: true });
  await assert.rejects(b.mutate(a, target, lease, 'stale'), /Lease/);
  await assert.rejects(b.mutate(c, { ...target, windowId: '@2' }, next, 'changed'), /Lease/);
  await b.mutate(c, target, next, 'second');
  now = 10;
  await assert.rejects(b.renew(c, target, next), /Lease/);
  const third = await b.claim(a, target);
  await b.disconnect(a);
  await assert.rejects(b.mutate(a, target, third, 'disconnected'), /Permission/);
  const restarted = new InputBroker(options); const fresh = restarted.connect({ principal: 'a', write: true });
  const newer = await restarted.claim(fresh, target);
  assert.notEqual(newer.generation, third.generation);
  await assert.rejects(restarted.mutate(fresh, target, third, 'restart'), /Lease/);
  assert.deepEqual(writes, ['first', 'second']);
});

test('disconnect invalidates work waiting for target verification', async () => {
  let resume; let calls = 0;
  const b = new InputBroker({ verifyTarget: async () => { if (++calls === 2) await new Promise(r => { resume = r; }); }, execute: async () => { throw Error('unexpected write'); } });
  const a = b.connect({ principal: 'a', write: true }); const lease = await b.claim(a, target);
  const pending = b.mutate(a, target, lease, {});
  await new Promise(r => setImmediate(r)); const closed = b.disconnect(a); resume();
  await assert.rejects(pending, /Permission/); await closed;
});

test('renew and release require the owning connection and exact proof', async () => {
  let now = 0;
  const b = new InputBroker({ verifyTarget: async () => {}, execute: async () => {}, now: () => now, ttlMs: 10 });
  const a = b.connect({ principal: 'a', write: true });
  const other = b.connect({ principal: 'other', write: true });
  const lease = await b.claim(a, target);
  await assert.rejects(b.claim(other, target, { takeover: true }), /Lease held|Permission/);
  await assert.rejects(b.release(other, target, lease), /Lease/);
  await assert.rejects(b.renew(a, target, { ...lease, generation: 'forged' }), /Lease/);
  now = 9; await b.renew(a, target, lease); now = 10;
  await b.mutate(a, target, lease, { type: 'text' });
  await b.release(a, target, lease);
  await assert.rejects(b.mutate(a, target, lease, {}), /Lease/);
  await b.claim(other, target);
});
