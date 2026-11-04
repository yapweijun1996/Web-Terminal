'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');

const serve = path.resolve(__dirname, '../runtime/serve.sh');
const ttydAvailable = spawnSync('ttyd', ['--version'], { stdio: 'ignore' }).status === 0;

test('ttyd serves the configured client through a private Unix socket', { skip: !ttydAvailable }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-terminal-origin-test-'));
    const html = path.join(root, 'index.html');
    const socket = path.join(root, 'terminal.sock');
    const content = '<!doctype html><title>isolated terminal fixture</title>';
    fs.writeFileSync(html, content);
    const child = spawn(serve, [], {
        env: {
            PATH: process.env.PATH,
            HOME: root,
            WEB_TERMINAL_RUNTIME_DIR: root,
            WEB_TERMINAL_CLIENT_HTML: html,
            WEB_TERMINAL_TMUX_SERVER: 'web-terminal-origin-unused',
            WEB_TERMINAL_START_DIR: root,
        },
        stdio: 'ignore',
    });
    try {
        for (let i = 0; i < 100 && !fs.existsSync(socket); i++) {
            if (child.exitCode !== null) throw new Error('ttyd fixture exited before listening');
            await delay(25);
        }
        assert.ok(fs.existsSync(socket), 'ttyd should create its socket');
        const directoryStat = fs.lstatSync(root);
        const socketStat = fs.lstatSync(socket);
        assert.equal(directoryStat.uid, process.getuid());
        assert.equal(directoryStat.mode & 0o077, 0, 'the parent directory must prevent group and other traversal');
        assert.equal(socketStat.uid, process.getuid());
        assert.equal(socketStat.mode & 0o007, 0, 'the socket must not grant access to other users');
        const response = await new Promise((resolve, reject) => {
            http.get({ socketPath: socket, path: '/', headers: { host: 'localhost' } }, res => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
            }).on('error', reject);
        });
        assert.equal(response.status, 200);
        assert.equal(response.body, content);
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
});
