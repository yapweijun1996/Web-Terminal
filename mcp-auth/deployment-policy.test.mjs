import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGateway, listenPrivate } from "./server.mjs";

test("Linux one-hour limit survives styled consent; diagnostics exclude private values", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consent-policy-"));
  const events = [];
  const config = {
    publicUrl: "https://mcp.example.test/mcp",
    approvalUrl: "https://owner.example.test/authorize",
    redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    upstreamSocket: path.join(dir, "unused.sock"),
    maxGrantSeconds: "3600",
    onRequest: (event) => events.push(event),
  };
  assert.throws(() => createGateway({ ...config, maxGrantSeconds: "invalid" }, async () => true));
  const gateway = createGateway(config, async () => true);
  const pub = path.join(dir, "public.sock"), owner = path.join(dir, "owner.sock");
  listenPrivate(gateway.publicServer, pub);
  listenPrivate(gateway.approvalServer, owner);
  await Promise.all([gateway.publicServer, gateway.approvalServer].map((s) =>
    s.listening ? Promise.resolve() : new Promise((resolve) => s.once("listening", resolve))));
  t.after(async () => {
    await Promise.all([gateway.publicServer, gateway.approvalServer].map((s) => new Promise((resolve) => s.close(resolve))));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = (ownerRequest, route, data, headers = {}) => new Promise((resolve, reject) => {
    const request = http.request({ socketPath: ownerRequest ? owner : pub, path: route,
      method: data === undefined ? "GET" : "POST",
      headers: { host: ownerRequest ? "owner.example.test" : "mcp.example.test", ...headers } }, (response) => {
      let body = "";
      response.on("data", (chunk) => body += chunk);
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on("error", reject);
    request.end(data);
  });
  const registration = await call(false, "/oauth/register", JSON.stringify({ redirect_uris: config.redirectUris }), { "content-type": "application/json" });
  assert.equal(registration.status, 201);
  const client = JSON.parse(registration.body).client_id;
  const verifier = crypto.randomBytes(32).toString("base64url");
  const query = new URLSearchParams({ client_id: client, redirect_uri: config.redirectUris[0], response_type: "code",
    code_challenge_method: "S256", code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
    resource: config.publicUrl, state: "PRIVATE_STATE" });
  const start = await call(false, "/oauth/authorize?" + query);
  assert.equal(start.status, 302);
  const url = new URL(start.headers.location);
  const page = await call(true, url.pathname + url.search);
  assert.equal(page.headers["referrer-policy"], "same-origin");
  assert.match(page.headers["content-security-policy"], /form-action 'self' https:\/\/chatgpt.com\/connector_platform_oauth_redirect/);
  assert.match(page.body, /<option value="3600" selected>1 hour<\/option>/);
  assert.match(page.body, /Maximum: 1 hour/);
  assert.doesNotMatch(page.body, /<option value="2592000"|365 days/);
  const fields = { request: url.searchParams.get("request"), csrf: /name="csrf" value="([^"]+)"/.exec(page.body)[1], decision: "allow" };
  const headers = { origin: "https://owner.example.test", "content-type": "application/x-www-form-urlencoded" };
  const invalidOrigin = await call(true, url.pathname, new URLSearchParams(fields).toString(), { ...headers, origin: "null" });
  assert.equal(invalidOrigin.status, 400);
  assert.match(invalidOrigin.body, /Unable to confirm this request/);
  assert.equal((await call(true, url.pathname, new URLSearchParams({ ...fields, duration: "2592000" }).toString(), headers)).status, 400);
  const allowed = await call(true, url.pathname, new URLSearchParams(fields).toString(), headers);
  assert.equal(allowed.status, 302);
  const result = new URL(allowed.headers.location);
  assert.equal(result.searchParams.get("iss"), "https://mcp.example.test");
  const token = await call(false, "/oauth/token", new URLSearchParams({ grant_type: "authorization_code", client_id: client,
    redirect_uri: config.redirectUris[0], resource: config.publicUrl, code: result.searchParams.get("code"), code_verifier: verifier }).toString(),
    { "content-type": "application/x-www-form-urlencoded" });
  assert.equal(token.status, 200);
  assert.ok(JSON.parse(token.body).expires_in <= 3600);
  await call(false, "/unknown-private-path?token=PRIVATE_QUERY", "PRIVATE_BODY");
  assert.ok(events.some((event) => event.route === "other" && event.status === 404));
  for (const event of events) assert.deepEqual(Object.keys(event).sort(), ["method", "route", "status", "surface"]);
  const logged = JSON.stringify(events);
  assert.doesNotMatch(logged, /PRIVATE_STATE|PRIVATE_QUERY|PRIVATE_BODY|unknown-private-path/);
  for (const secret of [fields.request, fields.csrf, verifier, result.searchParams.get("code"), JSON.parse(token.body).access_token])
    assert.ok(!logged.includes(secret));
});
