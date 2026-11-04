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
const preload = path.resolve(__dirname, 'fixtures/held-image-inspector.js');
const png = Buffer.from('89504e470d0a1a0a', 'hex');

async function waitFor(predicate, message) {
    for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await delay(10);
    }
    throw new Error(message);
}

function upload(socket, origin, ticket) {
    let result;
    let req;
    const done = new Promise(resolve => {
        req = http.request({
            socketPath: socket,
            path: '/__terminal_upload',
            method: 'POST',
            headers: { origin, 'content-type': 'application/octet-stream', 'content-length': png.length, ...(ticket ? { 'x-terminal-target': ticket } : {}) },
        }, res => {
            res.resume();
            res.on('end', () => { result = { status: res.statusCode }; resolve(result); });
        });
        req.on('error', error => { result = { error: error.code }; resolve(result); });
        req.end(png);
    });
    return { req, done, get result() { return result; } };
}

function control(socket, origin, action, ticket) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            socketPath: socket, path: '/__terminal_upload', method: 'POST',
            headers: { origin, 'content-length': 0, 'x-terminal-action': action, ...(ticket ? { 'x-terminal-target': ticket } : {}) },
        }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        });
        req.on('error', reject);
        req.end();
    });
}

function oversizedChunkedUpload(socket, origin) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            socketPath: socket,
            path: '/__terminal_upload',
            method: 'POST',
            headers: { origin, connection: 'close', 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
        }, res => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
            res.on('aborted', () => reject(new Error('oversized upload response was interrupted')));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('oversized upload timed out')));
        req.end(Buffer.alloc(10 * 1024 * 1024 + 1));
    });
}

function startFixture(extraEnv = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-terminal-concurrency-test-'));
    const socket = path.join(root, 'upload.sock');
    const events = path.join(root, 'events');
    const release = path.join(root, 'release');
    const directory = path.join(root, 'uploads');
    const origin = 'https://example.test';
    const child = spawn(process.execPath, ['--require', preload, serverPath], {
        env: { PATH: process.env.PATH, TERMINAL_UPLOAD_SOCKET: socket, TERMINAL_UPLOAD_DIR: directory, TERMINAL_ALLOWED_ORIGIN: origin, WT_TEST_EVENTS: events, WT_TEST_RELEASE: release, ...extraEnv },
        stdio: 'ignore',
    });
    const eventLines = () => fs.existsSync(events) ? fs.readFileSync(events, 'utf8').split('\n') : [];
    const stop = async () => {
        fs.writeFileSync(release, 'release');
        if (child.exitCode === null && child.signalCode === null) {
            await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
        }
        fs.rmSync(root, { recursive: true, force: true });
    };
    return { socket, events, release, directory, origin, eventLines, stop };
}

test('disconnected upload retains its work slot until image inspection finishes', async () => {
    const { socket, release, origin, eventLines, stop } = startFixture();
    const requests = [];
    try {
        await waitFor(() => fs.existsSync(socket), 'upload fixture did not start');
        for (let i = 0; i < 4; i++) requests.push(upload(socket, origin));
        await waitFor(() => eventLines().filter(x => x === 'inspection-started').length === 4, 'four inspections did not start');
        assert.equal((await upload(socket, origin).done).status, 429, 'the ordinary concurrency limit must apply');
        requests[0].req.destroy();
        await waitFor(() => eventLines().includes('aborted-response'), 'the server did not observe the disconnected client');
        const probe = upload(socket, origin);
        requests.push(probe);
        await waitFor(() => probe.result || eventLines().filter(x => x === 'inspection-started').length > 4, 'the capacity probe did not complete');
        assert.equal(probe.result?.status, 429, 'disconnection must not admit a fifth in-flight inspection');
        assert.equal(eventLines().filter(x => x === 'inspection-started').length, 4);
        fs.writeFileSync(release, 'release');
        const remaining = await Promise.all(requests.slice(1, 4).map(x => x.done));
        assert.deepEqual(remaining.map(x => x.status), [201, 201, 201]);
        assert.equal((await upload(socket, origin).done).status, 201, 'capacity must be released after work finishes');
    } finally {
        for (const request of requests) request.req.destroy();
        await stop();
    }
});

