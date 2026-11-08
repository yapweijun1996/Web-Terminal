import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TerminalController } from "../terminal.js";
import { TerminalError, terminalErrorResult, validateTerminalText } from "../terminal-errors.js";
const invalid = ["prefix\nnext", "prefix\r\nnext", ...Array.from({ length: 32 }, (_, n) => `prefix${String.fromCharCode(n)}suffix`), "prefix\x7fsuffix", ...Array.from({ length: 32 }, (_, n) => `prefix${String.fromCharCode(128 + n)}suffix`), "prefix\u2028suffix", "prefix\u2029suffix"];
const hasCode = code => error => error instanceof TerminalError && error.code === code;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-errors-"));
  const server = `errors-${randomUUID()}`;
  const env = { ...process.env, TMUX_TMPDIR: root, WEB_TERMINAL_TMUX_SERVER: server,
    WEB_TERMINAL_MCP_SESSION: "workspace", WEB_TERMINAL_MCP_LAYOUT: "grouped",
    WEB_TERMINAL_MCP_SOCKET: "", WEB_TERMINAL_MCP_INPUT_MODE: "disabled", WEB_TERMINAL_JOB_DIR: path.join(root, "jobs") };
  const tmux = (...args) => execFileSync("tmux", ["-L", server, ...args], { env, encoding: "utf8" });
  tmux("new-session", "-d", "-s", "workspace", "/bin/cat");
  const ctl = new TerminalController({ server, session: "workspace" });
  // Controller uses exec's inherited environment; give this fixture its exact socket.
  ctl.tmux = "tmux";
  const run = ctl.run.bind(ctl);
  ctl.run = args => run(["-S", path.join(root, `tmux-${process.getuid()}`, server), ...args]);
  let stopped = false;
  const stop = () => { tmux("kill-server"); stopped = true; };
  t.after(() => { try { if (!stopped) stop(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  return { ctl, tmux, env, stop };
}
test("text validation rejects every C0 control, DEL, C1 and line separators before any side effect", async () => {
  const ctl = new TerminalController({ server: "unused", session: "unused" });
  ctl.run = async () => { assert.fail("invalid input must not consult or change tmux"); };
  for (const text of invalid) await assert.rejects(ctl.type(null, text), hasCode("CONTROL_CHAR_OR_MULTILINE"));
  for (const text of [null, "", "é".repeat(4097)]) await assert.rejects(ctl.type(null, text), hasCode("INVALID_INPUT"));
  for (const text of ["hello", "  literal ; $() ' 中文 😀", "a".repeat(8192), "é".repeat(4096)]) assert.doesNotThrow(() => validateTerminalText(text));
});
test("public errors are fixed, branded, sanitized and never echo external messages or codes", () => {
  for (const error of [new Error("secret token\nterminal content"), { code: "STALE_TARGET", message: "secret" }, Object.assign(Object.create(TerminalError.prototype), { code: "AUTHORITY_UNAVAILABLE" }), null, "secret"]) {
    const result = terminalErrorResult(error);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^OPERATION_UNAVAILABLE:/);
    assert.doesNotMatch(result.content[0].text, /secret|token|terminal content/);
  }
  const typed = new TerminalError("STALE_TARGET");
  typed.code = "AUTHORITY_UNAVAILABLE";
  typed.message = "secret";
  assert.match(terminalErrorResult(typed).content[0].text, /^STALE_TARGET:/);
});
test("disposable tmux rejects multiline without partial input and rejects replayed/fenced targets", async t => {
  const { ctl, tmux } = fixture(t);
  const [target] = await ctl.list();
  assert.deepEqual(await ctl.type(target, "COMPAT_LITERAL"), { sent: true, submitted: false });
  await new Promise(r => setTimeout(r, 100));
  assert.match(await ctl.read(target), /COMPAT_LITERAL/);
  const before = tmux("capture-pane", "-p", "-t", target.paneId);
  for (const text of invalid) await assert.rejects(ctl.type(target, text), hasCode("CONTROL_CHAR_OR_MULTILINE"));
  assert.equal(tmux("capture-pane", "-p", "-t", target.paneId), before);
  for (const [key, value] of Object.entries({ serverPid: "1", sessionId: "$999999", windowId: "@999999", paneId: "%999999" })) {
    await assert.rejects(ctl.type({ ...target, [key]: value }, "MUST_NOT_ARRIVE"), hasCode("STALE_TARGET"));
  }
  tmux("new-window", "-d", "-t", "workspace:", "/bin/cat");
  tmux("kill-window", "-t", target.windowId);
  tmux("new-window", "-d", "-t", "workspace:", "/bin/cat");
  await assert.rejects(ctl.type(target, "REPLAY"), hasCode("STALE_TARGET"));
  for (const pane of await ctl.list()) assert.doesNotMatch(await ctl.read(pane), /MUST_NOT_ARRIVE|REPLAY/);
});
test("target lost after buffer creation sends no partial input and removes the buffer", async t => {
  const { ctl, tmux } = fixture(t);
  const [target] = await ctl.list();
  tmux("new-window", "-d", "-t", "workspace:", "/bin/cat");
  const run = ctl.run.bind(ctl);
  ctl.run = async args => {
    const result = await run(args);
    if (args[0] === "set-buffer") tmux("kill-window", "-t", target.windowId);
    return result;
  };
  await assert.rejects(ctl.type(target, "RACE_MUST_NOT_ARRIVE"), hasCode("STALE_TARGET"));
  assert.equal(tmux("list-buffers"), "");
  for (const pane of await ctl.list()) assert.doesNotMatch(await ctl.read(pane), /RACE_MUST_NOT_ARRIVE/);
});
test("copy-mode guard remains fenced and sends no text", async t => {
  const { ctl, tmux } = fixture(t);
  const [target] = await ctl.list();
  tmux("copy-mode", "-t", target.paneId);
  await assert.rejects(ctl.type(target, "MODE_MUST_NOT_ARRIVE"), hasCode("STALE_TARGET"));
  assert.equal(tmux("list-buffers"), "");
  assert.doesNotMatch(await ctl.read(target), /MODE_MUST_NOT_ARRIVE/);
});
for (const toolSet of ["full", "terminal-only"]) test(`real SDK (${toolSet}) reports precise invalid text, authority denial and stale reads; list/read compatible`, async t => {
  const { ctl, env, stop } = fixture(t);
  env.WEB_TERMINAL_MCP_TOOLS = toolSet;
  const client = new Client({ name: "error-regression", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../server.js", import.meta.url))], env }));
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, toolSet === "full" ? 11 : 6);
    if (toolSet === "terminal-only") {
      assert.deepEqual(tools.map(tool => tool.name).sort(), ["terminal_list", "terminal_read", "terminal_type", "terminal_send_key", "terminal_select", "terminal_new_window"].sort());
      for (const name of ["terminal_exec", "terminal_job_start", "terminal_job_status", "terminal_job_logs", "terminal_job_cancel"]) {
        const result = await client.callTool({ name, arguments: {} });
        assert.equal(result.isError, true);
      }
      assert.equal(fs.existsSync(env.WEB_TERMINAL_JOB_DIR), false);
    }
    const [target] = JSON.parse((await client.callTool({ name: "terminal_list", arguments: {} })).content[0].text);
    const before = await ctl.read(target);
    for (const text of invalid) {
      const result = await client.callTool({ name: "terminal_type", arguments: { target, text } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /^CONTROL_CHAR_OR_MULTILINE:/);
      assert.match(result.content[0].text, /Do not split/);
    }
    for (const text of ["hello", "r", "m", " -rf /", "hello", "é".repeat(4096)]) {
      const result = await client.callTool({ name: "terminal_type", arguments: { target, text } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /^AUTHORITY_UNAVAILABLE:/);
    }
    for (const key of ["Enter", "C-c", "C-d", "Tab", "Up"]) {
      const result = await client.callTool({ name: "terminal_send_key", arguments: { target, key } });
      assert.match(result.content[0].text, /^AUTHORITY_UNAVAILABLE:/);
    }
    assert.equal(await ctl.read(target), before);
    assert.equal((await client.callTool({ name: "terminal_read", arguments: { target, lines: 10 } })).content[0].text, before);
    const stale = { ...target, paneId: "%999999" };
    assert.match((await client.callTool({ name: "terminal_read", arguments: { target: stale } })).content[0].text, /^STALE_TARGET:/);
    assert.match((await client.callTool({ name: "terminal_type", arguments: { target: stale, text: "denied" } })).content[0].text, /^AUTHORITY_UNAVAILABLE:/);
    // A missing server cannot turn input denial into target probing or an input attempt.
    stop();
    assert.match((await client.callTool({ name: "terminal_type", arguments: { target, text: "denied" } })).content[0].text, /^AUTHORITY_UNAVAILABLE:/);
  } finally { await client.close(); }
});

test("terminal-only release needs no execution module; invalid tool sets fail startup", async t => {
  const { ctl, env } = fixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-terminal-only-package-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["server.js", "terminal.js", "terminal-errors.js", "package.json"])
    fs.copyFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), path.join(root, name));
  fs.symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), path.join(root, "node_modules"), "dir");
  env.WEB_TERMINAL_MCP_TOOLS = "terminal-only";
  // Constructing JobManager would fail on this value; limited startup must not import it.
  env.WEB_TERMINAL_JOB_DIR = "relative-invalid-registry";
  const client = new Client({ name: "packaged-profile", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "server.js")], env }));
    assert.equal((await client.listTools()).tools.length, 6);
    const [target] = await ctl.list();
    assert.match((await client.callTool({ name: "terminal_type", arguments: { target, text: "blocked" } })).content[0].text, /^AUTHORITY_UNAVAILABLE:/);
    assert.equal((await client.callTool({ name: "terminal_read", arguments: { target } })).content[0].text, await ctl.read(target));
  } finally { await client.close(); }
  for (const toolSet of ["", "typo", "FULL"]) {
    const result = spawnSync(process.execPath, [path.join(root, "server.js")], { env: { ...env, WEB_TERMINAL_MCP_TOOLS: toolSet }, encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid MCP tool set/);
  }
});
