'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const digest = data => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
function envelope(record) { return { record, integrity: digest(record) }; }
function inspect(path, expected) {
  try {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let value;
    try { if (!fs.fstatSync(fd).isFile()) throw Error('type'); value = JSON.parse(fs.readFileSync(fd, 'utf8')); } finally { fs.closeSync(fd); }
    const r = value.record;
    if (!r || value.integrity !== digest(r) || r.version !== 1 || !r.server || !r.session || !r.window || !r.pane || !Number.isSafeInteger(r.pid) || r.pid <= 0 || typeof r.processStart !== 'string' || !r.processStart || typeof r.generation !== 'string' || !r.generation || !Number.isSafeInteger(r.journalVersion) || r.journalVersion < 1) return { state: 'QUARANTINED', reason: 'INVALID_JOURNAL', authorized: false };
    if (!expected || r.generation !== expected.generation || r.journalVersion !== expected.journalVersion || r.processStart !== expected.processStart || r.pid !== expected.pid) return { state: 'QUARANTINED', reason: 'STALE_OR_ABA', authorized: false };
    return { state: 'QUARANTINED', reason: 'INDEPENDENT_RECONCILIATION_REQUIRED', authorized: false };
  } catch (_) { return { state: 'QUARANTINED', reason: 'INVALID_JOURNAL', authorized: false }; }
}
module.exports = { envelope, inspect };
