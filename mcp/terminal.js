import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
export class TerminalController {
  constructor({ server, session, layout = "grouped", tmux = process.env.TMUX_BIN || "tmux" }) {
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(server || "") ||
      (layout === "grouped" && !/^[A-Za-z0-9_-]{1,100}$/.test(session || "")) ||
      !["grouped", "linux-tabs"].includes(layout)
    )
      throw Error("Dedicated tmux server and session required");
    Object.assign(this, { server, session, layout, tmux });
  }
  async run(args) {
    return (
      await exec(this.tmux, ["-u", "-L", this.server, ...args], {
        timeout: 5000,
        maxBuffer: 262144,
      })
    ).stdout;
  }
  async list() {
    const data = await this.run([
      "list-panes",
      ...(this.layout === "linux-tabs" ? ["-a"] : ["-s", "-t", `=${this.session}`]),
      "-F",
      "#{pid}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{window_index}\t#{pane_index}\t#{window_active}\t#{pane_active}\t#{pane_in_mode}\t#{session_name}",
    ]);
    const panes = data
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [
          serverPid,
          sessionId,
          windowId,
          paneId,
          windowIndex,
          paneIndex,
          wa,
          pa,
          mode,
          sessionName,
        ] = line.split("\t");
        return {
          serverPid,
          sessionId,
          windowId,
          paneId,
          windowIndex: Number(windowIndex),
          paneIndex: Number(paneIndex),
          active: wa === "1" && pa === "1",
          inMode: mode === "1",
          ...(this.layout === "linux-tabs" ? { sessionName } : {}),
        };
      })
      .filter((pane) => this.layout !== "linux-tabs" || /^(shared|web-[a-f0-9]{12})$/.test(pane.sessionName));
    const names = new Map();
    for (const pane of panes)
      if (!names.has(pane.windowId))
        names.set(
          pane.windowId,
          (
            await this.run([
              "display-message",
              "-p",
              "-t",
              pane.windowId,
              "#{window_name}",
            ])
          )
            .replace(/[\x00-\x1f\x7f]/g, " ")
            .trim()
            .slice(0, 200),
        );
    return panes.map((p) => ({ ...p, windowName: names.get(p.windowId) }));
  }
  async validate(t) {
    if (
      !t ||
      !/^\d+$/.test(t.serverPid) ||
      !/^\$\d+$/.test(t.sessionId) ||
      !/^@\d+$/.test(t.windowId) ||
      !/^%\d+$/.test(t.paneId)
    )
      throw Error("Invalid target");
    const current = (await this.list()).find((p) =>
      ["serverPid", "sessionId", "windowId", "paneId"].every((k) => p[k] === t[k]),
    );
    if (!current) throw Error("Target changed");
    return current;
  }
  async guarded(t, command, allowMode = false) {
    const current = await this.validate(t);
    const checks = [
      `#{==:#{pid},${t.serverPid}}`,
      `#{==:#{session_id},${t.sessionId}}`,
      `#{==:#{window_id},${t.windowId}}`,
      `#{==:#{pane_id},${t.paneId}}`,
    ];
    if (this.layout === "linux-tabs")
      checks.push(`#{==:#{session_name},${current.sessionName}}`);
    if (!allowMode) checks.push("#{==:#{pane_in_mode},0}");
    const cond = checks.reduce((a, b) => `#{&&:${a},${b}}`);
    const result = await this.run([
      "if-shell",
      "-F",
      "-t",
      `${t.sessionId}:${t.windowId}.${t.paneId}`,
      cond,
      `${command} ; display-message -p WT_MCP_OK`,
      "display-message -p WT_MCP_STALE",
    ]);
    if (!result.endsWith("WT_MCP_OK\n"))
      throw Error(
        "Target changed or input unavailable; do not retry input automatically",
      );
    return result.slice(0, -"WT_MCP_OK\n".length);
  }
  async read(t, lines = 100) {
    if (!Number.isInteger(lines) || lines < 1 || lines > 500)
      throw Error("Read limit is 1–500");
    // Fresh panes have unused empty screen rows below the cursor. Omit only
    // those rows before bounding the meaningful tail; keep content whitespace.
    const text = await this.guarded(
      t,
      `capture-pane -p -t ${t.paneId} -S -${lines}`,
      true,
    );
    const rows = text.split("\n");
    while (rows.length && rows[rows.length - 1] === "") rows.pop();
    return rows.slice(-lines).join("\n");
  }

  async type(t, text) {
    if (
      typeof text !== "string" ||
      !text.length ||
      Buffer.byteLength(text) > 8192 ||
      /[\x00-\x1f\x7f]/.test(text)
    )
      throw Error("Text must be 1–8192 bytes without controls; use send_key");
    const buffer = `web-terminal-mcp-${randomUUID()}`;
    try {
      await this.select(t);
      await this.run(["set-buffer", "-b", buffer, "--", text]);
      await this.guarded(t, `paste-buffer -p -d -b ${buffer} -t ${t.paneId}`);
      return { sent: true, submitted: false };
    } finally {
      await this.run(["delete-buffer", "-b", buffer]).catch(() => {});
    }
  }
  async key(t, key) {
    if (
      ![
        "Enter",
        "Escape",
        "Tab",
        "BSpace",
        "Up",
        "Down",
        "Left",
        "Right",
        "C-c",
        "C-d",
      ].includes(key)
    )
      throw Error("Unsupported key");
    await this.select(t);
    await this.guarded(t, `send-keys -t ${t.paneId} ${key}`);
    return { sent: true, submitted: key === "Enter" };
  }
  async select(t) {
    await this.validate(t);
    if (this.layout === "linux-tabs") {
      await this.guarded(t, `select-window -t ${t.sessionId}:${t.windowId} ; select-pane -t ${t.paneId}`, true);
      return { selected: true, views: 1, sessionName: (await this.list()).find((p) => p.sessionId === t.sessionId)?.sessionName };
    }
    const group = (
      await this.run([
        "display-message",
        "-p",
        "-t",
        `=${this.session}:`,
        "#{session_group}",
      ])
    ).trim();
    const sessions = (
      await this.run(["list-sessions", "-F", "#{session_id}\t#{session_group}"])
    )
      .trim()
      .split("\n")
      .map((line) => line.split("\t"));
    const ids = group
      ? sessions.filter(([, g]) => g === group).map(([id]) => id)
      : [t.sessionId];
    for (const id of ids)
      if (/^\$\d+$/.test(id))
        await this.guarded(
          t,
          `select-window -t ${id}:${t.windowId} ; select-pane -t ${t.paneId}`,
          true,
        );
    return { selected: true, views: ids.length };
  }
  async newWindow() {
    const [first] = await this.list();
    if (!first) throw Error("Workspace unavailable");
    if (this.layout === "linux-tabs") {
      if (new Set((await this.list()).map((p) => p.sessionId)).size >= 20)
        throw Error("Terminal limit reached");
      const name = `web-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      await this.guarded(first, `new-session -d -e PI_CLIPBOARD_OSC52=1 -s ${name}`, true);
    } else {
      await this.guarded(first, `new-window -d -t ${first.sessionId}:`, true);
    }
    return this.list();
  }
}
