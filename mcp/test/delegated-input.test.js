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
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const serverFile = fileURLToPath(new URL("../server.js", import.meta.url));
function fixture(t, raw = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-delegated-"));
  const server = `delegated-${randomUUID()}`;
  const env = { ...process.env, TMUX_TMPDIR: root, WEB_TERMINAL_TMUX_SERVER: server,
    WEB_TERMINAL_MCP_SESSION: "workspace", WEB_TERMINAL_MCP_LAYOUT: "grouped",
    WEB_TERMINAL_MCP_INPUT_MODE: "delegated", WEB_TERMINAL_MCP_SOCKET: "",
    WEB_TERMINAL_JOB_DIR: path.join(root, "jobs") };
  const tmux = (...args) => execFileSync("tmux", ["-L", server, ...args], { env, encoding: "utf8" });
  if (raw) {
    const script = path.join(root, "keys.cjs");
    fs.writeFileSync(script, "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('READY\\r\\n');process.stdin.on('data',b=>process.stdout.write('KEY '+b.toString('hex')+'\\r\\n'));\n");
    tmux("new-session", "-d", "-s", "workspace", process.execPath, script);
  } else tmux("new-session", "-d", "-s", "workspace", "/bin/cat");
  const ctl = new TerminalController({ server, session: "workspace" });
  const run = ctl.run.bind(ctl);
  ctl.run = args => run(["-S", path.join(root, `tmux-${process.getuid()}`, server), ...args]);
  t.after(() => { try { tmux("kill-server"); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  return { root, server, env, tmux, ctl };
}
async function connect(t, env, entry = serverFile) {
  const client = new Client({ name: "delegated-input-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env }));
  t.after(() => client.close());
  return client;
}
const call = (client, name, args) => client.callTool({ name, arguments: args });
for (const toolSet of ["full", "terminal-only"]) test(`${toolSet}: delegated MCP literal typing, Enter and human handoff work without changing selection`, async t => {
  const { env, tmux, ctl } = fixture(t);
  env.WEB_TERMINAL_MCP_TOOLS = toolSet;
  const client = await connect(t, env);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, toolSet === "full" ? 11 : 6);
  assert.match(tools.find(tool => tool.name === "terminal_type").description, /literal single-line text/);
  assert.doesNotMatch(tools.find(tool => tool.name === "terminal_send_key").description, /Unavailable/);
  const [target] = JSON.parse((await call(client, "terminal_list", {})).content[0].text);
  tmux("send-keys", "-t", target.paneId, "-l", "--", "HUMAN_FIRST");
  tmux("send-keys", "-t", target.paneId, "Enter");
  tmux("new-window", "-t", "workspace:", "/bin/cat");
  const selected = tmux("display-message", "-p", "-t", "=workspace:", "#{window_id}").trim();
  assert.notEqual(selected, target.windowId);
  const literal = "literal 中文 😀 'quoted' ; $() \\ end";
  const typed = await call(client, "terminal_type", { target, text: literal });
  assert.equal(typed.isError, undefined);
  assert.deepEqual(JSON.parse(typed.content[0].text), { sent: true, submitted: false });
  await wait(75);
  let text = await ctl.read(target, 30);
  assert.ok(text.includes(literal));
  assert.equal(text.split(literal).length - 1, 1, "typing must not include an implicit Enter/cat echo");
  assert.equal(tmux("display-message", "-p", "-t", "=workspace:", "#{window_id}").trim(), selected);
  const entered = await call(client, "terminal_send_key", { target, key: "Enter" });
  assert.deepEqual(JSON.parse(entered.content[0].text), { sent: true, submitted: true });
  await wait(75);
  text = await ctl.read(target, 30);
  assert.equal(text.split(literal).length - 1, 2, "cat echoes the completed line only after explicit Enter");
  tmux("send-keys", "-t", target.paneId, "-l", "--", "HUMAN_AFTER");
  await wait(50);
  assert.match(await ctl.read(target), /HUMAN_AFTER/);
  assert.equal(tmux("display-message", "-p", "-t", "=workspace:", "#{window_id}").trim(), selected);
  const before = await ctl.read(target);
  for (const invalid of ["prefix\nsecond", "prefix\rsecond", "prefix\x1bsecond", "prefix\x00second"]) {
    const result = await call(client, "terminal_type", { target, text: invalid });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^CONTROL_CHAR_OR_MULTILINE:/);
  }
  const stale = await call(client, "terminal_send_key", { target: { ...target, paneId: "%999999" }, key: "Enter" });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /^STALE_TARGET:/);
  assert.equal(await ctl.read(target), before);
  assert.equal(tmux("list-buffers"), "");
});
test("delegated supported keys reach a disposable raw terminal exactly as terminal bytes", async t => {
  const { env, ctl } = fixture(t, true);
  env.WEB_TERMINAL_MCP_TOOLS = "terminal-only";
  const client = await connect(t, env);
  const [target] = await ctl.list();
  for (let n = 0; n < 100 && !(await ctl.read(target)).includes("READY"); n++) await wait(10);
  for (const [key, bytes] of Object.entries({ Enter: "0d", Escape: "1b", Tab: "09", BSpace: "7f", Up: "1b5b41", Down: "1b5b42", Left: "1b5b44", Right: "1b5b43", "C-c": "03", "C-d": "04" })) {
    const result = await call(client, "terminal_send_key", { target, key });
    assert.equal(result.isError, undefined, key);
    assert.deepEqual(JSON.parse(result.content[0].text), { sent: true, submitted: key === "Enter" });
    for (let n = 0; n < 100 && !(await ctl.read(target, 50)).includes(`KEY ${bytes}`); n++) await wait(10);
    assert.ok((await ctl.read(target, 50)).includes(`KEY ${bytes}`), key);
  }
});
test("controller rejects overlapping writes across instances and releases busy state after completion/failure", async t => {
  const { ctl, server, tmux } = fixture(t);
  const [target] = await ctl.list();
  const second = new TerminalController({ server, session: "workspace" });
  tmux("new-session", "-d", "-t", "workspace", "-s", "other-view");
  const ids = tmux("display-message", "-p", "-t", "=other-view:", "#{pid}|#{session_id}|#{window_id}|#{pane_id}").trim().split("|");
  const samePaneViaOtherSession = Object.fromEntries(["serverPid", "sessionId", "windowId", "paneId"].map((key, index) => [key, ids[index]]));
  let resume;
  const hold = new Promise(resolve => { resume = resolve; });
  const validate = ctl.validate.bind(ctl);
  let first = true;
  ctl.validate = async captured => { if (first) { first = false; await hold; } return validate(captured); };
  const writing = ctl.type(target, "ONE_WRITE");
  await assert.rejects(ctl.key(target, "Enter"), error => error.code === "INPUT_BUSY");
  await assert.rejects(second.type(target, "OTHER_CONTROLLER"), error => error.code === "INPUT_BUSY");
  await assert.rejects(second.key(samePaneViaOtherSession, "Enter"), error => error.code === "INPUT_BUSY");
  resume();
  assert.deepEqual(await writing, { sent: true, submitted: false });
  assert.deepEqual(await ctl.key(target, "Enter"), { sent: true, submitted: true });
  const bad = { ...target, paneId: "%999999" };
  await assert.rejects(ctl.type(bad, "STALE"), error => error.code === "STALE_TARGET");
  await assert.rejects(ctl.key(bad, "Enter"), error => error.code === "STALE_TARGET");
});
test("controller captures target identity before awaiting and never follows caller mutation", async t => {
  const { ctl, tmux } = fixture(t);
  const [original] = await ctl.list();
  tmux("new-window", "-d", "-t", "workspace:", "/bin/cat");
  const other = (await ctl.list()).find(pane => pane.paneId !== original.paneId);
  const target = { ...original };
  let resume;
  const hold = new Promise(resolve => { resume = resolve; });
  const validate = ctl.validate.bind(ctl);
  let first = true;
  ctl.validate = async captured => { if (first) { first = false; await hold; } return validate(captured); };
  const writing = ctl.type(target, "CAPTURED_TARGET");
  Object.assign(target, other);
  resume(); await writing; await wait(50);
  assert.match(await ctl.read(original), /CAPTURED_TARGET/);
  assert.doesNotMatch(await ctl.read(other), /CAPTURED_TARGET/);
});
test("minimal six-tool release supports delegated input, defaults disabled and rejects invalid input modes", async t => {
  const { root, env, ctl } = fixture(t);
  const release = path.join(root, "release"); fs.mkdirSync(release);
  for (const name of ["server.js", "terminal.js", "terminal-errors.js", "package.json"])
    fs.copyFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), path.join(release, name));
  fs.symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), path.join(release, "node_modules"), "dir");
  env.WEB_TERMINAL_MCP_TOOLS = "terminal-only";
  env.WEB_TERMINAL_JOB_DIR = "invalid-relative-path";
  const [target] = await ctl.list();
  const client = await connect(t, env, path.join(release, "server.js"));
  assert.equal((await client.listTools()).tools.length, 6);
  assert.equal((await call(client, "terminal_type", { target, text: "MINIMAL_PACKAGE" })).isError, undefined);
  const disabledEnv = { ...env }; delete disabledEnv.WEB_TERMINAL_MCP_INPUT_MODE;
  const disabled = await connect(t, disabledEnv, path.join(release, "server.js"));
  assert.match((await call(disabled, "terminal_type", { target, text: "DENIED", inputMode: "delegated", owner: true })).content[0].text, /^AUTHORITY_UNAVAILABLE:/);
  for (const value of ["", "DELEGATED", "true", "typo"]) {
    const result = spawnSync(process.execPath, [path.join(release, "server.js")], { env: { ...env, WEB_TERMINAL_MCP_INPUT_MODE: value }, encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /Invalid MCP input mode/);
  }
});

test("process-wide input capacity rejects excess work without an unbounded queue", async () => {
  const ctl = new TerminalController({ server: "capacity-fixture", session: "workspace" });
  let resume;
  const hold = new Promise(resolve => { resume = resolve; });
  const target = n => ({ serverPid: "1", sessionId: "$1", windowId: "@1", paneId: `%${n}` });
  const pending = Array.from({ length: 32 }, (_, n) => ctl.input(target(n), () => hold));
  try { await assert.rejects(ctl.input(target(32), async () => true), error => error.code === "INPUT_BUSY"); }
  finally { resume(); await Promise.all(pending); }
  assert.equal(await ctl.input(target(32), async () => true), true);
});
