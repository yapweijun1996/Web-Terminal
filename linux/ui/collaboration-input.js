'use strict';
// ttyd's pinned xterm reports protocol replies through onData too. Preserve its
// own wasUserInput provenance instead of guessing intent from escape bytes.
(() => {
  let source = 'unknown', installed = null;
  function asHuman(fn, receiver, args) {
    const previous = source; source = 'human';
    try { return Reflect.apply(fn, receiver, args); } finally { source = previous; }
  }
  function install(term) {
    if (!term || term === installed) return;
    const service = term._core?.coreService;
    if (typeof service?.triggerDataEvent !== 'function') return; // Unknown builds retain fail-safe owner takeover on all input.
    const trigger = service.triggerDataEvent;
    // The shipped ttyd/xterm method explicitly defaults its second parameter to
    // false. Recognize that feature before normalizing an omitted parameter;
    // unknown implementations keep omitted/null provenance fail-safe.
    const omittedMeansProtocol = /triggerDataEvent\([^,]+,[^=,)]+=(?:!1|false)\)/.test(Function.prototype.toString.call(trigger).replace(/\s+/g, ''));
    const restore = [];
    try {
    service.triggerDataEvent = function (data, wasUserInput) {
      const previous = source;
      if (source !== 'human') source = wasUserInput === true ? 'human' : wasUserInput === false || (wasUserInput === undefined && omittedMeansProtocol) ? 'protocol' : 'unknown';
      try { return Reflect.apply(trigger, this, arguments); } finally { source = previous; }
    };
    restore.push(() => { service.triggerDataEvent = trigger; });
    // ttyd 1.7.4's xterm lacks the newer public input() API used by our mobile
    // toolbar. Adapt it through the same verified core user-input service.
    const previousInput = term.input;
    restore.push(() => { if (previousInput === undefined) delete term.input; else term.input = previousInput; });
    if (typeof term.input !== 'function') term.input = function (data) {
      if (typeof data !== 'string') throw new TypeError('Terminal input must be text');
      return asHuman(trigger, service, [data, true]);
    };
    // Mobile keys and clipboard bridges deliberately use the public input APIs.
    for (const name of ['input', 'paste']) if (typeof term[name] === 'function') {
      const fn = term[name]; restore.push(() => { term[name] = fn; }); term[name] = function (...args) { return asHuman(fn, this, args); };
    }
    installed = term;
    } catch { for (const undo of restore.reverse()) { try { undo(); } catch {} } }
  }
  window.installCollaborationInputProvenance = (socket, getTerminal) => {
    const send = socket.send;
    socket.send = function (data, ...rest) {
      install(getTerminal());
      if (source === 'protocol') {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
        if (bytes?.[0] === 48) { const tagged = new Uint8Array(bytes); tagged[0] = 52; return Reflect.apply(send, this, [tagged, ...rest]); }
      }
      return Reflect.apply(send, this, [data, ...rest]);
    };
    install(getTerminal());
  };
})();
