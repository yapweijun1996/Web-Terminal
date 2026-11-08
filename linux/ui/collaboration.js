'use strict';
// Same-account private coordination. Authentication belongs to the trusted adapters.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { InputBroker } = require('../../runtime/gateway/broker.js');
const { operationDigest, privateCall } = require('../../runtime/gateway/collaboration-contract.cjs');
const messages = Object.freeze({
  AUTHORITY_UNAVAILABLE: 'An authenticated, unexpired admission is required. Nothing was sent.',
  INPUT_BUSY: 'Another writer is active. Verify the terminal before trying another input.',
  INPUT_PAUSED: 'The owner paused AI input. The owner can resume sharing in Web Terminal.',
  STALE_INPUT_GENERATION: 'Input authority changed. Read current terminal state; never retry an old input automatically.',
  STALE_TARGET: 'The terminal target changed. List terminals and verify the intended pane; do not retry input automatically.',
  INVALID_TARGET: 'Invalid terminal target.',
  INVALID_INPUT: 'Invalid input. Nothing was sent.',
  CONTROL_CHAR_OR_MULTILINE: 'Control characters or multiline text are not supported. Nothing was sent. Do not split it into automatic typing and Enter calls.',
  COLLABORATION_UNAVAILABLE: 'Collaboration is unavailable. Never retry input automatically: it may have arrived.',
  OPERATION_UNAVAILABLE: 'Input outcome is uncertain. AI input remains paused; never retry automatically.',
});
function fault(code) { const error = Error(messages[code] || messages.OPERATION_UNAVAILABLE); error.code = Object.hasOwn(messages, code) ? code : 'OPERATION_UNAVAILABLE'; return error; }
const ownerValid = owner => owner && owner.authorized === true && typeof owner.ownerId === 'string' && owner.ownerId.length > 0 && Number.isSafeInteger(owner.expires) && owner.expires > Date.now();
function createOwnerVerifier({ socket, url }) {
  if (!path.isAbsolute(socket || '')) throw Error('Owner verifier socket required');
  const approval = new URL(url);
  if (approval.protocol !== 'https:' || approval.username || approval.password || approval.search || approval.hash) throw Error('HTTPS owner verifier URL required');
  return req => new Promise((resolve, reject) => {
    const jwt = req.headers['cf-access-jwt-assertion'];
    if (typeof jwt !== 'string' || !jwt || jwt.length > 16384) return reject(fault('AUTHORITY_UNAVAILABLE'));
    let done = false;
    const fail = () => { if (!done) { done = true; reject(fault('AUTHORITY_UNAVAILABLE')); } };
    const upstream = http.request({ socketPath: socket, path: approval.pathname + '?view=input-identity', method: 'GET', headers: {
      Host: approval.host, 'CF-Access-Jwt-Assertion': jwt,
    } }, res => {
      let body = '';
      res.on('data', c => { body += c; if (body.length > 8192) { fail(); upstream.destroy(); } });
      res.on('error', fail);
      res.on('end', () => {
        if (done) return;
        try {
          const identity = JSON.parse(body);
          if (res.statusCode !== 200 || !ownerValid(identity)) return fail();
          done = true; resolve(Object.freeze({ authorized: true, ownerId: identity.ownerId, expires: identity.expires }));
        } catch { fail(); }
      });
    });
    const deadline = setTimeout(() => { fail(); upstream.destroy(); }, 5000);
    upstream.on('close', () => clearTimeout(deadline)); upstream.on('error', fail); upstream.end();
  });
}
async function createCoordinator({ socket, controller, now = () => performance.now(), wallNow = () => Date.now(), pauseTimeoutMs = 6000, grantVerifySocket, verifyGrant }) {
  if (!path.isAbsolute(socket || '')) throw Error('Private collaboration socket required');
  if (!verifyGrant && !path.isAbsolute(grantVerifySocket || '')) throw Error('Private grant verifier required');
  const verifyAuthority = verifyGrant || (grant => privateCall(grantVerifySocket, '/v1/grant', { grantId: grant.id }));
  const dir = fs.lstatSync(path.dirname(socket));
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077)) throw Error('Private collaboration directory required');
  if (fs.existsSync(socket)) throw Error('Collaboration socket exists');
  const admissions = new Map(), grants = new Map(), sessions = new Map(), fingerprints = new Map();
  const sessionKey = p => `${p.serverPid}:${p.sessionId}`;
  const paneKey = p => `${p.serverPid}:${p.paneId}`;
  // A tmux client can switch sessions through native prefix/mouse input. The
  // WebSocket URL is its original attachment, not authority over its destination.
  // Restart cannot restore an owner pause from volatile state. Start fail closed.
  let pauseNewSessions = true, humanPending = 0;
  const broker = new InputBroker({ verifyTarget: t => controller.validate(t), now,
    execute: async (target, op) => {
      const activeSession = sessions.get(op.sessionKey);
      const grant = grants.get(op.grantId);
      check(activeSession, op.generation, grant, op.admissionDeadline, op.admissionExpires);
      const beforeDispatch = async () => {
        let authority;
        try { authority = await verifyAuthority(grant); } catch { throw fault('AUTHORITY_UNAVAILABLE'); }
        if (!authority || authority.active !== true || authority.expires !== grant.expires) throw fault('AUTHORITY_UNAVAILABLE');
        check(activeSession, op.generation, grant, op.admissionDeadline, op.admissionExpires);
      };
      await beforeDispatch();
      try { return await (op.tool === 'terminal_type' ? controller.type(target, op.args.text, { expectedPanePid: op.expectedPanePid, beforeDispatch }) : controller.key(target, op.args.key, { expectedPanePid: op.expectedPanePid, beforeDispatch })); }
      catch (error) {
        if (!Object.hasOwn(messages, error?.code || '')) {
          activeSession.unknown = true; activeSession.paused = true; activeSession.generation = randomUUID();
          throw fault('OPERATION_UNAVAILABLE');
        }
        throw fault(error.code);
      }
    },
  });
  function currentGrant(grant) { return grants.get(grant.id) === grant && !grant.revoked && grant.expires > wallNow(); }
  function check(s, generation, grant, deadline = Infinity, expires = Infinity) {
    if (!grant || !currentGrant(grant) || deadline <= now() || expires <= wallNow()) throw fault('AUTHORITY_UNAVAILABLE');
    if (!s || s.unknown) throw fault('OPERATION_UNAVAILABLE');
    if (s.generation !== generation) throw fault('STALE_INPUT_GENERATION');
    if (s.paused) throw fault('INPUT_PAUSED');
  }
  function invalidate(s) {
    s.generation = randomUUID(); s.paused = true; s.writer = null;
    for (const record of s.writers.values()) void broker.disconnect(record.connection);
    s.writers.clear();
  }
  function retireWriters(s) {
    const paused = s.paused;
    invalidate(s); s.paused = paused;
  }
  function retireExpired(s) {
    if ([...s.writers.values()].some(record => record.expiresAt <= now())) retireWriters(s);
  }
  function sessionFor(p) {
    const key = sessionKey(p);
    if (!sessions.has(key)) {
      if (sessions.size >= 100) throw fault('INPUT_BUSY');
      sessions.set(key, { key, serverPid: p.serverPid, sessionId: p.sessionId, sessionName: p.sessionName, generation: randomUUID(), paused: pauseNewSessions, unknown: false, writer: null, writers: new Map(), inFlight: new Set(), jobs: new Map() });
    }
    return sessions.get(key);
  }
  function projection(s) { return { serverPid: s.serverPid, sessionId: s.sessionId, paused: s.paused, writer: s.writer ? 'AI' : s.paused ? 'Owner' : 'Shared', state: s.unknown ? 'unknown' : s.inFlight.size && s.paused ? 'pause-pending' : humanPending ? 'owner-active' : s.paused ? 'paused' : 'sharing', inputGeneration: s.generation }; }
  async function captureIdentity(pane) {
    const raw = await controller.run(['display-message', '-p', '-t', `${pane.sessionId}:${pane.windowId}.${pane.paneId}`,
      '#{pid}|#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}|#{pane_dead}']);
    const [serverPid, sessionId, windowId, paneId, panePid, dead] = raw.trim().split('|');
    if ([serverPid, sessionId, windowId, paneId].join('|') !== [pane.serverPid, pane.sessionId, pane.windowId, pane.paneId].join('|') || !/^\d+$/.test(panePid) || !['0', '1'].includes(dead)) throw fault('STALE_TARGET');
    const key = paneKey(pane), previous = fingerprints.get(key), s = sessionFor(pane);
    if ((previous && previous !== panePid) || dead === '1') invalidate(s);
    fingerprints.set(key, panePid);
    if (dead === '1') throw fault('STALE_TARGET');
    return panePid;
  }
  async function list() {
    const panes = await controller.list();
    const active = new Set(panes.map(sessionKey));
    for (const [key, s] of sessions) if (!active.has(key) && !s.inFlight.size) { invalidate(s); sessions.delete(key); }
    for (const p of panes) { await captureIdentity(p); retireExpired(sessionFor(p)); }
    const paneKeys = new Set(panes.map(paneKey));
    for (const key of fingerprints.keys()) if (!paneKeys.has(key)) fingerprints.delete(key);
    for (const s of sessions.values()) for (const [key, writer] of s.writers) if (!paneKeys.has(writer.paneKey)) { void broker.disconnect(writer.connection); s.writers.delete(key); }
    return { panes: panes.map(p => { const s = sessionFor(p); return { ...p, inputGeneration: s.generation, collaboration: projection(s) }; }) };
  }
  async function resolveSession(name) {
    if (!/^(shared|web-[a-f0-9]{12})$/.test(name || '')) throw fault('INVALID_TARGET');
    const pane = (await controller.list()).find(p => p.sessionName === name);
    if (!pane) throw fault('STALE_TARGET');
    return sessionFor(pane);
  }
  function prune() {
    for (const [nonce, admission] of admissions) if (admission.deadline <= now() || admission.expires <= wallNow()) admissions.delete(nonce);
    for (const [id, grant] of grants) if (grant.expires <= wallNow()) {
      grant.revoked = true;
      for (const s of sessions.values()) for (const [key, record] of s.writers) if (record.grant === grant) { void broker.disconnect(record.connection); s.writers.delete(key); s.writer = null; }
      grants.delete(id);
    }
  }
  function admit({ grant: input, tool, digest } = {}) {
    prune();
    if (!input || typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.id) || !Number.isSafeInteger(input.expires) || input.expires <= wallNow() || input.expires > wallNow() + 366 * 86400000 ||
      !['terminal_type', 'terminal_send_key'].includes(tool) || !/^[a-f0-9]{64}$/.test(digest || '')) throw fault('AUTHORITY_UNAVAILABLE');
    if (admissions.size >= 4096 || (!grants.has(input.id) && grants.size >= 1000)) throw fault('INPUT_BUSY');
    let grant = grants.get(input.id);
    if (grant && (grant.revoked || grant.expires !== input.expires)) throw fault('AUTHORITY_UNAVAILABLE');
    if (!grant) { grant = { id: input.id, expires: input.expires, revoked: false }; grants.set(input.id, grant); }
    const nonce = randomBytes(32).toString('hex'), expires = Math.min(input.expires, wallNow() + 15000);
    admissions.set(nonce, { grant, tool, digest, expires, deadline: now() + Math.min(15000, input.expires - wallNow()) });
    return { admission: nonce, expires };
  }
  async function execute({ admission: nonce, tool, arguments: args } = {}) {
    prune();
    const admission = admissions.get(nonce); admissions.delete(nonce);
    if (!admission || !currentGrant(admission.grant) || admission.tool !== tool || admission.digest !== operationDigest(tool, args)) throw fault('AUTHORITY_UNAVAILABLE');
    const captured = structuredClone(args), t = captured.target;
    const pane = await controller.validate(t), expectedPanePid = await captureIdentity(pane), s = sessionFor(pane), generation = t.inputGeneration;
    retireExpired(s);
    if (typeof generation !== 'string' || !generation) throw fault('STALE_INPUT_GENERATION');
    check(s, generation, admission.grant, admission.deadline, admission.expires);
    if (s.inFlight.size || [...sessions.values()].reduce((n, item) => n + item.inFlight.size, 0) >= 32) throw fault('INPUT_BUSY');
    let finish;
    const tracked = new Promise(resolve => { finish = resolve; });
    s.inFlight.add(tracked); s.jobs.set(tracked, admission.grant);
    try {
      const key = `${admission.grant.id}:${paneKey(pane)}`;
      let writer = s.writers.get(key);
      if (!writer) {
        if (s.writers.size >= 128) throw fault('INPUT_BUSY');
        writer = { paneKey: paneKey(pane), grant: admission.grant, connection: broker.connect({ principal: admission.grant.id, write: true }), proof: null, expiresAt: Infinity };
        s.writers.set(key, writer);
      }
      if (writer.proof) {
        try { await broker.renew(writer.connection, pane, writer.proof); }
        catch (error) { if (error.message !== 'Lease unavailable') throw error; retireWriters(s); throw fault('STALE_INPUT_GENERATION'); }
      }
      if (!writer.proof) {
        try { writer.proof = await broker.claim(writer.connection, pane); }
        catch (error) { void broker.disconnect(writer.connection); s.writers.delete(key); throw error; }
      }
      writer.expiresAt = now() + 15000;
      check(s, generation, admission.grant, admission.deadline, admission.expires); s.writer = admission.grant.id;
      return await broker.mutate(writer.connection, pane, writer.proof, { sessionKey: s.key, generation, grantId: admission.grant.id, admissionDeadline: admission.deadline, admissionExpires: admission.expires, expectedPanePid, tool, args: captured });
    } catch (error) {
      if (Object.hasOwn(messages, error?.code || '')) throw error;
      if (/Lease held/.test(error?.message || '')) throw fault('INPUT_BUSY');
      if (/Permission denied|Lease unavailable/.test(error?.message || '')) throw fault(s.paused ? 'INPUT_PAUSED' : 'AUTHORITY_UNAVAILABLE');
      throw fault('OPERATION_UNAVAILABLE');
    } finally { s.inFlight.delete(tracked); s.jobs.delete(tracked); finish(); }
  }
  async function revoke({ grantId } = {}) {
    const grant = grants.get(grantId), affected = [];
    if (grant) {
      grant.revoked = true;
      for (const [nonce, item] of admissions) if (item.grant === grant) admissions.delete(nonce);
      for (const s of sessions.values()) {
        if ([...s.writers.values()].some(record => record.grant === grant) || [...s.jobs.values()].includes(grant)) {
          invalidate(s); affected.push(s);
        }
      }
    }
    await Promise.all(affected.map(drain));
    return { revoked: true };
  }
  async function drain(s) {
    if (s.inFlight.size) {
      let timer;
      const drained = await Promise.race([Promise.all([...s.inFlight]).then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), pauseTimeoutMs); })]);
      clearTimeout(timer);
      if (!drained) s.unknown = true;
    }
    if (s.unknown) throw fault('OPERATION_UNAVAILABLE');
  }
  async function pauseSession(s) {
    invalidate(s);
    await drain(s);
    return projection(s);
  }
  function checkedBinding(s, binding) { if (binding && (binding.serverPid !== s.serverPid || binding.sessionId !== s.sessionId)) throw fault('STALE_TARGET'); }
  async function control(name, action, owner, binding) {
    if (!ownerValid(owner)) throw fault('AUTHORITY_UNAVAILABLE');
    const s = await resolveSession(name); checkedBinding(s, binding);
    if (action === 'pause' || action === 'takeover') return pauseSession(s);
    if (action !== 'resume') throw fault('INVALID_INPUT');
    if (humanPending) throw fault('INPUT_BUSY');
    if (s.inFlight.size || s.unknown) throw fault('OPERATION_UNAVAILABLE');
    invalidate(s); s.paused = false; return projection(s);
  }
  function beginHuman(binding, owner) {
    if (!ownerValid(owner)) throw fault('AUTHORITY_UNAVAILABLE');
    const s = sessions.get(`${binding?.serverPid}:${binding?.sessionId}`);
    if (!s) throw fault('STALE_TARGET');
    // Conservatively fence every managed AI writer before forwarding native
    // bytes: this client's next byte may address a different tmux session.
    pauseNewSessions = true;
    for (const current of sessions.values()) invalidate(current);
    humanPending++;
    let finished = false;
    return () => { if (!finished) { finished = true; humanPending--; } };
  }
  async function human(name, owner, dispatch, binding) {
    if (!ownerValid(owner)) throw fault('AUTHORITY_UNAVAILABLE');
    const s = await resolveSession(name); checkedBinding(s, binding);
    const finish = beginHuman(s, owner);
    try {
      await Promise.all([...sessions.values()].map(drain));
      if (!ownerValid(owner)) throw fault('AUTHORITY_UNAVAILABLE');
      return await dispatch();
    } finally { finish(); }
  }
  const server = http.createServer(async (req, res) => {
    const send = value => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.method !== 'POST' || req.headers.origin || !['/v1/admit', '/v1/execute', '/v1/list', '/v1/revoke'].includes(req.url)) { res.writeHead(404); return res.end(); }
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 1048576) throw fault('INVALID_INPUT'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = req.url === '/v1/admit' ? admit(body) : req.url === '/v1/execute' ? await execute(body) : req.url === '/v1/list' ? await list() : await revoke(body);
      send(result);
    } catch (error) { const code = Object.hasOwn(messages, error?.code || '') ? error.code : 'COLLABORATION_UNAVAILABLE'; send({ error: { code, message: messages[code] } }); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, () => { fs.chmodSync(socket, 0o600); resolve(); }); });
  return { list, admit, execute, revoke, control, human, beginHuman, binding: async name => { const s = await resolveSession(name); return { serverPid: s.serverPid, sessionId: s.sessionId }; }, state: async name => projection(await resolveSession(name)),
    close: () => new Promise(resolve => { for (const s of sessions.values()) invalidate(s); server.close(() => { try { fs.unlinkSync(socket); } catch {} resolve(); }); server.closeAllConnections(); }),
  };
}
module.exports = { createCoordinator, createOwnerVerifier, ownerValid };
