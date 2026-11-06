import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
test("MCP rejects all tmux input without consulting the target", async () => {
  const client = new Client({ name: "input-boundary-test", version: "1" });
  const target = { serverPid: "1", sessionId: "$1", windowId: "@1", paneId: "%1" };
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL("../server.js", import.meta.url))],
      env: { ...process.env, WEB_TERMINAL_TMUX_SERVER: "fixture", WEB_TERMINAL_MCP_SESSION: "fixture" } }));
    for (const text of ["r", "m", " -rf /", "echo pasted command"]) {
      const result = await client.callTool({ name: "terminal_type", arguments: { target, text } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /input is disabled/);
    }
    for (const key of ["Enter", "C-c", "C-d", "Tab", "Up"]) {
      const result = await client.callTool({ name: "terminal_send_key", arguments: { target, key } });
      assert.equal(result.isError, true);
    }
  } finally { await client.close(); }
});
for (const mode of ["emergency", "unavailable"]) test(`SDK denies both execution tools on ${mode}`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-admission-"));
  const marker = path.join(root, "marker");
  const client = new Client({ name: "admission-test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL("../server.js", import.meta.url))],
      env: { ...process.env, NODE_OPTIONS: `--import=${fileURLToPath(new URL("./fake-statfs.js", import.meta.url))}`,
        FIXTURE_STATFS: mode, WEB_TERMINAL_JOB_DIR: path.join(root, "jobs"), WEB_TERMINAL_TMUX_SERVER: "fixture", WEB_TERMINAL_MCP_SESSION: "fixture" } }));
    assert.equal((await client.listTools()).tools.length, 11);
    for (const name of ["terminal_exec", "terminal_job_start"]) {
      const args = { executable: process.execPath, args: ["-e", "require('fs').writeFileSync(process.argv[1], 'bad')", marker], cwd: root };
      if (name === "terminal_job_start") args.storage_class = "light";
      const result = JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
      assert.equal(result.error.code, "STORAGE_ADMISSION_DENIED");
      assert.equal(result.error.reason, mode === "emergency" ? "EMERGENCY" : "UNAVAILABLE");
      assert.equal(fs.existsSync(marker), false);
    }
  } finally { await client.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test("SDK initializes and lists the same disposable workspace while direct tmux input works", async () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-jobs-"));
  const name = `mcp-sdk-${randomUUID()}`;
  const tmux = (...a) =>
    execFileSync("tmux", ["-L", name, ...a], { encoding: "utf8" });
  tmux("new-session", "-d", "-s", "workspace", "/bin/cat");
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL("../server.js", import.meta.url))],
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${fileURLToPath(new URL("./fake-statfs.js", import.meta.url))}`,
          WEB_TERMINAL_JOB_DIR: jobDir,
          WEB_TERMINAL_TMUX_SERVER: name,
          WEB_TERMINAL_MCP_SESSION: "workspace",
        },
      }),
    );
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 11);
    assert.ok(tools.some((tool) => tool.name === "terminal_exec"));
    const execution = await client.callTool({ name: "terminal_exec", arguments: {
      executable: process.execPath, args: ["-e", "process.stdout.write('sdk')"], cwd: process.cwd(),
    } });
    assert.equal(JSON.parse(execution.content[0].text).stdout, "sdk");
    const started = await client.callTool({ name: "terminal_job_start", arguments: {
      executable: process.execPath, args: ["-e", "process.stdout.write('job-sdk')"], cwd: process.cwd(),
    } });
    const id = JSON.parse(started.content[0].text).job_id;
    let status;
    for (let i = 0; i < 100; i++) {
      status = JSON.parse((await client.callTool({ name: "terminal_job_status", arguments: { job_id: id } })).content[0].text);
      if (!["starting", "running"].includes(status.status)) break;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.equal(status.status, "success");
    const logs = JSON.parse((await client.callTool({ name: "terminal_job_logs", arguments: { job_id: id } })).content[0].text);
    assert.equal(Buffer.from(logs.data_base64, "base64").toString(), "job-sdk");
    const invalid = await client.callTool({ name: "terminal_exec", arguments: {
      executable: process.execPath, cwd: "relative",
    } });
    assert.equal(invalid.isError, true);
    const missing = await client.callTool({ name: "terminal_exec", arguments: {
      executable: "/nonexistent-mcp-executable", cwd: process.cwd(),
    } });
    assert.equal(missing.isError, undefined);
    assert.equal(JSON.parse(missing.content[0].text).error.code, "SPAWN_FAILED");
    const result = await client.callTool({
      name: "terminal_list",
      arguments: {},
    });
    const [target] = JSON.parse(result.content[0].text);
    const typed = await client.callTool({
      name: "terminal_type",
      arguments: { target, text: "SDK_VISIBLE" },
    });
    assert.equal(typed.isError, true);
    tmux("send-keys", "-t", "workspace:", "-l", "OWNER_VISIBLE");
    await new Promise((r) => setTimeout(r, 100));
    const pane = tmux("capture-pane", "-p", "-t", "workspace:");
    assert.match(pane, /OWNER_VISIBLE/);
    assert.doesNotMatch(pane, /SDK_VISIBLE/);
    const denied = await client.callTool({
      name: "terminal_type",
      arguments: { target: { ...target, paneId: "%999999" }, text: "BAD" },
    });
    assert.equal(denied.isError, true);
  } finally {
    await client.close();
    tmux("kill-server");
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
