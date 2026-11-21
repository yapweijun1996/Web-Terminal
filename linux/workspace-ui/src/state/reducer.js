export const emptyConversation = { lastSeq: 0, turns: [], pendingPrompt: null, error: null };

export function hasRunningTurn({ pendingPrompt, turns }, previewTurnId) {
  return Boolean(pendingPrompt) || turns.some((turn) => turn.status === 'running' && turn.id !== previewTurnId);
}

function newTurn(id, prompt = {}) {
  return { id, ...prompt, messages: [], tools: [], approvals: [], status: 'running', errors: [] };
}

function upsert(items, id, changes) {
  if (!items.some((item) => item.id === id)) return [...items, { id, ...changes() }];
  return items.map((item) => item.id === id ? { ...item, ...changes(item) } : item);
}

function applyEvent(turn, event) {
  switch (event.type) {
    case 'message_delta':
    case 'message_done':
      return { ...turn, messages: upsert(turn.messages, event.messageId, (message) => ({
        text: event.type === 'message_done' ? event.text : (message?.text ?? '') + event.text,
        done: event.type === 'message_done',
      })) };
    case 'tool_call_start':
      return { ...turn, tools: upsert(turn.tools, event.toolCallId, () => ({ name: event.name, input: event.input })) };
    case 'tool_call_output':
      return { ...turn, tools: upsert(turn.tools, event.toolCallId, () => ({ output: event.output, isError: event.isError })) };
    case 'approval_request':
      return { ...turn, approvals: upsert(turn.approvals, event.approvalId, () => ({ request: event })) };
    case 'approval_decision':
      return { ...turn, approvals: upsert(turn.approvals, event.approvalId, () => ({ decision: event.decision })) };
    case 'turn_finished':
      return {
        ...turn, status: event.status, costUsd: event.costUsd, usage: event.usage,
        approvals: turn.approvals.filter((approval) => approval.decision),
      };
    case 'error':
      return { ...turn, errors: [...turn.errors, { seq: event.seq, code: event.code, message: event.message }] };
    default:
      return turn;
  }
}

export function conversationReducer(state = emptyConversation, action) {
  switch (action.type) {
    case 'prompt':
      return { ...state, pendingPrompt: action.prompt };
    case 'discard_prompt':
      return { ...state, pendingPrompt: null };
    case 'event': {
      const { event } = action;
      if (!Number.isSafeInteger(event.seq) || event.seq <= state.lastSeq) return state;
      const next = { ...state, lastSeq: event.seq };
      if (event.type === 'session_started') return next;
      if (!event.turnId) {
        return event.type === 'error' ? { ...next, pendingPrompt: null, error: event } : next;
      }
      const knownTurn = state.turns.some((turn) => turn.id === event.turnId);
      return {
        ...next,
        pendingPrompt: knownTurn ? state.pendingPrompt : null,
        turns: upsert(state.turns, event.turnId, (turn) => applyEvent(turn ?? newTurn(event.turnId, state.pendingPrompt ?? {}), event)),
      };
    }
    default:
      return state;
  }
}
