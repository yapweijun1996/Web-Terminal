'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('status assets are served explicitly and unknown paths are rejected', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-static-'));
  const socket = path.join(directory, 'ui.sock');
  const env = { ...process.env, TERMINAL_RUNTIME: directory, TERMINAL_TEST_HTTP: '1' };
  delete env.TERMINAL_COLLABORATION_SOCKET;
  const server = spawn(process.execPath, [path.join(__dirname, '../ui/server.js')], { env, stdio: 'ignore' });
  const request = url => new Promise((resolve, reject) => {
    const req = http.get({ socketPath: socket, path: url, headers: { host: 'fixture.test' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
  try {
    const deadline = Date.now() + 10000;
    let response;
    while (Date.now() < deadline) {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error('Static fixture server exited');
      try { response = await request('/'); break; } catch (error) {
        if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
        await sleep(25);
      }
    }
    assert.ok(response, 'fixture server became ready');
    for (const [asset, contentType] of [['tokens.css', 'text/css; charset=utf-8'], ['status-model.js', 'text/javascript; charset=utf-8']]) {
      const result = await request(`/${asset}`);
      assert.equal(result.status, 200);
      assert.equal(result.headers['content-type'], contentType);
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal(result.headers['x-content-type-options'], 'nosniff');
      assert.equal(result.headers['referrer-policy'], 'no-referrer');
      assert.equal(result.body, fs.readFileSync(path.join(__dirname, '../ui', asset), 'utf8'));
    }
    const unknown = await request('/status-model.js.unknown');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.headers['cache-control'], 'no-store');
    assert.equal(unknown.headers['x-content-type-options'], 'nosniff');
    assert.equal(unknown.headers['referrer-policy'], 'no-referrer');
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      server.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
