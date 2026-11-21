'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const vm = require('node:vm');
const { createWorkspace } = require('../workspace');

const serverPath = require.resolve('../ui/server');
const source = fs.readFileSync(serverPath, 'utf8');
const uiRequire = createRequire(serverPath);
const terminalApi = '/api/workspace/terminal';
const projectRef = { rootId: 'development', relPath: 'repo##[#{pid}]' };
const origin = 'http://fixture.test';
const ownerHeader = 'cf-access-jwt-assertion';

function executable(name, option) {
  return [name, `/opt/homebrew/bin/${name}`, `/usr/bin/${name}`].find(candidate =>
    spawnSync(candidate, [option], { stdio: 'ignore' }).status === 0);
}
const tmuxBin = executable('tmux', '-V');
const ttydBin = executable('ttyd', '--version');
const tmuxSkip = tmuxBin ? false : 'tmux executable unavailable';
const ttydSkip = tmuxSkip || (!ttydBin && 'ttyd executable unavailable');

async function fixture(t, { enabled = true, withConfig = true, verifyOwner = true, realTmux = true, seed, beforeTmux } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-terminal-'));
  const cwd = path.join(fs.realpathSync(directory), 'roots', projectRef.relPath);
  const configPath = path.join(directory, 'config.json');
  const workspacesRoot = path.join(directory, 'managed');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(path.dirname(cwd), 'other'));
  fs.symlinkSync(directory, path.join(path.dirname(cwd), 'escape'));
  fs.writeFileSync(configPath, JSON.stringify({
    roots: [{ id: projectRef.rootId, label: 'Development', path: path.dirname(cwd) }],
    workspacesRoot,
    github: { repositories: ['example/allowed'] },
  }));
  const children = [];
  const terminalLaunches = [];
  const tmuxEnv = {
    ...process.env,
    TMUX_TMPDIR: directory,
    PATH: tmuxBin?.includes('/') ? `${path.dirname(tmuxBin)}:${process.env.PATH}` : process.env.PATH,
  };
  delete tmuxEnv.TMUX;
  const tmux = (...args) => execFileSync(tmuxBin, ['-f', '/dev/null', '-L', 'fixture', ...args], {
    env: tmuxEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const hasSession = name => {
    try { tmux('has-session', '-t', `=${name}`); return true; } catch { return false; }
  };
  const track = child => {
    children.push(once(child, 'close'));
    return child;
  };

  let server, shutdown, authorityAvailable = true;
  const diagnostics = [];
  t.after(async () => {
    shutdown?.();
    if (server?.listening) {
      await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
    if (realTmux) {
      try { tmux('kill-server'); } catch { /* Closing the last session also stops tmux. */ }
    }
    await Promise.all(children);
    fs.rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(diagnostics, []);
  });

  seed?.({ directory, tmux });
  vm.runInNewContext(source, {
    Buffer, setTimeout,
    __dirname: path.dirname(serverPath),
    console: { error: message => diagnostics.push(message) },
    process: {
      env: {
        ...(withConfig && { WEB_TERMINAL_WORKSPACE_CONFIG: configPath }),
        ...(enabled && { WEB_TERMINAL_WORKSPACE_TERMINAL: '1' }),
        TERMINAL_RUNTIME: directory, TERMINAL_TMUX_SOCKET: 'fixture',
        TERMINAL_TEST_HTTP: '1', TERMINAL_START_DIR: cwd,
      },
      getuid: process.getuid,
      on(signal, listener) { if (signal === 'SIGTERM') shutdown = listener; },
    },
    require(name) {
      if (name === '../workspace') return {
        createWorkspace(options) {
          if (options.terminal && verifyOwner) {
            options.terminal.verifyOwner = req => {
              const ownerId = req.headers[ownerHeader];
              if (!authorityAvailable || !['owner', 'other-owner'].includes(ownerId)) throw new Error();
              return { authorized: true, ownerId, expires: Date.now() + 60_000 };
            };
          }
          return createWorkspace({
            ...options,
            spawnFn(_agent, _args, options) {
              return track(spawn(process.execPath, ['-e', 'process.stdin.resume()'], options));
            },
            async gitRunner(_command, args) {
              if (args.includes('clone')) fs.mkdirSync(args.at(-1), { recursive: true });
              return { code: 0, stdout: '' };
            },
          });
        },
      };
      if (name === 'node:http') return {
        ...http,
        createServer(...args) {
          server = http.createServer(...args);
          return {
            on: (...args) => server.on(...args),
            listen: () => server.listen(0, '127.0.0.1'),
            close: () => server.close(),
          };
        },
      };
      if (name === 'node:child_process') return {
        execFileSync(command, [, , ...args]) {
          assert.equal(command, 'tmux');
          beforeTmux?.(args, cwd);
          if (realTmux) return tmux(...args);
          assert.equal(args[0], 'list-sessions');
          return '';
        },
        spawn(command, args, options) {
          assert.equal(command, '/usr/bin/ttyd');
          terminalLaunches.push([...args]);
          return track(spawn(ttydBin, args, { ...options, env: tmuxEnv }));
        },
      };
      return uiRequire(name);
    },
  }, { filename: serverPath });

  await once(server, 'listening');
  const request = (method, url, headers = {}, data, chunked = false) => new Promise((resolve, reject) => {
    const body = data === undefined ? undefined : JSON.stringify(data);
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method, path: url, agent: false,
      headers: {
        host: 'fixture.test', ...headers,
        ...(body !== undefined && !chunked && { 'content-length': Buffer.byteLength(body) }),
        ...(chunked && { 'transfer-encoding': 'chunked' }),
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body: res.headers['content-type']?.includes('application/json') ? JSON.parse(raw) : raw });
      });
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end(body);
  });
  const { body: { token } } = await request('GET', '/api/sessions');
  const mutation = { origin, 'x-terminal-request': token, 'content-type': 'application/json', [ownerHeader]: 'owner' };

  async function start(body = projectRef) {
    const response = await request('POST', '/api/workspace/sessions', mutation, { agent: 'claude', ...body });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.sessionId;
  }
  const create = (sessionId, body = projectRef, headers = mutation, chunked) =>
    request('POST', terminalApi, { ...headers, 'x-workspace-session': sessionId }, body, chunked);
  const remove = (name, headers = mutation, data, chunked) => request('DELETE', `${terminalApi}/${name}`, headers, data, chunked);

  function upgrade(name, ownerId, verifyAttachment = false) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, path: `/terminal/${name}/ws`, agent: false,
        headers: {
          host: 'fixture.test', origin, connection: 'Upgrade', upgrade: 'websocket',
          'sec-websocket-key': randomBytes(16).toString('base64'),
          'sec-websocket-version': '13', 'sec-websocket-protocol': 'tty',
          ...(ownerId && { [ownerHeader]: ownerId }),
        },
      });
      req.on('upgrade', async (res, socket) => {
        socket.on('error', reject);
        try {
          if (verifyAttachment) {
            const payload = Buffer.from(JSON.stringify({ AuthToken: '', columns: 80, rows: 24 }));
            const mask = randomBytes(4);
            for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
            socket.write(Buffer.concat([Buffer.from([0x82, 0x80 | payload.length]), mask, payload]));
            for (let attempt = 0; attempt < 40; attempt++) {
              if (tmux('list-clients', '-F', '#{session_name}').split('\n').includes(name)) break;
              if (attempt === 39) assert.fail('ttyd did not attach to the expected tmux session');
              await delay(25);
            }
          }
          resolve(res.statusCode);
        } catch (error) {
          reject(error);
        } finally {
          socket.destroy();
        }
      });
      req.on('response', res => { res.resume(); resolve(res.statusCode); });
      req.on('error', error => error.code === 'ECONNRESET' ? resolve(0) : reject(error));
      req.setTimeout(5000, () => req.destroy(new Error('Upgrade timed out')));
      req.end();
    });
  }

  return {
    create, cwd, directory, hasSession, mutation, remove, request, start, terminalLaunches, tmux, tmuxEnv, upgrade,
    revokeAuthority() { authorityAvailable = false; },
  };
}

