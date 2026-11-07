"use strict";
// Opt-in: PLAYWRIGHT_MODULE=/path/to/playwright node mcp-auth/browser/native-consent.e2e.cjs
const assert = require("node:assert/strict"),
  https = require("node:https"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
(async () => {
  const { createGateway } = await import("../server.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-consent-"));
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
  let gateway, policyOverride;
  const observed = [];
  const server = https.createServer(
    { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
    (req, res) => {
      const route = new URL(req.url, "https://fixture.invalid").pathname;
      if (route === "/fixture/callback") {
        res.writeHead(200, {
          "Content-Type": "text/html",
          "Referrer-Policy": "same-origin",
        });
        return res.end("<h1>Returned to app</h1>");
      }
      if (route === "/authorize") {
        if (req.method === "POST") {
          const entry = {
            origin: req.headers.origin || "(missing)",
            status: null,
          };
          observed.push(entry);
          res.once("finish", () => {
            entry.status = res.statusCode;
          });
        }
        if (policyOverride) {
          const writeHead = res.writeHead;
          res.writeHead = function (status, headers) {
            return writeHead.call(this, status, {
              ...headers,
              "Referrer-Policy": policyOverride,
            });
          };
        }
        return gateway.approvalServer.emit("request", req, res);
      }
      gateway.publicServer.emit("request", req, res);
    },
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = "https://127.0.0.1:" + server.address().port;
  // Inject owner verification only in this loopback fixture; production still verifies signed Access JWTs.
  gateway = createGateway(
    {
      publicUrl: origin + "/mcp",
      approvalUrl: origin + "/authorize",
      redirectUris: [origin + "/fixture/callback"],
      upstreamSocket: path.join(dir, "unused.sock"),
      maxGrantSeconds: process.env.MCP_TEST_MAX_GRANT_SECONDS,
    },
    async () => true,
  );
  const request = (route, method = "GET", data = "", headers = {}) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        origin + route,
        {
          method,
          rejectUnauthorized: false,
          headers: { "content-length": Buffer.byteLength(data), ...headers },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode, headers: res.headers, body }),
          );
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  const start = async () => {
    const registered = await request(
      "/oauth/register",
      "POST",
      JSON.stringify({
        redirect_uris: [origin + "/fixture/callback"],
        client_name: "Native browser fixture",
      }),
      { "content-type": "application/json" },
    );
    assert.equal(registered.status, 201);
    const clientId = JSON.parse(registered.body).client_id;
    const verifier = crypto.randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: origin + "/fixture/callback",
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: crypto
        .createHash("sha256")
        .update(verifier)
        .digest("base64url"),
      resource: origin + "/mcp",
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
    policyOverride = "no-referrer";
    await page.goto(await start());
    await page
      .getByRole("button", { name: "Allow access", exact: true })
      .click();
    await page.waitForLoadState("load");
    assert.equal(observed.at(-1).origin, "null");
    assert.equal(observed.at(-1).status, 400);
    console.log(
      JSON.stringify({
        case: "baseline-no-referrer",
        nativePostOrigin: "null",
        status: 400,
      }),
    );
    if (process.env.BASELINE_ONLY === "1") return;
    policyOverride = undefined;
    if (process.env.MCP_CONSENT_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.MCP_CONSENT_SCREENSHOT_DIR, { recursive: true });
      for (const width of [390, 768, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(await start());
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.ok((await page.getByRole("button", { name: "Allow access", exact: true }).boundingBox()).height >= 44);
        await page.screenshot({ path: path.join(process.env.MCP_CONSENT_SCREENSHOT_DIR, `consent-${width}.png`), fullPage: true });
      }
    }
    for (const decision of ["Deny", "Allow access"]) {
      await page.goto(await start());
      await page.getByRole("button", { name: decision, exact: true }).click();
      await page.waitForURL(origin + "/fixture/callback**");
      assert.equal(observed.at(-1).origin, origin);
      assert.equal(observed.at(-1).status, 302);
      console.log(
        JSON.stringify({
          case: decision === "Deny" ? "native-deny" : "native-allow",
          originMatches: true,
          status: 302,
        }),
      );
    }
    await page.goto(origin + "/authorize?view=connections");
    const revoke = page.getByRole("button", { name: /Revoke/i }).first();
    assert.equal(await revoke.count(), 1);
    await revoke.click();
    await page.waitForURL("**view=connections&revoked=1");
    assert.equal(observed.at(-1).origin, origin);
    assert.equal(observed.at(-1).status, 303);
    console.log(
      JSON.stringify({
        case: "native-revoke",
        originMatches: true,
        status: 303,
      }),
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(
    error.name +
      ": " +
      error.message.replace(
        /https:\/\/127\.0\.0\.1:\d+\/authorize\?[^\s]+/g,
        "[fixture request]",
      ),
  );
  process.exitCode = 1;
});
