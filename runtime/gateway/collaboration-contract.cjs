'use strict';
const http = require('node:http');
const { createHash } = require('node:crypto');
const path = require('node:path');
function operationDigest(tool, args) {
  if (!['terminal_type', 'terminal_send_key'].includes(tool) || !args || typeof args !== 'object') throw Error('Invalid collaboration operation');
  const t = args.target || {};
  return createHash('sha256').update(JSON.stringify([tool,
    [t.serverPid, t.sessionId, t.windowId, t.paneId, t.inputGeneration],
    tool === 'terminal_type' ? args.text : args.key])).digest('hex');
}
function privateCall(socket, route, payload, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!path.isAbsolute(socket || '') || !/^\/v1\/[a-z-]+$/.test(route) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
      return reject(Error('COLLABORATION_UNAVAILABLE'));
    let body;
    try { body = JSON.stringify(payload); } catch { return reject(Error('COLLABORATION_UNAVAILABLE')); }
    if (typeof body !== 'string' || Buffer.byteLength(body) > 1048576) return reject(Error('COLLABORATION_UNAVAILABLE'));
    let settled = false;
    const fail = () => { if (!settled) { settled = true; reject(Error('COLLABORATION_UNAVAILABLE')); } };
    const req = http.request({ socketPath: socket, path: route, method: 'POST', headers: {
      Host: 'localhost', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 1048576) { fail(); req.destroy(); } else chunks.push(chunk); });
      res.on('error', fail);
      res.on('end', () => {
        if (settled) return;
        try {
          if (res.statusCode !== 200) return fail();
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          settled = true; resolve(value);
        } catch { fail(); }
      });
    });
    const deadline = setTimeout(() => { fail(); req.destroy(); }, timeoutMs);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', fail);
    req.end(body);
  });
}
module.exports = { operationDigest, privateCall };
