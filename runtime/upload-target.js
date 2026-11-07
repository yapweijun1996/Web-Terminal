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
    async capture(view, session, expectedSessionId, pane, serverPid) {
      prune();
      if (tickets.size >= maxTickets) throw new Error('Target capture unavailable');
      let captured = null;
      if (typeof view === 'string' && viewPattern.test(view) && typeof session === 'string' &&
          session.startsWith(`view-${view}-`) && /^\d+$/.test(session.slice(`view-${view}-`.length)) &&
          typeof expectedSessionId === 'string' && /^\$\d+$/.test(expectedSessionId) &&
          typeof pane === 'string' && /^%\d+$/.test(pane) && typeof serverPid === 'string' && /^\d+$/.test(serverPid)) {
        try {
          const sessions = (await command('list-sessions', '-F', '#{session_name}|#{session_attached}')).trim().split('\n');
          const prefix = `view-${view}-`;
          const matches = sessions.map(line => line.split('|')).filter(([name, attached]) =>
            name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)) && attached === '1');
          if (matches.length === 1 && matches[0][0] === session) {
            const sessionId = (await command('display-message', '-p', '-t', `=${session}:`, '#{session_id}')).trim();
            const panes = (await command('list-panes', '-s', '-t', `=${session}`,
              '-F', '#{pane_id}|#{window_index}|#{pane_index}|#{pid}')).trim().split('\n');
            const details = panes.map(line => line.split('|')).find(([id, , , pid]) => id === pane && pid === serverPid) || [];
            const [, windowIndex, paneIndex] = details;
            if (sessionId === expectedSessionId && /^\d+$/.test(windowIndex) && /^\d+$/.test(paneIndex)) {
              captured = { session, sessionId, windowIndex, paneIndex, pane, serverPid };
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
    async returnToLive(view, session, sessionId, pane, serverPid) {
      const captured = await this.capture(view, session, sessionId, pane, serverPid);
      const record = lookup(captured.ticket);
      tickets.delete(captured.ticket);
      if (!record?.target) throw new Error('Target unavailable');
      const current = (await command('display-message', '-p', '-t', `=${record.target.session}:`, '#{session_id}')).trim();
      const panes = (await command('list-panes', '-s', '-t', `=${record.target.session}`, '-F', '#{pane_id}|#{pid}')).trim().split('\n');
      if (current !== record.target.sessionId || !panes.includes(`${record.target.pane}|${record.target.serverPid}`)) throw new Error('Target unavailable');
      // tmux checks the pane mode itself before executing -X. This never
      // sends a key to the application or submits an existing prompt.
      await command('if-shell', '-F', '-t', record.target.pane,
        '#{||:#{==:#{pane_mode},copy-mode},#{==:#{pane_mode},copy-mode-vi}}',
        `send-keys -X -t ${record.target.pane} cancel`);
    },
    async windows(view, session, sessionId, pane, serverPid, action = 'list', windowId, browserTabs = false) {
      const captured = await this.capture(view, session, sessionId, pane, serverPid);
      const record = lookup(captured.ticket);
      tickets.delete(captured.ticket);
      if (!record?.target) throw new Error('Target unavailable');
      if (!['list', 'native', 'select', 'close'].includes(action)) throw new Error('Window action unavailable');
      const setViewStatus = async value => {
        // Session-local option: other grouped views and workspace stay unchanged.
        const condition = `#{&&:#{==:#{pid},${serverPid}},#{==:#{session_id},${sessionId}}}`;
        const output = await command('if-shell', '-F', '-t', `${sessionId}:`, condition,
          `set-option -t ${sessionId} status ${value} ; display-message -p WT_STATUS_OK`,
          'display-message -p WT_STATUS_UNAVAILABLE');
        if (output.trim() !== 'WT_STATUS_OK') throw new Error('View unavailable');
      };
      // Restoring navigation must work even when listing windows is unavailable.
      if (action === 'native') {
        const saved = (await command('show-options', '-qv', '-t', sessionId, '@web-terminal-native-status')).trim();
        await setViewStatus(/^(?:on|off|[1-5])$/.test(saved) ? saved : 'on');
        await command('set-option', '-u', '-t', sessionId, '@web-terminal-native-status');
        return { restored: true };
      }
      if (action === 'select' || action === 'close') {
        if (typeof windowId !== 'string' || !/^@\d+$/.test(windowId)) throw new Error('Window unavailable');
        // Resolve in the confirmed view, then guard identity and last-window
        // preservation in tmux's command queue, not in a read-then-kill check.
        const condition = `#{&&:#{==:#{pid},${serverPid}},#{&&:#{==:#{session_id},${sessionId}},#{&&:#{==:#{window_id},${windowId}},${action === 'close' ? '#{>:#{session_windows},1}' : '1'}}}}`;
        const output = await command('if-shell', '-F', '-t', `${sessionId}:${windowId}`, condition,
          `${action === 'close' ? 'kill-window' : 'select-window'} -t ${sessionId}:${windowId} ; display-message -p WT_WINDOW_OK`,
          'display-message -p WT_WINDOW_UNAVAILABLE');
        if (output.trim() !== 'WT_WINDOW_OK') throw new Error('Window unavailable or last window');
      }
      const rows = (await command('list-windows', '-t', sessionId, '-F', '#{window_id}|#{window_index}|#{window_active}')).trim().split('\n');
      if (rows.length > 100) throw new Error('Window list unavailable');
      const windows = [];
      for (const row of rows.slice(0, 100)) {
        const match = /^(@\d+)\|(\d+)\|([01])$/.exec(row);
        if (!match) throw new Error('Window list unavailable');
        const name = (await command('display-message', '-p', '-t', `${sessionId}:${match[1]}`, '#{window_name}')).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 160).trim();
        const process = (await command('display-message', '-p', '-t', `${sessionId}:${match[1]}`, '#{pane_current_command}')).replace(/[\x00-\x1f\x7f]/g, '').trim().split(/[\\/]/).pop().slice(0, 80);
        windows.push({ id: match[1], index: match[2], active: match[3] === '1', name, process });
      }
      if (browserTabs) {
        const saved = (await command('show-options', '-qv', '-t', sessionId, '@web-terminal-native-status')).trim();
        if (!saved) {
          const status = (await command('show-options', '-Av', '-t', sessionId, 'status')).trim();
          if (!/^(?:on|off|[1-5])$/.test(status)) throw new Error('View status unavailable');
          await command('set-option', '-t', sessionId, '@web-terminal-native-status', status);
        }
        await setViewStatus('off');
      }
      return { windows };
    },
    async insert(ticket, requireCurrent = false) {
      const record = lookup(ticket);
      if (!record || !record.path || !record.target || record.busy) throw new Error('Target unavailable');
      record.busy = true;
      const buffer = `web-terminal-upload-${ticket}`;
      let bufferCreated = false;
      try {
        const current = (await command('display-message', '-p', '-t', `=${record.target.session}:`, '#{session_id}')).trim();
        if (current !== record.target.sessionId) throw new Error('Target unavailable');
        const panes = (await command('list-panes', '-s', '-t', `=${record.target.session}`, '-F', '#{pane_id}|#{pid}')).trim().split('\n');
        if (!panes.includes(`${record.target.pane}|${record.target.serverPid}`)) throw new Error('Target unavailable');
        await command('set-buffer', '-b', buffer, '--', shellQuote(record.path));
        bufferCreated = true;
        // -p honors bracketed-paste mode; -d deletes only this unique buffer.
        if (requireCurrent) {
          // Evaluate the view's active pane in tmux's own command queue. The
          // paste still targets the captured pane, never a newly selected one.
          const condition = `#{&&:#{==:#{session_id},${record.target.sessionId}},#{&&:#{==:#{pane_id},${record.target.pane}},#{==:#{pane_in_mode},0}}}`;
          const output = await command('if-shell', '-F', '-t', `=${record.target.session}:`, condition,
            `paste-buffer -p -d -b ${buffer} -t ${record.target.pane} ; display-message -p WT_INSERTED`,
            'display-message -p WT_TARGET_CHANGED');
          if (output.trim() !== 'WT_INSERTED') throw new Error('Target unavailable');
        } else {
          await command('paste-buffer', '-p', '-d', '-b', buffer, '-t', record.target.pane);
        }
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
