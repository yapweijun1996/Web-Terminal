'use strict';

// Codex exec v1 does not support approvals in this adapter.
// The sandbox mode is the only control.

const { randomUUID } = require('node:crypto');

function buildResumeArgs(sessionId, args, allowUnverifiedResume) {
  if (allowUnverifiedResume !== true) throw new Error('resume_not_verified');
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
    throw new Error('invalid_resume_session_id');
  }

  // ASSUMPTION: exec resume accepts the session ID before the flags.
  return ['exec', 'resume', sessionId, ...args];
}

function buildCodexArgs({ model, sandbox, resumeSessionId, effort, allowUnverifiedResume } = {}) {
  if (sandbox !== 'read-only' && sandbox !== 'workspace-write') {
    throw new Error('invalid_sandbox');
  }

  const args = ['--json', '--skip-git-repo-check', '--sandbox', sandbox];
  if (model !== undefined) {
    if (typeof model !== 'string' || !/^[A-Za-z0-9._-]+$/.test(model)) {
      throw new Error('invalid_model');
    }
    args.push(`--model=${model}`);
  }
  if (effort !== undefined) {
    if (!['low', 'medium', 'high'].includes(effort)) throw new Error('invalid_effort');
    args.push('-c', `model_reasoning_effort="${effort}"`);
  }

  if (resumeSessionId !== undefined) {
    return buildResumeArgs(resumeSessionId, args, allowUnverifiedResume);
  }
  return ['exec', ...args];
}

function createCodexParser({ sessionId }) {
  let turnId = randomUUID();
  let seq = 0;

  function event(type, fields) {
    return { type, sessionId, turnId, seq: ++seq, ...fields };
  }

  function finishTurn(fields) {
    const finished = event('turn_finished', fields);
    turnId = randomUUID();
    return finished;
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
    switch (record?.type) {
      case 'thread.started':
        sessionId = record.thread_id ?? sessionId;
        return [event('session_started')];
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

module.exports = { buildCodexArgs, createCodexParser };
