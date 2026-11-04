'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const serve = path.resolve(__dirname, '../runtime/serve.sh');

test('the terminal origin requires a private, owned directory and refuses an existing socket', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-terminal-runtime-test-'));
    const privateDir = path.join(root, 'private');
    const looseDir = path.join(root, 'loose');
    const linkDir = path.join(root, 'link');
    const html = path.join(root, 'index.html');
    const socket = path.join(privateDir, 'terminal.sock');
    let server;
    fs.mkdirSync(privateDir, { mode: 0o700 });
    fs.mkdirSync(looseDir, { mode: 0o755 });
    fs.chmodSync(looseDir, 0o755);
    fs.symlinkSync(privateDir, linkDir);
    fs.writeFileSync(html, 'fixture');
    const env = {
        PATH: process.env.PATH,
        WEB_TERMINAL_RUNTIME_DIR: privateDir,
        WEB_TERMINAL_CLIENT_HTML: html,
        WEB_TERMINAL_TMUX_SERVER: 'web-terminal-test-unused',
        WEB_TERMINAL_START_DIR: root,
        TTYD_BIN: '/usr/bin/true',
    };
    const run = overrides => spawnSync(serve, [], { env: { ...env, ...overrides }, encoding: 'utf8' });
    try {
        assert.equal(run({}).status, 0, 'a safe empty runtime directory may start the configured executable');
        assert.notEqual(run({ WEB_TERMINAL_RUNTIME_DIR: looseDir }).status, 0, 'a shared directory must fail');
        assert.notEqual(run({ WEB_TERMINAL_RUNTIME_DIR: linkDir }).status, 0, 'a symlink directory must fail');
        server = net.createServer();
        await new Promise((resolve, reject) => server.once('error', reject).listen(socket, resolve));
        assert.notEqual(run({}).status, 0, 'an existing socket must not be removed');
        assert.ok(fs.lstatSync(socket).isSocket(), 'the existing socket must remain present');
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
