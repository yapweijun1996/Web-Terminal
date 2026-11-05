import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
test("SDK initializes, lists and types into same disposable workspace", async () => {
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
          WEB_TERMINAL_TMUX_SERVER: name,
          WEB_TERMINAL_MCP_SESSION: "workspace",
        },
      }),
    );
    assert.equal((await client.listTools()).tools.length, 6);
    const result = await client.callTool({
      name: "terminal_list",
      arguments: {},
    });
    const [target] = JSON.parse(result.content[0].text);
    const typed = await client.callTool({
      name: "terminal_type",
      arguments: { target, text: "SDK_VISIBLE" },
    });
    assert.equal(typed.isError, undefined);
    await new Promise((r) => setTimeout(r, 100));
    assert.match(tmux("capture-pane", "-p", "-t", "workspace:"), /SDK_VISIBLE/);
    const denied = await client.callTool({
      name: "terminal_type",
      arguments: { target: { ...target, paneId: "%999999" }, text: "BAD" },
    });
    assert.equal(denied.isError, true);
  } finally {
    await client.close();
    tmux("kill-server");
  }
});
