'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadProjectRoots } = require('../workspace/project-roots');
const { createSessionManager, loadModelOptions } = require('../workspace/session-manager');

const cliPath = path.join(__dirname, 'fixtures', 'fake-cli.js');
const cliSessionId = 'c6cecb23-d965-4b2a-a68c-f975304021a2';
const codexThreadId = '2ef9cb3e-e900-4acb-aef2-9d1c945935ad';
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const historyEntry = { agent: 'claude', rootId: 'projects', relPath: 'project', cliSessionId };
const claudeDefault = { model: 'claude-sonnet-5-5', effort: 'medium' };
const codexDefault = { model: 'gpt-6.2-sol', effort: 'medium' };
const fakeCodex = `
  const [threadId] = process.argv.slice(1);
  const write = record => console.log(JSON.stringify(record));
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { prompt += chunk; });
  process.stdin.on('end', () => {
    write({ type: 'thread.started', thread_id: threadId });
    write({ type: 'item.completed', item: { type: 'agent_message', id: 'message-1', text: prompt } });
    write({ type: 'turn.completed', usage: { input_tokens: 3 } });
  });
`;

function fixture(t, { persistHistory, ...options } = {}, mode = 'echo') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-manager-'));
  const root = path.join(base, 'root');
  const otherRoot = path.join(base, 'other-root');
  const project = path.join(root, 'project');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(otherRoot, 'project'), { recursive: true });
  fs.mkdirSync(outside);
  const launches = [];
  const managerOptions = {
    roots: loadProjectRoots({ roots: [
      { id: 'projects', label: 'Projects', path: root },
      { id: 'other', label: 'Other', path: otherRoot },
    ] }),
    killGraceMs: 100,
    spawnFn(command, args, spawnOptions) {
      const executable = mode === 'spawn-failure' ? path.join(base, 'missing-agent') : process.execPath;
      const cliArgs = command === 'codex' ? ['-e', fakeCodex, codexThreadId] : [cliPath, command, mode];
      const child = spawn(executable, cliArgs, spawnOptions);
      const closed = new Promise(resolve => child.once('close', (...args) => resolve(args)));
      launches.push({ command, args, options: spawnOptions, child, closed });
      return child;
    },
    ...options,
  };
  const managers = [];
  function openManager(historyFile) {
    const manager = createSessionManager({ ...managerOptions, historyFile });
    managers.push(manager);
    return manager;
  }
  const historyFile = path.join(base, 'history.json');
  const manager = openManager(persistHistory ? historyFile : undefined);
  t.after(async () => {
    for (const manager of managers) {
      for (const { sessionId } of manager.list()) manager.stop(sessionId);
    }
    try {
      await Promise.all(launches.map(launch => launch.closed));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
  const start = overrides => manager.start({ rootId: 'projects', relPath: 'project', agent: 'claude', ...overrides });
  return { manager, root, project, outside, launches, start, historyFile, openManager };
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
  assert.deepEqual(f.manager.list(), [{
    sessionId, agent: 'claude', rootId: 'projects', relPath: 'project', cliSessionId: null, status: 'active',
    ...claudeDefault,
  }]);
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
  assert.equal(output.events[0].cliSessionId, cliSessionId);
});

for (const decision of ['allow', 'deny']) {
  test(`round-trips a Claude approval and rejects duplicate responses (${decision})`, { timeout: 5_000 }, async t => {
    const f = fixture(t, {}, 'approval');
    const { sessionId } = f.start();
    const { sessionId: otherSession } = f.start();
    const output = eventsFor(f.manager, sessionId);
    f.manager.send(sessionId, 'prompt');
    const request = await output.wait('approval_request');
    const write = t.mock.method(f.launches[0].child.stdin, 'write');
    assert.match(request.approvalId, uuid);
    assert.deepEqual(request.options, ['allow', 'deny']);
    assert.throws(() => f.manager.respond(otherSession, request.approvalId, decision), { code: 'unknown_approval' });
    f.manager.respond(sessionId, request.approvalId, decision);
    if (decision === 'deny') {
      const [payload] = write.mock.calls[0].arguments;
      assert.equal(JSON.parse(payload).response.response.message, 'The user denied this action.');
    }
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
  const discarded = [];
  const f = fixture(t, { now: () => clock, idleMs: 30, onDiscard: id => discarded.push(id) });
  const { sessionId } = f.start();
  const output = eventsFor(f.manager, sessionId);
  clock += 30;
  assert.equal((await output.wait('turn_finished')).status, 'cancelled');
  await f.launches[0].closed;
  assert.deepEqual(f.manager.list(), []);
  assert.deepEqual(discarded, [sessionId]);
});

test('Codex rejects approvals, closes stdin after the prompt, and keeps the workspace session ID', { timeout: 5_000 }, async t => {
  const f = fixture(t);
  const { sessionId } = f.start({ agent: 'codex' });
  const output = eventsFor(f.manager, sessionId);
  assert.throws(() => f.manager.respond(sessionId, 'unused', 'deny'), { code: 'approvals_unsupported' });
  assert.throws(() => f.start({ agent: 'codex', resumeSessionId: sessionId }), { code: 'resume_unavailable' });
  assert.deepEqual(f.launches[0].args, ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only',
    '-m', codexDefault.model, '-c', 'model_reasoning_effort="medium"']);
  f.manager.send(sessionId, 'exact\nprompt');
  const finished = await output.wait('turn_finished');
  assert.deepEqual(finished.usage, { input_tokens: 3 });
  assert.equal(output.events.find(event => event.type === 'message_done').text, 'exact\nprompt');
  assert.ok(output.events.every(event => event.sessionId === sessionId));
  assert.equal(output.events[0].cliSessionId, codexThreadId);
  assert.equal(f.manager.list()[0].cliSessionId, codexThreadId);
});

test('resumes Codex turns in the same project and restores the thread from history', { timeout: 5_000 }, async t => {
  const f = fixture(t, { persistHistory: true, now: () => 100 });
  const project = { agent: 'codex', rootId: 'projects', relPath: 'project' };
  const resume = { ...project, resumeSessionId: codexThreadId };
  const { sessionId } = f.start(project);
  f.manager.send(sessionId, 'first prompt');
  await f.launches[0].closed;
  const entry = { ...project, ...codexDefault, cliSessionId: codexThreadId, lastUsedAt: 100 };
  assert.deepEqual(JSON.parse(fs.readFileSync(f.historyFile, 'utf8')), [entry]);

  for (const overrides of [
    { rootId: 'other' }, { relPath: '.' }, { agent: 'claude' },
    { resumeSessionId: sessionId }, { resumeSessionId: 'not-a-uuid' }, { resumeSessionId: cliSessionId },
  ]) {
    assert.throws(() => f.start({ ...resume, ...overrides }), { code: 'resume_unavailable' });
  }
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.start(resume), { sessionId });
  assert.throws(() => f.start(resume), { code: 'turn_active' });
  const resumeArgs = ['exec', 'resume', '--json', '--skip-git-repo-check',
    '-c', 'sandbox_mode="read-only"', '-m', codexDefault.model, '-c', 'model_reasoning_effort="medium"', codexThreadId, '-'];
  assert.deepEqual(f.launches[1].args, resumeArgs);
  f.manager.send(sessionId, 'explicit resume');
  await f.launches[1].closed;

  const followUp = eventsFor(f.manager, sessionId);
  f.manager.send(sessionId, 'automatic resume');
  await f.launches[2].closed;
  assert.deepEqual(f.launches[2].args, resumeArgs);
  assert.deepEqual(followUp.events.filter(event => event.type === 'message_done').map(event => event.text), [
    'first prompt', 'explicit resume', 'automatic resume',
  ]);
  assert.equal(followUp.events.filter(event => event.type === 'session_started').length, 1);
  f.manager.stop(sessionId);

  const restarted = f.openManager(f.historyFile);
  assert.deepEqual(restarted.listHistory('codex'), [entry]);
  assert.throws(() => restarted.start({ ...resume, rootId: 'other' }), { code: 'resume_unavailable' });
  assert.throws(() => restarted.start({ ...resume, relPath: '.' }), { code: 'resume_unavailable' });
  const resumed = restarted.start(resume);
  assert.notEqual(resumed.sessionId, sessionId);
  assert.deepEqual(f.launches[3].args, resumeArgs);
  assert.equal(f.launches[3].options.cwd, fs.realpathSync(f.project));
  restarted.send(resumed.sessionId, 'resumed after restart');
  const output = eventsFor(restarted, resumed.sessionId);
  assert.equal((await output.wait('session_started')).cliSessionId, codexThreadId);
  assert.equal((await output.wait('turn_finished')).status, 'success');
});

