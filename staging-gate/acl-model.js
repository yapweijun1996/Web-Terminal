'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Proposed normalized model only. It does not read or authorize a real OS ACL.
const expected = Object.freeze({
  ingress: { owner: 'S', mode: 0o700, aces: [{ principal: 'C', type: 'allow', rights: ['search'] }] },
  socket: { owner: 'S', mode: 0o600, aces: [{ principal: 'C', type: 'allow', rights: ['connect'] }] },
  backend: { owner: 'S', mode: 0o700, aces: [] }
});
function evaluate(model) {
  const reasons = [];
  if (!model || typeof model !== 'object' || Array.isArray(model) || Object.keys(model).sort().join(',') !== 'backend,ingress,socket') reasons.push('PATH_SET');
  else for (const [name, target] of Object.entries(expected)) {
    const item = model[name];
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'aces,mode,owner' || item.owner !== target.owner || item.mode !== target.mode || !Array.isArray(item.aces)) { reasons.push(`${name}:OWNER_MODE_OR_SCHEMA`); continue; }
    if (item.aces.length !== target.aces.length) { reasons.push(`${name}:ACE_COUNT`); continue; }
    for (let i = 0; i < target.aces.length; i++) {
      const ace = item.aces[i], want = target.aces[i];
      if (!ace || typeof ace !== 'object' || Array.isArray(ace) || Object.keys(ace).sort().join(',') !== 'principal,rights,type' || ace.principal !== want.principal || ace.type !== want.type || !Array.isArray(ace.rights) || ace.rights.length !== want.rights.length || ace.rights.some((r,j) => r !== want.rights[j])) reasons.push(`${name}:UNEXPECTED_ACE`);
    }
  }
  return { classification: 'MODEL_ONLY', modelMatches: reasons.length === 0, reasons, G1: 'PENDING', productionAuthorization: false };
}
function inspectScratch(dir) {
  if (!path.isAbsolute(dir) || path.resolve(dir) !== dir || path.dirname(dir) !== fs.realpathSync(os.tmpdir()) || !path.basename(dir).startsWith('staging-')) throw Error('not scratch');
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.geteuid() || (st.mode & 0o7777) !== 0o700) throw Error('not private owner directory');
  return { ownerIsCurrent: true, mode: st.mode & 0o7777, acl: 'NOT_INSPECTED', G1: 'PENDING' };
}
module.exports = { expected, evaluate, inspectScratch };
