import path from "node:path";
import fs from "node:fs";
import contract from "../runtime/gateway/collaboration-contract.cjs";
import { TerminalError } from "./terminal-errors.js";

// Only fixed locally registered diagnostics may leave this adapter. The shared
// contract binds actual operation content; this adapter never invents authority.
export class CoordinatedInput {
  constructor(socket, admission) {
    if (!path.isAbsolute(socket || "") || socket.includes("\0"))
      throw Error("Coordinated input requires an absolute collaboration socket");
    this.socket = socket;
    this.admission = admission;
  }
  async call(route, payload) {
    let result;
    try {
      const parent = fs.lstatSync(path.dirname(this.socket));
      const socket = fs.lstatSync(this.socket);
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || parent.mode & 0o077 ||
          !socket.isSocket() || socket.isSymbolicLink() || socket.uid !== process.getuid() || socket.mode & 0o077)
        throw Error("Private collaboration socket required");
      result = await contract.privateCall(this.socket, route, payload, { timeoutMs: 12000 });
    } catch {
      throw new TerminalError("COLLABORATION_UNAVAILABLE");
    }
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new TerminalError("COLLABORATION_UNAVAILABLE");
    if (result.error) throw new TerminalError(result.error.code);
    return result;
  }
  async list() {
    const result = await this.call("/v1/list", {});
    if (!Array.isArray(result.panes)) throw new TerminalError("COLLABORATION_UNAVAILABLE");
    return result.panes;
  }
  async execute(tool, args) {
    if (typeof args.target?.inputGeneration !== "string" || !args.target.inputGeneration.length)
      throw new TerminalError("STALE_INPUT_GENERATION");
    const admission = this.admission();
    if (typeof admission !== "string" || !admission.length || admission.length > 512)
      throw new TerminalError("AUTHORITY_UNAVAILABLE");
    const result = await this.call("/v1/execute", { admission, tool, arguments: args });
    const submitted = tool === "terminal_send_key" && args.key === "Enter";
    if (result.sent !== true || result.submitted !== submitted)
      throw new TerminalError("COLLABORATION_UNAVAILABLE");
    return { sent: true, submitted };
  }
}
