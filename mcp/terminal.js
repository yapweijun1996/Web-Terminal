import { TerminalError, validateTerminalText } from "./terminal-errors.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
// Shared across controller instances in this process, not per HTTP request.
const activeWrites = new Set();
const maxActiveWrites = 32;
function snapshotTarget(t) {
  if (!t || !["serverPid", "sessionId", "windowId", "paneId"].every(k => typeof t[k] === "string") ||
      !/^\d+$/.test(t.serverPid) || !/^\$\d+$/.test(t.sessionId) ||
      !/^@\d+$/.test(t.windowId) || !/^%\d+$/.test(t.paneId))
    throw new TerminalError("INVALID_TARGET");
  return Object.freeze(Object.fromEntries(["serverPid", "sessionId", "windowId", "paneId"].map(k => [k, t[k]])));
}
function expectedPanePid(options) {
  const pid = options?.expectedPanePid;
  if (pid === undefined) return undefined;
  if (typeof pid !== "string" || !/^[1-9]\d{0,19}$/.test(pid))
    throw new TerminalError("INVALID_TARGET");
  return pid;
}
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
    t = snapshotTarget(t);
    const current = (await this.list()).find((p) =>
      ["serverPid", "sessionId", "windowId", "paneId"].every((k) => p[k] === t[k]),
    );
    if (!current) throw new TerminalError("STALE_TARGET");
    return current;
  }
  async guarded(t, command, allowMode = false, panePid) {
    panePid = expectedPanePid({ expectedPanePid: panePid });
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
    // Optional trusted adapter snapshot fences a respawn within the same pane ID.
    // This is the pane process, not the changing foreground command PID.
    if (panePid !== undefined)
      checks.push(`#{==:#{pane_pid},${panePid}}`, "#{==:#{pane_dead},0}");
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
      throw new TerminalError("STALE_TARGET");
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

  async input(t, execute) {
    const target = snapshotTarget(t);
    // Grouped sessions can expose the same physical pane through different IDs.
    const id = [this.server, target.serverPid, target.paneId].join(":");
    if (activeWrites.has(id) || activeWrites.size >= maxActiveWrites)
      throw new TerminalError("INPUT_BUSY");
    activeWrites.add(id);
    try {
      return await execute(target);
    } finally {
      activeWrites.delete(id);
    }
  }
  async type(t, text, options) {
    validateTerminalText(text);
    const panePid = expectedPanePid(options);
    return this.input(t, async target => {
      const buffer = `web-terminal-mcp-${randomUUID()}`;
      try {
        await this.validate(target);
        await this.run(["set-buffer", "-b", buffer, "--", text]);
        await this.guarded(target, `paste-buffer -p -d -b ${buffer} -t ${target.paneId}`, false, panePid);
        return { sent: true, submitted: false };
      } finally {
        await this.run(["delete-buffer", "-b", buffer]).catch(() => {});
      }
    });
  }
  async key(t, key, options) {
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
    const panePid = expectedPanePid(options);
    return this.input(t, async target => {
      await this.guarded(target, `send-keys -t ${target.paneId} ${key}`, false, panePid);
      return { sent: true, submitted: key === "Enter" };
    });
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
