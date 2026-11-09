'use strict';
// Disposable signed-owner fixture only. Never used by a live service.
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { WebSocket } = require('ws');
const { privateCall, operationDigest } = require('../../runtime/gateway/collaboration-contract.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function createFixture({ realGateway = false, startPaused = false, captureDiagnostics = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-c-'));
  const uiSocket = path.join(root, 'ui.sock'), authSocket = path.join(root, 'auth.sock'), collaborationSocket = path.join(root, 'c.sock'), grantSocket = path.join(root, 'g.sock'), publicAuthSocket = path.join(root, 'p.sock'), mcpSocket = path.join(root, 'm.sock');
  const tmuxServer = 'collab-' + crypto.randomBytes(6).toString('hex');
  const env = { ...process.env, TMUX_TMPDIR: root, TERMINAL_TEST_HTTP: '1', TERMINAL_RUNTIME: root, TERMINAL_TMUX_SOCKET: tmuxServer, TERMINAL_UPLOAD_DIR: path.join(root, 'uploads'), TERMINAL_COLLABORATION_SOCKET: collaborationSocket, TERMINAL_OWNER_VERIFY_SOCKET: authSocket, TERMINAL_GRANT_VERIFY_SOCKET: realGateway ? grantSocket : authSocket, TERMINAL_OWNER_VERIFY_URL: 'https://fixture.invalid/approve' };
  const tmux = (...args) => execFileSync('/usr/bin/tmux', ['-f', '/dev/null', '-L', tmuxServer, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ email: 'owner@fixture.invalid', sub: 'test-only-owner', iss: 'https://fixture.invalid', aud: 'fixture', iat: now, exp: now + 300 })).toString('base64url');
  const jwt = `${header}.${payload}.${crypto.sign('RSA-SHA256', Buffer.from(header + '.' + payload), keys.privateKey).toString('base64url')}`;
  const grantExpires = Date.now() + 120000;
  let verifierRequests = 0;
  const verifier = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/grant') {
      let body = ''; req.on('data', c => body += c); req.on('end', () => {
        let value; try { value = JSON.parse(body); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value?.grantId === 'test-only-grant' ? { active: true, expires: grantExpires } : { active: false }));
      }); return;
    }
    verifierRequests++;
    try {
      const token = req.headers['cf-access-jwt-assertion'] || '', parts = token.split('.');
      const data = JSON.parse(Buffer.from(parts[1] || '', 'base64url'));
      if (parts.length !== 3 || !crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), keys.publicKey, Buffer.from(parts[2], 'base64url')) || data.iss !== 'https://fixture.invalid' || data.aud !== 'fixture' || data.sub !== 'test-only-owner' || data.exp <= Date.now() / 1000 || req.url !== '/approve?view=input-identity' || req.headers.host !== 'fixture.invalid') throw Error('Invalid fixture authority');
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ authorized: true, ownerId: 'fixture-owner', expires: data.exp * 1000 }));
    } catch { res.writeHead(401); res.end('{}'); }
  });
  let gateway;
  if (realGateway) {
    const { pathToFileURL } = require('node:url'), { createRequire } = require('node:module');
    const requireAuth = createRequire(path.resolve(__dirname, '../../mcp-auth/package.json'));
    const { createLocalJWKSet } = await import(requireAuth.resolve('jose'));
    const { createGateway, createAccessVerifier } = await import(pathToFileURL(path.resolve(__dirname, '../../mcp-auth/server.mjs')));
    const jwk = keys.publicKey.export({ format: 'jwk' }); jwk.kid = 'fixture-key';
    const verifyOwner = createAccessVerifier({ accessIssuer: 'https://fixture.invalid', accessAudience: 'fixture', ownerEmail: 'owner@fixture.invalid' }, createLocalJWKSet({ keys: [jwk] }));
    gateway = createGateway({ publicUrl: 'https://fixture.invalid/mcp', approvalUrl: 'https://fixture.invalid/approve', redirectUris: ['https://client.invalid/callback'], upstreamSocket: mcpSocket, collaborationSocket }, verifyOwner);
    gateway.approvalServer.on('request', req => { if (req.method === 'GET' && req.url === '/approve?view=input-identity') verifierRequests++; });
    await Promise.all([[gateway.publicServer, publicAuthSocket], [gateway.approvalServer, authSocket], [gateway.grantVerifierServer, grantSocket]].map(([server, socket]) => new Promise(resolve => server.listen(socket, resolve))));
  } else await new Promise(resolve => verifier.listen(authSocket, resolve));
  tmux('new-session', '-d', '-s', 'shared', '-x', '100', '-y', '30', '/bin/cat');
  const diagnostics = [];
  let ui = spawn(process.execPath, [path.resolve(__dirname, '../ui/server.js')], {
    env, stdio: captureDiagnostics ? ['ignore', 'ignore', 'pipe'] : 'ignore',
  });
  if (captureDiagnostics) {
    let pending = '';
    ui.stderr.on('data', chunk => {
      pending += chunk.toString('utf8');
      if (pending.length > 16384) { pending = ''; return; }
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const value = JSON.parse(line);
          if (value.type === 'web_terminal_collaboration_diagnostic_v1' && diagnostics.length < 128) diagnostics.push(value);
        } catch { /* only fixed-schema events are accepted by tests */ }
      }
    });
  }

  for (let i = 0; i < 200 && !fs.existsSync(uiSocket); i++) { if (ui.exitCode !== null) throw Error('Fixture UI startup failed'); await sleep(25); }
  if (!fs.existsSync(uiSocket)) throw Error('Fixture UI startup timeout');
  let mcp;
  if (realGateway) {
    mcp = spawn(process.execPath, [path.resolve(__dirname, '../../mcp/server.js')], { env: { ...env, WEB_TERMINAL_MCP_SOCKET: mcpSocket, WEB_TERMINAL_TMUX_SERVER: tmuxServer, WEB_TERMINAL_MCP_LAYOUT: 'linux-tabs', WEB_TERMINAL_MCP_TOOLS: 'terminal-only', WEB_TERMINAL_MCP_INPUT_MODE: 'coordinated', WEB_TERMINAL_COLLABORATION_SOCKET: collaborationSocket }, stdio: 'ignore' });
    for (let i = 0; i < 200 && !fs.existsSync(mcpSocket); i++) { if (mcp.exitCode !== null) throw Error('Fixture MCP startup failed'); await sleep(25); }
    if (!fs.existsSync(mcpSocket)) throw Error('Fixture MCP startup timeout');
  }
  const request = (method, route, { headers = {}, body, owner = true } = {}) => new Promise((resolve, reject) => {
    const bytes = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = http.request({ socketPath: uiSocket, path: route, method, headers: { Host: 'fixture.invalid', ...(owner ? { 'CF-Access-Jwt-Assertion': jwt } : {}), 'Content-Length': bytes.length, ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const raw = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: raw, data }); });
    }); req.on('error', reject); req.end(bytes);
  });
  const authRequest = (socket, route, method = 'GET', body = '', headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path: route, method, headers: { Host: 'fixture.invalid', 'Content-Length': Buffer.byteLength(body), ...headers } }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }); req.on('error', reject); req.end(body);
  });
  let bearer, rpcId = 0;
  if (realGateway) {
    const callback = 'https://client.invalid/callback', resource = 'https://fixture.invalid/mcp';
    const registered = await authRequest(publicAuthSocket, '/oauth/register', 'POST', JSON.stringify({ redirect_uris: [callback], client_name: 'Signed collaboration fixture' }), { 'Content-Type': 'application/json' });
    if (registered.status !== 201) throw Error('Fixture registration failed');
    const clientId = JSON.parse(registered.body).client_id, pkce = crypto.randomBytes(32).toString('base64url');
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: 'code', code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(pkce).digest('base64url'), resource });
    const started = await authRequest(publicAuthSocket, '/oauth/authorize?' + query);
    if (started.status !== 302) throw Error('Fixture authorization start failed');
    const approval = new URL(started.headers.location), ownerHeaders = { 'CF-Access-Jwt-Assertion': jwt };
    const consent = await authRequest(authSocket, approval.pathname + approval.search, 'GET', '', ownerHeaders);
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.body)?.[1];
    const form = new URLSearchParams({ request: approval.searchParams.get('request'), csrf, decision: 'allow', duration: '3600' });
    const decision = await authRequest(authSocket, '/approve', 'POST', form.toString(), { ...ownerHeaders, Origin: 'https://fixture.invalid', 'Content-Type': 'application/x-www-form-urlencoded' });
    if (decision.status !== 302) throw Error('Fixture signed owner consent failed');
    const code = new URL(decision.headers.location).searchParams.get('code');
    const tokenForm = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: callback, code_verifier: pkce, resource });
    const token = await authRequest(publicAuthSocket, '/oauth/token', 'POST', tokenForm.toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
    if (token.status !== 200) throw Error('Fixture PKCE exchange failed');
    bearer = JSON.parse(token.body).access_token;
  }
  const rpc = async (method, params = {}, auth = true) => {
    const response = await authRequest(publicAuthSocket, '/mcp', 'POST', JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: 'Bearer ' + bearer } : {}) });
    return { ...response, data: JSON.parse(response.body) };
  };
  if (realGateway) {
    const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'full-stack-fixture', version: '1' } });
    if (initialized.status !== 200 || !initialized.data.result) throw Error('Fixture MCP initialization failed');
  }
  const tokens = (await request('GET', '/api/sessions')).data;
  const control = async (action, session = 'shared', owner = true) => { const p = (await privateCall(collaborationSocket, '/v1/list', {})).panes.find(p => p.sessionName === session); return request('POST', '/api/collaboration/control', { owner, body: { action, session, serverPid: p?.serverPid, sessionId: p?.sessionId }, headers: { Origin: 'http://fixture.invalid', 'Content-Type': 'application/json', 'X-Terminal-Request': tokens.token } }); };
  if (!startPaused) { const resumed = await control('resume'); if (resumed.status !== 200) throw Error('Fixture owner Resume failed'); }
  const publicServer = http.createServer((req, res) => {
    const upstream = http.request({ socketPath: uiSocket, method: req.method, path: req.url, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  publicServer.on('upgrade', (req, client, head) => {
    const upstream = net.connect(uiSocket, () => {
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
      for (const [name, value] of Object.entries(req.headers)) upstream.write(`${name}: ${value}\r\n`);
      upstream.write('\r\n'); if (head.length) upstream.write(head); client.pipe(upstream).pipe(client);
    }); upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
  });
  await new Promise(resolve => publicServer.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + publicServer.address().port;
  const clients = new Set();
  async function connect({ owner = true } = {}) {
    const client = new WebSocket(`ws+unix://${uiSocket}:/terminal/shared/ws`, ['tty'], { headers: { Host: 'fixture.invalid', Origin: 'http://fixture.invalid', ...(owner ? { 'CF-Access-Jwt-Assertion': jwt } : {}) }, perMessageDeflate: false });
    clients.add(client); let output = '';
    client.on('message', data => { if (data[0] === 48) output += data.subarray(1).toString(); });
    await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
    client.send(JSON.stringify({ AuthToken: '', columns: 100, rows: 30 }));
    await sleep(150);
    return { client, output: () => output };
  }
  const grant = { id: 'test-only-grant', expires: grantExpires };
  async function mutate(tool, args, selectedGrant = grant) {
    if (realGateway) {
      const result = await rpc('tools/call', { name: tool, arguments: args });
      if (result.status !== 200) return { error: { code: 'AUTHORITY_UNAVAILABLE' } };
      const value = result.data.result;
      if (value.isError) return { error: { code: value.content[0].text.split(':')[0] } };
      return JSON.parse(value.content[0].text);
    }
    const admission = await privateCall(collaborationSocket, '/v1/admit', { grant: selectedGrant, tool, digest: operationDigest(tool, args) });
    return privateCall(collaborationSocket, '/v1/execute', { ...admission, tool, arguments: args });
  }
  return { root, uiSocket, collaborationSocket, request, rpc, revoke: () => authRequest(publicAuthSocket, '/oauth/revoke', 'POST', new URLSearchParams({ token: bearer }).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' }), control, tmux, connect, url, jwt, tokens, mutate, grant, diagnostics: () => diagnostics.slice(), verifierRequests: () => verifierRequests,
    list: async () => realGateway ? JSON.parse((await rpc('tools/call', { name: 'terminal_list', arguments: {} })).data.result.content[0].text) : (await privateCall(collaborationSocket, '/v1/list', {})).panes,
    async close() {
      for (const client of clients) client.terminate();
      await new Promise(resolve => publicServer.close(resolve)); publicServer.closeAllConnections();
      if (ui.exitCode === null) { ui.kill('SIGTERM'); await new Promise(resolve => ui.once('exit', resolve)); }
      if (mcp && mcp.exitCode === null) { mcp.kill('SIGTERM'); await new Promise(resolve => mcp.once('exit', resolve)); }
      if (gateway) await Promise.all([gateway.publicServer, gateway.approvalServer, gateway.grantVerifierServer].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
      else await new Promise(resolve => verifier.close(resolve));
      try { tmux('kill-server'); } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  };
}
module.exports = { createFixture, sleep };
