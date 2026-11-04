'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

const script = path.join(__dirname, '../runtime/upload-server.js');

test('upload service preserves existing endpoints and restarts after graceful shutdown', { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-upload-socket-'));
  const loose = path.join(root, 'loose');
  const linked = path.join(root, 'linked');
  const socket = path.join(root, 'upload.sock');
  const uploadDir = path.join(root, 'uploads');
  fs.mkdirSync(loose, { mode: 0o755 });
  fs.chmodSync(loose, 0o755);
  fs.symlinkSync(root, linked);
  const env = socketPath => ({ ...process.env, TERMINAL_UPLOAD_SOCKET: socketPath,
    TERMINAL_UPLOAD_DIR: uploadDir, TERMINAL_ALLOWED_ORIGIN: 'https://example.test' });
  const rejectSocket = (socketPath, reason) => {
    const result = spawnSync(process.execPath, [script], { env: env(socketPath), encoding: 'utf8', timeout: 3000 });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, reason);
  };
  let original, child;
  const start = async () => {
    child = spawn(process.execPath, [script], { env: env(socket), stdio: 'ignore' });
    for (let i = 0; i < 100 && !fs.existsSync(socket); i++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('upload fixture exited before listening');
      await delay(20);
    }
    assert.equal(fs.existsSync(socket), true, 'upload fixture must listen');
    const status = await new Promise((resolve, reject) => {
      http.get({ socketPath: socket, path: '/' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
    });
    assert.equal(status, 404, 'the upload service answers on the socket');
  };
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([done, delay(3000, undefined, { ref: false }).then(() => { throw new Error('upload fixture did not stop'); })]);
  };
  try {
    rejectSocket(path.join(loose, 'upload.sock'), /Unsafe socket directory/);
    rejectSocket(path.join(linked, 'upload.sock'), /Unsafe socket directory/);

    fs.writeFileSync(socket, 'fixture');
    rejectSocket(socket, /Upload socket path already exists/);
    assert.equal(fs.readFileSync(socket, 'utf8'), 'fixture');
    fs.unlinkSync(socket);
    fs.symlinkSync(path.join(root, 'missing'), socket);
    rejectSocket(socket, /Upload socket path already exists/);
    assert.equal(fs.lstatSync(socket).isSymbolicLink(), true);
    fs.unlinkSync(socket);

    original = http.createServer((req, res) => res.end('original fixture'));
    await new Promise((resolve, reject) => original.once('error', reject).listen(socket, resolve));
    rejectSocket(socket, /Upload socket path already exists/);
    const body = await new Promise((resolve, reject) => {
      http.get({ socketPath: socket, path: '/' }, res => {
        let data = ''; res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    assert.equal(body, 'original fixture');
    await new Promise(resolve => original.close(resolve)); original = null;

    await start();
    await stop();
    assert.equal(fs.existsSync(socket), false, 'graceful shutdown removes the socket');
    await start();
    await stop();
    assert.equal(fs.existsSync(socket), false, 'graceful restart also removes the socket');
  } finally {
    if (original) await new Promise(resolve => original.close(resolve));
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
