'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createWorkspace } = require('../workspace');

const serverPath = path.join(__dirname, '../ui/server.js');
const source = fs.readFileSync(serverPath, 'utf8');
const dist = path.join(__dirname, '../workspace-ui/dist');
const fakeCli = path.join(__dirname, 'fixtures/fake-cli.js');
const codexThreadId = '2ef9cb3e-e900-4acb-aef2-9d1c945935ad';
const fakeCodex = `
  const [threadId, ...args] = process.argv.slice(1);
  if (args[1] === 'resume' && (args.at(-2) !== threadId || args.at(-1) !== '-')) process.exit(1);
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { prompt += chunk; });
  process.stdin.on('end', () => {
    for (const record of [
      { type: 'thread.started', thread_id: threadId },
      { type: 'item.completed', item: { type: 'agent_message', id: 'message-1', text: prompt } },
      { type: 'turn.completed', usage: { input_tokens: 3 } },
    ]) console.log(JSON.stringify(record));
  });
`;

async function fixture(t, enabled, { gitRunner, invalidConfig = false, customHistory = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-workspace-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  const project = fs.realpathSync(directory);
  const cwd = path.join(project, 'roots', 'repo');
  const codexHome = path.join(project, 'codex');
  const workspacesRoot = path.join(project, 'managed');
  const historyFile = customHistory ? path.join(project, 'sessions.json') : path.join(workspacesRoot, '.session-history.json');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(project, 'roots', 'ignored.txt'), '');
  fs.writeFileSync(configPath, invalidConfig ? 'private fixture config text' : JSON.stringify({
    roots: [{ id: 'development', label: 'Development', path: path.dirname(cwd) }],
    workspacesRoot,
    ...(customHistory && { historyFile }),
    claude: { model: 'test-model' },
    codex: { home: codexHome },
    github: { repositories: ['example/allowed'] },
  }));

  const launches = [];
  const diagnostics = [];
  let workspaceLoads = 0;
  let handler, shutdown;
  const uiRequire = require('node:module').createRequire(serverPath);
  vm.runInNewContext(source, {
    __dirname: path.dirname(serverPath),
    console: { error: message => diagnostics.push(message) },
    process: {
      env: {
        TERMINAL_RUNTIME: directory,
        TERMINAL_TEST_HTTP: '1',
        ...(enabled && { WEB_TERMINAL_WORKSPACE_CONFIG: configPath }),
      },
      getuid: process.getuid,
      on(signal, listener) { if (signal === 'SIGTERM') shutdown = listener; },
    },
    require(name) {
      if (name === '../workspace') {
        workspaceLoads++;
        return {
          createWorkspace: options => createWorkspace({
            ...options, gitRunner,
            spawnFn(agent, args, options) {
              const cliArgs = agent === 'codex'
                ? ['-e', fakeCodex, '--', codexThreadId, ...args] : [fakeCli, agent];
              const child = spawn(process.execPath, cliArgs, options);
              launches.push({ agent, args, options, closed: new Promise(resolve => child.once('close', resolve)) });
              return child;
            },
          }),
        };
      }
      if (name === 'node:http') return { createServer(fn) {
        handler = fn;
        return { on() {}, listen() {}, close() {} };
      } };
      if (name === 'node:child_process') return {
        spawn() { assert.fail('The workspace must not start ttyd'); },
        execFileSync(command, args) {
          assert.equal(command, 'tmux');
          assert.equal(args[2], 'list-sessions');
          return '';
        },
      };
      return uiRequire(name);
    },
  }, { filename: serverPath });

  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    shutdown();
    return new Promise(resolve => server.close(resolve));
  });
  const request = (method, url, headers = {}, data) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, method, path: url,
      headers: { host: 'fixture.test', ...headers },
    }, res => {
      const chunks = [];
      res.on('data', chunk => {
        chunks.push(chunk);
        if (res.headers['content-type']?.startsWith('text/event-stream')) {
          const frames = Buffer.concat(chunks).toString('utf8').split('\n\n').slice(0, -1);
          const events = frames.map(frame => JSON.parse(frame.split('\ndata: ')[1]));
          if (events.some(event => event.type === 'turn_finished')) {
            resolve({ status: res.statusCode, events });
            req.destroy();
          }
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('Workspace request timed out')));
    req.on('error', reject);
    req.end(data === undefined ? undefined : JSON.stringify(data));
  });
  const mutationHeaders = async () => ({
    origin: 'http://fixture.test',
    'content-type': 'application/json',
    'x-terminal-request': JSON.parse((await request('GET', '/api/sessions')).body).token,
  });
  return { request, mutationHeaders, launches, cwd, codexHome, historyFile, workspaceLoads, diagnostics };
}

