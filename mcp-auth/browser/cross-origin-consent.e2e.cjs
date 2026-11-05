"use strict";
// Opt-in: PLAYWRIGHT_MODULE=/path/to/playwright node mcp-auth/browser/cross-origin-consent.e2e.cjs
const assert = require("node:assert/strict"),
  https = require("node:https"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
(async () => {
  const { createGateway } = await import("../server.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-consent-"));
  fs.chmodSync(dir, 0o700);
  const key = path.join(dir, "key.pem"),
    cert = path.join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const tls = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
    returns = new Map(),
    observed = [];
  const upstreamSocket = path.join(dir, "mcp.sock");
  const sdk = spawn(
    process.execPath,
    [path.resolve(__dirname, "../../mcp/server.js")],
    {
      env: {
        ...process.env,
        WEB_TERMINAL_MCP_SOCKET: upstreamSocket,
        WEB_TERMINAL_TMUX_SERVER: "cross-origin-fixture-unused-" + process.pid,
        WEB_TERMINAL_MCP_SESSION: "workspace",
      },
      stdio: "ignore",
    },
  );
  for (
    let attempt = 0;
    attempt < 100 && !fs.existsSync(upstreamSocket);
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(upstreamSocket));
  let gateway,
    request,
    origin,
    callback,
    blockRedirect = false,
    arrivals = 0,
    exchanges = 0,
    bearer;
  const callbackServer = https.createServer(tls, async (req, res) => {
    try {
      const url = new URL(req.url, callback);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        return res.end();
      }
      arrivals++;
      const record = returns.get(url.searchParams.get("state"));
      assert.ok(record);
      assert.equal(url.searchParams.get("iss"), origin);
      if (url.searchParams.has("error"))
        assert.equal(url.searchParams.get("error"), "access_denied");
      else {
        const result = await request(
          "/oauth/token",
          "POST",
          new URLSearchParams({
            grant_type: "authorization_code",
            client_id: record.clientId,
            redirect_uri: callback,
            resource: origin + "/mcp",
            code: url.searchParams.get("code"),
            code_verifier: record.verifier,
          }).toString(),
          { "content-type": "application/x-www-form-urlencoded" },
        );
        assert.equal(result.status, 200);
        bearer = JSON.parse(result.body).access_token;
        assert.ok(bearer);
        exchanges++;
        for (const [id, method, params] of [
          [
            1,
            "initialize",
            {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "cross-origin-fixture", version: "1" },
            },
          ],
          [2, "tools/list", {}],
        ]) {
          const mcp = await request(
            "/mcp",
            "POST",
            JSON.stringify({ jsonrpc: "2.0", id, method, params }),
            {
              authorization: "Bearer " + bearer,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
          );
          assert.equal(mcp.status, 200);
          const payload = JSON.parse(mcp.body);
          if (method === "initialize")
            assert.equal(payload.result.serverInfo.name, "web-terminal");
          else assert.equal(payload.result.tools.length, 6);
        }
        assert.equal(
          (
            await request("/mcp", "GET", "", {
              authorization: "Bearer " + bearer,
            })
          ).status,
          405,
        );
      }
      res.writeHead(200, {
        "content-type": "text/html",
        "Referrer-Policy": "no-referrer",
      });
      res.end("<h1>App callback completed</h1>");
    } catch {
      res.writeHead(500);
      res.end("Fixture callback failed");
    }
  });
  await new Promise((r) => callbackServer.listen(0, "127.0.0.1", r));
  callback = "https://127.0.0.1:" + callbackServer.address().port + "/callback";
  const server = https.createServer(tls, (req, res) => {
    const route = new URL(req.url, "https://fixture.invalid").pathname;
    if (route === "/authorize") {
      if (req.method === "POST") {
        const row = { origin: req.headers.origin, status: null };
        observed.push(row);
        res.once("finish", () => (row.status = res.statusCode));
      }
      if (blockRedirect) {
        const write = res.writeHead;
        res.writeHead = function (status, headers) {
          return write.call(this, status, {
            ...headers,
            "Content-Security-Policy":
              headers["Content-Security-Policy"]?.replace(
                /form-action[^;]+/,
                "form-action 'self'",
              ) || "default-src 'none'; form-action 'self'",
          });
        };
      }
      gateway.approvalServer.emit("request", req, res);
    } else gateway.publicServer.emit("request", req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = "https://127.0.0.1:" + server.address().port;
  assert.notEqual(new URL(callback).origin, origin);
  // Owner verification is synthetic only inside this disposable TLS fixture.
  gateway = createGateway(
    {
      publicUrl: origin + "/mcp",
      approvalUrl: origin + "/authorize",
      redirectUris: [callback],
      upstreamSocket,
    },
    async () => true,
  );
  request = (route, method = "GET", data = "", headers = {}) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        origin + route,
        {
          method,
          rejectUnauthorized: false,
          agent: false,
          headers: { "content-length": Buffer.byteLength(data), ...headers },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: text,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  const start = async () => {
    const registration = await request(
      "/oauth/register",
      "POST",
      JSON.stringify({
        redirect_uris: [callback],
        client_name: "Cross-origin fixture",
      }),
      { "content-type": "application/json" },
    );
    assert.equal(registration.status, 201);
    const clientId = JSON.parse(registration.body).client_id,
      verifier = crypto.randomBytes(32).toString("base64url"),
      state = crypto.randomBytes(16).toString("hex");
    returns.set(state, { clientId, verifier });
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callback,
      resource: origin + "/mcp",
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: crypto
        .createHash("sha256")
        .update(verifier)
        .digest("base64url"),
      state,
    });
    const result = await request("/oauth/authorize?" + query);
    assert.equal(result.status, 302);
    return result.headers.location;
  };
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || "chrome",
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    let cspBlocked = false;
    page.on("console", (message) => {
      if (message.type() === "error" && message.text().includes("form-action"))
        cspBlocked = true;
    });
    blockRedirect = true;
    await page.goto(await start());
    await page
      .getByRole("button", { name: "Allow access", exact: true })
      .click({ noWaitAfter: true });
    await page.waitForTimeout(500);
    assert.equal(observed.at(-1).status, 302);
    assert.equal(cspBlocked, true);
    assert.equal(arrivals, 0);
    assert.equal(exchanges, 0);
    console.log(
      JSON.stringify({
        case: "baseline-self-only-csp",
        nativeOriginMatches: observed.at(-1).origin === origin,
        status: 302,
        callbackBlocked: true,
        tokenExchanged: false,
      }),
    );
    if (process.env.CSP_BASELINE_ONLY === "1") return;
    const countGrants = async () => {
      const response = await request("/authorize?view=connections");
      return [...response.body.matchAll(/name="grantId"/g)].length;
    };
    assert.equal(await countGrants(), 1);
    await page
      .getByRole("button", { name: "Allow access", exact: true })
      .click();
    await page.waitForLoadState("load");
    assert.equal(observed.at(-1).status, 409);
    assert.equal(
      await page
        .getByRole("heading", { name: "Connection request already handled" })
        .count(),
      1,
    );
    assert.equal(await countGrants(), 1);
    assert.equal(exchanges, 0);
    blockRedirect = false;
    for (const decision of ["Deny", "Allow access"]) {
      cspBlocked = false;
      await page.goto(await start());
      const prior = arrivals;
      await page.getByRole("button", { name: decision, exact: true }).click();
      await page.waitForURL(callback + "**");
      assert.equal(
        await page
          .getByRole("heading", { name: "App callback completed" })
          .count(),
        1,
      );
      assert.equal(arrivals, prior + 1);
      assert.equal(cspBlocked, false);
      assert.equal(observed.at(-1).origin, origin);
      console.log(
        JSON.stringify({
          case:
            decision === "Deny" ? "cross-origin-deny" : "cross-origin-allow",
          status: 302,
          callbackReached: true,
          tokenExchanged: decision === "Allow access",
        }),
      );
    }
    assert.equal(exchanges, 1);
    assert.equal(
      (await request("/mcp", "GET", "", { authorization: "Bearer " + bearer }))
        .status,
      405,
    );
  } finally {
    if (browser) await browser.close();
    await Promise.all(
      [server, callbackServer].map(
        (s) =>
          new Promise((r) => {
            s.close(r);
            s.closeAllConnections();
          }),
      ),
    );
    if (sdk.exitCode === null) {
      sdk.kill("SIGTERM");
      await new Promise((resolve) => sdk.once("exit", resolve));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(
    error.name +
      ": " +
      error.message.replace(
        /https:\/\/127\.0\.0\.1:\d+\/[^\s]*/g,
        "[fixture URL]",
      ),
  );
  process.exitCode = 1;
});
