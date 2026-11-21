export function isSubmitKey(event) {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

export function canSendMessage(draft, disabled) {
  return !disabled && draft.trim().length > 0;
}
