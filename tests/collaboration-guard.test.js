'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

test('the collaboration launcher fails closed even with legacy runtime settings', () => {
    const launcher = path.resolve(__dirname, '../runtime/collaboration-serve.sh');
    const result = spawnSync('/bin/sh', [launcher], {
        env: {
            PATH: process.env.PATH,
            WEB_TERMINAL_RUNTIME_DIR: '/not-used',
            WEB_TERMINAL_TMUX_SERVER: 'not-used',
            WEB_TERMINAL_CLIENT_HTML: '/not-used',
        },
        encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Collaborative terminal unavailable/);
});
