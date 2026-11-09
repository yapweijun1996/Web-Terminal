'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelemetry, nonBlockingStderr } = require('../ui/collaboration-telemetry');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

function clock() {
  let time = 0, tasks = [];
  return {
    now: () => time,
    later(fn, delay) {
      const timer = { deadline: time + delay, fn, unref() {} };
      tasks.push(timer);
      return timer;
    },
    advance(ms) {
      time += ms;
      let rounds = 0;
      while (tasks.some(task => task.deadline <= time)) {
        assert.ok(++rounds < 100, 'summary retries may not spin');
        const [task] = tasks.filter(item => item.deadline <= time);
        tasks = tasks.filter(item => item !== task);
        task.fn();
      }
    },
    pending: () => tasks.length,
    cancel: timer => { tasks = tasks.filter(item => item !== timer); },
  };
}
const parse = entries => entries.map(line => JSON.parse(line));

test('fixed schema redacts all caller-controlled content, including invalid values', () => {
  const lines = [], emit = createTelemetry(line => lines.push(line));
  const secret = 'SECRET_JWT_COOKIE_TERMINAL_TEXT';
  emit({ event: secret, action: secret, reason: secret, state: secret, status: 999, binding: secret, headers: { authorization: secret }, session: secret, terminal: secret });
  assert.deepEqual(parse(lines)[0], {
    type: 'web_terminal_collaboration_diagnostic_v1', event: 'control', action: 'none',
    reason: 'unknown', state: 'none', status: 0, binding: 'not_checked',
    droppedRate: 0, droppedBackpressure: 0,
  });
  assert.doesNotMatch(lines[0], /SECRET|headers|session|terminal_text|authorization/i);
  assert.ok(Buffer.byteLength(lines[0]) < 512, 'every event must fit one bounded line');
});

test('ordinary and input event budgets are independent; dropped totals are summarized once', () => {
  const c = clock(), lines = [], emit = createTelemetry(line => lines.push(line), { now: c.now, later: c.later });
  for (let i = 0; i < 1000; i++) emit({ event: 'pause', reason: 'human_input', state: 'paused' });
  for (let i = 0; i < 30; i++) emit({ event: 'control', action: 'resume', status: 409, reason: 'binding', binding: 'rejected' });
  assert.equal(lines.length, 21, 'one input and twenty controls per ten seconds');
  assert.equal(c.pending(), 1, 'only one summary timer under a large burst');
  c.advance(10000);
  assert.equal(lines.length, 22, 'a single summary follows the burst even with no more events');
  const summary = parse(lines).at(-1);
  assert.equal(summary.event, 'drops');
  assert.equal(summary.droppedRate, 1009);
  assert.equal(summary.droppedBackpressure, 0);
  assert.equal(c.pending(), 0, 'no timer leak after a successful summary');
  emit({ event: 'control', action: 'pause', status: 200, reason: 'accepted' });
  assert.equal(lines.length, 23, 'rate budget resets at the next window');
});

test('full/blocked stderr is never written to; dropped counts survive until recovery', () => {
  const c = clock(), lines = []; let available = false;
  const emit = createTelemetry(line => lines.push(line), { now: c.now, later: c.later, ready: () => available });
  for (let i = 0; i < 9; i++) emit({ event: 'control', action: 'resume', status: 401, reason: 'owner_auth' });
  assert.equal(lines.length, 0, 'no writes against a blocked stream');
  assert.equal(c.pending(), 1);
  c.advance(10000);
  assert.equal(lines.length, 0, 'failed summary does not allocate a queue or force a write');
  assert.equal(c.pending(), 1, 'at most one retry timer');
  available = true;
  c.advance(10000);
  assert.deepEqual(parse(lines).map(x => [x.event, x.droppedBackpressure]), [['drops', 9]]);
  assert.equal(c.pending(), 0);
  emit({ event: 'control', action: 'resume', status: 200, reason: 'accepted' });
  assert.equal(lines.length, 2);
});

