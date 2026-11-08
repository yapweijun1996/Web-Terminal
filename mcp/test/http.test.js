import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
for (const toolSet of ["full", "terminal-only"]) for (const inputMode of ["disabled", "delegated"]) test(`private HTTP MCP (${toolSet}/${inputMode}) initialize and tools list; browser Origin denied`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-http-"));
  fs.chmodSync(root, 0o700);
  const socket = path.join(root, "mcp.sock");
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../server.js", import.meta.url))],
    {
      env: {
        ...process.env,
        WEB_TERMINAL_MCP_TOOLS: toolSet,
        WEB_TERMINAL_MCP_INPUT_MODE: inputMode,
        WEB_TERMINAL_MCP_SOCKET: socket,
        WEB_TERMINAL_TMUX_SERVER: "fixture-unused",
        WEB_TERMINAL_MCP_SESSION: "workspace",
      },
      stdio: "ignore",
    },
  );
  const request = (body, origin) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: socket,
          path: "/mcp",
          method: "POST",
          headers: {
            Host: "localhost",
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            ...(origin ? { Origin: origin } : {}),
          },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode, text }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(socket); i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(socket));
    assert.equal(fs.statSync(socket).mode & 0o077, 0);
    const init = await request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    assert.equal(init.status, 200);
    assert.equal(JSON.parse(init.text).result.serverInfo.name, "web-terminal");
    const list = await request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    assert.equal(list.status, 200);
    assert.equal(JSON.parse(list.text).result.tools.length, toolSet === "full" ? 11 : 6);
    assert.equal(
      (
        await request(
          { jsonrpc: "2.0", id: 3, method: "tools/list" },
          "https://bad.example",
        )
      ).status,
      403,
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
