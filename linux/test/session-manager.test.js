'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadProjectRoots } = require('../workspace/project-roots');
const { createSessionManager } = require('../workspace/session-manager');

const cliPath = path.join(__dirname, 'fixtures', 'fake-cli.js');
const cliSessionId = 'c6cecb23-d965-4b2a-a68c-f975304021a2';
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function fixture(t, options = {}, mode = 'echo') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-manager-'));
  const root = path.join(base, 'root');
  const project = path.join(root, 'project');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(outside);
  const launches = [];
  const manager = createSessionManager({
    roots: loadProjectRoots({ roots: [{ id: 'projects', label: 'Projects', path: root }] }),
    killGraceMs: 100,
    spawnFn(command, args, spawnOptions) {
      const executable = mode === 'spawn-failure' ? path.join(base, 'missing-agent') : process.execPath;
      const child = spawn(executable, [cliPath, command, mode], spawnOptions);
      const closed = new Promise(resolve => child.once('close', (...args) => resolve(args)));
      launches.push({ command, args, options: spawnOptions, child, closed });
      return child;
    },
    ...options,
  });
  t.after(async () => {
    for (const { sessionId } of manager.list()) manager.stop(sessionId);
    try {
      await Promise.all(launches.map(launch => launch.closed));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
  const start = overrides => manager.start({ rootId: 'projects', relPath: 'project', agent: 'claude', ...overrides });
  return { manager, root, project, outside, launches, start };
}

function eventsFor(manager, sessionId) {
  const events = [];
  const waiters = new Map();
  manager.onEvent(sessionId, event => {
    events.push(event);
    waiters.get(event.type)?.(event);
  }, 0);
  return {
    events,
    wait(type) {
      const event = events.find(entry => entry.type === type);
      if (event) return Promise.resolve(event);
      return new Promise(resolve => waiters.set(type, resolve));
    },
  };
}

test('start rejects traversal and symlinks outside project roots', t => {
  const f = fixture(t);
  fs.symlinkSync(f.outside, path.join(f.root, 'escape'));
  assert.throws(() => f.start({ relPath: '../outside' }), { code: 'invalid_path' });
  assert.throws(() => f.start({ relPath: 'escape' }), { code: 'outside_root' });
  assert.equal(f.launches.length, 0);
  assert.deepEqual(f.manager.list(), []);
});

test('start rejects a directory swapped after initial validation and before spawn', t => {
  const f = fixture(t);
  const canonical = fs.realpathSync.native(f.project);
  const stat = fs.statSync;
  const moved = path.join(f.root, 'original');
  let swapped = false;
  const patch = t.mock.method(fs, 'statSync', (file, ...args) => {
    const result = stat(file, ...args);
    if (file === canonical && !swapped) {
      swapped = true;
      fs.renameSync(f.project, moved);
      fs.symlinkSync(f.outside, f.project);
    }
    return result;
  });
  try {
    assert.throws(() => f.start(), { code: 'outside_root' });
  } finally {
    patch.mock.restore();
  }
  assert.ok(swapped);
  assert.equal(f.launches.length, 0);
  assert.deepEqual(f.manager.list(), []);
});

test('spawns directly with a canonical cwd, Claude isolation flags, and sanitized environment', t => {
  const blocked = ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'AWS_ACCESS_KEY_ID', 'AWS_TEST', 'ANTHROPIC_API_KEY'];
  const original = Object.fromEntries(blocked.map(key => [key, process.env[key]]));
  const f = fixture(t, { env: { ANTHROPIC_API_KEY: 'explicit-test-override' } });
  const inherited = fixture(t);
  try {
    for (const key of blocked) process.env[key] = 'fake-inherited-value';
    const { sessionId } = f.start();
    assert.match(sessionId, uuid);
    inherited.start();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const [{ command, args, options }] = f.launches;
  assert.equal(command, 'claude');
  assert.equal(options.shell, false);
  assert.equal(options.cwd, fs.realpathSync.native(f.project));
  assert.deepEqual(args.slice(-4), ['--setting-sources', 'project', '--disable-slash-commands', '--strict-mcp-config']);
  assert.ok(args.includes('host'));
  for (const key of blocked) assert.equal(Object.hasOwn(inherited.launches[0].options.env, key), false);
  for (const key of blocked.slice(0, -1)) assert.equal(Object.hasOwn(options.env, key), false);
  assert.equal(options.env.ANTHROPIC_API_KEY, 'explicit-test-override');
  assert.equal(options.env.PATH, process.env.PATH);
});

test('buffers partial CRLF lines and split UTF-8 with ordered, opaque events', { timeout: 5_000 }, async t => {
  const f = fixture(t, {}, 'partial');
  const { sessionId } = f.start();
  const output = eventsFor(f.manager, sessionId);
  f.manager.send(sessionId, 'prompt');
  assert.throws(() => f.manager.send(sessionId, 'overlap'), { code: 'turn_active', status: 409 });
  const finished = await output.wait('turn_finished');
  assert.equal(finished.status, 'success');
  assert.equal(finished.costUsd, 0.01);
  assert.deepEqual(output.events.map(event => event.type), ['session_started', 'message_done', 'turn_finished']);
  assert.equal(output.events[1].text, 'hello 🌍');
  assert.match(finished.turnId, uuid);
  assert.deepEqual(output.events.map(event => event.seq), [1, 2, 3]);
  assert.ok(output.events.every(event => event.sessionId === sessionId && event.turnId === finished.turnId));
  assert.ok(!JSON.stringify(output.events).includes(cliSessionId));
});

for (const decision of ['allow', 'deny']) {
  test(`round-trips a Claude approval and rejects duplicate responses (${decision})`, { timeout: 5_000 }, async t => {
    const f = fixture(t, {}, 'approval');
    const { sessionId } = f.start();
    const { sessionId: otherSession } = f.start();
    const output = eventsFor(f.manager, sessionId);
    f.manager.send(sessionId, 'prompt');
    const request = await output.wait('approval_request');
    assert.match(request.approvalId, uuid);
    assert.deepEqual(request.options, ['allow', 'deny']);
    assert.throws(() => f.manager.respond(otherSession, request.approvalId, decision), { code: 'unknown_approval' });
    f.manager.respond(sessionId, request.approvalId, decision);
    assert.throws(() => f.manager.respond(sessionId, request.approvalId, decision), { code: 'unknown_approval' });
    const acknowledged = await output.wait('approval_decision');
    assert.equal(acknowledged.approvalId, request.approvalId);
    assert.equal(acknowledged.decision, decision);
    assert.equal((await output.wait('message_done')).text, decision);
    assert.equal((await output.wait('turn_finished')).status, 'success');
  });
}

test('stop sends TERM then KILL, completes once, and holds capacity until close', { timeout: 5_000 }, async t => {
  const f = fixture(t, { maxSessions: 1 }, 'hold');
  const { sessionId } = f.start();
  const output = eventsFor(f.manager, sessionId);
  await output.wait('session_started');
  f.manager.send(sessionId, 'prompt');
  const term = once(f.launches[0].child.stderr, 'data');
  f.manager.stop(sessionId);
  f.manager.stop(sessionId);
  assert.throws(() => f.start(), { code: 'max_sessions' });
  assert.equal(String((await term)[0]), 'TERM received\n');
  assert.deepEqual(await f.launches[0].closed, [null, 'SIGKILL']);
  assert.equal((await output.wait('turn_finished')).status, 'cancelled');
  assert.equal(output.events.filter(event => event.type === 'turn_finished').length, 1);
  assert.deepEqual(f.manager.list(), []);
  assert.match(f.start().sessionId, uuid);
});

test('maxSessions limits open child processes and permits a start after close', async t => {
  const f = fixture(t, { maxSessions: 1 });
  const { sessionId } = f.start();
  assert.throws(() => f.start(), { code: 'max_sessions', status: 409 });
  f.manager.send(sessionId, 'prompt');
  await f.launches[0].closed;
  assert.match(f.start().sessionId, uuid);
});

test('reports spawn failure without exposing the executable path and releases capacity', async t => {
  const f = fixture(t, { maxSessions: 1 }, 'spawn-failure');
  const { sessionId } = f.start();
  const output = eventsFor(f.manager, sessionId);
  await f.launches[0].closed;
  assert.deepEqual(output.events.map(event => event.type), ['error', 'turn_finished']);
  assert.equal(output.events[0].code, 'spawn_failed');
  assert.equal(output.events[1].status, 'error');
  assert.ok(!JSON.stringify(output.events).includes('missing-agent'));
  assert.match(f.start().sessionId, uuid);
});

test('automatically reaps idle processes using the injected clock', { timeout: 5_000 }, async t => {
  let clock = 10;
  const f = fixture(t, { now: () => clock, idleMs: 30 });
  const { sessionId } = f.start();
  const output = eventsFor(f.manager, sessionId);
  clock += 30;
  assert.equal((await output.wait('turn_finished')).status, 'cancelled');
  await f.launches[0].closed;
  assert.deepEqual(f.manager.list(), []);
});

test('Codex rejects approvals, closes stdin after the prompt, and keeps the workspace session ID', { timeout: 5_000 }, async t => {
  const f = fixture(t);
  const { sessionId } = f.start({ agent: 'codex' });
  const output = eventsFor(f.manager, sessionId);
  assert.throws(() => f.manager.respond(sessionId, 'unused', 'deny'), { code: 'approvals_unsupported' });
  assert.throws(() => f.start({ agent: 'codex', resumeSessionId: sessionId }), { code: 'resume_not_verified' });
  assert.deepEqual(f.launches[0].args, ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only']);
  f.manager.send(sessionId, 'exact\nprompt');
  const finished = await output.wait('turn_finished');
  assert.deepEqual(finished.usage, { input_tokens: 3 });
  assert.equal(output.events.find(event => event.type === 'message_done').text, 'exact\nprompt');
  assert.ok(output.events.every(event => event.sessionId === sessionId));
});

test('retains Claude resume IDs server-side and replays only events after the supplied cursor', async t => {
  const f = fixture(t);
  const { sessionId } = f.start();
  const output = eventsFor(f.manager, sessionId);
  f.manager.send(sessionId, 'first');
  await f.launches[0].closed;
  assert.throws(() => f.start({ resumeSessionId: cliSessionId }), { code: 'resume_unavailable' });
  assert.deepEqual(f.start({ resumeSessionId: sessionId }), { sessionId });
  const args = f.launches[1].args;
  assert.equal(args[args.indexOf('--resume') + 1], cliSessionId);
  f.manager.send(sessionId, 'second');
  await f.launches[1].closed;
  const replay = [];
  f.manager.onEvent(sessionId, event => replay.push(event), 3)();
  assert.deepEqual(replay.map(event => event.seq), [4, 5]);
  assert.equal(replay[0].text, 'second');
  assert.notEqual(replay[0].turnId, output.events[0].turnId);
  assert.ok(!JSON.stringify(replay).includes(cliSessionId));
});

test('stops on an oversized stdout frame', { timeout: 5_000 }, async t => {
  const f = fixture(t, {}, 'oversized');
  const { sessionId } = f.start();
  const output = eventsFor(f.manager, sessionId);
  f.manager.send(sessionId, 'prompt');
  assert.equal((await output.wait('error')).code, 'stdout_limit');
  assert.equal((await output.wait('turn_finished')).status, 'error');
});

test('does not expose large stderr diagnostics on unexpected process exit', { timeout: 5_000 }, async t => {
  const f = fixture(t, {}, 'stderr');
  const { sessionId } = f.start();
  const output = eventsFor(f.manager, sessionId);
  f.manager.send(sessionId, 'prompt');
  assert.equal((await output.wait('error')).code, 'unexpected_exit');
  assert.equal((await output.wait('turn_finished')).status, 'error');
  assert.ok(!JSON.stringify(output.events).includes('fake-token-do-not-expose'));
});
