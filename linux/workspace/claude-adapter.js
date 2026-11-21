'use strict';

const { randomUUID } = require('node:crypto');

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MODEL_PATTERN = /^[A-Za-z0-9._-]+$/;

// The caller sets the child process cwd from a server-managed workspace.
function buildClaudeArgs(options = {}) {
  if (Object.hasOwn(options, 'cwd')) {
    throw new TypeError('Set cwd on the child process, not in Claude arguments');
  }

  const { resumeSessionId, model, maxBudgetUsd, approvalMode = 'deny' } = options;
  const args = [
    '-p', '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--permission-mode', 'manual',
  ];

  if (approvalMode === 'prompt') {
    args.push('--permission-prompts', 'host', '--permission-prompt-tool', 'stdio');
  } else if (approvalMode === 'deny') {
    args.push('--permission-prompts', 'none');
  } else {
    throw new TypeError('approvalMode must be prompt or deny');
  }

  if (resumeSessionId !== undefined) {
    if (typeof resumeSessionId !== 'string' || !UUID_PATTERN.test(resumeSessionId)) {
      throw new TypeError('resumeSessionId must be a UUID');
    }
    args.push('--resume', resumeSessionId);
  }
  if (model !== undefined) {
    if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) {
      throw new TypeError('model must contain only letters, digits, periods, underscores, or hyphens');
    }
    if (model.startsWith('-')) {
      args.push(`--model=${model}`);
    } else {
      args.push('--model', model);
    }
  }
  if (maxBudgetUsd !== undefined) {
    if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
      throw new TypeError('maxBudgetUsd must be a finite positive number');
    }
    args.push('--max-budget-usd', String(maxBudgetUsd));
  }
  return args;
}

function createClaudeParser({ sessionId }) {
  let seq = 0;
  let turnId = randomUUID();
  const activeMessages = new Map();
  const streamedText = new Map();
  const completedMessages = new Set();
  const approvalIds = new Map();

  function event(type, fields = {}) {
    return { type, sessionId, turnId, seq: ++seq, ...fields };
  }

  function parseStreamEvent(record) {
    const update = record.event;
    const scope = record.parent_tool_use_id ?? null;
    if (update?.type === 'message_start') {
      activeMessages.set(scope, update.message?.id);
    } else if (update?.type === 'message_stop') {
      activeMessages.delete(scope);
    } else if (update?.type === 'content_block_delta' && update.delta?.type === 'text_delta') {
      const messageId = activeMessages.get(scope);
      const { text } = update.delta;
      if (messageId && typeof text === 'string') {
        if (!completedMessages.has(messageId)) {
          streamedText.set(messageId, (streamedText.get(messageId) ?? '') + text);
        }
        return [event('message_delta', { messageId, text })];
      }
    }
    return [];
  }

  function parseAssistant(message) {
    if (!Array.isArray(message?.content)) return [];

    const events = [];
    const messageId = message.id;
    const textBlocks = message.content.filter(block => block?.type === 'text' && typeof block.text === 'string');
    for (const block of message.content) {
      if (block?.type === 'tool_use') {
        events.push(event('tool_call_start', {
          toolCallId: block.id,
          name: block.name,
          input: block.input,
        }));
      } else if (block && block === textBlocks[0] && messageId && !completedMessages.has(messageId)) {
        const text = textBlocks.map(part => part.text).join('');
        completedMessages.add(messageId);
        streamedText.delete(messageId);
        events.push(event('message_done', { messageId, text }));
      }
    }
    return events;
  }

  function finishTurn(record) {
    const events = [...streamedText].map(([messageId, text]) => event('message_done', { messageId, text }));
    const cancelled = ['cancelled', 'interrupted'].includes(record.terminal_reason);
    if (record.is_error) {
      const details = Array.isArray(record.errors)
        ? record.errors.filter(error => typeof error === 'string').join('\n')
        : '';
      events.push(event('error', {
        code: record.subtype ?? 'CLAUDE_RESULT_ERROR',
        message: details || (typeof record.result === 'string' && record.result) || 'Claude Code reported a turn error',
      }));
    }
    events.push(event('turn_finished', {
      status: cancelled ? 'cancelled' : record.is_error ? 'error' : 'success',
      ...(typeof record.total_cost_usd === 'number' && { costUsd: record.total_cost_usd }),
      ...(record.usage && { usage: record.usage }),
    }));
    turnId = randomUUID();
    activeMessages.clear();
    streamedText.clear();
    completedMessages.clear();
    approvalIds.clear();
    return events;
  }

  function push(line) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return [event('error', {
        code: 'MALFORMED_JSON',
        message: 'Claude Code emitted malformed JSON',
      })];
    }

    switch (record?.type) {
      case 'system':
        if (record.subtype === 'init') {
          return [event('session_started', { cliSessionId: record.session_id })];
        }
        if (record.subtype === 'permission_denied') {
          return [event('approval_decision', {
            approvalId: approvalIds.get(record.tool_use_id) ?? record.request_id ?? record.tool_use_id ?? record.uuid,
            decision: 'deny',
            reason: record.decision_reason ?? record.message ?? 'Claude Code denied the tool call',
          })];
        }
        return [];
      case 'stream_event':
        return parseStreamEvent(record);
      case 'assistant':
        return parseAssistant(record.message);
      case 'user':
        if (!Array.isArray(record.message?.content)) return [];
        return record.message.content
          .filter(block => block?.type === 'tool_result')
          .map(block => event('tool_call_output', {
            toolCallId: block.tool_use_id,
            output: block.content,
            isError: block.is_error === true,
          }));
      case 'control_request': {
        const { request } = record;
        if (request?.subtype !== 'can_use_tool') return [];
        if (request.tool_use_id) approvalIds.set(request.tool_use_id, record.request_id);
        return [event('approval_request', {
          approvalId: record.request_id,
          toolCallId: request.tool_use_id,
          toolName: request.tool_name,
          input: request.input,
          options: ['allow', 'deny'],
        })];
      }
      case 'result':
        return finishTurn(record);
      default:
        return [];
    }
  }

  return { push };
}

function buildApprovalResponse({ requestId, decision, message }) {
  if (decision !== 'allow' && decision !== 'deny') {
    throw new TypeError('decision must be allow or deny');
  }
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new TypeError('requestId must be a nonempty string');
  }
  if (message !== undefined && typeof message !== 'string') {
    throw new TypeError('message must be a string');
  }
  if (decision === 'deny' && !message?.trim()) message = 'The user denied this action.';

  return JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: { behavior: decision, message },
    },
  }) + '\n';
}

function buildUserMessage(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
}

module.exports = { buildClaudeArgs, createClaudeParser, buildApprovalResponse, buildUserMessage };