test('workspace terminal routes return 404 unless both feature flags are enabled', async t => {
  for (const options of [{ enabled: false }, { withConfig: false }]) {
    const f = await fixture(t, { ...options, realTmux: false });
    assert.equal((await f.create('unknown')).status, 404);
    assert.equal((await f.remove('web-000000000000')).status, 404);
    assert.equal((await f.request('GET', '/api/sessions')).status, 200);
  }
});

test('workspace terminal mutations fail closed when the owner verifier is unavailable', async t => {
  const f = await fixture(t, { verifyOwner: false, realTmux: false });
  const chat = await f.start();
  assert.equal((await f.create(chat)).status, 401);
  assert.equal((await f.remove('web-000000000000')).status, 401);
});

test('workspace terminal rejects wrong owners, path escapes, arbitrary cwd, and different projects', { skip: tmuxSkip }, async t => {
  const f = await fixture(t);
  const chat = await f.start();
  assert.equal((await f.create(chat, projectRef, { ...f.mutation, [ownerHeader]: 'other-owner' })).status, 403);
  for (const body of [
    { ...projectRef, relPath: '../other' },
    { ...projectRef, relPath: '/tmp' },
    { ...projectRef, relPath: 'escape' },
    { ...projectRef, cwd: '/tmp' },
  ]) assert.equal((await f.create(chat, body)).status, 400);
  assert.equal((await f.create(chat, { ...projectRef, relPath: 'other' })).status, 403);
  assert.equal((await f.create(chat, { rootId: 'managed-github', relPath: '.' })).status, 400);
  assert.deepEqual((await f.request('GET', '/api/sessions')).body.sessions, []);
});

