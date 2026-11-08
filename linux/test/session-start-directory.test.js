'use strict';

const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-start-dir-'));
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(runtime, { mode: 0o700 });
  const socket = path.join(runtime, 'ui.sock');
  const tmuxSocket = `wt-cwd-${process.pid}-${path.basename(root)}`;
  const tmux = (...args) => execFileSync('tmux', ['-f', '/dev/null', '-L', tmuxSocket, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  let server;
  const stop = async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(socket, { force: true });
  };
  t.after(async () => {
    await stop();
    try { tmux('kill-server'); } catch {}
    fs.rmSync(path.join(process.env.TMUX_TMPDIR || os.tmpdir(), `tmux-${process.getuid()}`, tmuxSocket), { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  // Keep this private server alive with a deliberately wrong default directory.
  tmux('new-session', '-d', '-s', 'shared', '-c', '/', '/bin/sh');
  const anchor = tmux('display-message', '-p', '-t', '=shared:', '#{pane_id}|#{pane_pid}');
  const request = (method = 'GET', headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, method, path: '/api/sessions',
      headers: { host: 'fixture.test', ...headers } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
  const start = async directory => {
    await stop();
    const env = { ...process.env, TERMINAL_RUNTIME: runtime, TERMINAL_TMUX_SOCKET: tmuxSocket,
      TERMINAL_TEST_HTTP: '1', TERMINAL_COLLABORATION_SOCKET: '' };
    if (directory === undefined) delete env.TERMINAL_START_DIR;
    else env.TERMINAL_START_DIR = directory;
    server = spawn(process.execPath, [path.join(__dirname, '../ui/server.js')], {
      cwd: '/', env, stdio: 'ignore',
    });
    let ready = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !ready) {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error('Fixture UI exited');
      ready = await new Promise(resolve => {
        const probe = net.connect(socket);
        probe.once('connect', () => { probe.destroy(); resolve(true); });
        probe.once('error', () => resolve(false));
      });
      if (!ready) await delay(20);
    }
    assert.ok(ready, 'root-launched UI must accept connections even with invalid start directory');
    const listing = await request();
    assert.equal(listing.status, 200);
    return { origin: 'http://fixture.test', 'content-type': 'application/json', 'x-terminal-request': listing.data.token };
  };
  const create = headers => request('POST', headers);
  const assertDirectory = async (name, directory) => {
    assert.equal(tmux('display-message', '-p', '-t', `=${name}:`, '#{pane_current_path}'), directory);
    const result = path.join(root, 'pwd.txt');
    fs.rmSync(result, { force: true });
    tmux('send-keys', '-t', `=${name}:`, '-l', `pwd -P > ${quote(result)}`);
    tmux('send-keys', '-t', `=${name}:`, 'Enter');
    const deadline = Date.now() + 5000;
    while ((!fs.existsSync(result) || !fs.readFileSync(result, 'utf8').trim()) && Date.now() < deadline) await delay(20);
    assert.equal(fs.readFileSync(result, 'utf8').trim(), directory, 'actual shell pwd must match the explicit start directory');
    assert.equal(tmux('display-message', '-p', '-t', '=shared:', '#{pane_id}|#{pane_pid}'), anchor, 'existing pane process must survive');
  };
  return { root, tmux, start, create, request, assertDirectory };
}

test('root-launched UI uses a literal canonical directory and retains it after restart', async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, `directory with ' " ; #[data] #{pid} #{pane_current_path} ## #`);
  fs.mkdirSync(directory);
  const link = path.join(f.root, 'directory-link');
  fs.symlinkSync(directory, link);
  let headers = await f.start(link);
  const first = await f.create(headers);
  assert.equal(first.status, 201);
  await f.assertDirectory(first.data.name, directory);

  headers = await f.start(link);
  assert.ok((await f.request()).data.sessions.includes(first.data.name), 'UI restart preserves existing session');
  const second = await f.create(headers);
  assert.equal(second.status, 201);
  await f.assertDirectory(second.data.name, directory);
});

test('default directory overrides root service and existing tmux server directories', async t => {
  // Generic Linux fixtures need not provision the deployment's default directory.
  try { fs.accessSync('/srv/agent-workstation', fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK); }
  catch { t.skip('Default workstation directory is not provisioned on this host'); return; }
  const f = await fixture(t);
  const headers = await f.start();
  const created = await f.create(headers);
  assert.equal(created.status, 201);
  await f.assertDirectory(created.data.name, fs.realpathSync('/srv/agent-workstation'));
});

test('invalid start directories reject only creation and never fall back or create directories', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'file');
  const rootLink = path.join(f.root, 'root-link');
  const missing = path.join(f.root, 'missing');
  fs.writeFileSync(file, 'fixture');
  fs.symlinkSync('/', rootLink);
  for (const directory of ['', 'relative/path', '/', '/tmp/..', rootLink, file, missing]) {
    const headers = await f.start(directory);
    assert.equal((await f.create({ ...headers, origin: 'http://foreign.test' })).status, 403, 'auth rejection retains precedence');
    const result = await f.create(headers);
    assert.equal(result.status, 503, `invalid start directory ${JSON.stringify(directory)}`);
    assert.equal(result.data.code, 'START_DIRECTORY_UNAVAILABLE');
    assert.match(result.data.error, /TERMINAL_START_DIR/);
    assert.deepEqual((await f.request()).data.sessions, ['shared']);
    assert.equal(f.tmux('list-sessions', '-F', '#{session_name}'), 'shared', 'no hidden session may be created');
    assert.equal(fs.existsSync(missing), false, 'invalid configuration does not create a directory');
  }
});

test('directory removal and permission loss after startup are rechecked before creation', async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, 'temporary');
  fs.mkdirSync(directory);
  const headers = await f.start(directory);
  fs.rmdirSync(directory);
  assert.equal((await f.create(headers)).status, 503);
  assert.deepEqual((await f.request()).data.sessions, ['shared']);
  fs.mkdirSync(directory);
  if (process.getuid() !== 0) {
    fs.chmodSync(directory, 0o400);
    try { assert.equal((await f.create(headers)).status, 503, 'directory must remain writable and searchable'); }
    finally { fs.chmodSync(directory, 0o700); }
  } else {
    t.diagnostic('Permission-loss check requires an unprivileged test user; root bypasses directory permissions');
  }
  const recovered = await f.create(headers);
  assert.equal(recovered.status, 201, 'repairing the configured directory restores creation without restarting the UI');
  await f.assertDirectory(recovered.data.name, directory);
});