test('status, state and binding enums are stable; no arbitrary error messages are emitted', () => {
  const lines = [], emit = createTelemetry(line => lines.push(line));
  emit({ event: 'control', action: 'resume', reason: 'binding', status: 409, binding: 'rejected', error: 'SECRET_ERROR' });
  emit({ event: 'resume', action: 'resume', reason: 'accepted', state: 'sharing' });
  emit({ event: 'pause', reason: 'human_input', state: 'paused' });
  emit({ event: 'auto_resume', reason: 'owner_expired', state: 'paused' });
  assert.deepEqual(parse(lines).map(x => [x.event, x.reason, x.status, x.binding]), [
    ['control', 'binding', 409, 'rejected'], ['resume', 'accepted', 0, 'not_checked'],
    ['pause', 'human_input', 0, 'not_checked'], ['auto_resume', 'owner_expired', 0, 'not_checked'],
  ]);
  assert.doesNotMatch(lines.join(''), /SECRET_ERROR/);
});

test('logging failures and capacity check exceptions cannot affect input authorization', () => {
  const c = clock();
  assert.doesNotThrow(() => createTelemetry(() => { throw Error('secret IO failure'); }, { now: c.now, later: c.later })({ event: 'control', action: 'resume' }));
  assert.doesNotThrow(() => createTelemetry(() => assert.fail('writer must never be reached'), {
    now: c.now, later: c.later, ready: () => { throw Error('secret capacity failure'); },
  })({ event: 'control', action: 'resume' }));
});


test('Linux stderr inspection accepts only nonblocking sockets/pipes, failing closed otherwise', () => {
  const sock = { isSocket: () => true, isFIFO: () => false };
  const fifo = { isSocket: () => false, isFIFO: () => true };
  const regular = { isSocket: () => false, isFIFO: () => false };
  const base = { platform: 'linux', fd: 2, stat: () => sock, read: () => 'pos:\t0\nflags:\t02004002\nmnt_id:\t9\n' };
  assert.equal(nonBlockingStderr(base), true);
  assert.equal(nonBlockingStderr({ ...base, stat: () => fifo }), true);
  assert.equal(nonBlockingStderr({ ...base, stat: () => regular }), false, 'file/tty must not be used for control path diagnostics');
  assert.equal(nonBlockingStderr({ ...base, platform: 'darwin' }), false);
  assert.equal(nonBlockingStderr({ ...base, read: () => 'flags:\t02000002\n' }), false);
  assert.equal(nonBlockingStderr({ ...base, read: () => 'flags: unknown\n' }), false);
  assert.equal(nonBlockingStderr({ ...base, read: () => { throw Error('proc unavailable'); } }), false);
  assert.equal(nonBlockingStderr({ ...base, stat: () => { throw Error('fd unavailable'); } }), false);
  assert.equal(nonBlockingStderr({ ...base, stat: fd => { assert.equal(fd, 2); return sock; }, read: filename => { assert.equal(filename, '/proc/self/fdinfo/2'); return 'flags:\t02004002\n'; } }), true);
  // The running Linux host's own fd2 classification must return a boolean.
  assert.equal(typeof nonBlockingStderr(), 'boolean');
});

function fakeStream() {
  const stream = new EventEmitter();
  stream.writableLength = 0;
  stream.writableNeedDrain = false;
  stream.writableEnded = false;
  stream.destroyed = false;
  stream.lines = [];
  stream.forceBackpressure = false;
  stream.write = line => {
    stream.lines.push(line);
    if (stream.forceBackpressure) { stream.writableNeedDrain = true; return false; }
    return true;
  };
  return stream;
}

test('unsafe startup stderr cannot receive log bytes or allocate a timer', () => {
  const c = clock(), stream = fakeStream();
  const emit = createTelemetry(null, { stream, inspectStderr: () => false, now: c.now, later: c.later, cancel: c.cancel });
  for (let i = 0; i < 100; i++) emit({ event: 'pause', reason: 'human_input' });
  assert.deepEqual(stream.lines, []);
  assert.equal(c.pending(), 0);
  assert.equal(stream.listenerCount('error'), 0, 'no stderr writes means no stream listener needed');
});

