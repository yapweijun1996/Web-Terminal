import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createGateway, listenPrivate } from "./server.mjs";
const origin = "https://terminal-mcp.example.test",
  approval = "https://terminal.example.test";
function call(socket, host, route, method = "GET", data = "", headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: socket,
        path: route,
        method,
        headers: {
          host,
          "content-length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (x) => (body += x));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}
test("owner consent, PKCE, one-use code, bearer proxy and negative boundaries", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-auth-"));
  fs.chmodSync(dir, 0o700);
  const pub = path.join(dir, "public.sock"),
    owner = path.join(dir, "owner.sock"),
    up = path.join(dir, "up.sock");
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.origin, undefined);
    res.end('{"ok":true}');
  });
  await new Promise((r) => upstream.listen(up, r));
  const gateway = createGateway(
    {
      publicUrl: origin + "/mcp",
      approvalUrl: approval + "/__terminal_mcp/authorize",
      redirectUris: ["https://client.example.test/callback"],
      upstreamSocket: up,
    },
    async (req) => req.headers["test-owner"] === "yes",
  );
  listenPrivate(gateway.publicServer, pub);
  listenPrivate(gateway.approvalServer, owner);
  await Promise.all(
    [gateway.publicServer, gateway.approvalServer].map(
      (s) => new Promise((r) => (s.listening ? r() : s.once("listening", r))),
    ),
  );
  t.after(async () => {
    await Promise.all(
      [upstream, gateway.publicServer, gateway.approvalServer].map(
        (s) => new Promise((r) => s.close(r)),
      ),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const publicCall = (route, method, data, headers) =>
    call(pub, "terminal-mcp.example.test", route, method, data, headers);
  for (const method of ["POST", "GET", "DELETE"])
    assert.equal((await publicCall("/mcp", method, "")).status, 401);
  assert.equal((await publicCall("/__terminal_mcp/authorize")).status, 404);
  assert.equal(
    (await call(pub, "evil.example", "/.well-known/oauth-authorization-server"))
      .status,
    400,
  );
  assert.equal(
    (await publicCall("/.well-known/oauth-protected-resource/mcp")).status,
    200,
  );
  assert.equal(
    (
      await publicCall(
        "/oauth/register",
        "POST",
        JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }),
        { "content-type": "application/json" },
      )
    ).status,
    400,
  );
  const metadata = await publicCall("/.well-known/oauth-authorization-server");
  assert.equal(
    JSON.parse(metadata.body).authorization_response_iss_parameter_supported,
    true,
  );
  assert.equal(JSON.parse(metadata.body).issuer, origin);
  const registered = await publicCall(
    "/oauth/register",
    "POST",
    JSON.stringify({
      redirect_uris: ["https://client.example.test/callback"],
      client_name: "Fixture",
    }),
    { "content-type": "application/json" },
  );
  assert.equal(registered.status, 201);
  const client = JSON.parse(registered.body).client_id;
  const verifier = crypto.randomBytes(32).toString("base64url"),
    challenge = crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");
  const query = new URLSearchParams({
    client_id: client,
    redirect_uri: "https://client.example.test/callback",
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: challenge,
    resource: origin + "/mcp",
    state: "fixture",
  });
  for (const [key, value] of [
    ["resource", origin + "/other"],
    ["code_challenge_method", "plain"],
    ["redirect_uri", "https://evil.example/cb"],
  ]) {
    const invalid = new URLSearchParams(query);
    invalid.set(key, value);
    assert.equal((await publicCall("/oauth/authorize?" + invalid)).status, 400);
  }
  assert.equal(
    (await publicCall("/oauth/authorize?" + query + "&client_id=" + client))
      .status,
    400,
  );
  const start = await publicCall("/oauth/authorize?" + query);
  assert.equal(start.status, 302);
  const route =
    new URL(start.headers.location).pathname +
    new URL(start.headers.location).search;
  assert.equal((await call(owner, "terminal.example.test", route)).status, 401);
  const consent = await call(owner, "terminal.example.test", route, "GET", "", {
    "test-owner": "yes",
  });
  assert.equal(consent.status, 200);
  assert.match(consent.body, /Share your terminal/);
  const id = new URL(start.headers.location).searchParams.get("request"),
    csrf = /name="csrf" value="([^"]+)"/.exec(consent.body)[1];
  const form = new URLSearchParams({
      request: id,
      csrf,
      decision: "allow",
    }).toString(),
    hdr = {
      "test-owner": "yes",
      "content-type": "application/x-www-form-urlencoded",
      origin: approval,
    };
  assert.equal(
    (
      await call(
        owner,
        "terminal.example.test",
        "/__terminal_mcp/authorize",
        "POST",
        form,
        { ...hdr, origin: "https://evil.example" },
      )
    ).status,
    400,
  );
  const decision = await call(
    owner,
    "terminal.example.test",
    "/__terminal_mcp/authorize",
    "POST",
    form,
    hdr,
  );
  assert.equal(decision.status, 302);
  assert.equal(
    new URL(decision.headers.location).searchParams.get("iss"),
    origin,
  );
  const code = new URL(decision.headers.location).searchParams.get("code");
  assert.equal(
    new URL(decision.headers.location).searchParams.get("state"),
    "fixture",
  );
  const exchange = new URLSearchParams({
    client_id: client,
    redirect_uri: "https://client.example.test/callback",
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    resource: origin + "/mcp",
  }).toString();
  const token = await publicCall("/oauth/token", "POST", exchange, {
    "content-type": "application/x-www-form-urlencoded",
  });
  assert.equal(token.status, 200);
  assert.equal(
    (
      await publicCall("/oauth/token", "POST", exchange, {
        "content-type": "application/x-www-form-urlencoded",
      })
    ).status,
    400,
  );
  const freshCode = async (decision = "allow") => {
    const fresh = await publicCall("/oauth/authorize?" + query);
    const url = new URL(fresh.headers.location);
    const page = await call(
      owner,
      "terminal.example.test",
      url.pathname + url.search,
      "GET",
      "",
      { "test-owner": "yes" },
    );
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)[1];
    const wrong = await call(
      owner,
      "terminal.example.test",
      url.pathname,
      "POST",
      new URLSearchParams({
        request: url.searchParams.get("request"),
        csrf: "wrong",
        decision: "allow",
      }).toString(),
      hdr,
    );
    assert.equal(wrong.status, 400);
    const allowed = await call(
      owner,
      "terminal.example.test",
      url.pathname,
      "POST",
      new URLSearchParams({
        request: url.searchParams.get("request"),
        csrf,
        decision,
      }).toString(),
      hdr,
    );
    const returned = new URL(allowed.headers.location);
    assert.equal(returned.searchParams.get("iss"), origin);
    if (decision === "deny") {
      assert.equal(returned.searchParams.get("error"), "access_denied");
      assert.equal(returned.searchParams.has("code"), false);
    }
    return returned.searchParams.get("code");
  };
  await freshCode("deny");
  for (const [key, value] of [
    ["code_verifier", "x".repeat(43)],
    ["resource", origin + "/wrong"],
  ]) {
    const invalid = new URLSearchParams(exchange);
    invalid.set("code", await freshCode());
    invalid.set(key, value);
    assert.equal(
      (
        await publicCall("/oauth/token", "POST", invalid.toString(), {
          "content-type": "application/x-www-form-urlencoded",
        })
      ).status,
      400,
    );
  }
  const expiringCode = await freshCode(),
    expired = new URLSearchParams(exchange);
  expired.set("code", expiringCode);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 61000;
    assert.equal(
      (
        await publicCall("/oauth/token", "POST", expired.toString(), {
          "content-type": "application/x-www-form-urlencoded",
        })
      ).status,
      400,
    );
  } finally {
    Date.now = realNow;
  }
  const bearer = JSON.parse(token.body).access_token;
  const response = await publicCall("/mcp", "POST", "{}", {
    authorization: "Bearer " + bearer,
    "content-type": "application/json",
    origin: "https://client.example.test",
  });
  assert.equal(response.status, 200);
  assert.equal(response.body, '{"ok":true}');
  for (const method of ["GET", "DELETE"])
    assert.equal(
      (
        await publicCall("/mcp", method, "", {
          authorization: "Bearer " + bearer,
        })
      ).status,
      405,
    );
  assert.equal(
    (
      await publicCall(
        "/oauth/revoke",
        "POST",
        new URLSearchParams({ token: bearer }).toString(),
        { "content-type": "application/x-www-form-urlencoded" },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await publicCall("/mcp", "POST", "{}", {
        authorization: "Bearer " + bearer,
      })
    ).status,
    401,
  );
  const freshTokenCode = await freshCode(),
    freshExchange = new URLSearchParams(exchange);
  freshExchange.set("code", freshTokenCode);
  const freshToken = JSON.parse(
    (
      await publicCall("/oauth/token", "POST", freshExchange.toString(), {
        "content-type": "application/x-www-form-urlencoded",
      })
    ).body,
  ).access_token;
  try {
    Date.now = () => realNow() + 2592000001;
    assert.equal(
      (
        await publicCall("/mcp", "POST", "{}", {
          authorization: "Bearer " + freshToken,
        })
      ).status,
      401,
    );
  } finally {
    Date.now = realNow;
  }
});

