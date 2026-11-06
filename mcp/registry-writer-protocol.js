// Portable candidate only. This module does not authenticate or persist anything.
export const MAX_REQUEST_BYTES = 4096;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const nonce = /^[0-9a-f]{64}$/;
export class ProtocolError extends Error {
  constructor(code) { super(code); this.code = code; }
}
// V1 is a flat object of scalar values. Tokenize its keys before parsing so
// escaped spellings of the same key cannot be interpreted differently.
function parseFlatJson(text) {
  let i = 0;
  const ws = () => { while (/[\x20\t\r\n]/.test(text[i] ?? '') && i < text.length) i++; };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '"') return JSON.parse(text.slice(start, ++i));
      if (text[i++] === '\\') i++;
    }
    throw Error('unterminated string');
  };
  ws(); if (text[i++] !== '{') throw Error('object required');
  const keys = new Set(); ws();
  if (text[i] !== '}') for (;;) {
    ws(); if (text[i] !== '"') throw Error('key required');
    const key = string(); if (keys.has(key)) throw Error('duplicate key'); keys.add(key);
    ws(); if (text[i++] !== ':') throw Error('colon required'); ws();
    if (text[i] === '"') string();
    else { const start = i; while (i < text.length && !/[\x20\t\r\n,}]/.test(text[i])) i++; if (start === i) throw Error('value required'); JSON.parse(text.slice(start, i)); }
    ws(); if (text[i] !== ',') break; i++;
  }
  if (text[i++] !== '}') throw Error('object end required'); ws();
  if (i !== text.length) throw Error('trailing data');
  return JSON.parse(text);
}
export function parseRequest(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_REQUEST_BYTES) throw new ProtocolError("INVALID_FRAME");
  let request;
  try { request = parseFlatJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { throw new ProtocolError("INVALID_JSON"); }
  if (!request || Array.isArray(request) || typeof request !== "object" || Object.keys(request).sort().join(",") !== "job_id,nonce,request_id,type,version" || request.version !== 1 || request.type !== "outcome" || typeof request.job_id !== "string" || !uuid.test(request.job_id) || typeof request.request_id !== "string" || !uuid.test(request.request_id) || typeof request.nonce !== "string" || !nonce.test(request.nonce)) throw new ProtocolError("INVALID_REQUEST");
  return Object.freeze(request);
}
// Internal events are model inputs, never accepted from a client transport. This
// pure transition is a simulation, not terminal evidence or an anti-replay journal.
export function simulateTransition(state, event) {
  if (!state || !event || typeof event !== 'object' || Array.isArray(event) || Object.keys(event).sort().join(',') !== 'instance_id,job_id,nonce,phase,sequence' || typeof event.job_id !== "string" || !uuid.test(event.job_id) || typeof event.instance_id !== "string" || !uuid.test(event.instance_id) || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || typeof event.nonce !== "string" || !nonce.test(event.nonce)) throw new ProtocolError("INVALID_EVENT");
  if (!Number.isSafeInteger(state.sequence) || state.sequence < 0 || !Array.isArray(state.nonces) || state.nonces.length > 128 || state.nonces.some(n => typeof n !== "string" || !nonce.test(n)) || new Set(state.nonces).size !== state.nonces.length) throw new ProtocolError("INVALID_STATE");
  if (state.job_id !== event.job_id || state.instance_id !== event.instance_id) throw new ProtocolError("INSTANCE_CONFLICT");
  if (state.nonces.length >= 128 || event.sequence !== state.sequence + 1 || state.nonces.includes(event.nonce)) throw new ProtocolError("REPLAY_OR_ORDER");
  if (state.phase !== "running" || !["unknown", "terminal"].includes(event.phase)) throw new ProtocolError("INVALID_TRANSITION");
  return Object.freeze({ ...state, sequence: event.sequence, phase: event.phase, nonces: Object.freeze([...state.nonces, event.nonce]) });
}