test('a disconnected client can recover a saved path without an available pane', async () => {
    const { socket, release, origin, directory, eventLines, stop } = startFixture();
    let request;
    try {
        await waitFor(() => fs.existsSync(socket), 'upload fixture did not start');
        const capture = await control(socket, origin, 'capture');
        assert.equal(capture.status, 200);
        assert.equal(capture.body.target, null);
        const ticket = capture.body.ticket;
        request = upload(socket, origin, ticket);
        await waitFor(() => eventLines().includes('inspection-started'), 'inspection did not start');
        request.req.destroy();
        await waitFor(() => eventLines().includes('aborted-response'), 'disconnect was not observed');
        assert.equal((await control(socket, origin, 'result', ticket)).body.pending, true);
        fs.writeFileSync(release, 'release');
        let recovered;
        for (let i = 0; i < 200; i++) {
            recovered = await control(socket, origin, 'result', ticket);
            if (!recovered.body.pending) break;
            await delay(10);
        }
        assert.equal(recovered.status, 200);
        assert.equal(path.dirname(recovered.body.path), directory);
        assert.equal(fs.existsSync(recovered.body.path), true, 'the recovered path must point to the saved file');
        assert.equal((await control(socket, origin, 'insert', ticket)).status, 409, 'an unavailable pane cannot receive input');
        assert.equal((await control(socket, 'https://wrong.example', 'result', ticket)).status, 403);
    } finally {
        request?.req.destroy();
        await stop();
    }
});

test('an upload aborted while receiving the body releases its slot', async () => {
    const { socket, release, origin, eventLines, stop } = startFixture();
    const stalled = [];
    let accepted;
    try {
        await waitFor(() => fs.existsSync(socket), 'upload fixture did not start');
        for (let i = 0; i < 4; i++) {
            const req = http.request({
                socketPath: socket,
                path: '/__terminal_upload',
                method: 'POST',
                headers: { origin, 'content-type': 'application/octet-stream', 'content-length': 1024 },
            }, res => res.resume());
            req.on('error', () => {});
            req.write(png);
            stalled.push(req);
        }
        await waitFor(() => eventLines().filter(x => x === 'body-data').length === 4, 'four request bodies did not start');
        assert.equal((await upload(socket, origin).done).status, 429);
        stalled[0].destroy();
        await waitFor(() => eventLines().includes('aborted-response'), 'the server did not observe the aborted body');
        accepted = upload(socket, origin);
        await waitFor(() => eventLines().includes('inspection-started'), 'the released slot was not reused');
        assert.equal((await upload(socket, origin).done).status, 429, 'the replacement request must occupy the released slot');
        fs.writeFileSync(release, 'release');
        assert.equal((await accepted.done).status, 201);
    } finally {
        stalled.forEach(req => req.destroy());
        if (accepted) accepted.req.destroy();
        await stop();
    }
});

test('rejected oversized streams do not consume future work slots', async () => {
    const { socket, release, origin, eventLines, stop } = startFixture();
    const requests = [];
    try {
        await waitFor(() => fs.existsSync(socket), 'upload fixture did not start');
        for (let i = 0; i < 5; i++) assert.equal(await oversizedChunkedUpload(socket, origin), 413);
        for (let i = 0; i < 4; i++) requests.push(upload(socket, origin));
        await waitFor(() => eventLines().filter(x => x === 'inspection-started').length === 4, 'rejected requests leaked capacity');
        assert.equal((await upload(socket, origin).done).status, 429);
        fs.writeFileSync(release, 'release');
        assert.deepEqual((await Promise.all(requests.map(x => x.done))).map(x => x.status), [201, 201, 201, 201]);
    } finally {
        requests.forEach(x => x.req.destroy());
        await stop();
    }
});

test('image-inspection timeout cleans its file and releases capacity', { timeout: 15000 }, async () => {
    const { socket, release, directory, origin, eventLines, stop } = startFixture({ WT_TEST_REAL_TIMEOUT: '1' });
    let request;
    try {
        await waitFor(() => fs.existsSync(socket), 'upload fixture did not start');
        request = upload(socket, origin);
        assert.equal((await request.done).status, 415);
        assert.ok(eventLines().includes('inspection-timed-out'), 'the real subprocess timeout should fire');
        assert.deepEqual(fs.readdirSync(directory), [], 'the timed-out image must be removed');
        fs.writeFileSync(release, 'release');
        assert.equal((await upload(socket, origin).done).status, 201, 'a later upload must be accepted');
    } finally {
        if (request) request.req.destroy();
        await stop();
    }
});
