'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('private Linux fixture isolates sessions and preserves jobs', async () => {
  assert.equal(spawnSync('tmux', ['-V']).status, 0, 'tmux is required');
  assert.equal(spawnSync('/usr/bin/ttyd', ['--version']).status, 0, 'ttyd is required at /usr/bin/ttyd');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-fixture-'));
  const socket = path.join(directory, 'ui.sock');
  const tmuxSocket = `wt-test-${process.pid}-${Date.now()}`;
  const tmux = (...args) => execFileSync('tmux', ['-f', '/dev/null', '-L', tmuxSocket, ...args], { encoding: 'utf8' }).trim();
  let server;
  const start = () => {
    server = spawn(process.execPath, [path.join(__dirname, '../ui/server.js')], {
      env: { ...process.env, TERMINAL_RUNTIME: directory, TERMINAL_TMUX_SOCKET: tmuxSocket, TERMINAL_TEST_HTTP: '1', TERMINAL_UPLOAD_DIR: path.join(directory, 'uploads') },
      stdio: 'ignore',
    });
  };
  const ready = async () => {
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error('fixture server exited');
      if (fs.existsSync(socket)) return;
      await sleep(50);
    }
    throw new Error('fixture socket did not appear');
  };
  const request = (method, url, headers = {}, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, method, path: url, headers: { host: 'fixture.test', ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const upgrade = origin => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path: '/terminal/shared/ws', headers: {
      host: 'fixture.test', origin, connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-protocol': 'tty',
    } });
    req.once('upgrade', (res, stream) => { stream.destroy(); resolve(res.statusCode); });
    req.once('response', res => { res.resume(); resolve(res.statusCode); });
    req.once('error', err => err.code === 'ECONNRESET' ? resolve('rejected') : reject(err));
    req.end();
  });

  try {
    tmux('new-session', '-d', '-s', 'shared');
    start();
    await ready();
    assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
    const index = await request('GET', '/');
    assert.equal(index.status, 200);
    assert.match(index.body, /Terminal tabs/);

    const list = JSON.parse((await request('GET', '/api/sessions')).body);
    assert.deepEqual(list.sessions, ['shared']);
    const headers = { origin: 'http://fixture.test', 'content-type': 'application/json', 'x-terminal-request': list.token };
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl6sAAAAASUVORK5CYII=', 'base64');
    const imageHeaders = { ...headers, 'content-type': 'application/octet-stream', 'content-length': image.length };
    assert.equal((await request('POST', '/api/images', { ...imageHeaders, origin: 'http://other.test' }, image)).status, 403);
    assert.equal((await request('POST', '/api/images', { ...imageHeaders, 'x-terminal-request': 'invalid' }, image)).status, 403);
    assert.equal((await request('POST', '/api/images', { ...imageHeaders, 'content-length': 4 }, Buffer.from('nope'))).status, 415);
    const uploaded = await request('POST', '/api/images', imageHeaders, image);
    assert.equal(uploaded.status, 201);
    const uploadedPath = JSON.parse(uploaded.body).path;
    assert.equal(path.dirname(uploadedPath), path.join(directory, 'uploads'));
    assert.equal(fs.statSync(uploadedPath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(uploadedPath), image);
    assert.equal((await request('POST', '/api/sessions', { ...headers, origin: 'http://other.test' })).status, 403);
    assert.equal((await request('POST', '/api/sessions', { ...headers, 'x-terminal-request': 'invalid' })).status, 403);
    const created = await request('POST', '/api/sessions', headers);
    assert.equal(created.status, 201);
    const name = JSON.parse(created.body).name;
    assert.match(name, /^web-[a-f0-9]{12}$/);
    assert.equal((await request('GET', '/terminal/invalid')).status, 404);
    const terminal = await request('GET', '/terminal/shared');
    assert.equal(terminal.status, 200);
    assert.match(terminal.body, /src="\/clipboard-bridge\.js"/);
    assert.equal((await request('GET', '/clipboard-bridge.js')).status, 200);
    assert.equal(await upgrade('http://other.test'), 'rejected');
    assert.equal(await upgrade('http://fixture.test'), 101);

    tmux('send-keys', '-t', name, 'sleep 60', 'Enter');
    let command = '';
    for (let i = 0; i < 30 && command !== 'sleep'; i++) {
      await sleep(50);
      command = tmux('display-message', '-p', '-t', name, '#{pane_current_command}');
    }
    assert.equal(command, 'sleep');
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
    start();
    await ready();
    assert.equal(tmux('display-message', '-p', '-t', name, '#{pane_current_command}'), 'sleep');
    assert.ok(JSON.parse((await request('GET', '/api/sessions')).body).sessions.includes(name));
  } finally {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise(resolve => server.once('exit', resolve));
    }
    try { tmux('kill-server'); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
