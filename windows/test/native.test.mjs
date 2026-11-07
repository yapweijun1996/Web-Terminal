import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { generateKeyPair, SignJWT } from 'jose';
import WebSocket from 'ws';
import { createAccessVerifier } from '../access.mjs';
import { createApplication } from '../server.mjs';

const config = { hostname: 'terminal.fixture.test', teamName: 'fixture', audience: 'a'.repeat(64), allowedEmail: 'owner@example.test', port: 8799 };
const { privateKey, publicKey } = await generateKeyPair('RS256');
const wrongKeys = await generateKeyPair('RS256');
const sign = (overrides = {}, key = privateKey) => new SignJWT({ email: config.allowedEmail, ...overrides })
  .setProtectedHeader({ alg: 'RS256' }).setSubject('fixture-owner').setIssuedAt()
  .setIssuer(`https://${config.teamName}.cloudflareaccess.com`).setAudience(config.audience)
  .setExpirationTime('10m').sign(key);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async predicate => {
  for (let i = 0; i < 160; i++) { if (predicate()) return; await sleep(50); }
  assert.fail('Expected fixture behavior did not appear');
};
function screen(session) {
  const buffer = session.terminal.buffer.active;
  return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString(true)).join('\n');
}

test('Access JWT rejects wrong identity, signature, audience, issuer and expiry', async () => {
  const verify = createAccessVerifier(config, publicKey);
  const request = token => ({ headers: { 'cf-access-jwt-assertion': token } });
  assert.ok((await verify(request(await sign()))).expiresAt > Date.now());
  await assert.rejects(verify({ headers: {} }));
  await assert.rejects(verify(request(await sign({ email: 'someone@example.test' }))));
  await assert.rejects(verify(request(await sign({}, wrongKeys.privateKey))));
  for (const claim of [{ aud: 'wrong' }, { iss: 'https://wrong.cloudflareaccess.com' }, { exp: 1 }]) {
    const token = await new SignJWT({ sub: 'fixture', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60,
      iss: 'https://fixture.cloudflareaccess.com', aud: config.audience, email: config.allowedEmail, ...claim })
      .setProtectedHeader({ alg: 'RS256' }).sign(privateKey);
    await assert.rejects(verify(request(token)));
  }
});

test('native PowerShell: protected HTTP/WS, resize, reconnect, running work and unsubmitted input', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const app = createApplication(config, { verifyAccess: createAccessVerifier(config, publicKey) });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const port = app.server.address().port;
  const jwt = await sign();
  const request = (method, route, headers = {}, authenticated = true) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: route,
      headers: { host: config.hostname, ...(authenticated ? { 'cf-access-jwt-assertion': jwt } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', data => chunks.push(data));
      res.once('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }); req.once('error', reject); req.end();
  });
  const connect = async (id, csrf, origin = `https://${config.hostname}`, authenticated = true) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${id}`, ['terminal', csrf], {
      origin, headers: { host: config.hostname, ...(authenticated ? { 'cf-access-jwt-assertion': jwt } : {}) },
    });
    ws.on('error', () => {});
    const messages = [];
    ws.on('message', data => messages.push(JSON.parse(data)));
    const outcome = await Promise.race([
      once(ws, 'open').then(() => 'open').catch(() => 'rejected'),
      once(ws, 'unexpected-response').then(([, response]) => { response.resume(); ws.terminate(); return response.statusCode; }).catch(() => 'rejected'),
    ]);
    return { ws, messages, outcome };
  };
  let client;
  try {
    for (const route of ['/', '/app.js', '/api/sessions', '/vendor/xterm.js', '/api/images']) {
      assert.equal((await request('GET', route, {}, false)).status, 403);
    }
    assert.equal((await request('GET', '/', { host: 'wrong.test' })).status, 403);
    assert.equal((await request('GET', '/')).status, 200);
    assert.equal((await request('GET', '/vendor/xterm.js')).status, 200);
    const csrf = JSON.parse((await request('GET', '/api/sessions')).body).token;
    assert.equal((await request('POST', '/api/sessions')).status, 403);
    assert.equal((await request('POST', '/api/sessions', { origin: 'https://evil.test', 'x-terminal-request': csrf })).status, 403);
    const created = await request('POST', '/api/sessions', { origin: `https://${config.hostname}`, 'x-terminal-request': csrf });
    assert.equal(created.status, 201);
    const { id, pid } = JSON.parse(created.body);
    const session = app.sessions.get(id);
    assert.equal((await connect(id, csrf, 'https://evil.test')).outcome, 403);
    assert.equal((await connect(id, csrf, `https://${config.hostname}`, false)).outcome, 403);
    assert.equal((await connect(id, 'wrong')).outcome, 403);
    client = await connect(id, csrf); assert.equal(client.outcome, 'open');
    await waitFor(() => client.messages.some(m => m.type === 'snapshot'));
    await waitFor(() => screen(session).includes('PS '));
    const send = value => client.ws.send(JSON.stringify(value));
    send({ type: 'resize', cols: 90, rows: 26 });
    await waitFor(() => session.terminal.cols === 90 && session.terminal.rows === 26);
    send({ type: 'input', data: "Start-Sleep -Seconds 2; Write-Output ('JOB_' + 'DONE')\r" });
    client.ws.close(); await once(client.ws, 'close');
    assert.equal(app.sessions.get(id).pid, pid);
    client = await connect(id, csrf); assert.equal(client.outcome, 'open');
    await waitFor(() => screen(session).includes('JOB_DONE'));
    send({ type: 'input', data: "Write-Output ('DRAFT_' + 'PRESERVED')" });
    await waitFor(() => screen(session).includes('DRAFT_'));
    client.ws.close(); await once(client.ws, 'close');
    client = await connect(id, csrf);
    await waitFor(() => client.messages.some(m => m.type === 'snapshot' && m.data.includes('DRAFT_')));
    assert.equal(screen(session).includes('DRAFT_PRESERVED'), false, 'Reconnect must not submit the draft');
    assert.equal(app.sessions.get(id).pid, pid);
    send({ type: 'input', data: '\r' });
    await waitFor(() => screen(session).includes('DRAFT_PRESERVED'));
    const second = await request('POST', '/api/sessions', { origin: `https://${config.hostname}`, 'x-terminal-request': csrf });
    assert.equal(second.status, 201);
    assert.notEqual(JSON.parse(second.body).pid, pid);
    assert.equal(app.sessions.list().length, 2);
    const secondId = JSON.parse(second.body).id;
    const secondSession = app.sessions.get(secondId);
    await waitFor(() => screen(secondSession).includes('PS '));
    secondSession.child.write('Start-Sleep -Seconds 60\r');
    assert.equal((await request('POST', `/api/sessions/${secondId}/end`, { origin: `https://${config.hostname}`, 'x-terminal-request': csrf })).status, 200);
    await waitFor(() => !app.sessions.get(secondId));
    assert.throws(() => process.kill(secondSession.pid, 0), 'Ending a fixture must terminate its actual PowerShell');
    assert.equal(app.sessions.get(id).pid, pid, 'Ending another session must preserve this shell');
    app.sessions.get(id).child.write('exit\r');
    await waitFor(() => app.sessions.list().length === 0);
    assert.equal((await request('POST', `/api/sessions/${id}/end`, { origin: `https://${config.hostname}`, 'x-terminal-request': csrf })).status, 404);
  } finally { client?.ws.terminate(); await app.close(); }
});
