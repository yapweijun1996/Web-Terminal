'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');

const serverPath = path.resolve(__dirname, '../runtime/upload-server.js');
const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+7lQAAAAASUVORK5CYII=',
    'base64'
);

function request(socketPath, origin, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const headers = { origin, connection: 'close', 'content-type': 'application/octet-stream', ...extraHeaders };
        if (!headers['transfer-encoding'] && !headers['content-length']) headers['content-length'] = body.length;
        const req = http.request({
            socketPath,
            path: '/__terminal_upload',
            method: 'POST',
            headers,
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                try { resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }); }
                catch (error) { reject(error); }
            });
            res.on('aborted', () => reject(new Error('upload response was interrupted')));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('upload fixture request timed out')));
        req.end(body);
    });
}

test('upload origin and image checks work on the isolated macOS baseline', { skip: process.platform !== 'darwin' }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-terminal-upload-test-'));
    const directory = path.join(root, 'uploads');
    const socket = path.join(root, 'upload.sock');
    const origin = 'https://example.test';
    const child = spawn(process.execPath, [serverPath], {
        env: { PATH: process.env.PATH, TERMINAL_UPLOAD_SOCKET: socket, TERMINAL_UPLOAD_DIR: directory, TERMINAL_ALLOWED_ORIGIN: origin },
        stdio: 'ignore',
    });
    try {
        for (let i = 0; i < 100 && !fs.existsSync(socket); i++) {
            if (child.exitCode !== null) throw new Error('upload fixture exited before listening');
            await delay(25);
        }
        assert.ok(fs.existsSync(socket), 'fixture should listen on its private socket');
        assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
        assert.equal((await request(socket, 'https://wrong.example', png)).status, 403);
        assert.equal((await request(socket, origin, png, { 'content-type': 'image/png' })).status, 415);
        assert.equal((await request(socket, origin, Buffer.from('not an image'))).status, 415);
        assert.equal((await request(socket, origin, png.subarray(0, 8))).status, 415, 'a malformed image with a valid signature must be removed');
        assert.equal((await request(socket, origin, Buffer.alloc(0), { 'content-length': String(10 * 1024 * 1024 + 1) })).status, 413);
        assert.equal((await request(socket, origin, Buffer.alloc(10 * 1024 * 1024 + 1), { 'transfer-encoding': 'chunked' })).status, 413);
        assert.deepEqual(fs.readdirSync(directory), [], 'rejected uploads must not leave files');
        const result = await request(socket, origin, png);
        assert.equal(result.status, 201);
        assert.equal(path.dirname(result.body.path), directory);
        assert.equal(fs.statSync(result.body.path).mode & 0o777, 0o600);
        assert.deepEqual(fs.readFileSync(result.body.path), png);
    } finally {
        if (child.exitCode === null) {
            child.kill('SIGTERM');
            await new Promise(resolve => child.once('exit', resolve));
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
});
