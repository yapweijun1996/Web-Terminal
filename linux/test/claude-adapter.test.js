'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  buildClaudeArgs,
  createClaudeParser,
  buildApprovalResponse,
  buildUserMessage,
} = require('../workspace/claude-adapter');

const SESSION_ID = 'workspace-session';
const RESUME_ID = '8686f84d-d1dd-4ed4-907e-4a431771cb3e';
const BASE_ARGS = [
  '-p', '--verbose', '--input-format', 'stream-json',
  '--output-format', 'stream-json', '--include-partial-messages',
  '--permission-mode', 'manual',
];

function replay(filename) {
  const { push } = createClaudeParser({ sessionId: SESSION_ID });
  const lines = readFileSync(path.join(__dirname, 'fixtures', filename), 'utf8').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const events = lines.flatMap(push);
  assert.ok(events[0].turnId);
  for (const [index, event] of events.entries()) {
    assert.equal(event.seq, index + 1);
    assert.equal(event.sessionId, SESSION_ID);
    assert.equal(event.turnId, events[0].turnId);
  }
  return { events, records: lines.map(line => JSON.parse(line)) };
}

test('replays the denied fixture in order with the full final text after the deltas', () => {
  const { events, records } = replay('claude-bash-denied.jsonl');
  assert.equal(events[0].cliSessionId, records[0].session_id);
  assert.deepEqual(events.map(event => event.type), [
    'session_started',
    'tool_call_start',
    'approval_decision',
    'tool_call_output',
    'tool_call_start',
    'tool_call_output',
    ...Array(41).fill('message_delta'),
    'message_done',
    'turn_finished',
  ]);
  const [, skill, denial, failedOutput, bash, bashOutput] = events;
  assert.equal(skill.name, 'Skill');
  assert.equal(denial.approvalId, skill.toolCallId);
  assert.equal(denial.decision, 'deny');
  assert.equal(denial.reason, 'no approval surface in this session; permission request denied automatically');
  assert.equal(failedOutput.toolCallId, skill.toolCallId);
  assert.equal(failedOutput.isError, true);
  assert.equal(bash.name, 'Bash');
  assert.equal(bash.input.command, 'pwd');
  assert.equal(bashOutput.toolCallId, bash.toolCallId);
  assert.equal(bashOutput.isError, false);

  const textEvents = events.filter(event => ['message_delta', 'message_done'].includes(event.type));
  const finalMessage = records.find(record => record.message?.content?.some(block => block.type === 'text')).message;
  assert.ok(textEvents.every(event => event.messageId === finalMessage.id));
  assert.equal(textEvents.slice(0, -1).map(event => event.text).join(''), finalMessage.content[0].text);
  assert.equal(textEvents.at(-1).text, finalMessage.content[0].text);
  assert.equal(events.at(-1).status, 'success');
  assert.equal(events.at(-1).costUsd, records.at(-1).total_cost_usd);
  assert.deepEqual(events.at(-1).usage, records.at(-1).usage);
});

test('replays the Write approval fixture and preserves its request and tool output', () => {
  const { events, records } = replay('claude-write-approval.jsonl');
  assert.deepEqual(events.map(event => event.type), [
    'session_started', 'tool_call_start', 'approval_request',
    'tool_call_output', 'message_done', 'turn_finished',
  ]);
  const [, tool, approval, output, message] = events;
  const request = records.find(record => record.type === 'control_request');
  assert.equal(approval.approvalId, request.request_id);
  assert.equal(approval.toolName, 'Write');
  assert.equal(approval.toolCallId, tool.toolCallId);
  assert.deepEqual(approval.options, ['allow', 'deny']);
  assert.deepEqual(approval.input, tool.input);
  assert.equal(approval.input.file_path, path.posix.join(records[0].cwd, 'approval-probe.txt'));
  assert.equal(output.toolCallId, tool.toolCallId);
  assert.equal(output.output, 'Denied by probe');
  assert.equal(output.isError, true);
  assert.equal(message.text, records.at(-1).result);
});