test('workspace terminal revalidates the project after the capacity check', { skip: tmuxSkip }, async t => {
  let armed = false;
  const f = await fixture(t, {
    beforeTmux(args, cwd) {
      if (!armed || args[0] !== 'list-sessions') return;
      armed = false;
      fs.renameSync(cwd, `${cwd}-old`);
      fs.symlinkSync(path.join(path.dirname(cwd), 'other'), cwd);
    },
  });
  const chat = await f.start();
  armed = true;
  assert.deepEqual(await f.create(chat), { status: 409, body: { error: 'project_path_changed' } });
  assert.deepEqual((await f.request('GET', '/api/sessions')).body.sessions, []);
});

test('workspace terminal uses the chat-bound GitHub checkout', { skip: tmuxSkip }, async t => {
  const f = await fixture(t);
  const chat = await f.start({ github: 'example/allowed' });
  assert.equal((await f.create(chat, { rootId: 'managed-github', relPath: 'another-checkout' })).status, 403);
  const result = await f.create(chat, { rootId: 'managed-github', relPath: '.' });
  assert.equal(result.status, 201);
  const cwd = f.tmux('display-message', '-p', '-t', `=${result.body.terminalId}:`, '#{pane_current_path}');
  assert.equal(path.dirname(cwd), path.join(path.dirname(path.dirname(f.cwd)), 'managed', 'example', 'allowed'));
});

test('workspace terminal gates mutations and caps both declared and streamed bytes', async t => {
  const f = await fixture(t, { realTmux: false });
  const chat = await f.start();
  const oversized = { ...projectRef, relPath: 'x'.repeat(4096) };
  for (const headers of [
    { ...f.mutation, origin: 'http://other.test' },
    { ...f.mutation, 'x-terminal-request': 'invalid' },
    { ...f.mutation, 'content-type': 'application/json; charset=utf-8' },
  ]) {
    assert.equal((await f.create(chat, oversized, headers)).status, 403);
    assert.equal((await f.remove('web-000000000000', headers)).status, 403);
  }
  assert.equal((await f.create(chat, oversized)).status, 413);
  assert.equal((await f.create(chat, oversized, f.mutation, true)).status, 413);
  assert.equal((await f.remove('web-000000000000', f.mutation, {})).status, 400);
  assert.equal((await f.remove('web-000000000000', f.mutation, undefined, true)).status, 400);
});

