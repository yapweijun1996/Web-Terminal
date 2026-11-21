'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  parseGithubRepo, workspacePathFor, redact, createWorkspace, cleanupWorkspace
} = require('../workspace/github-workspace');

const repo = 'Owner-1/example_repo';
const sessionId = 'session-1234';
const cleanStatus = { code: 0, stdout: '', stderr: '' };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'github-workspace-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const workspacesRoot = path.join(directory, 'workspaces');
  return {
    directory,
    workspacesRoot,
    target: workspacePathFor(workspacesRoot, repo, sessionId),
    options: { workspacesRoot, repo, sessionId }
  };
}

test('parses only the supported GitHub repository forms', () => {
  const valid = [
    'Owner-1/example_repo',
    'Owner-1/example_repo/',
    'Owner-1/example_repo.git',
    'Owner-1/example_repo.git/',
    'https://github.com/Owner-1/example_repo',
    'https://github.com/Owner-1/example_repo.git/',
  ];
  for (const input of valid) {
    assert.deepEqual(parseGithubRepo(input), {
      ok: true, owner: 'Owner-1', repo: 'example_repo', cloneUrl: 'https://github.com/Owner-1/example_repo.git'
    }, input);
  }
  assert.equal(parseGithubRepo(`${'a'.repeat(39)}/${'r'.repeat(100)}.git`).ok, true);

  const invalid = [
    '', null, {}, 'file:///etc/passwd', 'git@github.com:o/r.git', 'ssh://github.com/o/r',
    'http://github.com/o/r', 'https://evil.com/o/r', 'https://github.com.evil.com/o/r',
    'https://user:pw@github.com/o/r', 'https://github.com:443/o/r', 'owner/../x',
    'o/.', 'o/..', 'o/...git', 'o/%2e%2e', 'o/r?ref=x', 'o/r#ref', 'o/r//',
    'o/r more', 'o/r\n', ' o/r', '-owner/r', 'o_w/r', `${'a'.repeat(40)}/r`,
    `o/${'r'.repeat(101)}`,
  ];
  for (const input of invalid) {
    assert.deepEqual(parseGithubRepo(input), { ok: false, code: 'invalid_repo' }, String(input));
  }
});

test('builds paths below the configured root from validated components', t => {
  const { workspacesRoot, target } = fixture(t);
  assert.equal(target, path.join(workspacesRoot, 'Owner-1', 'example_repo', sessionId));
  assert.equal(workspacePathFor(workspacesRoot, parseGithubRepo(repo), sessionId), target);
  for (const badSession of ['../escape', '/absolute', '-leading', 'ABC12345', 'short', 'session-1234\n', 'a'.repeat(65), null]) {
    assert.throws(() => workspacePathFor(workspacesRoot, repo, badSession), { code: 'invalid_session' });
  }
  assert.throws(() => workspacePathFor(workspacesRoot, { owner: '..', repo: 'example' }, sessionId), { code: 'invalid_repo' });
});

test('redacts GitHub tokens, HTTPS credentials and authorization values', () => {
  const input = [
    'ghp_sample GHO_sample ghs_sample github_pat_example-123',
    'https://user:password@github.com/owner/repo',
    'Authorization: Bearer opaque-token',
    '> authorization: Basic encoded-secret',
  ].join('\n');
  assert.equal(redact(input), [
    '[REDACTED] [REDACTED] [REDACTED] [REDACTED]',
    'https://[REDACTED]@github.com/owner/repo',
    'Authorization: [REDACTED]',
    '> authorization: [REDACTED]',
  ].join('\n'));
});

test('clones with fixed arguments and an allowlisted, noninteractive environment', async t => {
  const { options, target } = fixture(t);
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK']) {
    const previousValue = process.env[key];
    process.env[key] = 'test-only-value';
    t.after(() => {
      if (previousValue === undefined) delete process.env[key];
      else process.env[key] = previousValue;
    });
  }
  const result = await createWorkspace({
    ...options,
    repo: { ...parseGithubRepo(repo), cloneUrl: 'file:///etc/passwd' },
    async runner(cmd, args, { env, timeoutMs }) {
      assert.equal(cmd, 'git');
      assert.deepEqual(args, ['clone', '--depth', '1', '--', 'https://github.com/Owner-1/example_repo.git', target]);
      assert.equal(env.GIT_TERMINAL_PROMPT, '0');
      for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK']) assert.equal(env[key], undefined);
      assert.ok(timeoutMs > 0);
      return cleanStatus;
    }
  });
  assert.deepEqual(result, { ok: true, path: target });
});

