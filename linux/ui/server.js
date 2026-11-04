'use strict';

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const runtime = process.env.TERMINAL_RUNTIME || `/run/user/${process.getuid()}/linux-web-terminal-ui`;
const tmuxSocket = process.env.TERMINAL_TMUX_SOCKET || 'linux-web-terminal';
const socket = path.join(runtime, 'ui.sock');
const maxSessions = 20;
const scheme = process.env.TERMINAL_TEST_HTTP === '1' ? 'http' : 'https';
const children = new Map();
const sessionPattern = /^(shared|web-[a-f0-9]{12})$/;
const token = crypto.randomBytes(32).toString('hex');
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
try { fs.unlinkSync(socket); } catch (e) { if (e.code !== 'ENOENT') throw e; }

function tmux(args) {
  return execFileSync('tmux', ['-L', tmuxSocket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function sessions() {
  try { return tmux(['list-sessions', '-F', '#{session_name}']).trim().split('\n').filter(s => sessionPattern.test(s)).sort(); }
  catch { return []; }
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
function ensureTtyd(name) {
  if (!sessionPattern.test(name) || !sessions().includes(name)) throw new Error('Unknown session');
  const existing = children.get(name);
  if (existing && existing.exitCode === null) return existing.socketPath;
  const socketPath = path.join(runtime, `ttyd-${name}.sock`);
  try { fs.unlinkSync(socketPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  tmux(['set-option', '-t', name, 'mouse', 'on']);
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
            const Native = window.WebSocket;
            window.WebSocket = class extends Native {
              constructor(...args) {
                super(...args);
                const report = state => {
                  if (window.term) window.term.options.disableStdin = state !== 'Connected';
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
                report('Connecting');
                for (const [event, state] of [['open', 'Connected'], ['close', 'Disconnected'], ['error', 'Connection error']]) {
                  this.addEventListener(event, () => report(state));
                }
              }
            };
          })();
        </script>`;
        const html = Buffer.concat(chunks).toString('utf8').replace('<head>', `<head>${shim}`);
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
    if (req.method === 'GET' && req.url === '/style.css') return file(res, 'style.css', 'text/css; charset=utf-8');
    if (req.method === 'GET' && req.url === '/api/sessions') return send(res, 200, JSON.stringify({ sessions: sessions(), token }));
    if (req.method === 'POST' && req.url === '/api/sessions') {
      if (!allowedMutation(req)) return send(res, 403, '{"error":"Forbidden"}');
      if (sessions().length >= maxSessions) return send(res, 409, '{"error":"Terminal limit reached"}');
      const name = `web-${crypto.randomBytes(6).toString('hex')}`;
      tmux(['new-session', '-d', '-s', name]);
      return send(res, 201, JSON.stringify({ name }));
    }
    const latest = /^\/api\/sessions\/(shared|web-[a-f0-9]{12})\/latest$/.exec(req.url);
    if (req.method === 'POST' && latest) {
      if (!allowedMutation(req)) return send(res, 403, '{"error":"Forbidden"}');
      if (!sessions().includes(latest[1])) return send(res, 404, '{"error":"Not found"}');
      const mode = tmux(['display-message', '-p', '-t', latest[1], '#{pane_mode}']).trim();
      if (mode === 'copy-mode' || mode === 'copy-mode-vi') tmux(['send-keys', '-t', latest[1], '-X', 'cancel']);
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
