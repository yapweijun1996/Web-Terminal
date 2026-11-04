'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const ConnectionLifecycle = require('../client/src/connection-lifecycle.js');

const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(requestToken) {
    const timers = [];
    const states = [];
    const input = [];
    let sockets = 0;
    const lifecycle = new ConnectionLifecycle({
        requestToken,
        openSocket: () => { sockets++; },
        onState: state => states.push(state),
        onInput: enabled => input.push(enabled),
        setTimer: (callback, delay) => { const timer = { callback, delay, canceled: false }; timers.push(timer); return timer; },
        clearTimer: timer => { timer.canceled = true; },
    });
    return { lifecycle, timers, states, input, get sockets() { return sockets; } };
}

test('disconnect pauses input and reconnects through a single socket', async () => {
    const h = harness(async () => 'ok');
    h.lifecycle.start();
    await flush();
    assert.equal(h.sockets, 1);
    h.lifecycle.socketOpened();
    h.lifecycle.socketClosed();
    assert.deepEqual(h.states, ['connecting', 'connected', 'reconnecting']);
    assert.deepEqual(h.input, [false, true, false]);
    assert.equal(h.timers[0].delay, 1000);
    h.timers[0].callback();
    await flush();
    assert.equal(h.sockets, 2);
    h.lifecycle.socketOpened();
    assert.equal(h.states.at(-1), 'connected');
    assert.equal(h.input.at(-1), true);
});

test('authentication failure offers a single explicit retry', async () => {
    let resolveRetry;
    let calls = 0;
    const h = harness(() => {
        calls++;
        return calls === 1 ? Promise.resolve('auth') : new Promise(resolve => { resolveRetry = resolve; });
    });
    h.lifecycle.start();
    await flush();
    assert.equal(h.states.at(-1), 'auth-required');
    assert.equal(h.sockets, 0);
    h.lifecycle.retry();
    h.lifecycle.retry();
    assert.equal(calls, 2);
    resolveRetry('ok');
    await flush();
    assert.equal(h.sockets, 1);
    h.lifecycle.socketOpened();
    assert.equal(h.states.at(-1), 'connected');
});

test('failed attempts are bounded and a manual retry can recover', async () => {
    let tokenResult = 'unavailable';
    const h = harness(async () => tokenResult);
    h.lifecycle.start();
    await flush();
    for (let i = 0; i < 6; i++) {
        assert.equal(h.states.at(-1), 'reconnecting');
        h.timers[i].callback();
        await flush();
    }
    assert.deepEqual(h.timers.map(x => x.delay), [1000, 2000, 4000, 8000, 15000, 15000]);
    assert.equal(h.states.at(-1), 'offline');
    assert.equal(h.sockets, 0);
    tokenResult = 'ok';
    h.lifecycle.retry();
    await flush();
    assert.equal(h.sockets, 1);
    h.lifecycle.socketOpened();
    assert.equal(h.states.at(-1), 'connected');
});

test('stop cancels timers and prevents a pending token response from opening a socket', async () => {
    let resolveToken;
    const h = harness(() => new Promise(resolve => { resolveToken = resolve; }));
    h.lifecycle.start();
    h.lifecycle.stop();
    resolveToken('ok');
    await flush();
    assert.equal(h.sockets, 0);
    assert.equal(h.input.at(-1), false);

    const second = harness(async () => 'unavailable');
    second.lifecycle.start();
    await flush();
    second.lifecycle.stop();
    assert.equal(second.timers[0].canceled, true);
    second.timers[0].callback();
    await flush();
    assert.equal(second.sockets, 0);
});

test('default browser timers are invoked with the global receiver', async () => {
    const context = vm.createContext({ module: { exports: {} }, timers: [] });
    vm.runInContext(`
        globalThis.setTimeout = function (callback, delay) {
            if (this !== globalThis) throw new Error('Illegal invocation');
            timers.push(delay);
            return 1;
        };
        globalThis.clearTimeout = function () {
            if (this !== globalThis) throw new Error('Illegal invocation');
        };
    `, context);
    vm.runInContext(fs.readFileSync(require.resolve('../client/src/connection-lifecycle.js'), 'utf8'), context);
    const Lifecycle = context.module.exports;
    const lifecycle = new Lifecycle({
        requestToken: async () => 'unavailable',
        openSocket: () => {},
        onState: () => {},
        onInput: () => {},
    });
    lifecycle.start();
    await flush();
    assert.deepEqual(Array.from(context.timers), [1000]);
    lifecycle.stop();
});
