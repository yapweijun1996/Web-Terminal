'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { createLocalIssuer, createVerifier, proofFor } = require('../collaboration-gateway/auth');
function setup() {
  let now = 1000000;
  const issuer = createLocalIssuer();
  const keys = generateKeyPairSync('ed25519');
  const verifier = createVerifier({ publicKey: issuer.publicKey, issuer: 'local-test', audience: 'gateway-test', session: 'fixture-test', now: () => now });
  const claims = { sub: 'alice', role: 'writer', panes: ['1'], session: 'fixture-test', iss: 'local-test', aud: 'gateway-test', iat: 1000, nbf: 1000, exp: 1030 };
  const issue = patch => issuer.issue({ ...claims, ...patch }, keys.publicKey);
  const request = (token, privateKey = keys.privateKey) => {
    const req = { method: 'GET', url: '/ws', headers: { origin: 'http://127.0.0.1:1234', 'sec-websocket-key': randomBytes(16).toString('base64'), authorization: `Bearer ${token}` } };
    req.headers['x-gateway-proof'] = proofFor(token, req, privateKey); return req;
  };
  return { issuer, verifier, issue, request, keys, setNow: n => { now = n; } };
}
test('signed scoped identity, holder binding, one-use nonce, revocation and active expiry', () => {
  const s = setup(), token = s.issue();
  const stolen = s.request(token, generateKeyPairSync('ed25519').privateKey);
  assert.throws(() => s.verifier.verifyUpgrade(stolen));
  const req = s.request(token), who = s.verifier.verifyUpgrade(req);
  assert.equal(who.role, 'writer'); assert.deepEqual(who.panes, ['1']);
  assert.throws(() => s.verifier.verifyUpgrade(req), /Denied/);
  s.verifier.assertActive(who); s.verifier.revoke(who.nonce);
  assert.throws(() => s.verifier.assertActive(who), /Denied/);
  const other = s.verifier.verifyUpgrade(s.request(s.issue()));
  s.setNow(1030000); assert.throws(() => s.verifier.assertActive(other));
});
test('fail closed: signature, issuer/audience/session/role, dates, nonce and missing identity', () => {
  for (const patch of [{ iss: 'evil' }, { aud: 'other' }, { session: 'other' }, { role: 'admin' }, { sub: '' }, { panes: [] }, { panes: ['1', '1'] }, { exp: 1000 }, { nbf: 1001 }, { iat: 1001 }, { exp: 2000 }, { nonce: '' }]) {
    const s = setup(); assert.throws(() => s.verifier.verifyUpgrade(s.request(s.issue(patch))), JSON.stringify(patch));
  }
  const s = setup(), token = s.issue();
  for (const bad of [token.slice(0, -10) + 'AAAAAAAAAA', JSON.stringify({ role: 'writer' }), 'writer']) assert.throws(() => s.verifier.verifyUpgrade(s.request(bad)));
  assert.throws(() => s.verifier.verifyUpgrade({ headers: { 'x-forwarded-user': 'alice', 'x-forwarded-role': 'writer' } }));
  const bound = s.request(s.issue()); bound.headers['sec-websocket-key'] = randomBytes(16).toString('base64');
  assert.throws(() => s.verifier.verifyUpgrade(bound), 'proof binds handshake key');
  const revoked = s.issue({ nonce: 'a'.repeat(48) }); s.verifier.revoke('a'.repeat(48));
  assert.throws(() => s.verifier.verifyUpgrade(s.request(revoked)), 'revoked before upgrade');
  const req = s.request(s.issue()); req.headers.origin = 'http://evil';
  assert.throws(() => s.verifier.verifyUpgrade(req), 'proof binds origin');
  assert.throws(() => createVerifier({}));
});
