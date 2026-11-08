'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../ui/server.js'), 'utf8');
const format = '#{session_name}|#{pane_current_command}';

function fixture() {
  const runtime = '/isolated/session-metadata-test';
  const calls = [], logs = [];
  let handler, now = 0, listing = 'shared|/usr/bin/sh\n', failure = null, mutationResult = '';
  const filesystem = {
    constants: fs.constants,
    realpathSync: filename => filename,
    statSync: () => ({ isDirectory: () => true }),
    accessSync() {},
    mkdirSync() {},
    chmodSync() {},
    lstatSync(filename) {
      if (filename === runtime) return { isDirectory: () => true, isSymbolicLink: () => false, uid: 1000, mode: 0o40700 };
      assert.equal(filename, path.join(runtime, 'ui.sock'));
      throw Object.assign(new Error('Fixture socket absent'), { code: 'ENOENT' });
    },
  };
  const capture = (...args) => logs.push(args.join(' '));
  const context = vm.createContext({
    __dirname: path.join(__dirname, '../ui'),
    Buffer, Date: { now: () => now },
    console: { log: capture, error: capture, warn: capture },
    process: {
      env: { TERMINAL_RUNTIME: runtime, TERMINAL_TMUX_SOCKET: 'isolated-metadata-fixture', TERMINAL_TEST_HTTP: '1' },
      getuid: () => 1000, on() {}, stdout: { write: capture }, stderr: { write: capture },
    },
    require(name) {
      if (name === 'node:fs') return filesystem;
      if (name === 'node:http') return { createServer(callback) {
        handler = callback;
        return { on() {}, listen(_socket, ready) { ready(); }, close() {} };
      } };
      if (name === 'node:child_process') return {
        spawn() { assert.fail('metadata must not start ttyd or any child process'); },
        execFileSync(command, args, options) {
          assert.equal(command, 'tmux');
          assert.deepEqual(Array.from(args.slice(0, 2)), ['-L', 'isolated-metadata-fixture']);
          assert.equal(options.encoding, 'utf8');
          assert.deepEqual(Array.from(options.stdio), ['ignore', 'pipe', 'pipe'], 'tmux stderr must remain captured');
          const operation = Array.from(args.slice(2));
          calls.push(operation);
          if (operation[0] === 'list-sessions') {
            assert.deepEqual(operation, ['list-sessions', '-F', format]);
            if (failure) throw failure;
            return listing;
          }
          assert.ok(['new-session', 'if-shell'].includes(operation[0]), 'no per-session metadata subprocess is allowed');
          return mutationResult;
        },
      };
      if (name === './image-receipts') return require('../ui/image-receipts');
      assert.ok(['node:net', 'node:path', 'node:crypto', 'node:os'].includes(name), `unexpected require: ${name}`);
      return require(name);
    },
  });
  vm.runInContext(source, context, { filename: 'server.js' });
  return {
    calls, logs,
    advance(ms) { now += ms; },
    listing(value) { listing = value; },
    failure(value) { failure = value; },
    mutationResult(value) { mutationResult = value; },
    // Exercise the existing names-only consumer without adding production exports.
    names() { return Array.from(vm.runInContext('sessions()', context)); },
    async request(method = 'GET', url = '/api/sessions', headers = {}) {
      const response = { status: null, body: null, headers: null };
      await handler({ method, url, headers: { host: 'fixture.test', ...headers } }, {
        writeHead(status, values) { response.status = status; response.headers = values; },
        end(body) { response.body = String(body); },
      });
      return response;
    },
  };
}

function serviceError(stderr) {
  return Object.assign(new Error(`Command failed: tmux\n${stderr}`), { status: 1, stderr });
}

function mutationHeaders(token) {
  return { origin: 'http://fixture.test', 'content-type': 'application/json', 'x-terminal-request': token };
}

test('one tmux metadata call builds sorted, filtered, sanitized details and caches the response for at most one second', async () => {
  const server = fixture();
  server.listing([
    'web-bbbbbbbbbbbb|/private/dir with spaces/Codex<script>+._- \u001b[31m',
    'unrelated|must-not-leak',
    'shared|/usr/bin/bash',
    'web-aaaaaaaaaaaa|/private/abcdefghijklmnopqrstuvwxyz0123456789',
    'web-cccccccccccc|',
    'web-ABCDEFabcdef|invalid-uppercase-session',
    'shared-extra|invalid-prefix',
    'malformed-row',
  ].join('\n'));
  const first = await server.request();
  assert.equal(first.status, 200);
  const body = JSON.parse(first.body);
  assert.deepEqual(Object.keys(body), ['sessions', 'details', 'token']);
  assert.deepEqual(body.sessions, ['shared', 'web-aaaaaaaaaaaa', 'web-bbbbbbbbbbbb', 'web-cccccccccccc']);
  assert.deepEqual(Object.keys(body.details), body.sessions);
  assert.deepEqual(body.details, {
    shared: { command: 'bash' },
    'web-aaaaaaaaaaaa': { command: 'abcdefghijklmnopqrstuvwx' },
    'web-bbbbbbbbbbbb': { command: 'Codexscript+._-31m' },
    'web-cccccccccccc': { command: '' },
  });
  assert.match(body.token, /^[a-f0-9]{64}$/);
  assert.equal(server.calls.length, 1, 'all session details must use one list-sessions call');
  assert.deepEqual(server.names(), body.sessions, 'sessions() preserves its names-only API and shares the cache');
  server.listing('shared|/usr/bin/sleep\n');
  server.advance(999);
  assert.equal((await server.request()).body, first.body, 'names, details, and token remain stable within the cache lifetime');
  assert.equal(server.calls.length, 1);
  server.advance(1);
  const refreshed = await server.request();
  assert.deepEqual(JSON.parse(refreshed.body), { sessions: ['shared'], details: { shared: { command: 'sleep' } }, token: body.token });
  assert.equal(server.calls.length, 2, 'the cache expires at one second, not two');
  assert.deepEqual(server.logs, []);
});

