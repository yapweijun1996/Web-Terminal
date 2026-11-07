import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const mac = process.platform === 'darwin';
let root, binary, temp;
const directories = [];
before(() => {
  if (!mac) return;
  temp = fs.realpathSync(os.tmpdir());
  root = fs.mkdtempSync(path.join(temp, 'pc-'));
  binary = path.join(root, 'probe');
  const source = fileURLToPath(new URL('../native/peercred_probe.c', import.meta.url));
  const result = spawnSync('clang', ['-Wall', '-Wextra', '-Werror', source, '-o', binary], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
after(() => { for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true }); if (root) fs.rmSync(root, { recursive: true, force: true }); });
function makeDir(prefix = 's-') { const dir = fs.mkdtempSync(path.join(temp, prefix)); directories.push(dir); return dir; }
function run(mode, directory = makeDir()) { return spawnSync(binary, [directory, mode], { encoding: 'utf8', timeout: 8000, maxBuffer: 65536 }); }
function ok(mode) { const r = run(mode); assert.equal(r.status, 0, `${mode}: ${r.stderr} ${r.error?.message || ''}`); return r.stdout; }
test('accepted and connected sockets expose kernel credentials and reject same UID', { skip: !mac }, () => {
  const out = ok('normal');
  assert.match(out, new RegExp(`server_accepted_sees_client uid=${process.getuid()} gid=${process.getgid()}\\b`));
  assert.match(out, new RegExp(`client_sees_server uid=${process.getuid()} gid=${process.getgid()}\\b`));
  assert.match(out, /directory_mode=0700 socket_mode=600/);
  assert.match(out, /policy=reject_same_uid/);
  assert.match(out, /local_peerpid=unsupported ancillary_policy=deny production_authority=none/);
});
test('spoofed claimed UID cannot change same-principal rejection', { skip: !mac }, () => {
  const out = ok('spoof');
  assert.match(out, new RegExp(`claimed_uid=${process.getuid() + 1} untrusted=true`));
  assert.match(out, /policy=reject_same_uid/);
});
test('SCM_RIGHTS transfers a real accepted descriptor and preserves its peer snapshot', { skip: !mac }, () => {
  const out = ok('transfer');
  const server = out.match(/server_accepted_sees_client (uid=\d+ gid=\d+ groups=\d+ xucred_length=\d+)/);
  assert.ok(server);
  assert.ok(out.includes(`transferred_accepted_fd_sees_client ${server[1]}`));
  assert.match(out, /ancillary_policy=deny/);
});
test('unexpected SCM_RIGHTS on the accepted socket is rejected and closed', { skip: !mac }, () => {
  const out = ok('ancillary');
  assert.match(out, /ancillary_rejected=true received_fds_closed=1 control_truncated=false malformed=false/);
  assert.match(out, /message=rejected/);
});
test('malformed and timed-out frames are rejected', { skip: !mac }, () => {
  for (const mode of ['malformed', 'timeout']) { const out = ok(mode); assert.match(out, /message=rejected/); assert.match(out, /policy=reject_unverified/); }
});
test('connection failure, unsafe permissions and excessive path length fail safely', { skip: !mac }, () => {
  assert.match(ok('connect-fail'), /connect_failure=observed/);
  const unsafe = makeDir('unsafe-');
  fs.chmodSync(unsafe, 0o755);
  assert.notEqual(run('normal', unsafe).status, 0);
  const long = makeDir('x'.repeat(100));
  const r = run('normal', long);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /socket path too long/);
});

test('multiple and truncated SCM_RIGHTS are rejected without retaining received descriptors', { skip: !mac }, () => {
  for (const [mode, truncated] of [['ancillary-multi', false], ['ancillary-trunc', true]]) {
    const out = ok(mode);
    assert.match(out, new RegExp(`ancillary_rejected=true received_fds_closed=\\d+ control_truncated=${truncated}`));
    if (!truncated) assert.match(out, /received_fds_closed=2\b/);
    isolated(out);
    if (truncated) assert.match(out, /received_fds_closed=0\b/);
    assert.match(out, /message=rejected/);
    assert.doesNotMatch(out, /claimed_uid=\d+ untrusted=true/);
  }
});
test('directory symlink and nested directory are rejected', { skip: !mac }, () => {
  const dir = makeDir();
  const alias = `${dir}-alias`; directories.push(alias);
  fs.symlinkSync(dir, alias);
  assert.notEqual(run('normal', alias).status, 0);
  const nested = path.join(dir, 'nested'); fs.mkdirSync(nested, { mode: 0o700 });
  assert.notEqual(run('normal', nested).status, 0);
});

