(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TerminalStatus = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function status(level, icon, label, detail) {
    return { level, icon, label, detail };
  }

  function unknown() {
    return status('unknown', '?', 'Not reported', 'Not reported');
  }

  function deriveStatus(data) {
    data = data && typeof data === 'object' ? data : {};
    const connections = {
      connected: ['ok', '●', 'Connected', 'Terminal connection is open; task health is unknown.'],
      connecting: ['busy', '◌', 'Connecting', 'Connecting to the terminal.'],
      reconnecting: ['busy', '◌', 'Reconnecting', 'Reconnecting to the terminal; task health is unknown.'],
      disconnected: ['error', '×', 'Disconnected', 'Terminal connection is disconnected; task health is unknown.'],
      'auth-expired': ['warn', '!', 'Sign-in required', 'Authentication is required or expired; sign in again. An existing connection may remain open.']
    };
    const connectionState = data.auth === 'auth-expired' || data.auth === 'auth-required' || data.auth === 'expired'
      ? 'auth-expired' : data.connection;
    const connection = Object.hasOwn(connections, connectionState) ? status(...connections[connectionState]) : unknown();

    const sessionData = data.session && typeof data.session === 'object' ? data.session : {};
    const name = typeof sessionData.name === 'string' ? sessionData.name.trim() : '';
    const rawProcess = typeof sessionData.process === 'string' ? sessionData.process.trim() : '';
    // Process arguments are not status data. Only show a single executable name.
    const process = rawProcess && !/\s/.test(rawProcess) ? rawProcess.split(/[\\/]/).pop() : '';
    const session = name || process
      ? status('unknown', '○', name || 'Session not reported', `${process ? `Process: ${process}. ` : 'Process not reported. '}Task health unknown.`)
      : unknown();

    let input = unknown();
    if (data.input === true || data.input === 'enabled') {
      input = status('ok', '✓', 'Input enabled', 'Input is reported as enabled.');
    } else if (data.input === false || data.input === 'disabled') {
      input = status('warn', '!', 'Input disabled', 'Input is reported as disabled.');
    }

    const sharingData = data.sharing && typeof data.sharing === 'object' ? data.sharing : { state: data.sharing };
    const sharingStates = {
      sharing: ['ok', '●', 'Sharing', 'AI sharing enabled.'],
      'manual-paused': ['warn', 'Ⅱ', 'Sharing paused', 'AI sharing paused manually.'],
      paused: ['warn', 'Ⅱ', 'Sharing paused', 'AI sharing is paused.'],
      'owner-active': ['warn', 'Ⅱ', 'Owner active', 'Owner control is active.'],
      'pause-pending': ['busy', '◌', 'Pausing sharing', 'AI sharing pause is pending.'],
      unavailable: ['error', '×', 'Sharing unavailable', 'AI sharing is unavailable.']
    };
    const sharing = Object.hasOwn(sharingStates, sharingData.state) ? status(...sharingStates[sharingData.state]) : unknown();
    if (sharingData.state === 'paused' && typeof sharingData.idleRemainingMs === 'number' && Number.isFinite(sharingData.idleRemainingMs) && sharingData.idleRemainingMs >= 0) {
      sharing.detail += ` AI resumes in ${Math.ceil(sharingData.idleRemainingMs / 1000)}s.`;
    }
    return { connection, session, input, sharing };
  }

  return { deriveStatus };
});