test('flag off keeps workspace routes inactive and skips loading the factory', async t => {
  const { request, workspaceLoads } = await fixture(t, false);
  assert.equal(workspaceLoads, 0);
  for (const url of ['/api/workspace/projects', '/workspace/', '/workspace/app.js', '/workspace/styles.css']) {
    const response = await request('GET', url);
    assert.equal(response.status, 404);
    assert.equal(response.body, '{"error":"Not found"}');
  }
});

test('flag on lists public project metadata and applies the existing mutation gate', async t => {
  const { request, mutationHeaders, workspaceLoads, launches } = await fixture(t, true);
  assert.equal(workspaceLoads, 1);
  const response = await request('GET', '/api/workspace/projects');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    projects: [{ id: 'development', label: 'Development', folders: ['repo'] }],
  });
  const headers = await mutationHeaders();
  const { 'x-terminal-request': token, ...noToken } = headers;
  assert.match(token, /^[a-f0-9]{64}$/);
  for (const invalidHeaders of [noToken, { ...headers, origin: 'http://other.test' }, { ...headers, 'content-type': 'text/plain' }]) {
    const result = await request('POST', '/api/workspace/sessions', invalidHeaders, {});
    assert.equal(result.status, 403);
  }
  assert.equal(launches.length, 0);
});

test('invalid workspace configuration leaves the terminal available and emits a generic diagnostic', async t => {
  const { request, diagnostics } = await fixture(t, true, { invalidConfig: true });
  assert.equal((await request('GET', '/')).status, 200);
  assert.equal((await request('GET', '/api/workspace/projects')).status, 404);
  assert.deepEqual(diagnostics, ['Workspace configuration unavailable']);
});

test('workspace serves only the three built assets with the existing file headers', async t => {
  const { request } = await fixture(t, true);
  for (const [url, file, contentType] of [
    ['/workspace/', 'index.html', 'text/html; charset=utf-8'],
    ['/workspace/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/workspace/styles.css', 'styles.css', 'text/css; charset=utf-8'],
  ]) {
    const asset = await request('GET', url);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['content-type'], contentType);
    assert.equal(asset.headers['cache-control'], 'no-store');
    assert.equal(asset.headers['x-content-type-options'], 'nosniff');
    assert.equal(asset.body, fs.readFileSync(path.join(dist, file), 'utf8'));
  }
  for (const url of ['/workspace/../app.js', '/workspace/%2e%2e/app.js', '/workspace/../ui/server.js', '/workspace/index.html']) {
    assert.equal((await request('GET', url)).status, 404);
  }
});

