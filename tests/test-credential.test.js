'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const { createTestCredentialVerifier } = require('../runtime/gateway/test-credential');

test('fixture credentials bind verified subjects to server-side permissions and reject invalid credentials', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const policy = new Map([['writer', { write: true, takeover: false }], ['watcher', { write: false, takeover: false }]]);
  const verify = createTestCredentialVerifier({ publicKey, issuer: 'fixture', audience: 'terminal', subjects: policy, now: () => 1000000 });
  const claims = { iss: 'fixture', aud: 'terminal', sub: 'writer', iat: 990, nbf: 990, exp: 1100 };
  const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
  const token = (payload, header = { alg: 'EdDSA', typ: 'JWT' }, key = privateKey) => {
    const content = `${encode(header)}.${encode(payload)}`;
    return `${content}.${sign(null, Buffer.from(content), key).toString('base64url')}`;
  };
  assert.deepEqual(verify(token(claims)), { principal: 'writer', write: true, takeover: false, expiresAt: 1100 });
  policy.get('writer').takeover = true;
  assert.equal(verify(token(claims)).takeover, false);
  assert.equal(verify(token({ ...claims, sub: 'watcher' })).write, false);
  const wrongKey = generateKeyPairSync('ed25519').privateKey;
  for (const bad of [undefined, '', token({ ...claims, exp: 1000 }), token({ ...claims, nbf: 1001 }),
    token({ ...claims, aud: 'wrong' }), token({ ...claims, iss: 'wrong' }), token({ ...claims, sub: 'forged' }),
    token({ ...claims, exp: 1400 }), token({ ...claims, write: true }), token(claims, { alg: 'none', typ: 'JWT' }),
    token(claims, undefined, wrongKey), `${token(claims)}x`]) assert.throws(() => verify(bad), /Invalid credential/);
});
