'use strict';

// A deliberately narrow fixture credential, not a Cloudflare Access verifier.
// No listener uses this module. Its issuer and keys must be supplied by tests.
const { createPublicKey, verify } = require('node:crypto');

function createTestCredentialVerifier({ publicKey, issuer, audience, subjects, now = () => Date.now(), maxLifetimeSeconds = 300 }) {
  const key = publicKey && publicKey.type === 'public' ? publicKey : createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || typeof issuer !== 'string' || !issuer ||
      typeof audience !== 'string' || !audience || !(subjects instanceof Map) ||
      !Number.isSafeInteger(maxLifetimeSeconds) || maxLifetimeSeconds < 1 || maxLifetimeSeconds > 300 ||
      typeof now !== 'function') throw Error('Invalid verifier configuration');
  const permissions = new Map();
  for (const [subject, value] of subjects) {
    if (typeof subject !== 'string' || !subject || subject.length > 256 || !value ||
        typeof value.write !== 'boolean' || typeof value.takeover !== 'boolean' ||
        (value.takeover && !value.write)) throw Error('Invalid subject policy');
    permissions.set(subject, Object.freeze({ principal: subject, write: value.write, takeover: value.takeover }));
  }
  if (!permissions.size || permissions.size > 64) throw Error('Invalid subject policy');

  function decode(part) {
    if (!/^[A-Za-z0-9_-]+$/.test(part)) throw Error('Invalid credential');
    const bytes = Buffer.from(part, 'base64url');
    if (bytes.toString('base64url') !== part) throw Error('Invalid credential');
    return bytes;
  }
  function object(part) {
    const text = decode(part).toString('utf8');
    const value = JSON.parse(text);
    // Canonical encoding excludes duplicate keys and ambiguous JSON forms.
    if (!value || Array.isArray(value) || typeof value !== 'object' || JSON.stringify(value) !== text) throw Error('Invalid credential');
    return value;
  }
  return token => {
    try {
      if (typeof token !== 'string' || token.length > 4096) throw Error();
      const parts = token.split('.');
      if (parts.length !== 3) throw Error();
      const header = object(parts[0]);
      if (Object.keys(header).sort().join(',') !== 'alg,typ' || header.alg !== 'EdDSA' || header.typ !== 'JWT') throw Error();
      const signature = decode(parts[2]);
      if (signature.length !== 64 || !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, signature)) throw Error();
      const claims = object(parts[1]);
      if (Object.keys(claims).sort().join(',') !== 'aud,exp,iat,iss,nbf,sub' ||
          claims.iss !== issuer || claims.aud !== audience || typeof claims.sub !== 'string' ||
          !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.nbf) || !Number.isSafeInteger(claims.exp)) throw Error();
      const current = Math.floor(now() / 1000);
      if (!Number.isSafeInteger(current) || claims.iat > current || claims.nbf > current ||
          claims.exp <= current || claims.exp <= claims.nbf || claims.exp <= claims.iat ||
          claims.exp - claims.iat > maxLifetimeSeconds) throw Error();
      const result = permissions.get(claims.sub);
      if (!result) throw Error();
      return Object.freeze({ ...result, expiresAt: claims.exp });
    } catch {
      throw Error('Invalid credential');
    }
  };
}
module.exports = { createTestCredentialVerifier };