test('successful create and close invalidate cached metadata immediately', async () => {
  const server = fixture();
  const { token } = JSON.parse((await server.request()).body);
  const headers = mutationHeaders(token);
  const created = await server.request('POST', '/api/sessions', headers);
  assert.equal(created.status, 201);
  const { name } = JSON.parse(created.body);
  assert.match(name, /^web-[a-f0-9]{12}$/);
  assert.deepEqual(server.calls.map(call => call[0]), ['list-sessions', 'new-session'], 'create reuses the cached names for the session limit');
  server.listing(`shared|sh\n${name}|bash\n`);
  assert.deepEqual(JSON.parse((await server.request()).body).sessions, ['shared', name]);
  assert.equal(server.calls.filter(call => call[0] === 'list-sessions').length, 2);

  const closed = await server.request('POST', `/api/sessions/${name}/close`, {
    ...headers, 'x-terminal-session-id': '$1', 'x-terminal-server-pid': '123',
  });
  assert.equal(closed.status, 200);
  server.listing('shared|sh\n');
  assert.deepEqual(JSON.parse((await server.request()).body).sessions, ['shared']);
  assert.equal(server.calls.filter(call => call[0] === 'list-sessions').length, 3);
  assert.deepEqual(server.logs, []);
});

test('rejected mutations do not discard a valid metadata cache', async () => {
  const server = fixture();
  const initial = await server.request();
  const headers = mutationHeaders(JSON.parse(initial.body).token);
  assert.equal((await server.request('POST', '/api/sessions', { ...headers, origin: 'http://other.test' })).status, 403);
  server.mutationResult('STALE');
  assert.equal((await server.request('POST', '/api/sessions/shared/close', {
    ...headers, 'x-terminal-session-id': '$1', 'x-terminal-server-pid': '123',
  })).status, 409);
  assert.equal((await server.request()).body, initial.body);
  assert.equal(server.calls.filter(call => call[0] === 'list-sessions').length, 1);
});

test('only no-server and no-sessions tmux failures produce an empty successful list', async t => {
  for (const stderr of ['no server running\n', 'no server running on /isolated/tmux-socket\n', 'error connecting to /isolated/tmux-socket (No such file or directory)\n', Buffer.from('no sessions\n')]) {
    await t.test(String(stderr).trim(), async () => {
      const server = fixture();
      server.failure(serviceError(stderr));
      const response = await server.request();
      assert.equal(response.status, 200);
      const body = JSON.parse(response.body);
      assert.deepEqual(body.sessions, []);
      assert.deepEqual(body.details, {});
      assert.match(body.token, /^[a-f0-9]{64}$/);
      assert.deepEqual(server.names(), []);
      assert.equal(server.calls.length, 1, 'empty metadata is cached too');
      assert.deepEqual(server.logs, []);
      server.failure(null);
      server.advance(1000);
      assert.deepEqual(JSON.parse((await server.request()).body).sessions, ['shared']);
      assert.equal(server.calls.length, 2);
    });
  }
});

test('other tmux list failures return exact generic 503 without output or a cached empty list', async t => {
  const failures = [
    serviceError(Buffer.from('error connecting to /isolated/private-socket (Permission denied)\n')),
    serviceError('no sessions\nprivate diagnostic must not leak\n'),
    serviceError('unexpected failure for no server running request\n'),
    Object.assign(new Error('spawnSync tmux ENOENT'), { code: 'ENOENT' }),
  ];
  for (const [index, failure] of failures.entries()) {
    await t.test(`failure ${index + 1}`, async () => {
      const server = fixture();
      const initial = JSON.parse((await server.request()).body);
      server.advance(1000);
      server.failure(failure);
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await server.request();
        assert.equal(response.status, 503);
        assert.equal(response.body, '{"error":"Terminal service error"}');
      }
      assert.equal(server.calls.length, 3, 'failed refreshes are retried, not cached as empty or served as stale success');
      assert.deepEqual(server.logs, []);
      server.failure(null);
      const recovered = await server.request();
      assert.equal(recovered.status, 200);
      assert.deepEqual(JSON.parse(recovered.body), initial, 'service recovery retains the existing response shape and token');
      assert.equal(server.calls.length, 4);
    });
  }
});