test('validates model catalogs and applies server defaults for custom models', t => {
  const claude = {
    default: 'example-model', defaultEffort: 'medium',
    list: [{ id: 'example-model', label: 'Example' }, { id: 'high-only', label: 'High Only', efforts: ['high'] }],
  };
  const codex = { default: 'gpt-6-luna', defaultEffort: 'medium', list: [{ id: 'gpt-6-luna', label: 'Luna' }] };
  for (const config of [
    null, [], { other: claude }, { claude: null }, { claude: { ...claude, extra: true } },
    { claude: { ...claude, default: 'missing' } }, { claude: { ...claude, defaultEffort: null } },
    { claude: { ...claude, list: [] } }, { claude: { ...claude, list: [...claude.list, claude.list[0]] } },
    { codex: { ...codex, list: [{ ...codex.list[0], efforts: ['medium', 'ultra'] }] } },
    ...[
      { id: 42 }, { id: 'example-model\n' }, { id: 'model/name' }, { label: '   ' }, { efforts: null },
      { efforts: [] }, { efforts: ['high'] }, { efforts: ['medium', 'ultra'] }, { efforts: ['medium', 'medium'] },
    ].map(fields => ({ claude: { ...claude, list: [{ ...claude.list[0], ...fields }] } })),
  ]) {
    assert.throws(() => loadModelOptions(config), { code: 'invalid_models_config' });
  }

  const agents = loadModelOptions({ claude });
  const f = fixture(t, { agents });
  f.start();
  f.start({ model: 'high-only' });
  assert.deepEqual(f.manager.list().map(({ model, effort }) => ({ model, effort })), [
    { model: 'example-model', effort: 'medium' }, { model: 'high-only', effort: 'high' },
  ]);
  assert.equal(agents.codex.default, codexDefault.model);
  assert.deepEqual(loadModelOptions({ codex }).codex.models[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.throws(() => f.start({ model: 'claude-sonnet-5-5' }), { code: 'invalid_model' });
  assert.throws(() => f.start({ model: 'high-only', effort: 'medium' }), { code: 'invalid_effort' });
  assert.equal(f.launches.length, 2);
});

test('resumes an idle conversation with a new workspace session when the selection changes', async t => {
  const f = fixture(t, { persistHistory: true });
  const { sessionId } = f.start();
  f.manager.send(sessionId, 'first');
  await f.launches[0].closed;

  const choice = { model: 'claude-opus-5-5', effort: 'xhigh' };
  const resumed = f.start({ resumeSessionId: sessionId, ...choice });
  assert.notEqual(resumed.sessionId, sessionId);
  assert.throws(() => f.manager.send(sessionId, 'old session'), { code: 'unknown_session' });
  assert.deepEqual(f.launches[1].args.slice(-10, -4), ['--resume', cliSessionId,
    '--model', choice.model, '--effort', choice.effort]);
  assert.throws(() => f.start({ resumeSessionId: cliSessionId }), { code: 'turn_active' });
  f.manager.send(resumed.sessionId, 'second');
  await f.launches[1].closed;
  assert.deepEqual(f.manager.listHistory().map(({ model, effort }) => ({ model, effort })), [choice]);

  f.manager.send(resumed.sessionId, 'automatic resume');
  await f.launches[2].closed;
  assert.deepEqual(f.launches[2].args, f.launches[1].args);
});

test('resumes Claude by CLI UUID and replays only events after the supplied cursor', async t => {
  const f = fixture(t);
  const { sessionId } = f.start();
  const output = eventsFor(f.manager, sessionId);
  f.manager.send(sessionId, 'first');
  await f.launches[0].closed;
  assert.deepEqual(f.manager.list(), [{
    sessionId, agent: 'claude', rootId: 'projects', relPath: 'project', cliSessionId, status: 'idle',
    ...claudeDefault,
  }]);
  assert.throws(() => f.start({ resumeSessionId: '--help' }), { code: 'resume_unavailable' });
  assert.throws(() => f.start({ resumeSessionId: '8686f84d-d1dd-4ed4-907e-4a431771cb3e' }), {
    code: 'resume_unavailable',
  });
  assert.throws(() => f.start({ resumeSessionId: cliSessionId, relPath: '.' }), { code: 'resume_unavailable' });
  assert.deepEqual(f.start({ resumeSessionId: cliSessionId }), { sessionId });
  assert.throws(() => f.start({ resumeSessionId: cliSessionId }), { code: 'turn_active' });
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
  assert.deepEqual(f.start({ resumeSessionId: sessionId }), { sessionId });
});

test('persists only private session metadata and resumes Claude after Stop and manager restart', { timeout: 5_000 }, async t => {
  let clock = 100;
  const f = fixture(t, { persistHistory: true, now: () => clock });
  const { sessionId } = f.start();
  const first = eventsFor(f.manager, sessionId);
  await first.wait('session_started');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.historyFile)), [{ ...historyEntry, ...claudeDefault, lastUsedAt: 100 }]);
  assert.equal(fs.statSync(f.historyFile).mode & 0o777, 0o600);

  clock = 200;
  f.manager.stop(sessionId);
  await f.launches[0].closed;
  assert.deepEqual(f.manager.list(), []);
  assert.deepEqual(f.manager.listHistory(), [{ ...historyEntry, ...claudeDefault, lastUsedAt: 200 }]);
  assert.throws(() => f.start({ resumeSessionId: cliSessionId, relPath: '.' }), { code: 'resume_unavailable' });
  const resumed = f.start({ resumeSessionId: cliSessionId });
  assert.notEqual(resumed.sessionId, sessionId);
  const resumeArgs = f.launches[1].args;
  assert.equal(resumeArgs[resumeArgs.indexOf('--resume') + 1], cliSessionId);
  await eventsFor(f.manager, resumed.sessionId).wait('session_started');
  clock = 300;
  f.manager.send(resumed.sessionId, 'do not persist this prompt');
  await f.launches[1].closed;

  const restarted = f.openManager(f.historyFile);
  assert.deepEqual(restarted.listHistory(), [{ ...historyEntry, ...claudeDefault, lastUsedAt: 300 }]);
  assert.throws(() => restarted.start({ ...historyEntry, relPath: '.', resumeSessionId: cliSessionId }), {
    code: 'resume_unavailable',
  });
  assert.throws(() => restarted.start({ ...historyEntry, agent: 'codex', resumeSessionId: cliSessionId }), {
    code: 'resume_unavailable',
  });
  const afterRestart = restarted.start({ ...historyEntry, resumeSessionId: cliSessionId });
  assert.notEqual(afterRestart.sessionId, resumed.sessionId);
  const { args } = f.launches[2];
  assert.equal(args[args.indexOf('--resume') + 1], cliSessionId);
});

