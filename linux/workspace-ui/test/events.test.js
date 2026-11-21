import assert from 'node:assert/strict';
import test from 'node:test';
import { subscribeToEvents } from '../src/api/events.js';

const sessionId = 'session';
const endpoint = '/api/workspace/sessions/session/events';

function event(seq) {
  return { type: 'message_delta', seq, sessionId, turnId: 'turn', messageId: 'message', text: 'test' };
}

function nativeSource() {
  const source = { closed: false, close() { this.closed = true; } };
  function EventSource(url) {
    assert.equal(url, endpoint);
    return source;
  }
  return { source, EventSource };
}

test('a dropped EventSource resumes with the last delivered SSE ID', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { source, EventSource } = nativeSource();
  const received = [];
  const statuses = [];
  const calls = [];
  const encoder = new TextEncoder();
  const first = event(10);
  const second = event(11);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`id: 10\ndata: ${JSON.stringify(first)}\n\nid: 11\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(second)}\n\n`));
      controller.close();
    },
  });
  const close = subscribeToEvents(sessionId, {
    EventSourceImpl: EventSource,
    async fetchImpl(url, options) {
      calls.push([url, options.headers]);
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    },
    onEvent: (value) => received.push(value),
    onStatus: (status) => statuses.push(status),
  });
  t.after(close);

  source.onopen();
  source.onmessage({ lastEventId: '10', data: JSON.stringify(first) });
  source.onerror();
  assert.equal(source.closed, true);
  t.mock.timers.tick(999);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1);
  await new Promise(setImmediate);

  assert.deepEqual(calls, [[endpoint, { Accept: 'text/event-stream', 'Last-Event-ID': '10' }]]);
  assert.deepEqual(received, [first, second]);
  assert.deepEqual(statuses.slice(0, 4), ['reconnecting', 'connected', 'reconnecting', 'connected']);
});

test('retries back off to 15 seconds and stop on an expired replay cursor', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const attempts = [];
  const statuses = [];
  const close = subscribeToEvents(sessionId, {
    lastSeq: 8,
    async fetchImpl(url, options) {
      attempts.push([url, options.headers['Last-Event-ID']]);
      if (attempts.length === 7) return Response.json({ error: 'replay_incomplete' }, { status: 409 });
      return Response.json({}, { status: 503 });
    },
    onEvent: () => assert.fail('Unexpected event'),
    onStatus: (status, message) => statuses.push([status, message]),
  });
  t.after(close);
  await new Promise(setImmediate);

  for (const delay of [1000, 2000, 4000, 8000, 15_000, 15_000]) {
    const before = attempts.length;
    t.mock.timers.tick(delay - 1);
    assert.equal(attempts.length, before);
    t.mock.timers.tick(1);
    await new Promise(setImmediate);
    assert.equal(attempts.length, before + 1);
  }

  assert.equal(attempts.length, 7);
  assert.ok(attempts.every(([url, id]) => url === endpoint && id === '8'));
  assert.deepEqual(statuses.at(-1), ['error', 'Part of the session history expired during the disconnect. Start a new session.']);
  t.mock.timers.tick(30_000);
  assert.equal(attempts.length, 7);
});