test('concurrent workspace terminal creates reuse one session and preserve literal hashes in cwd', { skip: tmuxSkip }, async t => {
  const f = await fixture(t);
  const chat = await f.start();
  const [first, retry] = await Promise.all([f.create(chat), f.create(chat)]);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual(retry, first);
  const name = first.body.terminalId;
  assert.match(name, /^web-[a-f0-9]{12}$/);
  assert.equal(f.tmux('display-message', '-p', '-t', `=${name}:`, '#{pane_current_path}'), f.cwd);
  assert.equal(f.tmux('list-sessions', '-F', '#{session_name}'), name);
});

test('workspace and legacy creation share the 20-session limit, including shared', { skip: tmuxSkip }, async t => {
  const f = await fixture(t);
  const chat = await f.start();
  f.tmux('new-session', '-d', '-s', 'shared');
  for (let index = 1; index < 19; index++) {
    f.tmux('new-session', '-d', '-s', `web-${String(index).padStart(12, '0')}`);
  }
  const legacy = await f.request('POST', '/api/sessions', f.mutation, {});
  assert.equal(legacy.status, 201);
  assert.equal((await f.create(chat)).status, 409);
  assert.equal((await f.request('POST', '/api/sessions', f.mutation, {})).status, 409);
  f.tmux('kill-session', '-t', `=${legacy.body.name}`);
  const result = await f.create(chat);
  assert.equal(result.status, 201);
  assert.deepEqual(await f.create(chat), result);
});

test('workspace terminal DELETE is owner-bound, repeat-safe, and preserves a same-name replacement', { skip: tmuxSkip }, async t => {
  const f = await fixture(t);
  const chat = await f.start();
  const { body: { terminalId: name } } = await f.create(chat);
  assert.equal((await f.remove(name, { ...f.mutation, [ownerHeader]: 'other-owner' })).status, 403);
  assert.equal(f.hasSession(name), true);
  const { body: identity } = await f.request('GET', `/api/sessions/${name}/identity`);
  assert.equal((await f.request('POST', `/api/sessions/${name}/close`, {
    ...f.mutation, [ownerHeader]: 'other-owner',
    'x-terminal-session-id': identity.sessionId, 'x-terminal-server-pid': identity.serverPid,
  })).status, 409);
  assert.equal(f.hasSession(name), true);
  assert.deepEqual(await f.remove(name), { status: 200, body: { ok: true } });
  assert.equal(f.hasSession(name), false);
  f.tmux('new-session', '-d', '-s', name);
  assert.deepEqual(await f.remove(name), { status: 200, body: { ok: true } });
  assert.equal(f.hasSession(name), true);

  const { body: { terminalId: next } } = await f.create(chat);
  f.tmux('kill-session', '-t', `=${next}`);
  f.tmux('new-session', '-d', '-s', next);
  assert.equal((await f.remove(next)).status, 200);
  assert.equal(f.hasSession(next), true);
});

test('startup reclaims marked terminals from its previous runtime only', { skip: tmuxSkip }, async t => {
  const orphan = 'web-0123456789ab';
  const foreign = 'web-0123456789ac';
  const f = await fixture(t, {
    seed({ directory, tmux }) {
      const ownMarker = createHash('sha256').update(directory).digest('hex').slice(0, 16) + 'a'.repeat(32);
      tmux('new-session', '-d', '-s', orphan, ';', 'set-option', '-t', orphan, '@web-workspace-terminal', ownMarker);
      tmux('new-session', '-d', '-s', foreign, ';', 'set-option', '-t', foreign, '@web-workspace-terminal', '0'.repeat(48));
      tmux('new-session', '-d', '-s', 'shared');
    },
  });
  assert.equal(f.hasSession(orphan), false);
  assert.equal(f.hasSession(foreign), true);
  assert.equal(f.hasSession('shared'), true);
  assert.equal((await f.request('GET', `/terminal/${foreign}/`, { [ownerHeader]: 'owner' })).status, 401);
});

