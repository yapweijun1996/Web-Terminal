'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { evaluate } = require('../staging-gate/preflight');
const acl = require('../staging-gate/acl-model');
const ledger = require('../staging-gate/ledger');
const base = () => ({ version: 1, role: 'S', uid: 9001, path: '/private/tmp/example', scope: 'scratch-ipc-preflight', approver: 'claimed-owner', expiresAt: '2099-01-01T00:00:00Z', distinctProof: 'claimed-proof' });
test('unapproved, expired, forged, same UID and name-only records never authorize', () => {
  const s = base(), c = { ...base(), role: 'C', uid: 9002 };
  for (const records of [{}, { S: s, C: c }, { S: { ...s, expiresAt: '2000-01-01T00:00:00Z' }, C: c }, { S: { ...s, uid: process.geteuid() }, C: c }, { S: s, C: { ...c, uid: s.uid } }, { S: { ...s, independentlyVerified: true }, C: c }, { S: { name: 'login-capable' }, C: c }]) {
    const result = evaluate(records); assert.equal(result.G0, 'BLOCKED'); assert.equal(result.S.usable, false); assert.equal(result.C.usable, false);
  }
  assert.equal(evaluate({S:s,C:c}).S.validShape, true);
  assert.equal(evaluate({S:s,C:c}).S.independentlyVerified, false);
  assert.ok(evaluate({S:{...s, expiresAt:'2000-01-01T00:00:00Z'}, C:c}).S.issues.includes('EXPIRY'));
  assert.ok(evaluate({S:s,C:{...c,uid:s.uid}}).C.issues.includes('SAME_PRINCIPAL'));
});
test('ACL model rejects extra or altered rights, inheritance, principals, deny and backend traversal', () => {
  const pristine = () => JSON.parse(JSON.stringify(acl.expected));
  assert.equal(acl.evaluate(pristine()).modelMatches, true);
  const variants = [m => m.ingress.aces.push({principal:'everyone',type:'allow',rights:['search']}), m => m.socket.aces[0].type='deny', m => m.socket.aces[0].rights.push('write_acl'), m => m.socket.aces[0].rights.push('write_owner'), m => m.socket.aces[0].inherited=true, m => m.backend.aces.push({principal:'C',type:'allow',rights:['search']}), m => m.ingress.mode=0o750, m => m.socket.owner='C', m => m.socket.aces[0].principal='group', m => m.socket.aces[0].rights.push('write')];
  for (const mutate of variants) { const m = pristine(); mutate(m); const r = acl.evaluate(m); assert.equal(r.modelMatches, false); assert.equal(r.G1, 'PENDING'); assert.equal(r.productionAuthorization, false); }
});
test('ledger rejects takeover, corrupt and replayed journals and symlink output', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'staging-policy-'));
  try {
    const a = ledger.open(root); assert.equal(a.status, 'ACTIVE');
    assert.equal(ledger.open(root).status, 'QUARANTINED');
    assert.throws(() => a.renew('old-generation'));
    const journal = path.join(root,'journal'), original = fs.readFileSync(journal,'utf8');
    fs.writeFileSync(journal, '{'); assert.throws(() => a.write(a.lease, 'bad'));
    const altered = JSON.parse(original); altered.generation = '0'.repeat(64); fs.writeFileSync(journal, JSON.stringify(altered));
    assert.throws(() => a.renew(a.lease));
    fs.writeFileSync(journal, original);
    fs.unlinkSync(path.join(root,'output')); fs.symlinkSync(journal,path.join(root,'output'));
    assert.throws(() => a.write(a.lease,'bad')); assert.equal(fs.readFileSync(journal,'utf8'),original);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('harness rejects even claimed approvals and environment overrides', () => {
  const r = spawnSync(process.execPath,[path.join(__dirname,'../staging-gate/cross-uid-harness.js')],{encoding:'utf8', env:{...process.env, APPROVED:'1', ALLOW_SAME_UID:'1'}});
  assert.equal(r.status,1); assert.match(r.stderr,/DENIED/);
});
test('scratch metadata is read-only and never claims ACL verification', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'staging-acl-'));
  try { assert.deepEqual(acl.inspectScratch(dir), {ownerIsCurrent:true,mode:0o700,acl:'NOT_INSPECTED',G1:'PENDING'}); }
  finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('same-UID filesystem mode denial is only a local control', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'staging-mode-'));
  try {
    const file = path.join(dir,'readonly');
    fs.writeFileSync(file, 'unchanged', {mode:0o400, flag:'wx'});
    assert.throws(() => fs.openSync(file,'w'), e => e.code === 'EACCES' || e.code === 'EPERM');
    assert.equal(fs.readFileSync(file,'utf8'), 'unchanged');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('symlink fence and nonempty directory fail closed without following targets', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'staging-link-'));
  try {
    const target=path.join(dir,'target'); fs.writeFileSync(target,'unchanged',{mode:0o600});
    fs.symlinkSync(target,path.join(dir,'fence'));
    assert.equal(ledger.open(dir).status,'QUARANTINED');
    assert.equal(fs.readFileSync(target,'utf8'),'unchanged');
    assert.throws(() => ledger.open('/'));
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
