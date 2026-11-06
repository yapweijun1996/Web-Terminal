'use strict';
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { InputBroker } = require('../runtime/gateway/broker');
const { upgrade } = require('../collaboration-mvp/websocket');
// A headless authenticated adapter. The caller must supply a trusted verifier
// and backend. There is no default identity, forwarded-header trust or issuer.
async function startGateway({ backend, verifier, leaseMs = 15000 } = {}) {
  if (!verifier || typeof verifier.verifyUpgrade !== 'function' || typeof verifier.assertActive !== 'function') throw Error('Trusted verifier required');
  if (!backend || !(backend.targets instanceof Map) || !['verify', 'execute', 'watch'].every(k => typeof backend[k] === 'function')) throw Error('Trusted backend required');
  const targets = new Map(backend.targets), clients = new Map(); let closing = false, healthy = true;
  function active(c) {
    if (!c?.live || !healthy || closing) throw Error('Unavailable');
    verifier.assertActive(c.who);
  }
  const broker = new InputBroker({ ttlMs: leaseMs, verifyTarget: t => backend.verify([...targets.values()].find(x => x.paneId === t.paneId && x.serverPid === t.serverPid && x.sessionId === t.sessionId && x.windowId === t.windowId)),
    execute(t, op) {
      const c = clients.get(op.connectionId); active(c);
      const pinned = targets.get(c.pane);
      if (!c.who.panes.includes(c.pane) || c.who.role !== 'writer' || pinned?.paneId !== t.paneId) throw Error('Denied');
      // Synchronous final active check and execution form one event-loop turn.
      // A future remote supervisor must enforce its own durable fencing.
      return backend.execute(pinned, op.payload);
    },
  });
  const server = http.createServer((req, res) => { res.writeHead(404, { 'Cache-Control': 'no-store' }).end(); });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxHeadersCount = 32;
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (!healthy || closing || req.method !== 'GET' || req.url !== '/ws' || req.headers.host !== origin.slice(7) || req.headers.origin !== origin) throw Error('Denied');
      // Reject duplicates of security-relevant headers, including proof and origin.
      const counts = new Map();
      for (let i = 0; i < req.rawHeaders.length; i += 2) { const key = req.rawHeaders[i].toLowerCase(); counts.set(key, (counts.get(key) || 0) + 1); }
      for (const key of ['authorization', 'origin', 'host', 'x-gateway-proof', 'sec-websocket-key']) if (counts.get(key) !== 1) throw Error('Denied');
      try { for (const target of targets.values()) backend.verify(target); }
      catch { healthy = false; throw Error('Backend unavailable'); }
      const who = verifier.verifyUpgrade(req);
      // Enforce the pluggable verifier's identity contract as well as its result.
      if (!who || typeof who.sub !== 'string' || !who.sub || !['writer', 'watcher'].includes(who.role) || who.session !== backend.id || !Array.isArray(who.panes) || !who.panes.length || who.panes.some(p => !targets.has(p))) throw Error('Denied');
      verifier.assertActive(who);
      const bus = upgrade(req, socket, head);
      const c = { id: randomUUID(), who, bus, live: true, pane: null, upstream: null, generation: 0, queued: 0, queue: Promise.resolve(), lastPong: Date.now() };
      c.connection = broker.connect({ principal: who.sub, write: who.role === 'writer' }); clients.set(c.id, c);
      const send = message => bus.send(JSON.stringify(message));
      function disconnected() {
        if (!c.live) return;
        c.live = false; c.generation++; c.upstream?.close(); broker.disconnect(c.connection); clients.delete(c.id);
      }
      bus.once('close', disconnected);
      // Upgraded HTTP sockets can remain half-open after peer FIN. Revoke
      // immediately on end instead of waiting for a heartbeat or close event.
      socket.once('end', () => { disconnected(); bus.close(); });
      bus.on('pong', () => { c.lastPong = Date.now(); });
      bus.on('message', (data, opcode) => {
        if (opcode !== 1 || ++c.queued > 32) { bus.close(); return; }
        c.queue = c.queue.then(async () => {
          try {
            active(c);
            const m = JSON.parse(data.toString());
            if (!m || Array.isArray(m) || typeof m !== 'object') throw Error('Denied');
            if (m.type === 'select') {
              if (!c.who.panes.includes(m.pane) || !targets.has(m.pane)) throw Error('Denied');
              await broker.disconnect(c.connection); active(c);
              c.connection = broker.connect({ principal: who.sub, write: who.role === 'writer' });
              const generation = ++c.generation;
              c.upstream?.close(); c.upstream = null; c.pane = m.pane;
              const t = targets.get(c.pane); backend.verify(t);
              const upstream = await backend.watch(t, data => {
                if (c.live && c.generation === generation) { try { active(c); send({ type: 'output', pane: c.pane, data }); } catch { bus.close(); } }
              });
              if (!c.live || generation !== c.generation) { upstream.close(); return; }
              try { active(c); } catch (e) { upstream.close(); throw e; }
              c.upstream = upstream;
              upstream.once('close', () => { if (c.live && c.generation === generation) bus.close(); });
              send({ type: 'selected', pane: c.pane });
            } else {
              if (m.pane !== undefined && m.pane !== c.pane) throw Error('Denied');
              const t = targets.get(c.pane);
              if (!t || !c.upstream || !who.panes.includes(c.pane)) throw Error('Denied');
              backend.verify(t);
              if (m.type === 'claim') send({ type: 'lease', lease: await broker.claim(c.connection, t) });
              else if (m.type === 'renew') { await broker.renew(c.connection, t, m.lease); send({ type: 'renewed' }); }
              else if (m.type === 'release') { await broker.release(c.connection, t, m.lease); send({ type: 'released' }); }
              else if (m.type === 'input') { await broker.mutate(c.connection, t, m.lease, { connectionId: c.id, payload: m.operation }); send({ type: 'ack' }); }
              else throw Error('Denied');
            }
          } catch {
            try { active(c); send({ type: 'error', message: 'Denied or unavailable' }); } catch { bus.close(); }
          } finally { c.queued--; if (!c.live) broker.disconnect(c.connection); }
        }).catch(() => bus.close());
      });
      send({ type: 'hello', role: who.role, selectedPane: null, leaseMs });
    } catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const monitor = setInterval(() => {
    try { for (const t of targets.values()) backend.verify(t); }
    catch { healthy = false; }
    for (const c of clients.values()) {
      try { active(c); if (Date.now() - c.lastPong > 10000) throw Error(); c.bus.send('', 9); }
      catch { c.bus.close(); }
    }
  }, 100); monitor.unref();
  return {
    url: `http://127.0.0.1:${server.address().port}`, connectionCount: () => clients.size, releaseStatus: 'P0 RELEASE BLOCKED',
    async close() {
      if (closing) return; closing = true; clearInterval(monitor);
      for (const c of clients.values()) { c.live = false; c.bus.close(); await broker.disconnect(c.connection); c.upstream?.close(); }
      server.closeAllConnections(); await new Promise(r => server.close(r));
    },
  };
}
module.exports = { startGateway };
