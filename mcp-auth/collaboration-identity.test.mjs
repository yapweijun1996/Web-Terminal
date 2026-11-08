import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { createGateway, createAccessVerifier, listenPrivate } from "./server.mjs";

const origin = "https://terminal.example.test";
function request(socket, token, headers = {}, host = "terminal.example.test") {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path: "/__terminal_mcp/authorize?view=input-identity", method: "GET", headers: {
      host, ...(token ? { "cf-access-jwt-assertion": token } : {}), ...headers,
    } }, res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject); req.end();
  });
}
async function fixture(t, verifier) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-identity-"));
  fs.chmodSync(root, 0o700);
  const gateway = createGateway({ publicUrl: "https://terminal-mcp.example.test/mcp", approvalUrl: origin + "/__terminal_mcp/authorize",
    redirectUris: ["https://client.example.test/callback"], upstreamSocket: path.join(root, "unused.sock") }, verifier);
  const pub = path.join(root, "public.sock"), owner = path.join(root, "owner.sock");
  listenPrivate(gateway.publicServer, pub); listenPrivate(gateway.approvalServer, owner);
  await Promise.all([gateway.publicServer, gateway.approvalServer].map(server => server.listening ? undefined : new Promise(resolve => server.once("listening", resolve))));
  t.after(async () => {
    await Promise.all([gateway.publicServer, gateway.approvalServer].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { pub, owner };
}
test("input identity is a minimal projection of signed Access claims, not owner-like headers", async t => {
  const config = { accessIssuer: "https://access.example.test", accessAudience: "terminal-audience", ownerEmail: "owner@example.test" };
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey); jwk.kid = "owner-fixture";
  const verify = createAccessVerifier(config, createLocalJWKSet({ keys: [jwk] }));
  const f = await fixture(t, verify);
  const expires = Math.floor(Date.now() / 1000) + 3600;
  async function signed({ email = config.ownerEmail, issuer = config.accessIssuer, audience = config.accessAudience, expiry = expires, subject = "verified-owner", key = privateKey } = {}) {
    return new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setIssuer(issuer).setAudience(audience)
      .setSubject(subject).setIssuedAt().setExpirationTime(expiry).sign(key);
  }
  const token = await signed();
  const response = await request(f.owner, token);
  assert.equal(response.status, 200);
  const identity = JSON.parse(response.body);
  assert.deepEqual(Object.keys(identity).sort(), ["authorized", "expires", "ownerId"]);
  assert.equal(identity.authorized, true);
  assert.equal(identity.expires, expires * 1000);
  assert.equal(identity.ownerId, crypto.createHash("sha256").update(config.accessIssuer + "\0verified-owner").digest("base64url"));
  assert.equal(response.body.includes(config.ownerEmail), false);
  assert.equal(response.body.includes(token), false);
  assert.equal(response.headers["cache-control"], "no-store");
  for (const bad of [undefined, "not-a-jwt", await signed({ email: "other@example.test" }), await signed({ issuer: "https://evil.example.test" }),
    await signed({ audience: "wrong-audience" }), await signed({ subject: "" }), await signed({ expiry: Math.floor(Date.now() / 1000) - 5 })]) {
    const result = await request(f.owner, bad, { "x-owner": "yes", "x-owner-id": "verified-owner", "cf-access-authenticated-user-email": config.ownerEmail });
    assert.equal(result.status, 401);
    assert.deepEqual(JSON.parse(result.body), { error: "invalid_token" });
  }
  const other = await generateKeyPair("RS256");
  assert.equal((await request(f.owner, await signed({ key: other.privateKey }))).status, 401);
  assert.equal((await request(f.owner, token, {}, "evil.example.test")).status, 400);
  assert.equal((await request(f.pub, token, {}, "terminal-mcp.example.test")).status, 404);
});

test("a boolean verifier cannot fabricate an independently verified owner identity", async t => {
  const f = await fixture(t, async () => true);
  const result = await request(f.owner, undefined, { "x-owner": "yes" });
  assert.equal(result.status, 401);
});
