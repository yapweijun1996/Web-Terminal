'use strict';
const { WebSocket, WebSocketServer } = require('ws');
const maximum = 1048576;
function createManagedWebSockets({ coordinator, verifyOwner }) {
  const server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: maximum,
    handleProtocols: protocols => protocols.has('tty') ? 'tty' : false });
  const live = new Set(); let pending = 0;
  async function upgrade(req, socket, head, { session, upstreamSocket }) {
    if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(req.headers['sec-websocket-key'] || '') || !(req.headers['sec-websocket-protocol'] || '').split(',').map(v => v.trim()).includes('tty') || live.size + pending >= 64)
      return socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    pending++;
    let identity, binding;
    try { identity = await verifyOwner(req); binding = await coordinator.binding(session); }
    catch { pending--; return socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
    if (socket.destroyed) { pending--; return; }
    // The original header is used only by verifyOwner, never forwarded to ttyd.
    const upstream = new WebSocket(`ws+unix://${upstreamSocket}:/ws`, ['tty'], { perMessageDeflate: false, maxPayload: maximum, handshakeTimeout: 5000, headers: { Host: req.headers.host, Origin: req.headers.origin } });
    socket.once('close', () => upstream.terminate());
    const ready = new Promise((resolve, reject) => { upstream.once('open', resolve); upstream.once('error', reject); });
    try { await ready; }
    catch { pending--; upstream.terminate(); return socket.destroy(); }
    pending--;
    server.handleUpgrade(req, socket, head, client => {
      live.add(client);
      let queued = 0, closed = false, queue = Promise.resolve();
      const close = () => { if (closed) return; closed = true; live.delete(client); client.terminate(); upstream.terminate(); };
      const send = (destination, data, binary) => new Promise((resolve, reject) => {
        if (closed || destination.readyState !== WebSocket.OPEN || destination.bufferedAmount > maximum) return reject(Error('Managed terminal unavailable'));
        destination.send(data, { binary }, error => error ? reject(Error('Managed terminal unavailable')) : resolve());
      });
      client.on('message', (data, binary) => {
        if (++queued > 32) return close();
        const captured = Buffer.from(data);
        let finishHuman;
        if (captured[0] === 48) { try { finishHuman = coordinator.beginHuman(binding, identity); } catch { return close(); } }
        queue = queue.then(async () => {
          if (closed) return;
          if (!captured.length) throw Error('Empty terminal message');
          if (captured[0] === 48) {
            // Verify current Access authority for each input, not only at upgrade.
            identity = await verifyOwner(req);
            return coordinator.human(session, identity, () => send(upstream, captured, binary), binding);
          }
          if (captured[0] === 52) {
            // Only the authenticated owner frontend emits xterm's protocol-reply
            // provenance. This is not an MCP/client-settable authority claim.
            identity = await verifyOwner(req);
            const native = Buffer.from(captured); native[0] = 48;
            return send(upstream, native, binary);
          }
          // Only native handshake, resize and output flow-control bypass writer mutation.
          if (![49, 50, 51, 123].includes(captured[0])) throw Error('Unsupported terminal message');
          return send(upstream, captured, binary);
        }).catch(close).finally(() => { finishHuman?.(); queued--; });
      });
      upstream.on('message', (data, binary) => { void send(client, data, binary).catch(close); });
      client.on('error', close); client.on('close', close); upstream.on('error', close); upstream.on('close', close);
    });
  }
  return { upgrade, close() { for (const client of live) client.terminate(); server.close(); } };
}
module.exports = { createManagedWebSockets };
