'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.join(__dirname, 'fixtures/access-origin.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('access fixture is private, inert and stable across WebSocket connections', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-access-fixture-'));
  const privateDir = path.join(root, 'private'), looseDir = path.join(root, 'loose');
  fs.mkdirSync(privateDir, { mode: 0o700 }); fs.mkdirSync(looseDir, { mode: 0o755 }); fs.chmodSync(looseDir, 0o755);
  const socketPath = path.join(privateDir, 'origin.sock');
  const env = { PATH: process.env.PATH, WT_ACCESS_FIXTURE_SOCKET: socketPath };
  const guard = socket => spawnSync(process.execPath, [script], { env: { ...env, WT_ACCESS_FIXTURE_SOCKET: socket }, encoding: 'utf8' });
  let child;
  try {
    assert.notEqual(guard('relative.sock').status, 0, 'a relative path is rejected');
    assert.notEqual(guard(path.join(looseDir, 'origin.sock')).status, 0, 'a shared directory is rejected');
    const linkDir = path.join(root, 'link'); fs.symlinkSync(privateDir, linkDir);
    assert.notEqual(guard(path.join(linkDir, 'origin.sock')).status, 0, 'a symlink directory is rejected');
    fs.writeFileSync(socketPath, 'sentinel');
    assert.notEqual(guard(socketPath).status, 0, 'an existing path is never replaced');
    assert.equal(fs.readFileSync(socketPath, 'utf8'), 'sentinel');
    fs.unlinkSync(socketPath);
    child = spawn(process.execPath, [script], { env, stdio: 'ignore' });
    for (let i = 0; i < 100 && (!fs.existsSync(socketPath) || (fs.statSync(socketPath).mode & 0o777) !== 0o600); i++) {
      if (child.exitCode !== null) throw Error('Fixture exited');
      await delay(20);
    }
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
    const request = (method, route, body = '') => new Promise((resolve, reject) => {
      const req = http.request({ socketPath, method, path: route }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('error', reject); req.end(body);
    });
    const home = JSON.parse((await request('GET', '/')).text);
    assert.equal(home.fixture, true);
    assert.match(home.instance, /^[a-f0-9]{24}$/);
    assert.equal(JSON.parse((await request('GET', '/token')).text).instance, home.instance);
    const upload = await request('POST', '/__terminal_upload', 'synthetic-input');
    assert.equal(upload.status, 200); assert.doesNotMatch(upload.text, /synthetic-input/);
    await assert.rejects(request('POST', '/__terminal_upload', 'x'.repeat(257)), /socket hang up|ECONNRESET/);
    const stalled = await new Promise(resolve => {
      const req = http.request({ socketPath, method: 'POST', path: '/__terminal_upload', headers: { 'Content-Length': 10 } });
      req.on('error', error => resolve(error.code)); req.write('x');
    });
    assert.equal(stalled, 'ECONNRESET', 'an unfinished upload reaches its absolute deadline');
    assert.deepEqual(fs.readdirSync(privateDir), ['origin.sock'], 'the upload is discarded and no file is created');
    assert.equal((await request('GET', '/unknown')).status, 404);
    const websocket = () => new Promise((resolve, reject) => {
      const req = http.request({ socketPath, path: '/ws', headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      } });
      req.once('error', reject);
      req.once('upgrade', (res, socket, head) => {
        assert.equal(res.statusCode, 101);
        let data = head;
        const read = chunk => {
          data = Buffer.concat([data, chunk]);
          if (data.length < 2 || data.length < data[1] + 2) return;
          try { const result = JSON.parse(data.subarray(2, 2 + data[1]).toString()); socket.removeListener('data', read); resolve({ result, socket }); }
          catch (error) { socket.destroy(); reject(error); }
        };
        socket.on('data', read); read(Buffer.alloc(0));
      });
      req.end();
    });
    const first = await websocket();
    assert.equal(first.result.instance, home.instance);
    first.socket.destroy(); await delay(20);
    const held = [];
    for (let i = 0; i < 4; i++) held.push(await websocket());
    assert.equal(held[0].result.instance, home.instance, 'reconnecting observes the same inert fixture process');
    await assert.rejects(websocket(), /socket hang up|ECONNRESET/, 'concurrent fixture connections are bounded');
    held.forEach(connection => connection.socket.destroy());
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
