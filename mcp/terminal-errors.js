// Only locally constructed errors may select a public, fixed diagnostic.
const messages = Object.freeze({
  CONTROL_CHAR_OR_MULTILINE: "Text contains a control character or multiple lines. Nothing was sent. Do not split it into automatic typing/Enter calls. Review multiline content in the owner's direct editor or terminal; use only an owner-approved delegated connection for MCP input.",
  COLLABORATION_UNAVAILABLE: "The collaboration coordinator is unavailable or the input outcome is uncertain. Never retry input automatically. Keep human recovery access available.",
  INPUT_PAUSED: "AI input is paused by the owner. Wait for deliberate sharing to resume; do not retry input automatically.",
  STALE_INPUT_GENERATION: "A current inputGeneration is required and the supplied generation may be stale. Verify the target and owner sharing state; do not substitute a fresh generation and retry an old action.",
  INPUT_BUSY: "Another input operation is active for this target, or the write capacity is full. Nothing was sent. Wait for that operation to finish and verify the pane before a new deliberate action.",
  INVALID_INPUT: "Text must be a non-empty string of at most 8192 UTF-8 bytes. Nothing was sent.",
  INVALID_TARGET: "Invalid terminal target. List terminals to obtain a current target.",
  STALE_TARGET: "The target changed or its input guard rejected the operation. List terminals and verify the intended pane. Never retry input automatically: an earlier operation may have arrived.",
  AUTHORITY_UNAVAILABLE: "MCP terminal input is disabled by deployment policy, or a trusted request admission is unavailable. Use the owner's direct browser or tmux controls. Nothing was sent.",
  OPERATION_UNAVAILABLE: "Operation unavailable. Never retry input automatically: it may have arrived.",
});
const codes = new WeakMap();
export class TerminalError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(messages, code) ? code : "OPERATION_UNAVAILABLE";
    super(messages[safeCode]);
    this.name = "TerminalError";
    this.code = safeCode;
    codes.set(this, this.code);
  }
}
export function terminalErrorResult(error) {
  const code = codes.get(error) || "OPERATION_UNAVAILABLE";
  return { isError: true, content: [{ type: "text", text: `${code}: ${messages[code]}` }] };
}
export function validateTerminalText(text) {
  if (typeof text !== "string" || !text.length || Buffer.byteLength(text) > 8192)
    throw new TerminalError("INVALID_INPUT");
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(text))
    throw new TerminalError("CONTROL_CHAR_OR_MULTILINE");
}
