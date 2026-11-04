'use strict';

// The browser's view ID correlates one ttyd connection with one tmux session.
// A random, short-lived ticket then binds an upload to the pane observed at
// capture time. Failure is closed: the caller can still offer the saved path.
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const viewPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ticketPattern = /^[a-f0-9]{48}$/;
const ticketLifetimeMs = 10 * 60 * 1000;
const maxTickets = 100;

function shellQuote(value) {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'";
}

function createUploadTargets(server, tmux = 'tmux') {
  const tickets = new Map();
  const command = async (...args) => {
    if (!server) throw new Error('Target capture unavailable');
    return (await run(tmux, ['-L', server, ...args], { timeout: 3000, maxBuffer: 32768 })).stdout;
  };
  const prune = () => {
    const now = Date.now();
    for (const [id, record] of tickets) if (record.expires <= now) tickets.delete(id);
  };
  const lookup = id => {
    prune();
    if (typeof id !== 'string' || !ticketPattern.test(id)) return null;
    return tickets.get(id) || null;
  };
  return {
    async capture(view, session, pane) {
      prune();
      if (tickets.size >= maxTickets) throw new Error('Target capture unavailable');
      let captured = null;
      if (typeof view === 'string' && viewPattern.test(view) && typeof session === 'string' &&
          session.startsWith(`view-${view}-`) && /^\d+$/.test(session.slice(`view-${view}-`.length)) &&
          typeof pane === 'string' && /^%\d+$/.test(pane)) {
        try {
          const sessions = (await command('list-sessions', '-F', '#{session_name}|#{session_attached}')).trim().split('\n');
          const prefix = `view-${view}-`;
          const matches = sessions.map(line => line.split('|')).filter(([name, attached]) =>
            name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)) && attached === '1');
          if (matches.length === 1 && matches[0][0] === session) {
            const sessionId = (await command('display-message', '-p', '-t', `=${session}:`, '#{session_id}')).trim();
            const panes = (await command('list-panes', '-s', '-t', `=${session}`,
              '-F', '#{pane_id}|#{window_index}|#{pane_index}')).trim().split('\n');
            const details = panes.map(line => line.split('|')).find(([id]) => id === pane) || [];
            const [, windowIndex, paneIndex] = details;
            if (/^\$\d+$/.test(sessionId) && /^\d+$/.test(windowIndex) &&
                /^\d+$/.test(paneIndex) && /^%\d+$/.test(pane)) {
              captured = { session, sessionId, windowIndex, paneIndex, pane };
            }
          }
        } catch { /* Save and copy still work if tmux cannot be identified. */ }
      }
      const ticket = crypto.randomBytes(24).toString('hex');
      tickets.set(ticket, { target: captured, expires: Date.now() + ticketLifetimeMs, path: null, busy: false });
      return { ticket, target: captured ? { windowIndex: captured.windowIndex, paneIndex: captured.paneIndex } : null };
    },
    bind(ticket, path) {
      const record = lookup(ticket);
      if (!record || record.path !== null || typeof path !== 'string') return false;
      record.path = path;
      return true;
    },
    result(ticket) {
      const record = lookup(ticket);
      if (!record) throw new Error('Upload receipt unavailable');
      return { path: record.path, pending: record.path === null };
    },
    async insert(ticket) {
      const record = lookup(ticket);
      if (!record || !record.path || !record.target || record.busy) throw new Error('Target unavailable');
      record.busy = true;
      const buffer = `web-terminal-upload-${ticket}`;
      let bufferCreated = false;
      try {
        const current = (await command('display-message', '-p', '-t', `=${record.target.session}:`, '#{session_id}')).trim();
        if (current !== record.target.sessionId) throw new Error('Target unavailable');
        const panes = (await command('list-panes', '-s', '-t', `=${record.target.session}`, '-F', '#{pane_id}')).trim().split('\n');
        if (!panes.includes(record.target.pane)) throw new Error('Target unavailable');
        await command('set-buffer', '-b', buffer, '--', shellQuote(record.path));
        bufferCreated = true;
        // -p honors bracketed-paste mode; -d deletes only this unique buffer.
        await command('paste-buffer', '-p', '-d', '-b', buffer, '-t', record.target.pane);
        bufferCreated = false;
        tickets.delete(ticket);
      } catch (error) {
        // Do not retry an uncertain paste automatically: it may have arrived.
        tickets.delete(ticket);
        throw error;
      } finally {
        if (bufferCreated) await command('delete-buffer', '-b', buffer).catch(() => {});
      }
    },
  };
}

module.exports = { createUploadTargets };