test('EPIPE and close disable logger without exceptions, retries or unauthorized effects', () => {
  for (const reason of ['error', 'close']) {
    const c = clock(), stream = fakeStream();
    const emit = createTelemetry(null, { stream, inspectStderr: () => true, now: c.now, later: c.later, cancel: c.cancel });
    emit({ event: 'control', action: 'resume', reason: 'accepted', status: 200 });
    for (let i = 0; i < 35; i++) emit({ event: 'pause', reason: 'human_input' });
    assert.equal(c.pending(), 1, 'drop summary timer initially pending');
    const before = stream.lines.length;
    assert.doesNotThrow(() => stream.emit(reason, reason === 'error' ? Object.assign(new Error('private stream failure'), { code: 'EPIPE' }) : undefined));
    assert.doesNotThrow(() => emit({ event: 'control', action: 'resume', reason: 'accepted', status: 200 }));
    c.advance(30000);
    assert.equal(stream.lines.length, before, 'no output following a broken stream');
    assert.equal(c.pending(), 0, 'no remaining summary timer after EPIPE');
  }
});

test('false write return waits for drain and keeps one bounded drop summary', () => {
  const c = clock(), stream = fakeStream();
  stream.forceBackpressure = true;
  const emit = createTelemetry(null, { stream, inspectStderr: () => true, now: c.now, later: c.later, cancel: c.cancel });
  emit({ event: 'control', action: 'resume', reason: 'accepted', status: 200 });
  assert.equal(stream.lines.length, 1, 'write(false) accepts its line exactly once');
  for (let i = 0; i < 100; i++) emit({ event: 'control', action: 'resume', reason: 'busy', status: 409 });
  assert.equal(stream.lines.length, 1, 'no further writes while waiting for drain');
  assert.equal(c.pending(), 1, 'one summary timer, not one per dropped event');
  c.advance(10000);
  assert.equal(stream.lines.length, 1, 'drop summary stays deferred until drain');
  stream.forceBackpressure = false;
  stream.writableNeedDrain = false;
  stream.emit('drain');
  c.advance(10000);
  assert.equal(stream.lines.length, 2);
  const summary = JSON.parse(stream.lines.at(-1));
  assert.equal(summary.event, 'drops');
  assert.equal(summary.droppedBackpressure, 100);
  assert.equal(c.pending(), 0);
});

test('16 KiB buffer gate prevents write and resumes bounded summary after recovery', () => {
  const c = clock(), stream = fakeStream();
  stream.writableLength = 16384;
  const emit = createTelemetry(null, { stream, inspectStderr: () => true, now: c.now, later: c.later, cancel: c.cancel });
  emit({ event: 'control', action: 'resume', reason: 'accepted', status: 200 });
  assert.equal(stream.lines.length, 0);
  assert.equal(c.pending(), 1);
  stream.writableLength = 0;
  c.advance(10000);
  assert.deepEqual(stream.lines.map(line => JSON.parse(line).event), ['drops']);
  assert.equal(JSON.parse(stream.lines[0]).droppedBackpressure, 1);
});


test('real Linux child process survives a broken stderr pipe without affecting work', { timeout: 6000 }, async t => {
  const modulePath = path.resolve(__dirname, '../ui/collaboration-telemetry.js');
  const script = `
    const log = require(${JSON.stringify(modulePath)}).createTelemetry();
    log({ event: 'control', action: 'resume', reason: 'accepted', status: 200 });
    setTimeout(() => {
      for (let i = 0; i < 30; i++) log({ event: 'control', action: 'resume', reason: 'busy', status: 409 });
      process.stdout.write('WORK_CONTINUED\\n');
    }, 80);
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  const [first] = await once(child.stderr, 'data');
  assert.match(String(first), /web_terminal_collaboration_diagnostic_v1/);
  child.stderr.destroy();
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null);
  assert.equal(code, 0, 'asynchronous EPIPE must never kill the terminal UI process');
  assert.match(stdout, /WORK_CONTINUED/);
});