test('builds prompt-mode arguments with resume, model, and budget', () => {
  assert.deepEqual(buildClaudeArgs({
    approvalMode: 'prompt', resumeSessionId: RESUME_ID, model: 'claude-sonnet_4.5', maxBudgetUsd: 1.25,
  }), [
    ...BASE_ARGS, '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio',
    '--resume', RESUME_ID, '--model', 'claude-sonnet_4.5', '--max-budget-usd', '1.25',
  ]);
});

test('builds deny-mode arguments and defaults to deny', () => {
  const expected = [...BASE_ARGS, '--permission-prompts', 'none'];
  assert.deepEqual(buildClaudeArgs({ approvalMode: 'deny' }), expected);
  assert.deepEqual(buildClaudeArgs(), expected);
});

test('keeps a flag-shaped model value attached to the model option', () => {
  const model = '--dangerously-skip-permissions';
  const args = buildClaudeArgs({ model });
  assert.equal(args.at(-1), `--model=${model}`);
  assert.equal(args.includes(model), false);
});

test('rejects invalid arguments and a supplied working directory', () => {
  for (const resumeSessionId of ['--help', '', 1, null, `${RESUME_ID}\n`]) {
    assert.throws(() => buildClaudeArgs({ resumeSessionId }), /UUID/);
  }
  for (const model of ['model space', 'model;pwd', 'model/name', 'model\n', '', 1, null]) {
    assert.throws(() => buildClaudeArgs({ model }), /model/);
  }
  for (const maxBudgetUsd of [0, -1, Infinity, NaN, '1', null]) {
    assert.throws(() => buildClaudeArgs({ maxBudgetUsd }), /maxBudgetUsd/);
  }
  assert.throws(() => buildClaudeArgs({ approvalMode: 'auto' }), /approvalMode/);
  assert.throws(() => buildClaudeArgs({ cwd: '/browser-supplied-path' }), /cwd/);
});

test('returns one error for a malformed line and ignores unknown or unrelated records', () => {
  const { push } = createClaudeParser({ sessionId: SESSION_ID });
  for (const line of [
    'null', '42', '{"type":"future_event"}', '{"type":"system","subtype":"status"}',
    '{"type":"assistant","message":{"content":[null]}}', '{"type":"control_request"}',
    '{"type":"user","message":{"content":"hello"}}',
  ]) {
    assert.deepEqual(push(line), []);
  }
  const errors = push('{"type":');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].type, 'error');
  assert.equal(errors[0].code, 'MALFORMED_JSON');
  assert.equal(errors[0].sessionId, SESSION_ID);
  assert.equal(errors[0].seq, 1);
  assert.equal(push('{"type":"system","subtype":"init"}')[0].seq, 2);
});

test('emits complete assistant text and ignores repeated final text for the same message', () => {
  const parser = createClaudeParser({ sessionId: SESSION_ID });
  const push = record => parser.push(JSON.stringify(record));
  push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-1' } } });
  const [delta] = push({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
  });
  assert.equal(delta.messageId, 'msg-1');
  assert.equal(delta.text, 'Hello');
  const final = {
    type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: 'Hello again' }] },
  };
  assert.equal(push(final)[0].text, 'Hello again');
  assert.deepEqual(push(final), []);
  const [laterBlock] = push({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Second block' } },
  });
  assert.equal(laterBlock.messageId, 'msg-1');
  assert.equal(laterBlock.text, 'Second block');
  assert.equal(push({ ...final, message: { ...final.message, id: 'msg-2' } })[0].text, 'Hello again');
});

