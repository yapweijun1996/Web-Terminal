'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.join(__dirname, '../ui/server.js');

test('Linux UI rejects unsafe runtime paths without removing existing endpoints', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-runtime-guard-'));
  const privateDir = path.join(root, 'private');
  const looseDir = path.join(root, 'loose');
  const linkedDir = path.join(root, 'linked');
  const socket = path.join(privateDir, 'ui.sock');
  fs.mkdirSync(privateDir, { mode: 0o700 });
  fs.mkdirSync(looseDir, { mode: 0o755 });
  fs.chmodSync(looseDir, 0o755);
  fs.symlinkSync(privateDir, linkedDir);
  const attempt = runtime => spawnSync(process.execPath, [script], {
    env: { ...process.env, TERMINAL_RUNTIME: runtime },
    encoding: 'utf8', timeout: 3000,
  });
  const rejectRuntime = (runtime, reason) => {
    const result = attempt(runtime);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, reason);
  };
  let original;
  try {
    rejectRuntime('relative-runtime', /Runtime directory must be absolute/);
    rejectRuntime(looseDir, /Runtime directory must be private/);
    rejectRuntime(linkedDir, /Runtime directory must be private/);

    fs.writeFileSync(socket, 'fixture');
    rejectRuntime(privateDir, /UI socket path already exists/);
    assert.equal(fs.readFileSync(socket, 'utf8'), 'fixture');
    fs.unlinkSync(socket);

    fs.symlinkSync(path.join(root, 'missing'), socket);
    rejectRuntime(privateDir, /UI socket path already exists/);
    assert.equal(fs.lstatSync(socket).isSymbolicLink(), true);
    fs.unlinkSync(socket);

    original = http.createServer((req, res) => res.end('original fixture'));
    await new Promise((resolve, reject) => original.once('error', reject).listen(socket, resolve));
    rejectRuntime(privateDir, /UI socket path already exists/);
    const body = await new Promise((resolve, reject) => {
      http.get({ socketPath: socket, path: '/' }, res => {
        let data = ''; res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    assert.equal(body, 'original fixture', 'the original listener remains reachable');
  } finally {
    if (original) await new Promise(resolve => original.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
