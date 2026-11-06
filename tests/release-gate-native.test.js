'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// This number is an unassigned policy input, never an account to execute as.
const S = process.geteuid(), C = 4000000000;
test('Golden: actual Darwin extended-stat ACL inspection is read-only', () => {
  assert.equal(process.platform, 'darwin', 'Darwin native proof requires macOS');
  const root = fs.mkdtempSync('/private/tmp/mba-release-native-');
  const bin = path.join(root, 'inspect');
  try {
    const build = spawnSync('/usr/bin/clang', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', 'release-gate/native-acl.c', '-o', bin], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
    const run = (role, target, pin, s = S, c = C) => {
      const r = spawnSync(bin, [String(s), String(c), role, target, ...(pin ? [pin] : [])], { encoding: 'utf8', timeout: 3000 });
      assert.equal(r.error, undefined); assert.equal(r.stderr, '');
      const result = JSON.parse(r.stdout); assert.equal(result.productionAuthorization, false);
      assert.equal(r.status, result.classification === 'METADATA_ONLY' ? 0 : 1);
      assert.ok(!r.stdout.includes(root)); return result;
    };
    const d = path.join(root, 'backend'); fs.mkdirSync(d, { mode: 0o700 });
    const before = fs.lstatSync(d);
    const good = run('backend', d);
    const afterProbe = fs.lstatSync(d);
    assert.deepEqual([afterProbe.ino, afterProbe.uid, afterProbe.gid, afterProbe.mode, afterProbe.ctimeMs, afterProbe.mtimeMs],
      [before.ino, before.uid, before.gid, before.mode, before.ctimeMs, before.mtimeMs]);
    assert.equal(good.reason, 'BACKEND_PRIVATE_METADATA'); assert.equal(good.aclPresent, false);
    assert.equal(good.uid, S); assert.equal(good.gid, before.gid); assert.equal(good.mode, 0o700);
    assert.equal(run('ingress-dir', d).reason, 'MISSING_ACL');
    assert.equal(run('backend', d, undefined, S, S).reason, 'SAME_UID');
    for (const bad of ['../x', d + '/..', d + '/', d + '//x', d + '/./x']) assert.equal(run('backend', bad).reason, 'PATH');
    const link = path.join(root, 'link'); fs.symlinkSync(d, link);
    assert.equal(run('backend', link).reason, 'SYMLINK');
    assert.equal(run('backend', link + '/nested').reason, 'SYMLINK');
    const file = path.join(root, 'file'); fs.writeFileSync(file, 'unchanged', { mode: 0o600 });
    assert.equal(run('backend', file).reason, 'WRONG_OBJECT');
    assert.equal(run('socket', d).reason, 'WRONG_OBJECT');
    assert.equal(run('backend', d + '/missing').reason, 'STAT_UNAVAILABLE');
    assert.equal(run('other', d).reason, 'ROLE');
    assert.equal(run('backend', root, undefined, C, S).reason, 'UNSAFE_OWNER_MODE');
    const open = path.join(root, 'unsafe');
    // Make an unsafe ancestor by construction; never chmod or change an ACL.
    const writable = path.join(root, 'writable');
    const previousMask = process.umask(0);
    try {
      fs.mkdirSync(open, { mode: 0o755 });
      fs.mkdirSync(writable, { mode: 0o777 });
    } finally { process.umask(previousMask); }
    assert.equal(run('backend', open).reason, 'UNSAFE_OWNER_MODE');
    fs.mkdirSync(path.join(writable, 'child'), { mode: 0o700 });
    assert.equal(run('backend', path.join(writable, 'child')).reason, 'UNSAFE_ANCESTOR');
    for (const uid of ['0', '-1', '502x', '4294967295']) assert.equal(run('backend', d, undefined, uid).reason, 'UID');
    fs.renameSync(d, d + '-old'); fs.mkdirSync(d, { mode: 0o700 });
    assert.equal(run('backend', d, good.pin).reason, 'PATH_RACE');
    fs.rmdirSync(d); fs.renameSync(d + '-old', d);
    assert.equal(run('backend', d, good.pin).reason, 'PATH_RACE', 'ctime drift invalidates a previous observation');
    assert.equal(fs.readFileSync(file, 'utf8'), 'unchanged');
    assert.equal(fs.lstatSync(d).mode, before.mode); assert.equal(fs.lstatSync(d).uid, before.uid);
    const unsupported = path.join(root, 'unsupported');
    const otherBuild = spawnSync('/usr/bin/clang', ['-Wall', '-Wextra', '-Werror', '-U__APPLE__', 'release-gate/native-acl.c', '-o', unsupported], { encoding: 'utf8' });
    assert.equal(otherBuild.status, 0, otherBuild.stderr);
    const otherResult = spawnSync(unsupported, [], { encoding: 'utf8' });
    assert.equal(otherResult.status, 1); assert.equal(JSON.parse(otherResult.stdout).reason, 'UNSUPPORTED_PLATFORM');
    console.log('ACL_POSITIVE=NOT_RUN; TWO_UID_KERNEL_E2E=NOT_RUN; G0=BLOCKED');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