test('refuses an existing destination and an overlapping clone', async t => {
  const { options, target } = fixture(t);
  const first = createWorkspace({ ...options, runner: async () => cleanStatus });
  const existing = await createWorkspace({
    ...options,
    runner: async () => assert.fail('Git must not run for an existing workspace')
  });
  assert.equal(existing.code, 'workspace_exists');
  assert.deepEqual(await first, { ok: true, path: target });
  assert.ok(fs.existsSync(target));
});

test('redacts clone failures and releases an empty reservation for retry', async t => {
  const { options, target } = fixture(t);
  const result = await createWorkspace({
    ...options,
    runner: async () => ({
      code: 1,
      stdout: '',
      stderr: 'ghp_sample https://user:password@github.com/owner/repo\nAuthorization: Bearer opaque-token'
    })
  });
  assert.deepEqual(result, {
    ok: false, code: 'clone_failed',
    message: '[REDACTED] https://[REDACTED]@github.com/owner/repo\nAuthorization: [REDACTED]'
  });
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(await createWorkspace({ ...options, runner: async () => cleanStatus }), { ok: true, path: target });
});

test('refuses clone and cleanup through a symlink below the root', async t => {
  const { options, directory, workspacesRoot, target } = fixture(t);
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(workspacesRoot);
  fs.symlinkSync(outside, path.join(workspacesRoot, 'Owner-1'), 'dir');
  let calls = 0;
  const runner = async () => { calls++; return cleanStatus; };
  assert.equal((await createWorkspace({ ...options, runner })).code, 'outside_workspaces');
  assert.deepEqual(fs.readdirSync(outside), []);

  const outsideTarget = path.join(outside, 'example_repo', sessionId);
  fs.mkdirSync(outsideTarget, { recursive: true });
  assert.equal((await cleanupWorkspace({ workspacesRoot, path: target, runner })).code, 'outside_workspaces');
  const targetLink = path.join(workspacesRoot, 'link');
  fs.symlinkSync(outsideTarget, targetLink, 'dir');
  assert.equal((await cleanupWorkspace({ workspacesRoot, path: targetLink, runner })).code, 'outside_workspaces');
  assert.equal(calls, 0);
  assert.ok(fs.existsSync(outsideTarget));
});

test('cleanup refuses paths outside the root, including similarly named siblings', async t => {
  const { workspacesRoot } = fixture(t);
  const sibling = `${workspacesRoot}-backup`;
  fs.mkdirSync(sibling);
  let calls = 0;
  const runner = async () => { calls++; return cleanStatus; };
  for (const target of [sibling, workspacesRoot]) {
    assert.equal((await cleanupWorkspace({ workspacesRoot, path: target, runner })).code, 'outside_workspaces');
  }
  assert.equal(calls, 0);
  assert.ok(fs.existsSync(sibling));
});

test('cleanup preserves dirty directories and directories whose status check failed', async t => {
  const { workspacesRoot, target } = fixture(t);
  fs.mkdirSync(target, { recursive: true });
  for (const result of [{ ...cleanStatus, stdout: '?? untracked.txt\n' }, { ...cleanStatus, code: 128 }]) {
    const runner = async () => result;
    assert.equal((await cleanupWorkspace({ workspacesRoot, path: target, runner })).code, 'dirty');
    assert.ok(fs.existsSync(target));
  }
});

test('cleanup removes a workspace only after empty porcelain output', async t => {
  const { workspacesRoot, target } = fixture(t);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'tracked.txt'), 'tracked');
  const result = await cleanupWorkspace({
    workspacesRoot,
    path: target,
    async runner(cmd, args, { cwd }) {
      assert.equal(cmd, 'git');
      assert.deepEqual(args, ['status', '--porcelain']);
      assert.equal(cwd, target);
      assert.ok(fs.existsSync(path.join(cwd, 'tracked.txt')));
      return cleanStatus;
    }
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(fs.existsSync(target), false);
});

test('cleanup refuses a replacement directory after the status check', async t => {
  const { workspacesRoot, target } = fixture(t);
  fs.mkdirSync(target, { recursive: true });
  const result = await cleanupWorkspace({
    workspacesRoot,
    path: target,
    async runner() {
      fs.renameSync(target, `${target}-original`);
      fs.mkdirSync(target);
      return cleanStatus;
    }
  });
  assert.equal(result.code, 'outside_workspaces');
  assert.ok(fs.existsSync(target));
});
