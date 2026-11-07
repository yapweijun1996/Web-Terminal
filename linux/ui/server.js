'use strict';

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { createImageReceipts } = require('./image-receipts');

const runtime = process.env.TERMINAL_RUNTIME || `/run/user/${process.getuid()}/linux-web-terminal-ui`;
const tmuxSocket = process.env.TERMINAL_TMUX_SOCKET || 'linux-web-terminal';
const uploadDir = process.env.TERMINAL_UPLOAD_DIR || path.join(require('node:os').homedir(), '.local/share/linux-web-terminal/uploads');
const maxUploadBytes = 10 * 1024 * 1024;
let activeUploads = 0;
const socket = path.join(runtime, 'ui.sock');
const maxSessions = 20;
const scheme = process.env.TERMINAL_TEST_HTTP === '1' ? 'http' : 'https';
const children = new Map();
const sessionPattern = /^(shared|web-[a-f0-9]{12})$/;
const token = crypto.randomBytes(32).toString('hex');
if (!path.isAbsolute(runtime)) throw new Error('Runtime directory must be absolute');
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
const runtimeStat = fs.lstatSync(runtime);
if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink() || runtimeStat.uid !== process.getuid() || (runtimeStat.mode & 0o077) !== 0) {
  throw new Error('Runtime directory must be private and owned by the current user');
}
try {
  fs.lstatSync(socket);
  throw new Error('UI socket path already exists; verify its owner before removal');
} catch (e) { if (e.code !== 'ENOENT') throw e; }

