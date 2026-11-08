import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import contract from "../../runtime/gateway/collaboration-contract.cjs";
const entry = fileURLToPath(new URL("../server.js", import.meta.url));
const baseTarget = { serverPid: "123", sessionId: "$1", windowId: "@1", paneId: "%1" };
async function fixture(t, packaged = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-coordination-"));
  const socket = path.join(root, "coord.sock"), mcpSocket = path.join(root, "mcp.sock");
  const admissions = new Map(), accepted = [], requests = [];
  let generation = "generation-1", errorOverride;
  // This is a TEST ONLY coordinator, not a production authorization verifier.
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const send = value => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    requests.push(req.url);
    if (req.url === "/v1/list") return send({ panes: [{ ...baseTarget, inputGeneration: generation, collaboration: { paused: false, writer: "shared", state: "ready" } }] });
    if (req.url !== "/v1/execute") return send({ error: { code: "OPERATION_UNAVAILABLE" } });
    if (errorOverride) return send({ error: { code: errorOverride, message: "secret upstream admission/token content" } });
    const record = admissions.get(payload.admission);
    admissions.delete(payload.admission);
    if (!record || record.expires <= Date.now() || record.tool !== payload.tool || record.digest !== contract.operationDigest(payload.tool, payload.arguments))
      return send({ error: { code: "AUTHORITY_UNAVAILABLE", message: "secret invalid authority details" } });
    if (payload.arguments.target.inputGeneration !== generation) return send({ error: { code: "STALE_INPUT_GENERATION" } });
    accepted.push({ tool: payload.tool, args: payload.arguments });
    if (payload.arguments.text === "SLOW_LITERAL") await new Promise(resolve => setTimeout(resolve, 100));
    return send({ sent: true, submitted: payload.tool === "terminal_send_key" && payload.arguments.key === "Enter" });
  });
  await new Promise(resolve => server.listen(socket, resolve)); fs.chmodSync(socket, 0o600);
  let serverFile = entry;
  if (packaged) {
    const mcp = path.join(root, "release", "mcp"), runtime = path.join(root, "release", "runtime", "gateway");
    fs.mkdirSync(mcp, { recursive: true }); fs.mkdirSync(runtime, { recursive: true });
    for (const name of ["server.js", "terminal.js", "terminal-errors.js", "coordinated-input.js", "package.json"])
      fs.copyFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), path.join(mcp, name));
    fs.copyFileSync(fileURLToPath(new URL("../../runtime/gateway/collaboration-contract.cjs", import.meta.url)), path.join(runtime, "collaboration-contract.cjs"));
    fs.symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), path.join(mcp, "node_modules"), "dir");
    serverFile = path.join(mcp, "server.js");
  }
  const env = { ...process.env, WEB_TERMINAL_MCP_INPUT_MODE: "coordinated", WEB_TERMINAL_MCP_TOOLS: "terminal-only",
    WEB_TERMINAL_TMUX_SERVER: "must-not-use-direct-controller", WEB_TERMINAL_MCP_SESSION: "workspace",
    WEB_TERMINAL_COLLABORATION_SOCKET: socket, WEB_TERMINAL_MCP_SOCKET: mcpSocket,
    WEB_TERMINAL_JOB_DIR: "invalid-relative-registry", TMUX_BIN: "/nonexistent/direct-tmux-forbidden" };
  const child = spawn(process.execPath, [serverFile], { env, stdio: "ignore" });
  t.after(async () => {
    if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise(resolve => child.once("exit", resolve)); }
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (let n = 0; n < 100 && !fs.existsSync(mcpSocket) && child.exitCode === null; n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(mcpSocket), "coordinated private MCP started");
  let id = 0;
  const request = (method, params, admission, origin) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: mcpSocket, method: "POST", path: "/mcp", headers: {
      Host: "localhost", Accept: "application/json, text/event-stream", "Content-Type": "application/json",
      ...(admission ? { "x-web-terminal-admission": admission } : {}), ...(origin ? { Origin: origin } : {}),
    } }, res => {
      let body = ""; res.on("data", chunk => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode, result: body ? JSON.parse(body).result : null }));
    });
    req.on("error", reject); req.end(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }));
  });
  const call = async (tool, args, admission) => (await request("tools/call", { name: tool, arguments: args }, admission)).result;
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "coordination-test", version: "1" } });
  const issue = (tool, args, expires = Date.now() + 10000) => {
    const nonce = randomUUID(); admissions.set(nonce, { tool, digest: contract.operationDigest(tool, args), expires }); return nonce;
  };
  return { env, serverFile, call, request, accepted, requests, issue, generation: value => { generation = value; }, error: value => { errorOverride = value; }, stopCoordinator: () => new Promise(resolve => server.close(resolve)) };
}
const expectCode = (result, code) => { assert.equal(result.isError, true); assert.ok(result.content[0].text.startsWith(code + ":")); };
test("coordinated HTTP uses single-use operation/generation-bound admissions; list comes only from coordinator", async t => {
  const { call, request, issue, accepted, requests, generation } = await fixture(t);
  const tools = (await request("tools/list", {})).result.tools;
  assert.equal(tools.length, 6);
  assert.ok(tools.find(tool => tool.name === "terminal_type").inputSchema.properties.target.properties.inputGeneration);
  assert.match(tools.find(tool => tool.name === "terminal_type").description, /inputGeneration/);
  const [target] = JSON.parse((await call("terminal_list", {})).content[0].text);
  assert.equal(target.inputGeneration, "generation-1");
  const args = { target, text: "literal 中文 ; $()" }, nonce = issue("terminal_type", args);
  const typed = await call("terminal_type", args, nonce);
  assert.deepEqual(JSON.parse(typed.content[0].text), { sent: true, submitted: false });
  const enter = { target, key: "Enter" };
  assert.deepEqual(JSON.parse((await call("terminal_send_key", enter, issue("terminal_send_key", enter))).content[0].text), { sent: true, submitted: true });
  expectCode(await call("terminal_type", args, nonce), "AUTHORITY_UNAVAILABLE");
  expectCode(await call("terminal_type", args), "AUTHORITY_UNAVAILABLE");
  expectCode(await call("terminal_type", { target: baseTarget, text: "missing generation" }, issue("terminal_type", args)), "STALE_INPUT_GENERATION");
  expectCode(await call("terminal_type", { target, text: "changed content" }, issue("terminal_type", args)), "AUTHORITY_UNAVAILABLE");
  expectCode(await call("terminal_send_key", enter, issue("terminal_type", args)), "AUTHORITY_UNAVAILABLE");
  expectCode(await call("terminal_type", args, issue("terminal_type", args, Date.now() - 1)), "AUTHORITY_UNAVAILABLE");
  generation("generation-2");
  expectCode(await call("terminal_type", args, issue("terminal_type", args)), "STALE_INPUT_GENERATION");
  assert.equal(accepted.length, 2);
  assert.ok(requests.includes("/v1/list"));
  assert.equal((await request("tools/list", {}, undefined, "https://untrusted.invalid")).status, 403);
});
test("coordinated request admissions remain isolated across concurrent HTTP operations", async t => {
  const { call, issue, accepted } = await fixture(t);
  const target = { ...baseTarget, inputGeneration: "generation-1" };
  const slow = { target, text: "SLOW_LITERAL" }, fast = { target, text: "FAST_LITERAL" };
  const results = await Promise.all([
    call("terminal_type", slow, issue("terminal_type", slow)),
    call("terminal_type", fast, issue("terminal_type", fast)),
    call("terminal_type", { target, text: "NO_CONTEXT" }),
  ]);
  for (const result of results.slice(0, 2)) assert.deepEqual(JSON.parse(result.content[0].text), { sent: true, submitted: false });
  expectCode(results[2], "AUTHORITY_UNAVAILABLE");
  assert.deepEqual(accepted.map(item => item.args.text).sort(), ["FAST_LITERAL", "SLOW_LITERAL"]);
});
test("coordinated failures are sanitized, invalid text is not forwarded and unavailable coordination never falls back", async t => {
  const { call, issue, accepted, error, requests, stopCoordinator } = await fixture(t);
  const target = { ...baseTarget, inputGeneration: "generation-1" };
  const invalid = { target, text: "first\nsecond" };
  expectCode(await call("terminal_type", invalid, issue("terminal_type", invalid)), "CONTROL_CHAR_OR_MULTILINE");
  assert.equal(requests.length, 0);
  const args = { target, text: "valid" };
  for (const code of ["INPUT_PAUSED", "INPUT_BUSY", "STALE_TARGET", "COLLABORATION_UNAVAILABLE"]) {
    error(code); const result = await call("terminal_type", args, issue("terminal_type", args)); expectCode(result, code);
    assert.doesNotMatch(result.content[0].text, /secret|token content/);
  }
  error("FORGED_UPSTREAM_SECRET");
  const result = await call("terminal_type", args, issue("terminal_type", args));
  expectCode(result, "OPERATION_UNAVAILABLE"); assert.doesNotMatch(result.content[0].text, /FORGED|secret/);
  error(undefined); await stopCoordinator();
  expectCode(await call("terminal_type", args, issue("terminal_type", args)), "COLLABORATION_UNAVAILABLE");
  expectCode(await call("terminal_list", {}), "COLLABORATION_UNAVAILABLE");
  assert.equal(accepted.length, 0);
});
test("minimal coordinated package works without execution modules, while stdio cannot invent a gateway admission", async t => {
  const { call, issue, env, serverFile, accepted } = await fixture(t, true);
  const target = { ...baseTarget, inputGeneration: "generation-1" }, args = { target, text: "PACKAGED_COORDINATION" };
  assert.deepEqual(JSON.parse((await call("terminal_type", args, issue("terminal_type", args))).content[0].text), { sent: true, submitted: false });
  const client = new Client({ name: "no-stdio-authority", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverFile], env: { ...env, WEB_TERMINAL_MCP_SOCKET: "" } }));
    assert.equal((await client.listTools()).tools.length, 6);
    const result = await client.callTool({ name: "terminal_type", arguments: { ...args, admission: issue("terminal_type", args), owner: true } });
    expectCode(result, "AUTHORITY_UNAVAILABLE");
  } finally { await client.close(); }
  assert.equal(accepted.length, 1);
  for (const socket of ["", "relative/socket"]) {
    const result = spawnSync(process.execPath, [serverFile], { env: { ...env, WEB_TERMINAL_MCP_SOCKET: "", WEB_TERMINAL_COLLABORATION_SOCKET: socket }, encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /absolute collaboration socket/);
  }
});
