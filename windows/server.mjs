import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { createAccessVerifier, validateConfig } from './access.mjs';
import { createSessions } from './sessions.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ['/vendor/xterm.js', ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8']],
  ['/vendor/xterm.css', ['node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8']],
  ['/vendor/addon-fit.js', ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8']],
]);
const sessionId = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';

export function createApplication(config, { verifyAccess = createAccessVerifier(config), sessions = createSessions(config) } = {}) {
  validateConfig(config);
  const origin = `https://${config.hostname}`;
  const csrf = crypto.randomBytes(32).toString('hex');
  const reply = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, {
      'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const authenticated = async req => {
    if (req.headers.host !== config.hostname) throw new Error('Unexpected host');
    const identity = await verifyAccess(req);
    if (!Number.isFinite(identity.expiresAt) || identity.expiresAt <= Date.now()) throw new Error('Expired identity');
    return identity;
  };
  const mutationAllowed = req => req.headers.origin === origin &&
    req.headers['x-terminal-request'] === csrf &&
    !req.headers['transfer-encoding'] && Number(req.headers['content-length'] || 0) === 0;
  const server = http.createServer(async (req, res) => {
    try { await authenticated(req); }
    catch { return reply(res, 403, { error: 'Cloudflare Access authentication required' }); }
    try {
      if (req.method === 'GET' && assets.has(req.url)) {
        const [filename, type] = assets.get(req.url);
        return reply(res, 200, fs.readFileSync(path.join(root, filename)), type);
      }
      if (req.method === 'GET' && req.url === '/api/sessions') return reply(res, 200, { sessions: sessions.list(), token: csrf });
      if (req.method === 'POST' && req.url === '/api/sessions') {
        if (!mutationAllowed(req)) return reply(res, 403, { error: 'Forbidden' });
        if (sessions.list().length >= 20) return reply(res, 409, { error: 'Session limit reached' });
        const session = await sessions.create();
        return reply(res, 201, { id: session.id, pid: session.pid });
      }
      const end = new RegExp(`^/api/sessions/(${sessionId})/end$`).exec(req.url);
      if (req.method === 'POST' && end) {
        if (!mutationAllowed(req)) return reply(res, 403, { error: 'Forbidden' });
        return reply(res, sessions.end(end[1]) ? 200 : 404, { ok: true });
      }
      return reply(res, 404, { error: 'Not found' });
    } catch { return reply(res, 500, { error: 'Terminal operation failed' }); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 65536, handleProtocols: () => 'terminal' });
  const expire = client => client.close(4001, 'Sign in again');
  server.on('upgrade', async (req, socket, head) => {
    const reject = () => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.on('error', () => {});
    const timer = setTimeout(() => socket.destroy(), 10000);
    timer.unref();
    try {
      const identity = await authenticated(req);
      const route = new RegExp(`^/ws/(${sessionId})$`).exec(req.url);
      const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
      const session = route && sessions.get(route[1]);
      if (!session || !session.alive || req.headers.origin !== origin || protocols.length !== 2 ||
          protocols[0] !== 'terminal' || protocols[1] !== csrf || session.clients.size >= 4) return reject();
      clearTimeout(timer);
      sockets.handleUpgrade(req, socket, head, client => {
        const timeout = setTimeout(() => expire(client), Math.min(identity.expiresAt - Date.now(), 2147483647));
        timeout.unref();
        session.clients.add(client);
        client.send(JSON.stringify({ type: 'snapshot', data: session.serializer.serialize(), cols: session.terminal.cols, rows: session.terminal.rows }));
        client.on('error', () => {});
        client.on('message', (message, binary) => {
          if (!session.alive || Date.now() >= identity.expiresAt) return expire(client);
          try {
            if (binary) throw new Error('Text messages required');
            const value = JSON.parse(message.toString());
            if (value.type === 'input' && typeof value.data === 'string' && value.data.length <= 16384) session.child.write(value.data);
            else if (value.type === 'resize' && Number.isInteger(value.cols) && Number.isInteger(value.rows) &&
                value.cols >= 10 && value.cols <= 500 && value.rows >= 2 && value.rows <= 200) {
              session.terminal.resize(value.cols, value.rows);
              session.child.resize(value.cols, value.rows);
            } else throw new Error('Invalid terminal message');
          } catch { client.close(1008, 'Invalid terminal message'); }
        });
        client.once('close', () => { clearTimeout(timeout); session.clients.delete(client); });
      });
    } catch { reject(); }
    finally { clearTimeout(timer); }
  });
  return {
    server, sessions,
    async close() {
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      await sessions.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.platform !== 'win32') throw new Error('This adapter requires native Windows');
  const config = validateConfig(JSON.parse(fs.readFileSync(process.env.WEB_TERMINAL_CONFIG || path.join(root, 'deployment.local.json'), 'utf8')));
  const app = createApplication(config);
  app.server.listen(config.port, '127.0.0.1', () => console.log('Windows terminal listening on loopback; Access JWT required'));
  app.server.once('error', () => { console.error('Terminal listener failed'); process.exitCode = 1; });
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
