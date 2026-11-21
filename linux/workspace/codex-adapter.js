'use strict';

// Codex exec v1 does not support approvals in this adapter.
// The sandbox mode is the only control.

const { randomUUID } = require('node:crypto');
const CODEX_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function isCliSessionId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

function buildCodexArgs({ model, sandbox, resumeSessionId, effort } = {}) {
  if (sandbox !== 'read-only' && sandbox !== 'workspace-write') {
    throw new Error('invalid_sandbox');
  }

  const resume = resumeSessionId !== undefined;
  if (resume && !isCliSessionId(resumeSessionId)) {
    throw new Error('invalid_resume_session_id');
  }

  const args = resume ? ['exec', 'resume'] : ['exec'];
  args.push('--json', '--skip-git-repo-check');
  // The resume subcommand takes sandbox mode as a config override.
  if (resume) args.push('-c', `sandbox_mode="${sandbox}"`);
  else args.push('--sandbox', sandbox);

  if (model !== undefined) {
    if (typeof model !== 'string' || !/^[A-Za-z0-9._-]+$/.test(model)) {
      throw new Error('invalid_model');
    }
    if (model.startsWith('-')) args.push(`--model=${model}`);
    else args.push('-m', model);
  }
  if (effort !== undefined) {
    if (!CODEX_EFFORTS.includes(effort)) throw new Error('invalid_effort');
    args.push('-c', `model_reasoning_effort="${effort}"`);
  }

  if (resume) args.push(resumeSessionId, '-');
  return args;
}

function createCodexParser({ sessionId }) {
  let turnId = randomUUID();
  let seq = 0;
  const reasoning = new Map();

  function event(type, fields) {
    return { type, sessionId, turnId, seq: ++seq, ...fields };
  }

  function finishTurn(fields) {
    const finished = event('turn_finished', fields);
    turnId = randomUUID();
    reasoning.clear();
    return finished;
  }

  function parseReasoning(item) {
    const messageId = item.id;
    if (typeof messageId !== 'string' || !messageId) return [];
    const events = [];
    if (!reasoning.has(messageId)) events.push(event('thinking_start', { messageId }));
    const previous = reasoning.get(messageId) ?? '';
    const text = typeof item.text === 'string' ? item.text : previous;
    const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
    if (delta) events.push(event('thinking_delta', { messageId, text: delta, tokens: 0 }));
    reasoning.set(messageId, text);
    return events;
  }

  function push(line) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return [event('error', {
        code: 'invalid_json',
        message: 'Malformed Codex JSONL record',
      })];
    }

    const item = record?.item;
    if (item?.type === 'reasoning' && ['item.started', 'item.updated', 'item.completed'].includes(record.type)) {
      return parseReasoning(item);
    }
    switch (record?.type) {
      case 'thread.started':
        sessionId = record.thread_id ?? sessionId;
        return [event('session_started', { cliSessionId: record.thread_id })];
      case 'item.started':
        if (item?.type === 'command_execution') {
          return [event('tool_call_start', {
            toolCallId: item.id,
            name: 'shell',
            input: { command: item.command },
          })];
        }
        return [];
      case 'item.completed':
        if (item?.type === 'agent_message') {
          return [event('message_done', { messageId: item.id, text: item.text })];
        }
        if (item?.type === 'command_execution') {
          return [event('tool_call_output', {
            toolCallId: item.id,
            output: item.aggregated_output,
            isError: item.exit_code !== 0,
          })];
        }
        return [];
      case 'turn.completed':
        return [finishTurn({ status: 'success', usage: record.usage })];
      case 'turn.failed':
      case 'error': {
        const error = record.error ?? record;
        return [
          event('error', {
            code: error.code ?? 'codex_error',
            message: error.message ?? 'Codex exec failed',
          }),
          finishTurn({ status: 'error' }),
        ];
      }
      default:
        return [];
    }
  }

  return { push };
}

module.exports = { CODEX_EFFORTS, buildCodexArgs, createCodexParser, isCliSessionId };
