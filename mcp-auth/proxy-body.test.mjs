import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGateway, listenPrivate } from "./server.mjs";

const publicOrigin = "https://terminal-mcp.example.test";
const ownerOrigin = "https://terminal.example.test";
const callback = "https://client.example.test/callback";
function call(socket, host, route, method = "GET", data = "", headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, host, path: route, method,
      headers: { host, "content-length": Buffer.byteLength(data), ...headers } }, res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(data);
  });
}
async function fixture(t, timeoutMs = 5000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-proxy-body-"));
  fs.chmodSync(dir, 0o700);
  const pub = path.join(dir, "public.sock"), owner = path.join(dir, "owner.sock"), upstreamSocket = path.join(dir, "upstream.sock");
  const requests = [];
  const upstream = http.createServer((req, res) => {
    const entry = { headers: req.headers, chunks: [] };
    requests.push(entry);
    req.on("data", chunk => entry.chunks.push(chunk));
    req.on("end", () => res.end('{"fixture":true}'));
  });
  await new Promise(resolve => upstream.listen(upstreamSocket, resolve));
  const gateway = createGateway({ publicUrl: publicOrigin + "/mcp", approvalUrl: ownerOrigin + "/__terminal_mcp/authorize",
    redirectUris: [callback], upstreamSocket, mcpBodyTimeoutMs: timeoutMs },
  async req => req.headers["test-owner"] === "yes");
  let bodyObserver;
  gateway.publicServer.on("request", req => {
    if (req.url === "/mcp") req.once("data", () => { const observed = bodyObserver; bodyObserver = undefined; observed?.(); });
  });
  listenPrivate(gateway.publicServer, pub);
  listenPrivate(gateway.approvalServer, owner);
  await Promise.all([gateway.publicServer, gateway.approvalServer].map(server => server.listening ? undefined : new Promise(resolve => server.once("listening", resolve))));
  t.after(async () => {
    await Promise.all([upstream, gateway.publicServer, gateway.approvalServer].map(server => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const publicCall = (route, method, data, headers) => call(pub, new URL(publicOrigin).host, route, method, data, headers);
  const ownerCall = (route, method, data, headers = {}) => call(owner, new URL(ownerOrigin).host, route, method, data,
    { "test-owner": "yes", origin: ownerOrigin, "content-type": "application/x-www-form-urlencoded", ...headers });
  const registration = await publicCall("/oauth/register", "POST", JSON.stringify({ redirect_uris: [callback], client_name: "Body fixture" }), { "content-type": "application/json" });
  assert.equal(registration.status, 201);
  const clientId = JSON.parse(registration.body).client_id;
  async function grant() {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: "code", code_challenge_method: "S256",
      code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), resource: publicOrigin + "/mcp" });
    const start = await publicCall("/oauth/authorize?" + query);
    assert.equal(start.status, 302);
    const location = new URL(start.headers.location);
    const consent = await ownerCall(location.pathname + location.search);
    assert.equal(consent.status, 200);
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.body)[1];
    const decision = await ownerCall(location.pathname, "POST", new URLSearchParams({ request: location.searchParams.get("request"), csrf, decision: "allow", duration: "3600" }).toString());
    assert.equal(decision.status, 302);
    const exchange = await publicCall("/oauth/token", "POST", new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, redirect_uri: callback,
      code: new URL(decision.headers.location).searchParams.get("code"), code_verifier: verifier, resource: publicOrigin + "/mcp" }).toString(), { "content-type": "application/x-www-form-urlencoded" });
    assert.equal(exchange.status, 200);
    return JSON.parse(exchange.body).access_token;
  }
  function hold(token, length = 2) {
    const seen = new Promise(resolve => { bodyObserver = resolve; });
    let request;
    const response = new Promise((resolve, reject) => {
      request = http.request({ socketPath: pub, path: "/mcp", method: "POST", headers: { host: new URL(publicOrigin).host,
        authorization: "Bearer " + token, "content-type": "application/json", "content-length": length } }, res => {
        let body = "";
        res.on("data", chunk => body += chunk);
        res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
      });
      request.on("error", reject);
      request.write("{");
    });
    return { request, response, seen };
  }
  return { pub, requests, publicCall, grant, hold };
}

