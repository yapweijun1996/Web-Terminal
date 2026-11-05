import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { TerminalController } from "../terminal.js";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
    await ctl.type(t, "VISIBLE_AGENT_TEXT");
    await wait(100);
    assert.match(
      tmux("capture-pane", "-p", "-t", "view-test:"),
      /VISIBLE_AGENT_TEXT/,
    );
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
