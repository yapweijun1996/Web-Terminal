'use strict';
// Owner-only context transfer. Receipts carry authority; filenames never come from callers.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { ownerValid } = require('./collaboration');
const LIMIT = 65536, INSERT_LIMIT = 8192, FILE_TTL = 3600000, RECEIPT_TTL = 60000;
const fields = ['session', 'serverPid', 'sessionId', 'windowId', 'paneId', 'panePid'];
const fail = code => { throw Object.assign(Error(code), { code }); };
const digest = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
function validateText(text, insert = false) {
  if (typeof text !== 'string' || !text.length || Buffer.byteLength(text, 'utf8') > (insert ? INSERT_LIMIT : LIMIT) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) fail('INVALID_CONTEXT');
  if ((insert ? /[\x00-\x1f\x7f-\x9f\u2028\u2029]/ : /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/).test(text)) fail('INVALID_CONTEXT');
  return text;
}
function createContextPaste({ tmux, controller, coordinator, directory, now = () => performance.now(), wallNow = () => Date.now() }) {
  const receipts = new Map(), files = new Map();
  function ownerCheck(owner) { if (!ownerValid(owner)) fail('AUTHORITY_UNAVAILABLE'); }
  function privateDirectory() {
    if (!path.isAbsolute(directory || '')) fail('CONTEXT_UNAVAILABLE');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('CONTEXT_UNAVAILABLE');
  }
  function clients() {
    // Conservative: a native switch or disconnect in any attached client retires
    // the confirmation. No guess based on the browser's OSC/title is authority.
    const value = tmux(['display-message', '-p', '#{L:#{?#{client_tty},#{client_pid}|#{client_session};,}}']).trim();
    if (!/^(?:[1-9]\d*\|(?:shared|web-[a-f0-9]{12});)*$/.test(value)) fail('STALE_TARGET');
    return value;
  }
  function capture(session, expected) {
    if (!/^(shared|web-[a-f0-9]{12})$/.test(session || '')) fail('STALE_TARGET');
    const values = tmux(['display-message', '-p', '-t', `=${session}:`, '#{session_name}|#{pid}|#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}|#{pane_dead}|#{pane_in_mode}']).trim().split('|');
    const target = Object.fromEntries(fields.map((key, i) => [key, values[i]]));
    if (target.session !== session || !/^\d+$/.test(target.serverPid) || !/^\$\d+$/.test(target.sessionId) || !/^@\d+$/.test(target.windowId) || !/^%\d+$/.test(target.paneId) || !/^[1-9]\d*$/.test(target.panePid) || values[6] !== '0' || values[7] !== '0') fail('STALE_TARGET');
    if (expected && Object.entries(expected).some(([key, value]) => fields.includes(key) && target[key] !== value)) fail('STALE_TARGET');
    const connections = clients();
    if (!connections.split(';').some(line => line.split('|')[1] === target.session)) fail('STALE_TARGET');
    return { ...target, connections };
  }
  function prune() {
    for (const [id, record] of receipts) if (record.deadline <= now()) receipts.delete(id);
    for (const [id, file] of files) if (file.expires <= wallNow()) removeFile(id, file.ownerId);
    // Only this module's strict random files are eligible; never follow symlinks.
    if (fs.existsSync(directory)) {
      privateDirectory();
      for (const name of fs.readdirSync(directory)) if (/^[a-f0-9]{48}\.txt$/.test(name)) {
        const filename = path.join(directory, name), stat = fs.lstatSync(filename);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600 && stat.mtimeMs + FILE_TTL <= wallNow()) fs.unlinkSync(filename);
      }
    }
  }
  function receipt(id, owner) {
    ownerCheck(owner);
    const r = receipts.get(id);
    if (!r || r.ownerId !== owner.ownerId || r.deadline <= now()) fail('STALE_CONTEXT');
    return r;
  }
  function verifyTarget(r) {
    const current = capture(r.target.session, r.target);
    if (current.connections !== r.target.connections) fail('STALE_TARGET');
  }
  function prepare(input, owner) {
    ownerCheck(owner); prune();
    if (receipts.size >= 100 || !input || (input.digest !== undefined && (!/^[a-f0-9]{64}$/.test(input.digest) || !['file', 'insert'].includes(input.purpose) || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > LIMIT))) fail('INVALID_CONTEXT');
    let target;
    if (input.previous) { const previous = receipt(input.previous, owner); verifyTarget(previous); if (previous.target.session !== input.session) fail('STALE_TARGET'); target = previous.target; }
    else target = capture(input.session, input.expected);
    const id = crypto.randomBytes(24).toString('hex');
    receipts.set(id, { ownerId: owner.ownerId, target: Object.freeze(target), deadline: now() + (input.digest ? RECEIPT_TTL : 600000), digest: input.digest || null, bytes: input.bytes, purpose: input.purpose, state: 'prepared' });
    return { receipt: id, target: Object.fromEntries(fields.map(key => [key, target[key]])), expiresInMs: input.digest ? RECEIPT_TTL : 600000 };
  }
  function createFile(input, owner) {
    const r = receipt(input.receipt, owner);
    validateText(input.text);
    if (r.purpose !== 'file' || Buffer.byteLength(input.text, 'utf8') !== r.bytes || !r.digest || digest(input.text) !== r.digest || r.state !== 'prepared') fail('STALE_CONTEXT');
    r.state = 'file-attempted';
    verifyTarget(r); privateDirectory(); prune();
    const entries = fs.readdirSync(directory).filter(name => /^[a-f0-9]{48}\.txt$/.test(name));
    if (files.size >= 100 || entries.length >= 100) fail('CONTEXT_CAPACITY');
    const id = crypto.randomBytes(24).toString('hex'), filename = path.join(directory, id + '.txt');
    let fd;
    try {
      fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, input.text, 'utf8');
      const stat = fs.fstatSync(fd);
      files.set(id, { path: filename, ownerId: owner.ownerId, dev: stat.dev, ino: stat.ino, expires: wallNow() + FILE_TTL });
    } catch (error) { try { if (fd !== undefined) fs.unlinkSync(filename); } catch {} throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    return { fileId: id, path: filename, expires: files.get(id).expires };
  }
  function removeFile(id, ownerId) {
    const file = files.get(id);
    if (!file || file.ownerId !== ownerId) fail('STALE_CONTEXT');
    privateDirectory();
    try { const stat = fs.lstatSync(file.path); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.dev !== file.dev || stat.ino !== file.ino) fail('CONTEXT_UNAVAILABLE'); fs.unlinkSync(file.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    files.delete(id);
    return { deleted: true };
  }
  async function insert(input, owner) {
    const r = receipt(input.receipt, owner);
    const text = validateText(input.text, true);
    if (r.purpose !== 'insert' || Buffer.byteLength(text, 'utf8') !== r.bytes || !r.digest || digest(text) !== r.digest || r.state !== 'prepared') fail('STALE_CONTEXT');
    // Consume before all asynchronous work. Errors/unknown delivery never replay.
    r.state = 'insert-attempted';
    verifyTarget(r);
    return coordinator.human(r.target.session, owner, () => controller.input(r.target, async () => {
      receipt(input.receipt, owner); verifyTarget(r);
      const buffer = 'web-terminal-context-' + input.receipt;
      try {
        tmux(['set-buffer', '-b', buffer, '--', text]);
        // Synchronous recheck and atomic tmux condition: no awaiting operation can
        // let a receipt expire/retarget between final verification and dispatch.
        receipt(input.receipt, owner); verifyTarget(r);
        const checks = [['pid', r.target.serverPid], ['session_id', r.target.sessionId], ['session_name', r.target.session], ['window_id', r.target.windowId], ['pane_id', r.target.paneId], ['pane_pid', r.target.panePid], ['pane_dead', '0'], ['pane_in_mode', '0']];
        checks.push(['client-map', r.target.connections]);
        const condition = checks.map(([key, value]) => `#{==:${key === 'client-map' ? '#{L:#{?#{client_tty},#{client_pid}|#{client_session};,}}' : '#{' + key + '}'},${value}}`).reduce((a, b) => `#{&&:${a},${b}}`);
        const result = tmux(['if-shell', '-F', '-t', `${r.target.sessionId}:`, condition, `paste-buffer -p -d -b ${buffer} -t ${r.target.paneId} ; display-message -p WT_CONTEXT_OK`, 'display-message -p WT_CONTEXT_STALE']);
        if (result.trim() !== 'WT_CONTEXT_OK') fail('STALE_TARGET');
        return { sent: true, submitted: false };
      } finally { try { tmux(['delete-buffer', '-b', buffer]); } catch {} }
    }), r.target);
  }
  const timer = setInterval(() => { try { prune(); } catch {} }, 60000); timer.unref();
  return { prepare, createFile, insert, deleteFile(input, owner) { ownerCheck(owner); return removeFile(input.fileId, owner.ownerId); }, close() { clearInterval(timer); } };
}
module.exports = { createContextPaste, validateText, digest, LIMIT };