test("signed Access JWT pins issuer, audience, signature, expiry and optional owner", async () => {
  const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } =
    await import("jose");
  const { createAccessVerifier } = await import("./server.mjs");
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "fixture";
  const config = {
    accessIssuer: "https://access.example.test",
    accessAudience: "terminal-audience",
    ownerEmail: "owner@example.test",
  };
  const verify = createAccessVerifier(
    config,
    createLocalJWKSet({ keys: [jwk] }),
  );
  const signed = async (overrides = {}, key = privateKey) =>
    new SignJWT({ email: "owner@example.test", ...overrides })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(config.accessIssuer)
      .setAudience(config.accessAudience)
      .setSubject("owner")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key);
  const req = (token) => ({ headers: { "cf-access-jwt-assertion": token } });
  assert.equal(await verify(req(await signed())), true);
  assert.equal(
    await createAccessVerifier(
      { ...config, ownerEmail: undefined },
      createLocalJWKSet({ keys: [jwk] }),
    )(req(await signed())),
    true,
  );
  assert.equal(
    await verify(req(await signed({ email: "other@example.test" }))),
    false,
  );
  await assert.rejects(() => verify(req("not-a-jwt")));
  const other = await generateKeyPair("RS256");
  await assert.rejects(async () =>
    verify(req(await signed({}, other.privateKey))),
  );
  for (const [issuer, audience, expires] of [
    ["https://other.example.test", config.accessAudience, "1h"],
    [config.accessIssuer, "wrong", "1h"],
    [config.accessIssuer, config.accessAudience, -10],
  ]) {
    const token = await new SignJWT({ email: "owner@example.test" })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("owner")
      .setIssuedAt()
      .setExpirationTime(expires)
      .sign(privateKey);
    await assert.rejects(() => verify(req(token)));
  }
});