for (const agent of ['claude', 'codex']) {
  test(`workspace runs a fake ${agent} CLI with isolated options and streams sequenced events`, async t => {
    const { request, mutationHeaders, launches, cwd, codexHome, historyFile } = await fixture(t, true, {
      customHistory: agent === 'codex',
    });
    const headers = await mutationHeaders();
    const create = await request('POST', '/api/workspace/sessions', headers, {
      rootId: 'development', relPath: 'repo', agent,
    });
    assert.equal(create.status, 201);
    const { sessionId } = JSON.parse(create.body);
    const [{ args, options }] = launches;
    assert.equal(launches[0].agent, agent);
    assert.equal(options.cwd, cwd);
    assert.equal(options.shell, false);
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'SSH_AUTH_SOCK', 'WEB_TERMINAL_WORKSPACE_CONFIG']) {
      assert.equal(options.env[key], undefined);
    }
    if (agent === 'claude') {
      assert.deepEqual(args.slice(-6), ['--setting-sources', 'project', '--disable-slash-commands', '--strict-mcp-config', '--model', 'test-model']);
      assert.equal(options.env.CODEX_HOME, undefined);
    } else {
      assert.equal(options.env.CODEX_HOME, codexHome);
      assert.deepEqual(args, ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only']);
    }

    const url = `/api/workspace/sessions/${sessionId}`;
    assert.equal((await request('POST', `${url}/messages`, headers, { text: 'Hello workspace' })).status, 200);
    const stream = await request('GET', `${url}/events`);
    assert.equal(stream.status, 200);
    const { events } = stream;
    assert.equal(events[0].type, 'session_started');
    assert.ok(events.some(event => event.type === 'message_done' && event.text === 'Hello workspace'));
    assert.equal(events.at(-1).type, 'turn_finished');
    assert.equal(events.at(-1).status, 'success');
    const history = await request('GET', `/api/workspace/history?agent=${agent}`);
    assert.equal(history.status, 200);
    const { entries } = JSON.parse(history.body);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], {
      agent, rootId: 'development', relPath: 'repo', cliSessionId: events[0].cliSessionId,
      lastUsedAt: entries[0].lastUsedAt,
    });
    assert.ok(Number.isSafeInteger(entries[0].lastUsedAt));
    assert.deepEqual(JSON.parse(fs.readFileSync(historyFile, 'utf8')), entries);
    for (const [index, event] of events.entries()) {
      assert.equal(event.seq, index + 1);
      assert.equal(event.sessionId, sessionId);
      assert.equal(event.turnId, events[0].turnId);
      assert.ok(event.turnId);
    }
    await launches[0].closed;
    assert.equal((await request('POST', `${url}/stop`, headers)).status, 200);
    const resumeInput = { rootId: 'development', relPath: 'repo', agent, resumeSessionId: entries[0].cliSessionId };
    const rejected = await request('POST', '/api/workspace/sessions', headers, { ...resumeInput, relPath: '.' });
    assert.equal(rejected.status, 409);
    assert.deepEqual(JSON.parse(rejected.body), { error: 'resume_unavailable' });
    assert.equal(launches.length, 1);
    const resumed = await request('POST', '/api/workspace/sessions', headers, resumeInput);
    assert.equal(resumed.status, 201);
    const resumedId = JSON.parse(resumed.body).sessionId;
    assert.notEqual(resumedId, sessionId);
    const { args: resumeArgs, options: resumeOptions } = launches[1];
    assert.equal(resumeOptions.cwd, cwd);
    if (agent === 'claude') {
      assert.equal(resumeArgs[resumeArgs.indexOf('--resume') + 1], entries[0].cliSessionId);
    } else {
      assert.equal(resumeOptions.env.CODEX_HOME, codexHome);
      assert.deepEqual(resumeArgs, ['exec', 'resume', '--json', '--skip-git-repo-check',
        '-c', 'sandbox_mode="read-only"', codexThreadId, '-']);
      const resumedUrl = `/api/workspace/sessions/${resumedId}`;
      const prompt = 'Resume workspace\nwith stdin';
      assert.equal((await request('POST', `${resumedUrl}/messages`, headers, { text: prompt })).status, 200);
      const resumedStream = await request('GET', `${resumedUrl}/events`);
      assert.equal(resumedStream.status, 200);
      assert.equal(resumedStream.events[0].cliSessionId, codexThreadId);
      assert.equal(resumedStream.events.find(event => event.type === 'message_done').text, prompt);
      assert.equal(resumedStream.events.at(-1).status, 'success');
    }
  });
}

test('only allowlisted GitHub references are provisioned under the hidden managed root', async t => {
  const gitCalls = [];
  const { request, mutationHeaders, launches } = await fixture(t, true, {
    async gitRunner(command, args) {
      gitCalls.push({ command, args });
      return { code: 0 };
    },
  });
  const headers = await mutationHeaders();
  const endpoint = '/api/workspace/sessions';
  const denied = await request('POST', endpoint, headers, { github: 'example/denied', agent: 'claude' });
  assert.equal(denied.status, 403);
  assert.equal(gitCalls.length, 0);
  const allowed = await request('POST', endpoint, headers, { github: 'example/allowed', agent: 'claude' });
  assert.equal(allowed.status, 201);
  assert.equal(gitCalls.length, 1);
  const [{ command, args }] = gitCalls;
  assert.equal(command, 'git');
  assert.deepEqual(args.slice(0, -1), ['clone', '--depth', '1', '--', 'https://github.com/example/allowed.git']);
  assert.equal(launches[0].options.cwd, args.at(-1));
  const escape = await request('POST', endpoint, headers, {
    rootId: 'managed-github', relPath: `example/allowed/${path.basename(args.at(-1))}`, agent: 'claude',
  });
  assert.equal(escape.status, 400);
  assert.deepEqual(JSON.parse(escape.body), { error: 'unknown_root' });
});
