// Minimal ACP client: AIR-like capabilities, auto-allow, timestamped log of every message.
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
const repo = process.argv[2], cwd = process.argv[3], logFile = process.argv[4];
const promptText = fs.readFileSync(process.argv[5], "utf8");
const listenAfterMs = Number(process.argv[6] ?? 180000);
const acp = await import(repo + "/node_modules/@agentclientprotocol/sdk/dist/acp.js");
const t0 = Date.now();
const out = fs.createWriteStream(logFile);
const transport = fs.createWriteStream(process.argv[7]);
const wire = (dir, line) => { if (!line.trim()) return; let payload; try { payload = JSON.parse(line); } catch { payload = { unparsed: line }; } transport.write(JSON.stringify({ dir, payload }) + "\n"); };
const splitter = (dir) => { let b = ""; return (d) => { b += d; let i; while ((i = b.indexOf("\n")) >= 0) { wire(dir, b.slice(0, i)); b = b.slice(i + 1); } }; };
const log = (dir, obj) => out.write(JSON.stringify({ t: ((Date.now() - t0) / 1000).toFixed(2), dir, ...obj }) + "\n");
const child = spawn(process.execPath, [repo + "/dist/index.js"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => fs.appendFileSync(logFile + ".stderr", d));
let buf = "";
const inSplit = splitter("IN"); child.stdout.on("data", (d) => { inSplit(String(d)); buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) { try { log("WIRE", { promptOpen, msg: JSON.parse(l) }); } catch { log("WIRE", { promptOpen, raw: l }); } } } });
const { PassThrough } = await import("node:stream");
const tee = new PassThrough(); child.stdout.pipe(tee);
const outSplit = splitter("OUT");
const stdinTap = new Writable({ write(chunk, enc, cb) { outSplit(String(chunk)); child.stdin.write(chunk, cb); } });
const stream = acp.ndJsonStream(Writable.toWeb(stdinTap), Readable.toWeb(tee));
let promptOpen = false;
const client = {
  async sessionUpdate(n) {},
  async requestPermission(r) {
    log("IN", { promptOpen, method: "session/request_permission", params: r });
    const o = r.options.find((x) => x.kind === "allow_always") ?? r.options.find((x) => x.kind === "allow_once") ?? r.options[0];
    return { outcome: { outcome: "selected", optionId: o.optionId } };
  },
  async extNotification(method, params) { log("IN", { promptOpen, method, params }); },
  async extMethod(method, params) { log("IN", { promptOpen, method, params }); return {}; },
};
const conn = new acp.ClientSideConnection(() => client, stream);
const init = await conn.initialize({
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false }, terminal: false,
    _meta: { terminal_output_delta: true, "subagent-transcript": true,
      jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions", "asyncTasks", "sessionFailure"] } } },
  },
});
log("RESULT", { method: "initialize", result: { agentInfo: init.agentInfo } });
const s = await conn.newSession({ cwd, mcpServers: [] });
log("RESULT", { method: "session/new", result: { sessionId: s.sessionId, mode: s.modes?.currentModeId } });
try { await conn.setSessionMode({ sessionId: s.sessionId, modeId: "bypassPermissions" }); log("RESULT", { method: "set_mode", result: "bypassPermissions" }); }
catch (e) { log("ERR", { method: "set_mode", error: String(e) }); }
promptOpen = true;
log("OUT", { method: "session/prompt" });
const r = await conn.prompt({ sessionId: s.sessionId, prompt: [{ type: "text", text: promptText }] });
promptOpen = false;
log("RESULT", { method: "session/prompt", result: r });
await new Promise((res) => setTimeout(res, listenAfterMs));
log("END", {}); await new Promise((res) => transport.end(res));
child.kill();
process.exit(0);
