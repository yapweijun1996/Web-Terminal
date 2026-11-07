import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { TerminalController } from "../terminal.js";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
test("Linux tabs are scoped, independently controlled and created for the browser", async () => {
  const server = `mcp-linux-${randomUUID()}`;
  const tmux = (...args) => execFileSync("tmux", ["-L", server, ...args], { encoding: "utf8" });
  tmux("new-session", "-d", "-s", "web-012345abcdef", "/bin/cat");
  try {
    tmux("new-session", "-d", "-s", "web-abcdef012345", "/bin/cat");
    tmux("new-session", "-d", "-s", "unrelated", "/bin/cat");
    const ctl = new TerminalController({ server, layout: "linux-tabs" });
    const initial = await ctl.list();
    assert.equal(initial.length, 2);
    assert.ok(initial.every((p) => p.sessionName.startsWith("web-")));
    const target = initial.find((p) => p.sessionName === "web-012345abcdef");
    await ctl.type(target, "LINUX_MCP_VISIBLE");
    await wait(100);
    assert.match(await ctl.read(target, 10), /LINUX_MCP_VISIBLE/);
    assert.doesNotMatch(tmux("capture-pane", "-p", "-t", "=web-abcdef012345:"), /LINUX_MCP_VISIBLE/);
    const [pid, sessionId, windowId, paneId] = tmux("display-message", "-p", "-t", "=unrelated:", "#{pid}|#{session_id}|#{window_id}|#{pane_id}").trim().split("|");
    await assert.rejects(ctl.type({ serverPid: pid, sessionId, windowId, paneId }, "DENIED"));
    const after = await ctl.newWindow();
    assert.equal(after.length, 3);
    const created = after.find((p) => !initial.some((old) => old.sessionId === p.sessionId));
    assert.match(created.sessionName, /^web-[a-f0-9]{12}$/);
    assert.equal(tmux("show-environment", "-t", created.sessionId, "PI_CLIPBOARD_OSC52").trim(), "PI_CLIPBOARD_OSC52=1");
    tmux("kill-session", "-t", target.sessionId);
    tmux("new-session", "-d", "-s", target.sessionName, "/bin/cat");
    await assert.rejects(ctl.type(target, "STALE"));
  } finally {
    tmux("kill-server");
  }
});
test("shared workspace input, selection and stale targets", async () => {
  const server = `mcp-test-${randomUUID()}`;
  const tmux = (...a) =>
    execFileSync("tmux", ["-L", server, ...a], { encoding: "utf8" });
  tmux(
    "new-session",
    "-d",
    "-s",
    "workspace",
    "-x",
    "100",
    "-y",
    "30",
    "/bin/cat",
  );
  try {
    tmux("new-session", "-d", "-t", "workspace", "-s", "view-test");
    const ctl = new TerminalController({ server, session: "workspace" }),
      [t] = await ctl.list();
    await ctl.type(t, "  VISIBLE_AGENT_TEXT");
    await wait(100);
    assert.match(
      tmux("capture-pane", "-p", "-t", "view-test:"),
      /VISIBLE_AGENT_TEXT/,
    );
    for (const limit of [1, 20]) {
      const text = await ctl.read(t, limit);
      assert.match(text, /^  VISIBLE_AGENT_TEXT/);
      assert.ok(text.split("\n").length <= limit);
    }
    await assert.rejects(ctl.type(t, "bad\nsubmit"));
    await assert.rejects(ctl.type({ ...t, serverPid: "1" }, "bad"));
    await assert.rejects(ctl.key(t, "C-z"));
    assert.ok((await ctl.read(t, 3)).split("\n").length <= 4);
    const windows = await ctl.newWindow(),
      second = windows.find((p) => p.windowId !== t.windowId);
    assert.ok(second);
    await ctl.select(second);
    await ctl.type(t, "AUTOFOLLOW");
    assert.equal(
      tmux("display-message", "-p", "-t", "=view-test:", "#{window_id}").trim(),
      t.windowId,
    );
    await ctl.select(second);
    assert.equal(
      tmux("display-message", "-p", "-t", "=view-test:", "#{window_id}").trim(),
      second.windowId,
    );
    tmux("kill-window", "-t", second.windowId);
    await assert.rejects(ctl.type(second, "bad"));
  } finally {
    tmux("kill-server");
  }
});