test("MCP body proxy revalidates revocation after the initial authorization check", async t => {
  const f = await fixture(t);
  const token = await f.grant();
  const pending = f.hold(token);
  await pending.seen;
  assert.equal((await f.publicCall("/oauth/revoke", "POST", new URLSearchParams({ token }).toString(), { "content-type": "application/x-www-form-urlencoded" })).status, 200);
  pending.request.end("}");
  const response = await pending.response;
  assert.equal(response.status, 401);
  assert.deepEqual(JSON.parse(response.body), { error: "invalid_token" });
  assert.equal(response.headers["www-authenticate"], `Bearer resource_metadata="${publicOrigin}/.well-known/oauth-protected-resource/mcp"`);
  assert.equal(f.requests.length, 0);
});

test("MCP body proxy revalidates grant expiry before opening upstream", async t => {
  const f = await fixture(t);
  const token = await f.grant();
  const pending = f.hold(token);
  await pending.seen;
  const now = Date.now;
  t.mock.method(Date, "now", () => now() + 3600001);
  pending.request.end("}");
  const response = await pending.response;
  assert.equal(response.status, 401);
  assert.equal(f.requests.length, 0);
});

test("MCP body deadline is total, returns sanitized 408, and never forwards late data", async t => {
  const f = await fixture(t, 80);
  const token = await f.grant();
  const pending = f.hold(token, 100);
  await pending.seen;
  const started = performance.now();
  const ticker = setInterval(() => { if (!pending.request.destroyed) pending.request.write(" "); }, 20);
  try {
    const response = await pending.response;
    assert.equal(response.status, 408);
    assert.deepEqual(JSON.parse(response.body), { error: "request_timeout" });
    assert.ok(performance.now() - started < 1000);
    assert.equal(f.requests.length, 0);
  } finally { clearInterval(ticker); pending.request.destroy(); }
  const normal = await f.publicCall("/mcp", "POST", "{}", { authorization: "Bearer " + token, "content-type": "application/json" });
  assert.equal(normal.status, 200);
  assert.equal(f.requests.length, 1);
});

test("aborted body is not forwarded and does not poison the next authorized request", async t => {
  const f = await fixture(t);
  const token = await f.grant();
  const pending = f.hold(token);
  const expectedAbort = assert.rejects(pending.response, error => error.code === "ECONNRESET");
  await pending.seen;
  pending.request.destroy();
  await expectedAbort;
  const normal = await f.publicCall("/mcp", "POST", '{"literal":"fixture"}', { authorization: "Bearer " + token,
    "content-type": "application/json", origin: "https://client.example.test", "mcp-protocol-version": "2025-11-25" });
  assert.equal(normal.status, 200);
  assert.equal(f.requests.length, 1);
  assert.equal(Buffer.concat(f.requests[0].chunks).toString(), '{"literal":"fixture"}');
  assert.equal(f.requests[0].headers.authorization, undefined);
  assert.equal(f.requests[0].headers.origin, undefined);
  assert.equal(f.requests[0].headers["mcp-protocol-version"], "2025-11-25");
});

test("missing, malformed and unknown tokens and oversized bodies send zero upstream bytes", async t => {
  const f = await fixture(t);
  for (const authorization of [undefined, "Bearer malformed", "Bearer " + "x".repeat(43)]) {
    const result = await f.publicCall("/mcp", "POST", "{}", authorization ? { authorization } : {});
    assert.equal(result.status, 401);
  }
  const token = await f.grant();
  const oversized = f.hold(token, 1048577);
  assert.equal((await oversized.response).status, 413);
  oversized.request.destroy();
  assert.equal(f.requests.length, 0);
});

test("MCP body deadline rejects invalid configuration", () => {
  for (const mcpBodyTimeoutMs of [0, -1, 30001, NaN, Infinity, "80", "", 1.5]) {
    assert.throws(() => createGateway({ publicUrl: publicOrigin + "/mcp", approvalUrl: ownerOrigin + "/__terminal_mcp/authorize", redirectUris: [callback], mcpBodyTimeoutMs }, async () => false), /MCP body timeout/);
  }
});

test("chunked body exceeding the byte limit is refused before upstream setup", async t => {
  const f = await fixture(t);
  const token = await f.grant();
  const response = await new Promise((resolve, reject) => {
    const req = http.request({ socketPath: f.pub, path: "/mcp", method: "POST", headers: {
      host: new URL(publicOrigin).host, authorization: "Bearer " + token,
      "content-type": "application/json", "transfer-encoding": "chunked",
    } }, res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.write(Buffer.alloc(524288, "x"));
    req.write(Buffer.alloc(524288, "x"));
    req.end("x");
  });
  assert.equal(response.status, 413);
  assert.deepEqual(JSON.parse(response.body), { error: "request_too_large" });
  assert.equal(f.requests.length, 0);
});
