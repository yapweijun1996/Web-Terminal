'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const KEYS = ['approver', 'distinctProof', 'expiresAt', 'path', 'role', 'scope', 'uid', 'version'];
function inspectRecord(record, role, now = Date.now()) {
  const issues = [];
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).sort().join(',') !== KEYS.join(',')) return { validShape: false, independentlyVerified: false, usable: false, issues: ['STRICT_SCHEMA'] };
  if (record.version !== 1 || record.role !== role || !Number.isSafeInteger(record.uid) || record.uid <= 0 || record.uid > 4294967294 || record.uid === process.geteuid()) issues.push('IDENTITY');
  if (typeof record.path !== 'string' || record.path.length > 4096 || /[\x00-\x1f\x7f]/.test(record.path) || !path.isAbsolute(record.path) || path.resolve(record.path) !== record.path) issues.push('PATH');
  if (record.scope !== 'scratch-ipc-preflight' || typeof record.approver !== 'string' || !record.approver.trim() || record.approver.length > 256 || typeof record.distinctProof !== 'string' || !record.distinctProof.trim() || record.distinctProof.length > 1024) issues.push('SCOPE_OR_PROVENANCE');
  if (typeof record.expiresAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(record.expiresAt) || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= now || (Number.isFinite(Date.parse(record.expiresAt)) && new Date(record.expiresAt).toISOString() !== record.expiresAt.replace(/Z$/, record.expiresAt.includes('.') ? 'Z' : '.000Z'))) issues.push('EXPIRY');
  // No trusted attestation channel is implemented. Text, signatures, flags and
  // JSON assertions are not independent owner/admin verification.
  return { validShape: issues.length === 0, independentlyVerified: false, usable: false, issues: [...issues, 'INDEPENDENT_VERIFICATION_UNAVAILABLE'] };
}
function evaluate(records = {}, now = Date.now()) {
  const s = inspectRecord(records.S, 'S', now), c = inspectRecord(records.C, 'C', now);
  if (records.S && records.C && records.S.uid === records.C.uid) { s.issues.push('SAME_PRINCIPAL'); c.issues.push('SAME_PRINCIPAL'); s.validShape = c.validShape = false; }
  if (records.S && records.C && records.S.path !== records.C.path) { s.issues.push('PATH_MISMATCH'); c.issues.push('PATH_MISMATCH'); s.validShape = c.validShape = false; }
  return { G0: 'BLOCKED', S: s, C: c, verification: 'NO_INDEPENDENT_ATTESTATION_IMPLEMENTED' };
}
function inventory() {
  return [501, 502, 503].map(uid => {
    if (uid === process.geteuid()) return { uid, present: true, source: 'current-euid', usable: false };
    if (process.platform !== 'darwin') return { uid, present: null, source: 'unavailable', usable: false };
    const r = spawnSync('/usr/bin/dscl', ['.', '-search', '/Users', 'UniqueID', String(uid)], { encoding: 'utf8', timeout: 3000, maxBuffer: 65536 });
    const present = r.status === 0 ? r.stdout.split('\n').some(line => line.trim().split(/\s+/).at(-1) === String(uid)) : null;
    return { uid, present, source: 'local-directory-read-only', usable: false };
  });
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1) throw Error('usage: node preflight.js [record.json]');
    const records = args.length ? JSON.parse(fs.readFileSync(args[0], 'utf8')) : {};
    if (!records || Array.isArray(records) || typeof records !== 'object' || Object.keys(records).some(k => !['S', 'C'].includes(k))) throw Error('invalid input');
    console.log(JSON.stringify({ inventory: inventory(), ...evaluate(records) }, null, 2));
    process.exitCode = 1;
  } catch { console.error('DENIED: invalid input or unavailable evidence'); process.exitCode = 2; }
}
module.exports = { evaluate, inspectRecord, inventory };
