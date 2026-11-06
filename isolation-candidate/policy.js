'use strict';
const { verify } = require('node:crypto');
function createPolicy({ publicKey, pane, lease, epoch, now = Date.now }) {
  const used = new Map(); let released = false;
  return { authorize(request) {
    const deny = () => { throw Error('DENIED'); };
    if (!request || Object.keys(request).sort().join() !== 'payload,signature') deny();
    const { payload, signature } = request;
    if (typeof payload !== 'string' || typeof signature !== 'string' || payload.length > 8192 || !verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, 'base64url'))) deny();
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!c || typeof c !== 'object') deny();
    const expected = ['iss','aud','role','pane','lease','epoch','iat','exp','nonce','op'];
    if (c.op === 'text') expected.push('text'); else if (c.op === 'key') expected.push('key'); else if (c.op !== 'release') deny();
    if (Object.keys(c).sort().join() !== expected.sort().join()) deny();
    const time = now();
    if (c.iss !== 'test-issuer' || c.aud !== 'supervisor' || c.role !== 'writer' || c.pane !== pane || c.lease !== lease || c.epoch !== epoch || released || !Number.isSafeInteger(c.iat) || !Number.isSafeInteger(c.exp) || c.iat > time || c.exp <= time || c.exp <= c.iat || c.exp - c.iat > 5000 || typeof c.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(c.nonce)) deny();
    if (c.op === 'text' && (typeof c.text !== 'string' || !/^[\x20-\x7e]{1,128}$/.test(c.text))) deny();
    if (c.op === 'key' && c.key !== 'Enter') deny();
    for (const [nonce, exp] of used) if (exp <= time) used.delete(nonce);
    if (used.has(c.nonce) || used.size >= 1024) deny();
    used.set(c.nonce, c.exp);
    if (c.op === 'release') released = true;
    return Object.freeze(c);
  } };
}
module.exports = { createPolicy };