test('stopping a chat closes its terminal immediately and prevents reopening it', { skip: tmuxSkip }, async t => {
  const f = await fixture(t);
  const chat = await f.start();
  const { body: { terminalId: name } } = await f.create(chat);
  assert.equal((await f.request('POST', `/api/workspace/sessions/${chat}/stop`, f.mutation)).status, 200);
  assert.equal(f.hasSession(name), false);
  assert.equal((await f.create(chat)).status, 404);
  assert.equal((await f.remove(name)).status, 200);
});

test('workspace iframe and WebSocket require the bound owner and use an attach-only tmux target', { skip: ttydSkip }, async t => {
  const f = await fixture(t);
  const chat = await f.start();
  const { body: { terminalId: name } } = await f.create(chat);
  const frame = `/terminal/${name}/`;
  assert.equal((await f.request('GET', frame)).status, 401);
  assert.equal((await f.request('GET', `${frame}token`, { [ownerHeader]: 'other-owner' })).status, 401);
  assert.equal(await f.upgrade(name, 'other-owner'), 0);
  assert.equal(f.terminalLaunches.length, 0);
  assert.equal((await f.request('GET', frame, { [ownerHeader]: 'owner' })).status, 200);
  assert.equal(await f.upgrade(name, 'owner', true), 101);
  const [launch] = f.terminalLaunches;
  const [script, socket, target, sessionId, serverPid, marker] = launch.slice(-6);
  assert.equal(target, name);
  assert.match(sessionId, /^\$\d+$/);
  assert.match(serverPid, /^\d+$/);
  assert.match(marker, /^[a-f0-9]{48}$/);

  f.revokeAuthority();
  assert.equal((await f.request('GET', frame, { [ownerHeader]: 'owner' })).status, 401);
  assert.equal(await f.upgrade(name, 'owner'), 0);
  f.tmux('new-session', '-d', '-s', 'shared');
  f.tmux('kill-session', '-t', `=${name}`);
  spawnSync('/bin/sh', [script, socket, target, sessionId, serverPid, marker], { env: f.tmuxEnv, stdio: 'ignore' });
  assert.equal(f.hasSession(name), false);
});

test('disabling workspace terminals preserves legacy iframe, WebSocket, split and close behavior', { skip: ttydSkip }, async t => {
  const calls = [];
  const f = await fixture(t, { enabled: false, beforeTmux: args => calls.push(args) });
  const created = await f.request('POST', '/api/sessions', f.mutation, {});
  assert.equal(created.status, 201);
  const name = created.body.name;
  f.tmux('set-option', '-t', name, '@web-workspace-terminal', 'a'.repeat(48));
  const identity = await f.request('GET', `/api/sessions/${name}/identity`);
  assert.equal(identity.status, 200);
  calls.length = 0;
  assert.equal((await f.request('GET', `/terminal/${name}/`)).status, 200);
  assert.equal(await f.upgrade(name, undefined, true), 101);
  assert.equal(calls.some(([command]) => command === 'display-message'), false);
  assert.deepEqual(f.terminalLaunches.map(args => args.slice(4)), [
    ['/bin/sh', path.join(path.dirname(serverPath), 'attach-tab.sh'), 'fixture', name],
  ]);
  const headers = {
    ...f.mutation,
    'x-terminal-session-id': identity.body.sessionId,
    'x-terminal-server-pid': identity.body.serverPid,
  };
  assert.equal((await f.request('POST', `/api/sessions/${name}/split/horizontal`, headers)).status, 200);
  assert.equal((await f.request('POST', `/api/sessions/${name}/close`, headers)).status, 200);
  assert.equal(f.hasSession(name), false);
});
