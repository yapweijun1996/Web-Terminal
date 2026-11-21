import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationReducer, emptyConversation, hasRunningTurn } from '../src/state/reducer.js';

function receive(state, seq, event) {
  return conversationReducer(state, { type: 'event', event: { sessionId: 'session', turnId: 'turn', seq, ...event } });
}

test('streamed deltas concatenate and the final message replaces them', () => {
  const first = receive(undefined, 1, { type: 'message_delta', messageId: 'message', text: 'Hello' });
  const streamed = receive(first, 2, { type: 'message_delta', messageId: 'message', text: ' world' });
  assert.deepEqual(streamed.turns[0].messages, [{ id: 'message', text: 'Hello world', done: false }]);
  assert.equal(first.turns[0].messages[0].text, 'Hello');

  const done = receive(streamed, 3, { type: 'message_done', messageId: 'message', text: 'Hello world!' });
  assert.deepEqual(done.turns[0].messages, [{ id: 'message', text: 'Hello world!', done: true }]);
});

test('replayed sequence numbers do not change the state', () => {
  const delta = { type: 'message_delta', messageId: 'message', text: 'Hello' };
  const first = receive(undefined, 4, delta);
  assert.equal(receive(first, 4, delta), first);
  assert.equal(receive(first, 3, delta), first);
  assert.equal(first.turns[0].messages[0].text, 'Hello');
});

test('approval lifecycle and tool output are associated with the turn', () => {
  const input = { check: 'test' };
  const start = receive(undefined, 1, { type: 'tool_call_start', toolCallId: 'tool', name: 'Run checks', input });
  const approval = {
    type: 'approval_request', approvalId: 'approval', toolCallId: 'tool',
    toolName: 'Run checks', input, options: ['allow', 'deny'],
  };
  const pending = receive(start, 2, approval);
  assert.equal(pending.turns[0].approvals[0].decision, undefined);
  assert.equal(pending.turns[0].approvals[0].request.toolCallId, 'tool');

  const decided = receive(pending, 3, { type: 'approval_decision', approvalId: 'approval', decision: 'allow' });
  assert.equal(decided.turns[0].approvals[0].decision, 'allow');
  assert.equal(pending.turns[0].approvals[0].decision, undefined);
  const output = receive(decided, 4, { type: 'tool_call_output', toolCallId: 'tool', output: 'Passed', isError: false });
  const finished = receive(output, 5, { type: 'turn_finished', status: 'success', costUsd: 0.01 });
  assert.deepEqual(finished.turns[0].tools, [{ id: 'tool', name: 'Run checks', input, output: 'Passed', isError: false }]);
  assert.equal(finished.turns[0].status, 'success');
  assert.equal(finished.turns[0].costUsd, 0.01);
  assert.equal(finished.turns[0].approvals[0].decision, 'allow');
});

test('a session start advances the cursor and leaves the prompt for its turn', () => {
  const prompt = conversationReducer(emptyConversation, { type: 'prompt', prompt: { prompt: 'Check the build' } });
  const start = receive(prompt, 1, { type: 'session_started' });
  assert.equal(start.lastSeq, 1);
  assert.equal(start.turns.length, 0);

  const failed = receive(start, 2, { type: 'error', code: 'spawn_failed', message: 'Agent failed.' });
  assert.equal(failed.pendingPrompt, null);
  assert.equal(failed.turns[0].prompt, 'Check the build');
  assert.deepEqual(failed.turns[0].errors, [{ seq: 2, code: 'spawn_failed', message: 'Agent failed.' }]);
  const complete = receive(failed, 3, { type: 'turn_finished', status: 'error' });
  assert.equal(complete.turns[0].status, 'error');
});

test('cancelling a turn clears unanswered approvals', () => {
  const pending = receive(undefined, 1, {
    type: 'approval_request', approvalId: 'approval', toolCallId: 'tool', options: ['allow', 'deny'],
  });
  const finished = receive(pending, 2, { type: 'turn_finished', status: 'cancelled' });
  assert.equal(finished.turns[0].status, 'cancelled');
  assert.deepEqual(finished.turns[0].approvals, []);
});

test('ending a session preserves the transcript and clears work that cannot finish', () => {
  const complete = receive(undefined, 1, { type: 'turn_finished', status: 'success', turnId: 'earlier' });
  const partial = receive(complete, 2, { type: 'message_delta', messageId: 'message', text: 'Partial response' });
  const approval = receive(partial, 3, {
    type: 'approval_request', approvalId: 'approval', toolCallId: 'tool', options: ['allow', 'deny'],
  });
  const pending = conversationReducer(approval, { type: 'prompt', prompt: { prompt: 'Unsent draft' } });
  const ended = conversationReducer(pending, { type: 'session_ended' });

  assert.equal(ended.ended, true);
  assert.equal(ended.pendingPrompt, null);
  assert.equal(ended.turns[0], complete.turns[0]);
  assert.equal(ended.turns[1].status, 'interrupted');
  assert.equal(ended.turns[1].messages[0].text, 'Partial response');
  assert.deepEqual(ended.turns[1].approvals, []);
  assert.equal(hasRunningTurn(ended), false);
  assert.equal(conversationReducer(ended, { type: 'session_ended' }), ended);
  assert.equal(receive(ended, 4, { type: 'message_done', text: 'Late event' }), ended);
});