test('ignores invalid history files and malformed entries', t => {
  const f = fixture(t);
  for (const contents of ['{', '{}']) {
    fs.writeFileSync(f.historyFile, contents);
    assert.deepEqual(f.openManager(f.historyFile).listHistory(), []);
  }
  const valid = { ...historyEntry, lastUsedAt: 10 };
  const malformed = [
    null, [],
    { ...valid, relPath: f.project },
    { ...valid, relPath: '../outside' },
    { ...valid, cliSessionId: '--help' },
    { ...valid, agent: 'codex', cliSessionId: 'private-codex-thread' },
    { ...valid, rootId: '/private' },
    { ...valid, agent: 'unknown' },
    { ...valid, lastUsedAt: '20' },
    { ...valid, lastUsedAt: -1 },
    { ...valid, model: 'valid-id' },
    { ...valid, model: 'bad id', effort: 'high' },
    { ...valid, model: 'valid-id', effort: 'ultra' },
    { ...valid, env: {} },
  ];
  fs.writeFileSync(f.historyFile, JSON.stringify([...malformed, valid]));
  assert.deepEqual(f.openManager(f.historyFile).listHistory(), [valid]);
});

test('loads and writes at most 200 distinct history entries, newest first', async t => {
  const f = fixture(t, { now: () => 1000 });
  const seed = Array.from({ length: 202 }, (_, index) => ({
    ...historyEntry, cliSessionId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, lastUsedAt: index,
  }));
  const newest = { ...seed.at(-1), lastUsedAt: 500 };
  fs.writeFileSync(f.historyFile, JSON.stringify([...seed, newest]));
  const manager = f.openManager(f.historyFile);
  assert.deepEqual(manager.listHistory(), [newest, ...seed.slice(2, -1).reverse()]);

  const { sessionId } = manager.start(historyEntry);
  await eventsFor(manager, sessionId).wait('session_started');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.historyFile)), [
    { ...historyEntry, ...claudeDefault, lastUsedAt: 1000 }, newest, ...seed.slice(3, -1).reverse(),
  ]);
});

test('does not write through a symlinked history parent', async t => {
  const f = fixture(t);
  const linkedParent = f.historyFile + '.link';
  fs.symlinkSync(f.outside, linkedParent, 'dir');
  const manager = f.openManager(path.join(linkedParent, 'history.json'));
  const { sessionId } = manager.start(historyEntry);
  await eventsFor(manager, sessionId).wait('session_started');
  assert.equal(manager.listHistory().length, 1);
  assert.deepEqual(fs.readdirSync(f.outside), []);
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
