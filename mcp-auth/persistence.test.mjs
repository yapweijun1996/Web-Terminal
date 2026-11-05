import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGateway } from "./server.mjs";
const issuer = "https://mcp.example.test",
  ownerOrigin = "https://terminal.example.test";
async function request(server, route, method = "GET", body = "", headers = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: route,
        method,
        headers: {
          host:
            server === current?.publicServer
              ? "mcp.example.test"
              : "terminal.example.test",
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: text }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
let current;
const hidden = (html, name) =>
  new RegExp('name="' + name + '" value="([^"]+)"').exec(html)?.[1];
test("duration boundaries, durable gateway restart and protected owner revocation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-durable-"));
  fs.chmodSync(root, 0o700);
  const stateDir = path.join(root, "state"),
    keys = path.join(root, "keys");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.mkdirSync(keys, { mode: 0o700 });
  const config = {
    publicUrl: issuer + "/mcp",
    approvalUrl: ownerOrigin + "/authorize",
    redirectUris: ["https://client.example.test/cb"],
    upstreamSocket: path.join(root, "missing.sock"),
    stateDir,
    keyFile: path.join(keys, "key"),
  };
  const start = async () => {
    current = createGateway(config, async (req) => req.headers.owner === "yes");
    await Promise.all(
      [current.publicServer, current.approvalServer].map(
        (s) => new Promise((r) => s.listen(0, "127.0.0.1", r)),
      ),
    );
  };
  const stop = async () =>
    Promise.all(
      [current.publicServer, current.approvalServer].map(
        (s) => new Promise((r) => s.close(r)),
      ),
    );
  t.after(async () => {
    if (current.publicServer.listening) await stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await start();
  const formHeaders = {
    owner: "yes",
    origin: ownerOrigin,
    "content-type": "application/x-www-form-urlencoded",
  };
  const registration = await request(
    current.publicServer,
    "/oauth/register",
    "POST",
    JSON.stringify({
      redirect_uris: config.redirectUris,
      client_name: "Fixture",
    }),
    { "content-type": "application/json" },
  );
  const clientId = JSON.parse(registration.body).client_id;
  const prepare = async (registeredClient = clientId) => {
    const verifier = crypto.randomBytes(32).toString("base64url"),
      challenge = crypto
        .createHash("sha256")
        .update(verifier)
        .digest("base64url");
    const query = new URLSearchParams({
      client_id: registeredClient,
      redirect_uri: config.redirectUris[0],
      resource: config.publicUrl,
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: challenge,
    });
    const auth = await request(
      current.publicServer,
      "/oauth/authorize?" + query,
    );
    assert.equal(auth.status, 302);
    const url = new URL(auth.headers.location),
      page = await request(
        current.approvalServer,
        url.pathname + url.search,
        "GET",
        "",
        { owner: "yes" },
      );
    assert.equal(page.status, 200);
    assert.match(page.body, /<option value="2592000" selected/);
    return {
      clientId: registeredClient,
      verifier,
      request: hidden(page.body, "request"),
      csrf: hidden(page.body, "csrf"),
    };
  };
  const approve = async (prepared, duration) => {
    const body = new URLSearchParams({
      request: prepared.request,
      csrf: prepared.csrf,
      decision: "allow",
      ...(duration === undefined ? {} : { duration }),
    });
    const result = await request(
      current.approvalServer,
      "/authorize",
      "POST",
      body.toString(),
      formHeaders,
    );
    assert.equal(result.status, 302);
    return new URL(result.headers.location).searchParams.get("code");
  };
  const exchange = async (prepared, code) => {
    const result = await request(
      current.publicServer,
      "/oauth/token",
      "POST",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: prepared.clientId,
        redirect_uri: config.redirectUris[0],
        resource: config.publicUrl,
        code,
        code_verifier: prepared.verifier,
      }).toString(),
      { "content-type": "application/x-www-form-urlencoded" },
    );
    assert.equal(result.status, 200);
    return JSON.parse(result.body);
  };
  const first = await prepare();
  for (const duration of [
    "0",
    "-1",
    "31536001",
    "63072000",
    "1e6",
    "2592000.0",
    "",
  ]) {
    const form = new URLSearchParams({
      request: first.request,
      csrf: first.csrf,
      decision: "allow",
      duration,
    });
    assert.equal(
      (
        await request(
          current.approvalServer,
          "/authorize",
          "POST",
          form.toString(),
          formHeaders,
        )
      ).status,
      400,
    );
  }
  const duplicate = new URLSearchParams({
    request: first.request,
    csrf: first.csrf,
    decision: "allow",
    duration: "2592000",
  });
  duplicate.append("duration", "31536000");
  assert.equal(
    (
      await request(
        current.approvalServer,
        "/authorize",
        "POST",
        duplicate.toString(),
        formHeaders,
      )
    ).status,
    400,
  );
  const clock = Date.now,
    base = clock();
  let token;
  try {
    Date.now = () => base;
    const code = await approve(first);
    Date.now = () => base + 5000;
    token = await exchange(first, code);
    assert.equal(token.expires_in, 2591995);
  } finally {
    Date.now = clock;
  }
  assert.equal(
    (
      await request(current.publicServer, "/mcp", "GET", "", {
        authorization: "Bearer " + token.access_token,
      })
    ).status,
    405,
  );
  let freshClient;
  for (let index = 0; index < 105; index++) {
    const response = await request(
      current.publicServer,
      "/oauth/register",
      "POST",
      JSON.stringify({
        redirect_uris: config.redirectUris,
        client_name: "Unapproved",
      }),
      { "content-type": "application/json" },
    );
    assert.equal(response.status, 201);
    freshClient = JSON.parse(response.body).client_id;
  }
  const freshPrepared = await prepare(freshClient);
  await exchange(freshPrepared, await approve(freshPrepared, "3600"));
  assert.equal(
    (
      await request(current.publicServer, "/mcp", "GET", "", {
        authorization: "Bearer " + token.access_token,
      })
    ).status,
    405,
  );
  const stalePage = await prepare();
  await stop();
  await start();
  assert.equal(
    (
      await request(current.publicServer, "/mcp", "GET", "", {
        authorization: "Bearer " + token.access_token,
      })
    ).status,
    405,
  );
  const stalePost = await request(
    current.approvalServer,
    "/authorize",
    "POST",
    new URLSearchParams({
      request: stalePage.request,
      csrf: stalePage.csrf,
      decision: "allow",
    }).toString(),
    formHeaders,
  );
  assert.equal(stalePost.status, 400);
  assert.match(stalePost.headers["content-type"], /text\/html/);
  assert.match(stalePost.body, /Connection request expired/);
  const max = await prepare();
  const maximum = await exchange(max, await approve(max, "31536000"));
  assert.ok(maximum.expires_in <= 31536000 && maximum.expires_in >= 31535998);
  assert.equal(
    (await request(current.approvalServer, "/authorize?view=connections"))
      .status,
    401,
  );
  const management = await request(
    current.approvalServer,
    "/authorize?view=connections",
    "GET",
    "",
    { owner: "yes" },
  );
  assert.equal(management.status, 200);
  assert.equal(management.body.includes(token.access_token), false);
  const csrf = hidden(management.body, "csrf"),
    grantId = hidden(management.body, "grantId");
  assert.ok(grantId);
  assert.ok(csrf);
  const revoke = new URLSearchParams({
    csrf,
    grantId,
    action: "revoke",
  }).toString();
  assert.equal(
    (
      await request(
        current.approvalServer,
        "/authorize?view=connections",
        "POST",
        revoke,
        { ...formHeaders, origin: "https://evil.example" },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        current.approvalServer,
        "/authorize?view=connections",
        "POST",
        revoke,
        formHeaders,
      )
    ).status,
    303,
  );
  assert.equal(
    (
      await request(current.publicServer, "/mcp", "GET", "", {
        authorization: "Bearer " + token.access_token,
      })
    ).status,
    401,
  );
  await stop();
  await start();
  assert.equal(
    (
      await request(current.publicServer, "/mcp", "GET", "", {
        authorization: "Bearer " + token.access_token,
      })
    ).status,
    401,
  );
  await prepare();
  const disk = fs.readFileSync(path.join(stateDir, "grants.json"), "utf8");
  assert.equal(disk.includes(token.access_token), false);
  assert.equal(disk.includes(maximum.access_token), false);
  config.redirectUris = ["https://other.example.test/cb"];
  await stop();
  await start();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "https://client.example.test/cb",
    resource: config.publicUrl,
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64url"),
  });
  assert.equal(
    (await request(current.publicServer, "/oauth/authorize?" + query)).status,
    400,
  );
});
