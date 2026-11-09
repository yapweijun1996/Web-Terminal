'use strict';
const fs = require('node:fs');
// Bounded, fixed-schema operational diagnostics. No request data, identities,
// session names, tokens or terminal contents are accepted for output.
const events = new Set(['control', 'resume', 'pause', 'auto_resume', 'drops']);
const actions = new Set(['resume', 'pause', 'takeover', 'none']);
const reasons = new Set(['accepted', 'owner_auth', 'csrf', 'binding', 'busy', 'uncertain', 'invalid', 'aborted', 'human_input', 'manual', 'owner_expired', 'owner_unavailable', 'owner_changed', 'in_flight', 'grant_revoked', 'unknown']);
const states = new Set(['sharing', 'paused', 'manual-paused', 'unknown', 'owner-active', 'pause-pending', 'none']);
const statuses = new Set([0, 200, 400, 401, 403, 409, 413, 500, 503]);
const WINDOW_MS = 10000;
const MAX_EVENTS_PER_WINDOW = 20;
const MAX_HUMAN_EVENTS_PER_WINDOW = 1;
const MAX_BUFFERED_BYTES = 16384;
const MAX_COUNT = 2147483647;
const cap = n => n < MAX_COUNT ? n + 1 : MAX_COUNT;
const allow = (set, value, fallback) => set.has(value) ? value : fallback;
// Only Linux nonblocking sockets/pipes are permitted as production stderr
// destinations. Files, terminals and unknown fd types may synchronously
// block the event loop on POSIX Node and therefore fail closed.
function nonBlockingStderr({ fd = 2, platform = process.platform, stat = fs.fstatSync, read = fs.readFileSync } = {}) {
  if (platform !== 'linux') return false;
  try {
    const info = stat(fd);
    if (!info.isSocket() && !info.isFIFO()) return false;
    const match = /^flags:\s*([0-7]+)\s*$/m.exec(read(`/proc/self/fdinfo/${fd}`, 'utf8'));
    return !!match && (parseInt(match[1], 8) & fs.constants.O_NONBLOCK) !== 0;
  } catch { return false; }
}

// At most 20 ordinary events + 1 human event + 1 drop summary per 10 s.
// No application-side log queue; stop before adding to a backed-up stream.
// A single unref'ed timer reports dropped events even if the burst has ended.
// The production logger installs a permanent error listener before writing;
// EPIPE / async output errors disable diagnostics, never input authority.
function createTelemetry(write = null, { now = Date.now, ready = () => true,
  later = (fn, ms) => setTimeout(fn, ms), cancel = clearTimeout,
  stream = process.stderr, inspectStderr = nonBlockingStderr,
  windowMs = WINDOW_MS, eventLimit = MAX_EVENTS_PER_WINDOW,
  humanLimit = MAX_HUMAN_EVENTS_PER_WINDOW } = {}) {
  const usesStderr = write === null;
  let disabled = false, needDrain = false;
  let summaryTimer = null;
  function disable() {
    disabled = true;
    if (summaryTimer !== null) { try { cancel(summaryTimer); } catch {} summaryTimer = null; }
  }
  if (usesStderr) {
    try {
      if (!inspectStderr() || typeof stream?.on !== 'function' || typeof stream?.write !== 'function') disabled = true;
      else {
        stream.on('error', disable);
        stream.on('close', disable);
        stream.on('drain', () => { needDrain = false; });
      }
    } catch { disable(); }
  }
  const sink = usesStderr ? line => stream.write(line + '\n') : write;
  const canWrite = usesStderr ? bytes => !disabled && !needDrain && !stream.destroyed &&
    !stream.writableEnded && !stream.writableNeedDrain &&
    Number.isSafeInteger(stream.writableLength) && stream.writableLength + bytes <= MAX_BUFFERED_BYTES
    : ready;
  let windowStart = now(), used = 0, humanUsed = 0;
  let droppedRate = 0, droppedBackpressure = 0;
  function rotate(t) {
    if (t >= windowStart + windowMs || t < windowStart) { windowStart = t; used = 0; humanUsed = 0; }
  }
  function entry({ event, action = 'none', reason = 'unknown', state = 'none', status = 0, binding = 'not_checked' } = {}, rate = 0, backpressure = 0) {
    return {
      type: 'web_terminal_collaboration_diagnostic_v1',
      event: allow(events, event, 'control'),
      action: allow(actions, action, 'none'),
      reason: allow(reasons, reason, 'unknown'),
      state: allow(states, state, 'none'),
      status: statuses.has(status) ? status : 0,
      binding: binding === 'matched' || binding === 'rejected' ? binding : 'not_checked',
      droppedRate: rate,
      droppedBackpressure: backpressure,
    };
  }
  function tryWrite(value) {
    try {
      const line = JSON.stringify(value);
      if (disabled || !canWrite(Buffer.byteLength(line) + 1)) return false;
      // A false return means the line was accepted into the Node stream, but
      // future writes must wait for drain. Never enqueue another log line.
      if (usesStderr && sink(line) === false) needDrain = true;
      else if (!usesStderr) sink(line);
      return true;
    } catch { disable(); return false; }
  }
  function scheduleSummary() {
    if (disabled || summaryTimer !== null) return;
    const delay = Math.max(1, windowStart + windowMs - now());
    summaryTimer = later(() => {
      summaryTimer = null;
      try {
        if (disabled || (!droppedRate && !droppedBackpressure)) return;
        rotate(now());
        if (tryWrite(entry({ event: 'drops' }, droppedRate, droppedBackpressure))) {
          droppedRate = 0; droppedBackpressure = 0;
        } else scheduleSummary();
      } catch { /* never affect input authorization */ }
    }, delay);
    summaryTimer?.unref?.();
  }
  function drop(kind) {
    if (disabled) return;
    if (kind === 'rate') droppedRate = cap(droppedRate);
    else droppedBackpressure = cap(droppedBackpressure);
    scheduleSummary();
  }
  return function record(value) {
    try {
      if (disabled) return;
      const t = now(); rotate(t);
      const human = value?.event === 'pause' && value?.reason === 'human_input';
      if (human ? humanUsed >= humanLimit : used >= eventLimit) return drop('rate');
      if (!tryWrite(entry(value))) return drop('backpressure');
      if (human) humanUsed++; else used++;
    } catch { /* logging is not an authorization dependency */ }
  };
}
module.exports = { createTelemetry, nonBlockingStderr };
