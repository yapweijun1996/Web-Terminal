export function isSubmitKey(event) {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

export function sendDisabledReason(draft, blockedReason) {
  return blockedReason ?? (draft.trim() ? null : 'Enter a message to send.');
}

export function composerBlockedReason({ mode, sending, running, ended }) {
  if (mode === 'loading') return 'Loading projects.';
  if (mode === 'error') return 'The workspace could not load.';
  if (ended) return 'Start a new session to send.';
  if (sending) return 'Sending…';
  if (running) return 'The agent is still working.';
  return null;
}