test('finalizes each streamed message and uses assistant text when supplied', () => {
  const parser = createClaudeParser({ sessionId: SESSION_ID });
  const push = record => parser.push(JSON.stringify(record));
  for (const [id, parts] of [['first', ['Draft']], ['second', ['One', ' two']]]) {
    push({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
    for (const text of parts) {
      push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    }
    push({ type: 'stream_event', event: { type: 'message_stop' } });
  }
  const [first] = push({
    type: 'assistant', message: { id: 'first', content: [{ type: 'text', text: 'Corrected' }, { type: 'text', text: ' text' }] },
  });
  assert.equal(first.type, 'message_done');
  assert.equal(first.messageId, 'first');
  assert.equal(first.text, 'Corrected text');
  const [second, finish] = push({ type: 'result' });
  assert.equal(second.type, 'message_done');
  assert.equal(second.messageId, 'second');
  assert.equal(second.text, 'One two');
  assert.equal(finish.type, 'turn_finished');
});

test('correlates a system denial with the host approval request', () => {
  const { push } = createClaudeParser({ sessionId: SESSION_ID });
  const [request] = push(JSON.stringify({
    type: 'control_request',
    request_id: 'request-1',
    request: { subtype: 'can_use_tool', tool_use_id: 'tool-1', tool_name: 'Write', input: {} },
  }));
  const [denial] = push(JSON.stringify({
    type: 'system', subtype: 'permission_denied', tool_use_id: 'tool-1', decision_reason: 'Denied by policy',
  }));
  assert.equal(denial.approvalId, request.approvalId);
  assert.equal(denial.decision, 'deny');
  assert.equal(denial.reason, 'Denied by policy');
});

test('reports result errors and starts a new turn with a continuing sequence', () => {
  const { push } = createClaudeParser({ sessionId: SESSION_ID });
  const [error, finish] = push(JSON.stringify({
    type: 'result', is_error: true, subtype: 'error_max_turns', errors: ['Turn limit reached'],
    total_cost_usd: 0, usage: { output_tokens: 1 },
  }));
  assert.equal(error.type, 'error');
  assert.equal(error.code, 'error_max_turns');
  assert.equal(error.message, 'Turn limit reached');
  assert.equal(finish.type, 'turn_finished');
  assert.equal(finish.status, 'error');
  assert.equal(finish.costUsd, 0);
  assert.deepEqual(finish.usage, { output_tokens: 1 });
  assert.equal(finish.turnId, error.turnId);
  const [next] = push('{"type":"result","terminal_reason":"interrupted","is_error":false}');
  assert.equal(next.status, 'cancelled');
  assert.notEqual(next.turnId, finish.turnId);
  assert.equal(next.seq, finish.seq + 1);
});

test('encodes allow and deny as single approval response lines', () => {
  for (const decision of ['allow', 'deny']) {
    const message = 'Host decision\nwith a second line';
    const line = buildApprovalResponse({ requestId: 'request-1', decision, message });
    assert.equal(line.split('\n').length, 2);
    assert.ok(line.endsWith('\n'));
    assert.deepEqual(JSON.parse(line), {
      type: 'control_response',
      response: {
        subtype: 'success', request_id: 'request-1', response: { behavior: decision, message },
      },
    });
  }
  assert.throws(() => buildApprovalResponse({ requestId: 'request-1', decision: 'ask' }), /decision/);
  assert.throws(() => buildApprovalResponse({ decision: 'deny' }), /requestId/);
  assert.throws(() => buildApprovalResponse({ requestId: 'request-1', decision: 'deny', message: 1 }), /message/);
});

test('supplies a non-empty denial message when the host omits it or sends whitespace', () => {
  for (const message of [undefined, '', ' \t\n']) {
    const deny = JSON.parse(buildApprovalResponse({ requestId: 'request-1', decision: 'deny', message }));
    assert.deepEqual(deny.response.response, { behavior: 'deny', message: 'The user denied this action.' });
  }
  const allow = JSON.parse(buildApprovalResponse({ requestId: 'request-1', decision: 'allow' }));
  assert.deepEqual(allow.response.response, { behavior: 'allow' });
});

test('encodes user text as one stdin line', () => {
  const text = 'First line\nSecond line';
  const line = buildUserMessage(text);
  assert.equal(line.split('\n').length, 2);
  assert.ok(line.endsWith('\n'));
  assert.deepEqual(JSON.parse(line), { type: 'user', message: { role: 'user', content: text } });
  assert.throws(() => buildUserMessage(null), /text/);
});
