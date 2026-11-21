'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildCodexArgs, createCodexParser } = require('../workspace/codex-adapter');

test('replays the recorded Codex exec session in order', () => {
  const fixture = path.join(__dirname, 'fixtures', 'codex-exec-pwd.jsonl');
  const lines = readFileSync(fixture, 'utf8').trimEnd().split('\n');
  const records = lines.map(line => JSON.parse(line));
  const parser = createCodexParser({ sessionId: 'initial-session' });
  const events = lines.flatMap(line => parser.push(line));

  assert.deepEqual(events.map(event => event.type), [
    'session_started',
    'message_done',
    'tool_call_start',
    'tool_call_output',
    'message_done',
    'turn_finished',
  ]);
  const [, firstMessage, toolStart, toolOutput, lastMessage, finished] = events;
  assert.deepEqual(events.map(event => event.seq), [1, 2, 3, 4, 5, 6]);
  assert.ok(events[0].turnId);
  for (const event of events) {
    assert.equal(event.sessionId, records[0].thread_id);
    assert.equal(event.turnId, events[0].turnId);
  }
  assert.equal(firstMessage.messageId, 'item_0');
  assert.equal(firstMessage.text, records[2].item.text);
  assert.equal(toolStart.name, 'shell');
  assert.deepEqual(toolStart.input, { command: '/bin/zsh -lc pwd' });
  assert.equal(toolStart.toolCallId, 'item_1');
  assert.equal(toolOutput.toolCallId, toolStart.toolCallId);
  assert.equal(toolOutput.output, records[4].item.aggregated_output);
  assert.equal(toolOutput.isError, false);
  assert.equal(lastMessage.text + '\n', toolOutput.output);
  assert.equal(finished.status, 'success');
  assert.deepEqual(finished.usage, records[6].usage);
});

test('builds exec arguments for supported sandboxes, models, and effort levels', () => {
  assert.deepEqual(buildCodexArgs({ sandbox: 'read-only' }), [
    'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only',
  ]);
  for (const effort of ['low', 'medium', 'high']) {
    assert.deepEqual(buildCodexArgs({ sandbox: 'workspace-write', model: 'gpt-5.4_test', effort }), [
      'exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write',
      '--model=gpt-5.4_test', '-c', `model_reasoning_effort="${effort}"`,
    ]);
  }
});

test('rejects sandbox bypasses and invalid model or effort values', () => {
  for (const sandbox of ['danger-full-access', '--dangerously-bypass-approvals-and-sandbox']) {
    assert.throws(() => buildCodexArgs({ sandbox }), /invalid_sandbox/);
  }
  assert.throws(() => buildCodexArgs({ sandbox: 'read-only', model: 'bad model' }), /invalid_model/);
  assert.throws(() => buildCodexArgs({ sandbox: 'read-only', effort: 'max' }), /invalid_effort/);
});

test('requires an explicit opt-in for the assumed resume argument order', () => {
  const options = { sandbox: 'read-only', resumeSessionId: 'session-123' };
  assert.throws(() => buildCodexArgs(options), /resume_not_verified/);
  assert.throws(() => buildCodexArgs({
    ...options, allowUnverifiedResume: 'true',
  }), /resume_not_verified/);
  assert.deepEqual(buildCodexArgs({ ...options, allowUnverifiedResume: true }), [
    'exec', 'resume', 'session-123', '--json', '--skip-git-repo-check', '--sandbox', 'read-only',
  ]);
  assert.throws(() => buildCodexArgs({
    ...options, allowUnverifiedResume: true, resumeSessionId: '--danger-full-access',
  }), /invalid_resume_session_id/);
});

test('reports one error for malformed JSON and continues parsing', () => {
  const parser = createCodexParser({ sessionId: 'initial-session' });
  const errors = parser.push('{broken');
  assert.equal(errors.length, 1);
  const [error] = errors;
  assert.equal(error.type, 'error');
  assert.equal(error.code, 'invalid_json');
  assert.equal(error.sessionId, 'initial-session');
  assert.equal(error.seq, 1);
  const [finished] = parser.push('{"type":"turn.completed","usage":{}}');
  assert.equal(finished.turnId, error.turnId);
  assert.equal(finished.seq, 2);
});

test('ignores unknown records and item types without consuming sequence numbers', () => {
  const parser = createCodexParser({ sessionId: 'initial-session' });
  assert.deepEqual(parser.push('{"type":"future.event"}'), []);
  assert.deepEqual(parser.push('{"type":"item.completed","item":{"type":"reasoning"}}'), []);
  assert.deepEqual(parser.push('null'), []);
  const [started] = parser.push('{"type":"thread.started","thread_id":"codex-session"}');
  assert.equal(started.seq, 1);
});

test('reports command exit failures and maps both Codex error record shapes', () => {
  const parser = createCodexParser({ sessionId: 'initial-session' });
  const [output] = parser.push(JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', id: 'item_1', aggregated_output: 'failed', exit_code: 1 },
  }));
  assert.equal(output.type, 'tool_call_output');
  assert.equal(output.isError, true);
  assert.equal(output.output, 'failed');

  const [error, finished] = parser.push('{"type":"turn.failed","error":{"message":"Turn failed"}}');
  assert.equal(error.type, 'error');
  assert.equal(error.message, 'Turn failed');
  assert.equal(error.turnId, output.turnId);
  assert.equal(finished.type, 'turn_finished');
  assert.equal(finished.status, 'error');
  assert.equal(finished.turnId, error.turnId);

  const [nextError, nextFinished] = parser.push('{"type":"error","code":"test","message":"Stream error"}');
  assert.equal(nextError.type, 'error');
  assert.equal(nextError.code, 'test');
  assert.equal(nextError.message, 'Stream error');
  assert.notEqual(nextError.turnId, finished.turnId);
  assert.equal(nextError.seq, finished.seq + 1);
  assert.equal(nextFinished.type, 'turn_finished');
  assert.equal(nextFinished.status, 'error');
  assert.equal(nextFinished.turnId, nextError.turnId);
});
