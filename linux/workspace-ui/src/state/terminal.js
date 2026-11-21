export function isTerminalId(value) {
  return typeof value === 'string' && value.length === 16 && /^web-[a-f0-9]{12}$/.test(value);
}

export function terminalReducer(state, action) {
  switch (action.type) {
    case 'open':
      return state.status === 'idle' ? { status: 'loading' } : state;
    case 'retry':
      return state.status === 'error' ? { status: 'loading' } : state;
    case 'created':
      if (state.status !== 'loading') return state;
      return isTerminalId(action.terminalId)
        ? { status: 'ready', url: `/terminal/${action.terminalId}/` }
        : { status: 'error', message: 'The workspace server returned an unexpected response.' };
    case 'failed':
      if (state.status !== 'loading') return state;
      if (action.error?.status === 404) return { status: 'disabled' };
      return { status: 'error', message: action.error?.message || 'Could not open the terminal.' };
    default:
      return state;
  }
}
