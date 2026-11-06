'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign, randomUUID } = require('node:crypto');
const { createPolicy } = require('./policy');
test('independent signature, scope, lease, expiry and replay enforcement', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const policy = createPolicy({ publicKey, pane: '%0', lease: 'active', epoch: 'epoch', now: () => 1000 });
  const claims = { iss: 'test-issuer', aud: 'supervisor', role: 'writer', pane: '%0', lease: 'active', epoch: 'epoch', iat: 1000, exp: 2000, nonce: randomUUID(), op: 'text', text: 'OK' };
  const envelope = c => { const payload = Buffer.from(JSON.stringify(c)).toString('base64url'); return { payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64url') }; };
  for (const patch of [{ role: 'watcher' }, { pane: '%1' }, { lease: 'old' }, { epoch: 'old' }, { exp: 999 }, { op: 'shell' }, { text: '\n' }, { uid: 21001 }, { exp: '2000' }]) assert.throws(() => policy.authorize(envelope({ ...claims, ...patch })));
  assert.throws(() => policy.authorize({ role: 'writer', uid: 21001 }));
  const good = envelope(claims); assert.equal(policy.authorize(good).text, 'OK'); assert.throws(() => policy.authorize(good));
  policy.authorize(envelope({ ...claims, nonce: randomUUID(), op: 'release', text: undefined }));
  assert.throws(() => policy.authorize(envelope({ ...claims, nonce: randomUUID() })));
});
