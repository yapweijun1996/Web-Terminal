'use strict';

// This preload is used only by the isolated upload concurrency test. It holds
// image inspection until the test releases it, without changing server code.
const fs = require('node:fs');
const http = require('node:http');
const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const execFile = childProcess.execFile;

const record = event => fs.appendFileSync(process.env.WT_TEST_EVENTS, `${event}\n`);
const emit = http.ServerResponse.prototype.emit;
http.ServerResponse.prototype.emit = function (event, ...args) {
    const result = emit.call(this, event, ...args);
    if (event === 'close' && !this.writableFinished) record('aborted-response');
    return result;
};
const incomingEmit = http.IncomingMessage.prototype.emit;
http.IncomingMessage.prototype.emit = function (event, ...args) {
    const result = incomingEmit.call(this, event, ...args);
    if (event === 'data' && this.method === 'POST') record('body-data');
    return result;
};

function inspect() {
    throw new Error('The fixture must use the promisified inspector');
}
inspect[promisify.custom] = (_file, _args, options) => new Promise((resolve, reject) => {
    record('inspection-started');
    if (process.env.WT_TEST_REAL_TIMEOUT === '1' && !fs.existsSync(process.env.WT_TEST_RELEASE)) {
        execFile(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 10000)'], options, (error, stdout, stderr) => {
            record(error?.killed ? 'inspection-timed-out' : 'inspection-finished');
            if (error) reject(error);
            else resolve({ stdout, stderr });
        });
        return;
    }
    const timer = setInterval(() => {
        if (!fs.existsSync(process.env.WT_TEST_RELEASE)) return;
        clearInterval(timer);
        resolve({ stdout: '  format: png\n  pixelWidth: 1\n  pixelHeight: 1\n', stderr: '' });
    }, 10);
});
childProcess.execFile = inspect;
