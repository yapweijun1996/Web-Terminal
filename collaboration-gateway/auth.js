'use strict';
const { generateKeyPairSync, createPublicKey, createHash, randomBytes, sign, verify } = require('node:crypto');
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error('Denied');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw Error('Denied');
  return bytes;
}
function object(value) {
  const text = decode(value).toString('utf8'), result = JSON.parse(text);
  if (!result || Array.isArray(result) || JSON.stringify(result) !== text) throw Error('Denied');
  return result;
}
function publicKey(value) {
  const key = value?.type === 'public' ? value : createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519') throw Error('Invalid key');
  return key;
}
function proofMessage(token, req) {
  return Buffer.from(JSON.stringify(['gateway-upgrade-v1', req.method, req.url, req.headers.origin,
    req.headers['sec-websocket-key'], createHash('sha256').update(token).digest('base64url')]));
}
function proofFor(token, req, privateKey) { return sign(null, proofMessage(token, req), privateKey).toString('base64url'); }
// Test-only trusted issuer. No network minting endpoint and no browser-supplied roles.
// The gateway receives only its public key. All private keys stay in caller memory.
function createLocalIssuer() {
  const keys = generateKeyPairSync('ed25519');
  return { publicKey: keys.publicKey, issue(claims, holderKey) {
    const body = encode({ nonce: randomBytes(24).toString('hex'), ...claims,
      cnf: publicKey(holderKey).export({ type: 'spki', format: 'der' }).toString('base64url') });
    const input = encode({ alg: 'EdDSA', typ: 'JWT' }) + '.' + body;
    return input + '.' + sign(null, Buffer.from(input), keys.privateKey).toString('base64url');
  } };
}
function createVerifier({ publicKey: pinnedKey, issuer, audience, session, now = Date.now } = {}) {
  const key = publicKey(pinnedKey);
  if ([issuer, audience, session].some(x => typeof x !== 'string' || !x || x.length > 256) || typeof now !== 'function') throw Error('Invalid verifier configuration');
  const used = new Map(), revoked = new Map(), authenticated = new WeakSet(); let sessionRevoked = false;
  const seconds = () => {
    const n = Math.floor(now() / 1000); if (!Number.isSafeInteger(n)) throw Error('Denied'); return n;
  };
  function assertActive(who) {
    const n = seconds();
    if (!authenticated.has(who) || sessionRevoked || revoked.has(who.nonce) || who.exp <= n || who.nbf > n || who.iat > n) throw Error('Denied');
  }
  return Object.freeze({
    verifyUpgrade(req) {
      try {
        const auth = req.headers.authorization;
        if (typeof auth !== 'string' || auth.length > 4096 || !auth.startsWith('Bearer ')) throw Error();
        const token = auth.slice(7), parts = token.split('.'); if (parts.length !== 3) throw Error();
        const header = object(parts[0]);
        if (JSON.stringify(header) !== '{"alg":"EdDSA","typ":"JWT"}' ||
            !verify(null, Buffer.from(parts[0] + '.' + parts[1]), key, decode(parts[2]))) throw Error();
        const c = object(parts[1]), n = seconds();
        if (Object.keys(c).sort().join(',') !== 'aud,cnf,exp,iat,iss,nbf,nonce,panes,role,session,sub' ||
            c.iss !== issuer || c.aud !== audience || c.session !== session ||
            typeof c.sub !== 'string' || !c.sub || c.sub.length > 256 ||
            !['writer', 'watcher'].includes(c.role) || !/^[a-f0-9]{48}$/.test(c.nonce) ||
            !Array.isArray(c.panes) || !c.panes.length || c.panes.length > 16 ||
            c.panes.some(p => typeof p !== 'string' || !/^[1-9][0-9]{0,3}$/.test(p)) || new Set(c.panes).size !== c.panes.length ||
            ![c.iat, c.nbf, c.exp].every(Number.isSafeInteger) ||
            c.iat > n || c.nbf > n || c.exp <= n || c.exp <= c.nbf || c.exp <= c.iat || c.exp - c.iat > 60 || c.nbf < c.iat ||
            typeof c.cnf !== 'string' || c.cnf.length > 128 || sessionRevoked || revoked.has(c.nonce)) throw Error();
        const holder = publicKey({ key: decode(c.cnf), type: 'spki', format: 'der' });
        const proof = req.headers['x-gateway-proof'];
        if (typeof proof !== 'string' || proof.length > 128 || !verify(null, proofMessage(token, req), holder, decode(proof))) throw Error();
        // One use for the assertion, not merely one use for a particular proof.
        // Invalid proofs never consume a legitimate holder's nonce.
        for (const [nonce, exp] of used) if (exp <= n) used.delete(nonce);
        for (const [nonce, exp] of revoked) if (exp <= n) revoked.delete(nonce);
        if (used.has(c.nonce) || used.size >= 4096) throw Error();
        used.set(c.nonce, c.exp);
        const who = Object.freeze({ ...c, panes: Object.freeze([...c.panes]) });
        authenticated.add(who); return who;
      } catch { throw Error('Denied'); }
    },
    assertActive,
    revoke(nonce) {
      if (typeof nonce !== 'string' || !/^[a-f0-9]{48}$/.test(nonce) || revoked.size >= 4096) throw Error('Denied');
      revoked.set(nonce, Math.max(used.get(nonce) || 0, seconds() + 60));
    },
    revokeSession() { sessionRevoked = true; },
  });
}
module.exports = { createLocalIssuer, createVerifier, proofFor };