function tmux(args) {
  return execFileSync('tmux', ['-L', tmuxSocket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const imageReceipts = createImageReceipts(tmux);
function sessions() {
  try { return tmux(['list-sessions', '-F', '#{session_name}']).trim().split('\n').filter(s => sessionPattern.test(s)).sort(); }
  catch { return []; }
}
function sessionDetails(names) {
  const details = {};
  for (const name of names) {
    let command = '';
    try {
      // Read only the active pane's executable name, never its arguments or title.
      command = path.basename(tmux(['display-message', '-p', '-t', `=${name}:`, '#{pane_current_command}']).trim())
        .replace(/[^A-Za-z0-9._+-]/g, '').slice(0, 24);
    } catch { /* A session may disappear after the list was captured. */ }
    details[name] = { command };
  }
  return details;
}
function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(body);
}
function file(res, filename, contentType) {
  send(res, 200, fs.readFileSync(path.join(__dirname, filename)), contentType);
}
function allowedMutation(req) {
  return req.headers.origin === `${scheme}://${req.headers.host}` &&
    req.headers['x-terminal-request'] === token && req.headers['content-type'] === 'application/json';
}
function imageType(data) {
  if (data.length >= 45 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && data.readUInt32BE(8) === 13 && data.toString('ascii', 12, 16) === 'IHDR' && data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0 && data.readUInt32BE(16) <= 16384 && data.readUInt32BE(20) <= 16384 && data.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))) return 'png';
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9) return 'jpg';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' && data.readUInt32LE(4) + 8 === data.length) return 'webp';
  return null;
}
async function upload(req, res) {
  if (req.headers.origin !== `${scheme}://${req.headers.host}` || req.headers['x-terminal-request'] !== token || req.headers['content-type'] !== 'application/octet-stream') return send(res, 403, '{"error":"Forbidden"}');
  const length = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(length) || length < 1 || length > maxUploadBytes) return send(res, 413, '{"error":"Invalid image size"}');
  if (activeUploads >= 3) return send(res, 429, '{"error":"Too many uploads"}');
  const ticket = req.headers['x-image-receipt'];
  if (!imageReceipts.start(ticket)) return send(res, 409, '{"error":"Upload receipt unavailable"}');
  activeUploads++;
  const timeout = setTimeout(() => req.destroy(), 30000);
  let savedPath = null;
  try {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxUploadBytes || size > length) return send(res, 413, '{"error":"Image too large"}');
      chunks.push(chunk);
    }
    if (size !== length) return send(res, 400, '{"error":"Incomplete upload"}');
    const data = Buffer.concat(chunks); const ext = imageType(data);
    if (!ext) return send(res, 415, '{"error":"Unsupported image"}');
    fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
    const entries = fs.readdirSync(uploadDir, { withFileTypes: true }).filter(entry => entry.isFile() && /^[a-f0-9]{32}\.(png|jpg|webp)$/.test(entry.name));
    const totalBytes = entries.reduce((total, entry) => total + fs.statSync(path.join(uploadDir, entry.name)).size, 0);
    if (entries.length >= 500 || totalBytes + size > 500 * 1024 * 1024) return send(res, 507, '{"error":"Image storage limit reached"}');
    const filename = path.join(uploadDir, `${crypto.randomBytes(16).toString('hex')}.${ext}`);
    fs.writeFileSync(filename, data, { flag: 'wx', mode: 0o600 });
    savedPath = filename;
    return send(res, 201, JSON.stringify({ path: filename }));
  } finally { clearTimeout(timeout); activeUploads--; imageReceipts.finish(ticket, savedPath); }
}
function ensureTtyd(name) {
  if (!sessionPattern.test(name) || !sessions().includes(name)) throw new Error('Unknown session');
  // A session can be recreated under the same name while ttyd stays alive.
  // Reapply per-session settings before reusing the existing ttyd process.
  tmux(['set-option', '-t', name, 'mouse', 'on']);
  tmux(['set-option', '-t', name, 'set-titles', 'on']);
  tmux(['set-option', '-t', name, 'set-titles-string', '__WEB_TERMINAL_TARGET__|#{session_name}|#{session_id}|#{pane_id}|#{pid}|#{pane_mode}|#{pane_title}']);
  const existing = children.get(name);
  if (existing && existing.exitCode === null) return existing.socketPath;
  const socketPath = path.join(runtime, `ttyd-${name}.sock`);
  try { fs.unlinkSync(socketPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // This is a tmux server option and therefore applies to every session on this socket.
  // Application OSC 52 writes must reach ttyd for the browser clipboard bridge.
  tmux(['set-option', '-s', 'set-clipboard', 'on']);
  const child = spawn('/usr/bin/ttyd', ['-i', socketPath, '-W', '-O', '/bin/sh', path.join(__dirname, 'attach-tab.sh'), tmuxSocket, name], { stdio: 'ignore' });
  child.socketPath = socketPath;
  children.set(name, child);
  child.once('exit', () => { if (children.get(name) === child) children.delete(name); });
  return socketPath;
}
async function waitForSocket(socketPath) {
  for (let i = 0; i < 50; i++) {
    try { if (fs.statSync(socketPath).isSocket()) return; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Terminal service did not start');
}
function parseTerminal(url) {
  const match = /^\/terminal\/(shared|web-[a-f0-9]{12})(?:\/(token|ws))?\/?$/.exec(url);
  return match && { name: match[1], endpoint: match[2] ? `/${match[2]}` : '/' };
}
function proxy(req, res, target, endpoint) {
  const headers = { ...req.headers };
  delete headers.cookie;
  delete headers['cf-access-jwt-assertion'];
  headers['accept-encoding'] = 'identity';
  const upstream = http.request({ socketPath: target, path: endpoint, method: req.method, headers }, up => {
    if (endpoint === '/' && up.statusCode === 200) {
      const chunks = []; let size = 0;
      up.on('data', chunk => { size += chunk.length; if (size > 2_000_000) upstream.destroy(); else chunks.push(chunk); });
      up.on('end', () => {
        const shim = `<script>
          (() => {
            // The embedded ttyd client otherwise publishes its launch command
            // and tmux title metadata to the browser's accessible page title.
            try {
              document.title = 'Terminal view';
              Object.defineProperty(document, 'title', {
                configurable: true, get: () => 'Terminal view', set: () => {},
              });
            } catch { /* Keep the terminal usable if this browser rejects the title override. */ }
            const Native = window.WebSocket;
            window.WebSocket = class extends Native {
              constructor(...args) {
                super(...args);
                const report = state => {
                  if (window.term) window.term.options.disableStdin = state !== 'Connected';
                  if (state !== 'Connected') window.webTerminalTarget = null;
                  window.parent.postMessage({ type: 'terminal-connection', state }, window.location.origin);
                  if (state === 'Disconnected' || state === 'Connection error') {
                    setTimeout(() => {
                      for (const node of document.querySelectorAll('.xterm div')) {
                        if (node.childNodes.length === 1 && node.firstChild.nodeType === Node.TEXT_NODE && node.textContent === 'Press ⏎ to Reconnect') {
                          node.textContent = 'Use Retry in the toolbar';
                        }
                      }
                    }, 0);
                  }
                };
                if (typeof window.term?.onTitleChange === 'function' && !window.__terminalTargetListener) {
                  window.__terminalTargetListener = true;
                  window.term.onTitleChange(title => {
                    const match = /^__WEB_TERMINAL_TARGET__\\|(shared|web-[a-f0-9]{12})\\|(\\$\\d+)\\|(%\\d+)\\|(\\d+)\\|([a-z0-9-]*)\\|/.exec(title);
                    window.webTerminalTarget = match ? { session: match[1], sessionId: match[2], pane: match[3], serverPid: match[4] } : null;
                    window.parent.postMessage({ type: 'terminal-scroll', mode: match ? match[5] : null }, window.location.origin);
                  });
                }
                // ttyd focuses its terminal after opening. Preserve keyboard
                // navigation unless the user has already focused this frame.
                if (window.frameElement?.dataset?.preserveTabFocus === 'true' && typeof window.term?.focus === 'function') {
                  const focus = window.term.focus.bind(window.term);
                  window.term.focus = (...args) => {
                    window.term.focus = focus;
                    if (window.parent.document.activeElement === window.frameElement) focus(...args);
                  };
                }
                report('Connecting');
                for (const [event, state] of [['open', 'Connected'], ['close', 'Disconnected'], ['error', 'Connection error']]) {
                  this.addEventListener(event, () => report(state));
                }
              }
            };
          })();
        </script>`;
        const html = Buffer.concat(chunks).toString('utf8').replace('<head>', `<head>${shim}<script src="/clipboard-bridge.js"></script><script src="/touch-scroll.js"></script>`);
        const responseHeaders = { ...up.headers, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(html) };
        delete responseHeaders['transfer-encoding']; delete responseHeaders['content-encoding'];
        res.writeHead(200, responseHeaders); res.end(html);
      });
      return;
    }
    res.writeHead(up.statusCode, { ...up.headers, 'cache-control': 'no-store' });
    up.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) send(res, 502, 'Terminal unavailable', 'text/plain'); else res.destroy(); });
  req.pipe(upstream);
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') return file(res, 'index.html', 'text/html; charset=utf-8');
    if (req.method === 'GET' && req.url === '/app.js') return file(res, 'app.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && req.url === '/clipboard-bridge.js') return file(res, 'clipboard-bridge.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && req.url === '/touch-scroll.js') return file(res, 'touch-scroll.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && req.url === '/mobile-keys.js') return file(res, 'mobile-keys.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && req.url === '/mobile-keys.css') return file(res, 'mobile-keys.css', 'text/css; charset=utf-8');
    if (req.method === 'GET' && req.url === '/display-controls.js') return file(res, 'display-controls.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && req.url === '/display-controls.css') return file(res, 'display-controls.css', 'text/css; charset=utf-8');
    if (req.method === 'GET' && req.url === '/sidebar.js') return file(res, 'sidebar.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && req.url === '/sidebar.css') return file(res, 'sidebar.css', 'text/css; charset=utf-8');
    if (req.method === 'GET' && req.url === '/style.css') return file(res, 'style.css', 'text/css; charset=utf-8');
    if (req.method === 'GET' && req.url === '/api/sessions') {
      const names = sessions();
      return send(res, 200, JSON.stringify({ sessions: names, details: sessionDetails(names), token }));
    }
    const identity = /^\/api\/sessions\/(shared|web-[a-f0-9]{12})\/identity$/.exec(req.url);
    if (req.method === 'GET' && identity) {
      try {
        const result = tmux(['display-message', '-p', '-t', `=${identity[1]}:`, '#{session_name}|#{session_id}|#{pid}']).trim().split('|');
        if (result[0] !== identity[1] || !/^\$\d+$/.test(result[1]) || !/^\d+$/.test(result[2])) throw new Error('Session unavailable');
        return send(res, 200, JSON.stringify({ sessionId: result[1], serverPid: result[2] }));
      } catch { return send(res, 404, '{"error":"Session unavailable"}'); }
    }
    const close = /^\/api\/sessions\/(shared|web-[a-f0-9]{12})\/close$/.exec(req.url);
    if (req.method === 'POST' && close) {
      if (!allowedMutation(req)) return send(res, 403, '{"error":"Forbidden"}');
      if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0) return send(res, 400, '{"error":"Unexpected body"}');
      const sessionId = req.headers['x-terminal-session-id'], serverPid = req.headers['x-terminal-server-pid'];
      if (!/^\$\d+$/.test(sessionId || '') || !/^\d+$/.test(serverPid || '')) return send(res, 409, '{"error":"Session changed"}');
      try {
        // Check and kill in one tmux command queue, bound to the original session ID and server.
        const result = tmux(['if-shell', '-F', '-t', sessionId,
          `#{&&:#{==:#{session_name},${close[1]}},#{==:#{pid},${serverPid}}}`,
          `kill-session -t '${sessionId}'`, 'display-message -p STALE']).trim();
        if (result === 'STALE') throw new Error('Session changed');
      } catch { return send(res, 409, '{"error":"Session changed or unavailable"}'); }
      const child = children.get(close[1]);
      if (child) { children.delete(close[1]); child.kill('SIGTERM'); }
      return send(res, 200, '{"ok":true}');
    }
    if (req.method === 'POST' && ['/api/images/prepare', '/api/images/result', '/api/images/insert'].includes(req.url)) {
      if (!allowedMutation(req)) return send(res, 403, '{"error":"Forbidden"}');
      if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0) return send(res, 400, '{"error":"Unexpected body"}');
      try {
        const ticket = req.headers['x-image-receipt'];
        const result = req.url.endsWith('/prepare')
          ? imageReceipts.prepare({ session: req.headers['x-terminal-session'], sessionId: req.headers['x-terminal-session-id'], pane: req.headers['x-terminal-pane'], serverPid: req.headers['x-terminal-server-pid'] })
          : req.url.endsWith('/result') ? imageReceipts.result(ticket) : (imageReceipts.insert(ticket), { inserted: true });
        return send(res, 200, JSON.stringify(result));
      } catch { return send(res, 409, '{"error":"Image target unavailable"}'); }
    }
    if (req.method === 'POST' && req.url === '/api/images') return await upload(req, res);
    if (req.method === 'POST' && req.url === '/api/sessions') {
      if (!allowedMutation(req)) return send(res, 403, '{"error":"Forbidden"}');
      if (sessions().length >= maxSessions) return send(res, 409, '{"error":"Terminal limit reached"}');
      const name = `web-${crypto.randomBytes(6).toString('hex')}`;
      // Pi runs on the host, but the clipboard belongs to the remote browser.
      tmux(['new-session', '-d', '-e', 'PI_CLIPBOARD_OSC52=1', '-s', name]);
      return send(res, 201, JSON.stringify({ name }));
    }
    const latest = /^\/api\/sessions\/(shared|web-[a-f0-9]{12})\/latest$/.exec(req.url);
    if (req.method === 'POST' && latest) {
      if (!allowedMutation(req)) return send(res, 403, '{"error":"Forbidden"}');
      if (!sessions().includes(latest[1])) return send(res, 404, '{"error":"Not found"}');
      if (req.headers['x-terminal-session'] !== latest[1]) return send(res, 409, '{"error":"Target unavailable"}');
      try {
        imageReceipts.returnToLive({ session: latest[1], sessionId: req.headers['x-terminal-session-id'], pane: req.headers['x-terminal-pane'], serverPid: req.headers['x-terminal-server-pid'] });
      } catch { return send(res, 409, '{"error":"Target unavailable"}'); }
      return send(res, 200, '{"ok":true}');
    }
    const route = parseTerminal(req.url);
    if (route && req.method === 'GET' && route.endpoint !== '/ws') {
      const target = ensureTtyd(route.name); await waitForSocket(target);
      return proxy(req, res, target, route.endpoint);
    }
    return send(res, 404, '{"error":"Not found"}');
  } catch { return send(res, 500, '{"error":"Terminal service error"}'); }
});
server.on('upgrade', async (req, client, head) => {
  const route = parseTerminal(req.url);
  if (!route || route.endpoint !== '/ws' || req.headers.origin !== `${scheme}://${req.headers.host}`) return client.destroy();
  try {
    const target = ensureTtyd(route.name); await waitForSocket(target);
    const upstream = net.createConnection(target);
    upstream.on('connect', () => {
      upstream.write(`${req.method} /ws HTTP/${req.httpVersion}\r\n`);
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (['cookie', 'cf-access-jwt-assertion'].includes(req.rawHeaders[i].toLowerCase())) continue;
        upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      }
      upstream.write('\r\n'); if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
  } catch { client.destroy(); }
});
server.listen(socket, () => fs.chmodSync(socket, 0o600));
function shutdown() { server.close(); for (const child of children.values()) child.kill('SIGTERM'); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