test("OAuth gateway reaches actual MCP SDK and the same disposable tmux view", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-e2e-"));
  fs.chmodSync(dir, 0o700);
  const pub = path.join(dir, "public.sock"),
    owner = path.join(dir, "owner.sock"),
    up = path.join(dir, "up.sock");
  const tmuxName = "auth-e2e-" + crypto.randomUUID();
  const tmux = (...args) =>
    execFileSync("tmux", ["-L", tmuxName, ...args], { encoding: "utf8" });
  tmux("new-session", "-d", "-s", "workspace", "/bin/cat");
  tmux("new-session", "-d", "-t", "workspace", "-s", "view-fixture");
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../mcp/server.js", import.meta.url))],
    {
      env: {
        ...process.env,
        WEB_TERMINAL_MCP_SOCKET: up,
        WEB_TERMINAL_TMUX_SERVER: tmuxName,
        WEB_TERMINAL_MCP_SESSION: "workspace",
      },
      stdio: "ignore",
    },
  );
  const gateway = createGateway(
    {
      publicUrl: origin + "/mcp",
      approvalUrl: approval + "/__terminal_mcp/authorize",
      redirectUris: ["https://client.example.test/callback"],
      upstreamSocket: up,
    },
    async (req) => req.headers["test-owner"] === "yes",
  );
  listenPrivate(gateway.publicServer, pub);
  listenPrivate(gateway.approvalServer, owner);
  try {
    for (let i = 0; i < 100 && !fs.existsSync(up); i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(up));
    const pubCall = (route, method, data, headers) =>
      call(pub, "terminal-mcp.example.test", route, method, data, headers);
    const registration = await pubCall(
      "/oauth/register",
      "POST",
      JSON.stringify({
        redirect_uris: ["https://client.example.test/callback"],
      }),
      { "content-type": "application/json" },
    );
    const client = JSON.parse(registration.body).client_id;
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");
    const q = new URLSearchParams({
      client_id: client,
      redirect_uri: "https://client.example.test/callback",
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: challenge,
      resource: origin + "/mcp",
    });
    const auth = await pubCall("/oauth/authorize?" + q);
    const url = new URL(auth.headers.location);
    const consent = await call(
      owner,
      "terminal.example.test",
      url.pathname + url.search,
      "GET",
      "",
      { "test-owner": "yes" },
    );
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.body)[1];
    const allowed = await call(
      owner,
      "terminal.example.test",
      url.pathname,
      "POST",
      new URLSearchParams({
        request: url.searchParams.get("request"),
        csrf,
        decision: "allow",
      }).toString(),
      {
        "test-owner": "yes",
        origin: approval,
        "content-type": "application/x-www-form-urlencoded",
      },
    );
    const exchanged = await pubCall(
      "/oauth/token",
      "POST",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client,
        redirect_uri: "https://client.example.test/callback",
        resource: origin + "/mcp",
        code: new URL(allowed.headers.location).searchParams.get("code"),
        code_verifier: verifier,
      }).toString(),
      { "content-type": "application/x-www-form-urlencoded" },
    );
    const token = JSON.parse(exchanged.body).access_token;
    assert.ok(token);
    const rpc = async (method, params) => {
      const response = await pubCall(
        "/mcp",
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        {
          authorization: "Bearer " + token,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
      );
      assert.equal(response.status, 200);
      return JSON.parse(response.body).result;
    };
    assert.equal(
      (
        await rpc("initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "auth-fixture", version: "1" },
        })
      ).serverInfo.name,
      "web-terminal",
    );
    assert.equal((await rpc("tools/list", {})).tools.length, 6);
    const listed = await rpc("tools/call", {
      name: "terminal_list",
      arguments: {},
    });
    const target = JSON.parse(listed.content[0].text)[0];
    const typed = await rpc("tools/call", {
      name: "terminal_type",
      arguments: { target, text: "OAUTH_SAME_VIEW" },
    });
    assert.equal(typed.isError, undefined);
    await new Promise((r) => setTimeout(r, 100));
    assert.match(
      tmux("capture-pane", "-p", "-t", "view-fixture:"),
      /OAUTH_SAME_VIEW/,
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    await Promise.all(
      [gateway.publicServer, gateway.approvalServer].map(
        (s) => new Promise((r) => s.close(r)),
      ),
    );
    tmux("kill-server");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
