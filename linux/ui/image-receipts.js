'use strict';

const crypto = require('node:crypto');
const sessionPattern = /^(shared|web-[a-f0-9]{12})$/;
const ticketPattern = /^[a-f0-9]{48}$/;
const lifetime = 10 * 60 * 1000;

function shellQuote(value) {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'";
}

function createImageReceipts(tmux) {
  const receipts = new Map();
  const lookup = ticket => {
    const now = Date.now();
    for (const [id, value] of receipts) if (value.expires <= now) receipts.delete(id);
    return typeof ticket === 'string' && ticketPattern.test(ticket) ? receipts.get(ticket) : null;
  };
  const getTarget = input => {
    if (!input || !sessionPattern.test(input.session || '') || !/^\$\d+$/.test(input.sessionId || '') ||
        !/^%\d+$/.test(input.pane || '') || !/^\d+$/.test(input.serverPid || '')) return null;
    try {
      const lines = tmux(['list-panes', '-s', '-t', `=${input.session}`, '-F', '#{session_id}|#{pane_id}|#{window_index}|#{pane_index}|#{pid}']).trim().split('\n');
      const match = lines.map(line => line.split('|')).find(([sid, pane, , , pid]) => sid === input.sessionId && pane === input.pane && pid === input.serverPid);
      if (!match || !/^\d+$/.test(match[2]) || !/^\d+$/.test(match[3])) return null;
      return { ...input, windowIndex: match[2], paneIndex: match[3] };
    } catch { return null; }
  };
  return {
    prepare(input) {
      lookup('');
      if (receipts.size >= 100) throw Error('Receipt capacity reached');
      const target = getTarget(input);
      const ticket = crypto.randomBytes(24).toString('hex');
      receipts.set(ticket, { target, expires: Date.now() + lifetime, state: 'prepared', path: null, attempted: false });
      return { ticket, target: target && { windowIndex: target.windowIndex, paneIndex: target.paneIndex } };
    },
    start(ticket) {
      const receipt = lookup(ticket);
      if (!receipt || receipt.state !== 'prepared') return false;
      receipt.state = 'uploading';
      return true;
    },
    finish(ticket, path) {
      const receipt = lookup(ticket);
      if (!receipt || receipt.state !== 'uploading') return false;
      receipt.path = path || null;
      receipt.state = path ? 'saved' : 'failed';
      return true;
    },
    result(ticket) {
      const receipt = lookup(ticket);
      if (!receipt) throw Error('Receipt unavailable');
      return { state: receipt.state, path: receipt.path, attempted: receipt.attempted };
    },
    insert(ticket) {
      const receipt = lookup(ticket);
      if (!receipt || receipt.state !== 'saved' || !receipt.target || receipt.attempted) throw Error('Target unavailable');
      receipt.attempted = true;
      if (!getTarget(receipt.target)) throw Error('Target unavailable');
      const buffer = `web-terminal-image-${ticket}`;
      let created = false;
      try {
        tmux(['set-buffer', '-b', buffer, '--', shellQuote(receipt.path)]);
        created = true;
        tmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', receipt.target.pane]);
        created = false;
      } finally {
        if (created) { try { tmux(['delete-buffer', '-b', buffer]); } catch {} }
      }
    },
  };
}

module.exports = { createImageReceipts };