// A separate connected-socket family exercises isolation even where pathname
// bind is sandbox-denied. The original eight pathname tests remain mandatory.
function isolated(out) {
  assert.match(out, /receiver_terminated=true transferred_pipe_eof=true parent_fds_intact=true concurrent_fd_intact=true/);
  assert.match(out, /authorization=false/);
  assert.doesNotMatch(out, /fd_count_before|fd_count_after|policy=accept|authorization=true/);
}
function connected(mode) {
  const r = run(mode, '--socketpair');
  assert.equal(r.status, 0, `${mode}: ${r.stdout} ${r.stderr} ${r.error?.message || ''}`);
  isolated(r.stdout);
  return r.stdout;
}
for (const [mode, count, truncated] of [
  ['ancillary', 1, false], ['ancillary-multi', 2, false],
  ['ancillary-trunc-one', 1, true], ['ancillary-trunc-two', 2, true], ['ancillary-trunc', 32, true],
]) test(`Golden connected sockets: ${count} rights, MSG_CTRUNC=${truncated}`, { skip: !mac }, () => {
  const out = connected(mode);
  assert.match(out, new RegExp(`ancillary_rejected=true received_fds_closed=${truncated ? 0 : count} control_truncated=${truncated}`));
  assert.match(out, /message=rejected/);
  assert.doesNotMatch(out, /claimed_uid=\d+ untrusted=true/);
});
test('Golden connected sockets: high source and installed FD slots above 1023', { skip: !mac }, t => {
  const r = run('ancillary-high', '--socketpair');
  if (r.status === 77 && /high_fd_unavailable=true/.test(r.stdout)) {
    t.skip('OS resource limits prevent >1023 FD test; high-FD acceptance remains missing'); return;
  }
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  assert.ok(Number(r.stdout.match(/sender_high_fd=(\d+)/)?.[1]) > 1023);
  assert.match(r.stdout, /receiver_allocation_floor_above_1023=true/);
  assert.match(r.stdout, /high_installed_fd_observed=1101/);
  assert.match(r.stdout, /control_truncated=true/);
  isolated(r.stdout);
});
test('Golden connected sockets: real concurrent open and recvmsg, unrelated handles survive', { skip: !mac }, () => {
  // The scheduler may serialize a particular attempt. Require measured syscall
  // overlap in at least one bounded attempt; never replace it with a sleep/mock.
  let evidence = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    const out = connected('ancillary-concurrent');
    assert.match(out, /control_truncated=true/);
    evidence += out;
    if (Number(out.match(/open_syscalls_overlapping_recvmsg=(\d+)/)?.[1]) > 0) return;
  }
  assert.fail(`No real syscall overlap observed; concurrent acceptance is missing: ${evidence}`);
});
test('Golden connected sockets: later ancillary message rejects partial claims', { skip: !mac }, () => {
  const out = connected('ancillary-late');
  assert.match(out, /frame_bytes=12 frame_complete=false recv_calls=13 receive_error=false/);
  assert.match(out, /ancillary_rejected=true/);
  assert.match(out, /message=rejected/);
  assert.doesNotMatch(out, /claimed_uid=\d+ untrusted=true/);
});
test('Golden connected sockets: peer claims, EOF and deadline never grant authority', { skip: !mac }, () => {
  for (const mode of ['normal', 'spoof', 'transfer', 'eof', 'timeout', 'malformed']) {
    const out = connected(mode);
    assert.match(out, /policy=reject_(same_uid|unverified)/);
    if (['eof', 'timeout', 'malformed'].includes(mode)) assert.match(out, /message=rejected/);
  }
});
test('Golden connected sockets: hung own receiver is killed and reaped before reporting', { skip: !mac }, () => {
  const r = run('receiver-hang', '--socketpair');
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  assert.match(r.stdout, /receiver_timeout_killed_and_reaped=true authorization=false/);
  assert.doesNotMatch(r.stdout, /receiver_terminated=true/);
});
for (const mode of ['ctrunc', 'trunc', 'short-header', 'short-length', 'oversized-header',
  'oversized-buffer', 'partial-int', 'unknown', 'misaligned', 'trailing', 'multiple']) {
  test(`control parser in disposable process: ${mode}`, { skip: !mac }, () => {
    const r = run(mode, '--control');
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.match(r.stdout, /rejected=1/);
    assert.match(r.stdout, /handles_as_expected=1 authorization=false/);
  });
}
test('native source has no descriptor sweep or production integration', () => {
  const source = fs.readFileSync(new URL('../native/peercred_probe.c', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /fd_before|snapshot_fds|count_fds|closefrom|close_range/);
  assert.doesNotMatch(source, /for\s*\([^;]*\bfd\s*=\s*0[^;]*;[^;]*\bfd\s*</);
  assert.match(source, /waitpid\(child, status, WNOHANG\)/);
  assert.match(source, /_exit\(0\); \/\* Includes every uncertain\/invisible descriptor/);
});

test('Golden connected sockets: receive errors terminate the disposable receiver', { skip: !mac }, () => {
  const out = connected('receiver-error');
  assert.match(out, /frame_bytes=0 frame_complete=false recv_calls=1 receive_error=true/);
  assert.match(out, /message=rejected/);
});
test('Golden connected sockets: frame processing is bounded to 64 bytes', { skip: !mac }, () => {
  const out = connected('oversized-frame');
  assert.match(out, /frame_bytes=64 frame_complete=false recv_calls=64 receive_error=false/);
  assert.match(out, /message=rejected/);
});
