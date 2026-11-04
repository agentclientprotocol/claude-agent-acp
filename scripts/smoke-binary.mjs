#!/usr/bin/env node
// Smoke-tests a built agent over ACP. Defaults to the executable from
// scripts/build-binary.mjs, with `claude` next to it. Pass another command
// after `--` to compare, e.g.
// `node scripts/smoke-binary.mjs --full -- node "$PWD/dist/index.js"` (the full
// run starts the agent in a scratch directory, so paths must be absolute).
//
//   node scripts/smoke-binary.mjs            # no login needed
//   node scripts/smoke-binary.mjs --full     # talks to the model; needs a logged-in Claude
//
// SMOKE_DEBUG=1 prints every tool call the full run saw.
//
// The basic run checks `--version`, `--cli --version`, `initialize` (v1 and
// v2) and the `terminal-auth` login command. The
// full run also has Claude use Bash, Read (text and image), Edit and a
// subagent in a scratch directory, then cancels a turn, lists the session,
// loads it in a fresh agent process, and forks and deletes it.
//
// Claude Code's native builds have no Grep or Glob tool: its Bash shell wraps
// `grep` and `find` in functions that run the ugrep and bfs built into the
// Claude binary at `$CLAUDE_CODE_EXECPATH`. The full run checks that those
// run, since they are the helpers a packaged build could fail to reach.

import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { deflateSync } from "node:zlib";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values, positionals } = parseArgs({
  options: { full: { type: "boolean", default: false } },
  allowPositionals: true,
});
const exe = process.platform === "win32" ? ".exe" : "";
const [command, ...commandArgs] =
  positionals.length > 0 ? positionals : [join(repoRoot, "dist-bin", `claude-agent-acp${exe}`)];

let failures = 0;
function check(ok, label, detail) {
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== undefined ? `: ${detail}` : ""}`,
  );
  if (!ok) failures++;
  return ok;
}

// ---------------------------------------------------------------- basic

function runSync(args, [cmd, ...cmdArgs] = [command, ...commandArgs]) {
  const result = spawnSync(cmd, [...cmdArgs, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return { stdout: (result.stdout ?? "").trim(), error: result.error ?? result.stderr };
}

const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
const own = runSync(["--version"]);
check(own.stdout === version, `--version prints ${version}`, own.stdout || own.error);
const cli = runSync(["--cli", "--version"]);
check(
  /\(Claude Code\)$/.test(cli.stdout),
  "--cli --version runs the bundled Claude CLI",
  cli.stdout || cli.error,
);

// The release archive's layout: the executable finds `claude` in the directory
// of its real path. Only for the default executable; a `--` command has no
// such layout.
if (positionals.length === 0) {
  const scratch = mkdtempSync(join(tmpdir(), "acp-layout-"));
  try {
    if (process.platform !== "win32") {
      const link = join(scratch, "claude-agent-acp");
      symlinkSync(command, link);
      const linked = runSync(["--cli", "--version"], [link]);
      check(
        /\(Claude Code\)$/.test(linked.stdout),
        "a symlink to the executable finds the bundled CLI",
        linked.stdout || linked.error,
      );
      rmSync(link);
    }
    const alone = join(scratch, `claude-agent-acp${exe}`);
    copyFileSync(command, alone);
    const missing = runSync(["--cli", "--version"], [alone]);
    check(
      String(missing.error).includes("The Claude CLI is missing"),
      "without claude next to it, says the CLI is missing",
      missing.stdout || missing.error,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Starts the agent and speaks newline-delimited JSON-RPC to it. */
function startAgent(cwd, onNotification) {
  const child = spawn(command, commandArgs, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  let nextId = 0;
  const pending = new Map();
  const write = (message) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      check(false, "stdout carries only JSON-RPC", line.slice(0, 200));
      return;
    }
    if (message.method === undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method === "session/request_permission") {
      const allow =
        message.params.options.find((o) => o.kind === "allow_once") ?? message.params.options[0];
      write({
        id: message.id,
        result: { outcome: { outcome: "selected", optionId: allow.optionId } },
      });
    } else if (message.id !== undefined && message.method !== undefined) {
      write({
        id: message.id,
        error: { code: -32601, message: `smoke client does not handle ${message.method}` },
      });
    } else {
      onNotification?.(message);
    }
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  // Answer anything still pending if the agent dies, instead of hanging.
  let exitError;
  exited.then((code) => {
    exitError = { message: `agent exited with ${code}: ${Buffer.concat(stderr)}` };
    for (const resolve of pending.values()) resolve({ error: exitError });
    pending.clear();
  });
  return {
    request(method, params) {
      const id = ++nextId;
      return new Promise((resolve) => {
        if (exitError) return resolve({ error: exitError });
        pending.set(id, resolve);
        write({ id, method, params });
      });
    },
    notify: (method, params) => write({ method, params }),
    async stop() {
      child.stdin.end();
      const code = await Promise.race([
        exited,
        new Promise((r) => setTimeout(() => r("timeout"), 10_000)),
      ]);
      if (code === "timeout") child.kill();
      return { code, stderr: Buffer.concat(stderr).toString() };
    },
  };
}

const initializeParams = { protocolVersion: 1, clientCapabilities: {} };
{
  const agent = startAgent(process.cwd());
  const init = await agent.request("initialize", initializeParams);
  check(
    init.result?.agentInfo?.version === version,
    "initialize answers",
    JSON.stringify(init.error),
  );
  const { code } = await agent.stop();
  check(code === 0, "exits 0 when stdin closes", code);
}
{
  // The `terminal-auth` login command reruns the agent; run it with
  // `--version` in place of `auth login --console` instead of logging in.
  // `--version` wins over a stray argument, so also check that no path inside
  // a compiled executable leaked into the arguments.
  const agent = startAgent(process.cwd());
  const init = await agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { _meta: { "terminal-auth": true } },
  });
  await agent.stop();
  const login = init.result?.authMethods?.find((m) => m.id === "console-login")?._meta?.[
    "terminal-auth"
  ];
  const cliArgs = login?.args?.slice(0, login.args.indexOf("--cli") + 1);
  const rerun = login
    ? runSync([...cliArgs, "--version"], [login.command])
    : { stdout: "", error: "no terminal-auth console-login method" };
  check(
    /\(Claude Code\)$/.test(rerun.stdout) &&
      !login.args.some((arg) => arg.includes("$bunfs") || arg.includes("~BUN")),
    "the terminal-auth login command reruns the agent",
    `${JSON.stringify(login)} -> ${rerun.stdout || rerun.error}`,
  );
}
{
  const agent = startAgent(process.cwd());
  const init = await agent.request("initialize", {
    protocolVersion: 2,
    info: { name: "smoke-binary", version },
    capabilities: {},
  });
  check(
    init.result?.protocolVersion === 2,
    "initialize answers ACP v2",
    JSON.stringify(init.error),
  );
  await agent.stop();
}

// ---------------------------------------------------------------- full

if (values.full) {
  const work = mkdtempSync(join(tmpdir(), "acp-smoke-"));
  try {
    await fullSmoke(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** A solid red 16x16 PNG, so the model has something to name. */
function redPng() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const size = 16;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([255, 0, 0]))]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(size).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Writes its results to files so the checks don't depend on the model's reply. */
function searchCommand(token) {
  return [
    `grep -rl "${token}" . > grep.out`,
    'find . -name "*.md" > find.out',
    '{ echo "$CLAUDE_CODE_EXECPATH"; grep --version | head -1; find --version | head -1; } > tools.out',
  ].join("; ");
}

function searchResults(work) {
  const read = (name) => {
    try {
      return readFileSync(join(work, name), "utf8");
    } catch (error) {
      return String(error);
    }
  };
  const [execPath = "", grepVersion = "", findVersion = ""] = read("tools.out").split("\n");
  return { grep: read("grep.out"), find: read("find.out"), execPath, grepVersion, findVersion };
}

async function fullSmoke(work) {
  const token = `SMOKE_TOKEN_${process.pid}`;
  mkdirSync(join(work, "notes"));
  mkdirSync(join(work, "src"));
  writeFileSync(join(work, "notes", "alpha.md"), `# Alpha\n\nThe token is ${token}.\n`);
  writeFileSync(join(work, "notes", "beta.md"), "# Beta\n\nNothing here.\n");
  writeFileSync(join(work, "src", "gamma.ts"), `export const value = "${token}";\n`);
  writeFileSync(join(work, "pixel.png"), redPng());

  const toolCalls = new Map();
  let text = "";
  const onNotification = (message) => {
    if (message.method !== "session/update") return;
    const update = message.params.update;
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      text += update.content.text;
    } else if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      const call = toolCalls.get(update.toolCallId) ?? {};
      toolCalls.set(update.toolCallId, {
        ...call,
        name: update._meta?.claudeCode?.toolName ?? call.name,
        status: update.status ?? call.status,
        title: update.title ?? call.title,
      });
    }
  };

  const agent = startAgent(work, onNotification);
  await agent.request("initialize", initializeParams);
  const created = await agent.request("session/new", { cwd: work, mcpServers: [] });
  if (!check(created.result?.sessionId, "session/new", JSON.stringify(created.error))) {
    console.error((await agent.stop()).stderr);
    return;
  }
  const sessionId = created.result.sessionId;

  const started = Date.now();
  const prompt = await agent.request("session/prompt", {
    sessionId,
    prompt: [
      {
        type: "text",
        text: [
          "This is an automated smoke test of your tools. Do each step with the named tool, in order, one tool call per step:",
          `1. Bash: run exactly \`${searchCommand(token)}\``,
          "2. Read: read notes/alpha.md.",
          "3. Read: read pixel.png and note its color.",
          `4. Edit: in notes/alpha.md replace "${token}" with "EDITED".`,
          "5. Bash: run `cat notes/alpha.md`.",
          '6. Agent: launch a subagent (subagent_type "Explore") that counts the .ts files under src/ and reports the number.',
          "Then reply with one line: SMOKE-DONE color=<the color of pixel.png> tsfiles=<the subagent's count>.",
        ].join("\n"),
      },
    ],
  });
  check(
    prompt.result?.stopReason === "end_turn",
    "prompt ends with end_turn",
    JSON.stringify(prompt.result ?? prompt.error),
  );
  console.log(`     (turn took ${Math.round((Date.now() - started) / 1000)}s)`);

  const calls = [...toolCalls.values()];
  if (process.env.SMOKE_DEBUG) console.log(JSON.stringify(calls, null, 1));
  const searched = searchResults(work);
  check(
    searched.grep.includes("alpha.md") && searched.grep.includes("gamma.ts"),
    "grep found the token",
    searched.grep,
  );
  check(
    searched.find.includes("alpha.md") && searched.find.includes("beta.md"),
    "find listed the .md files",
    searched.find,
  );
  check(
    /^ugrep /.test(searched.grepVersion),
    "grep ran Claude's embedded ugrep",
    searched.grepVersion,
  );
  check(/^bfs /.test(searched.findVersion), "find ran Claude's embedded bfs", searched.findVersion);
  console.log(`     (CLAUDE_CODE_EXECPATH=${searched.execPath})`);
  for (const name of ["Read", "Edit", "Bash"]) {
    const used = calls.filter((c) => c.name === name);
    check(
      used.length > 0 && used.every((c) => c.status === "completed"),
      `${name} ran and completed`,
      JSON.stringify(used),
    );
  }
  const subagent = calls.filter((c) => c.name === "Agent" || c.name === "Task");
  check(
    subagent.some((c) => c.status === "completed"),
    "subagent ran and completed",
    JSON.stringify(subagent),
  );
  const failed = calls.filter((c) => c.status === "failed");
  check(failed.length === 0, "no tool call failed", JSON.stringify(failed));
  check(
    readFileSync(join(work, "notes", "alpha.md"), "utf8").includes("EDITED"),
    "Edit changed the file on disk",
  );
  check(
    /SMOKE-DONE/.test(text) && /color=\W*red/i.test(text),
    "image read as red",
    text.slice(-300),
  );
  check(/tsfiles=\W*1\b/.test(text), "subagent counted 1 .ts file", text.slice(-300));

  // A cancel interrupts a running Bash command and ends the turn as cancelled.
  const cancelled = agent.request("session/prompt", {
    sessionId,
    prompt: [
      { type: "text", text: "Use the Bash tool to run `sleep 60`. Do not run anything else." },
    ],
  });
  const deadline = Date.now() + 60_000;
  const bashRunning = () =>
    [...toolCalls.values()].some((c) => c.name === "Bash" && c.status !== "completed");
  while (!bashRunning() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  agent.notify("session/cancel", { sessionId });
  const cancelResult = await cancelled;
  check(
    cancelResult.result?.stopReason === "cancelled",
    "session/cancel ends the turn as cancelled",
    JSON.stringify(cancelResult.result ?? cancelResult.error),
  );

  const listed = await agent.request("session/list", { cwd: work });
  check(
    listed.result?.sessions?.some((s) => s.sessionId === sessionId),
    "session/list finds the session",
    JSON.stringify(listed.result ?? listed.error),
  );
  const { code, stderr } = await agent.stop();
  check(code === 0, "exits 0 when stdin closes", code);
  if (failures > 0) console.error(stderr);

  // A fresh process, so the replay comes from the transcript on disk.
  let replayed = "";
  const reloaded = startAgent(work, (message) => {
    const update = message.params?.update;
    if (update?.sessionUpdate === "user_message_chunk" && update.content.type === "text")
      replayed += update.content.text;
  });
  await reloaded.request("initialize", initializeParams);
  const loaded = await reloaded.request("session/load", { sessionId, cwd: work, mcpServers: [] });
  check(!loaded.error, "session/load in a new process", JSON.stringify(loaded.error));
  check(replayed.includes(token), "session/load replays the first prompt", replayed.slice(0, 200));

  // Fork and delete go through the SDK's transcript helpers, not the CLI.
  const forked = await reloaded.request("session/fork", { sessionId, cwd: work, mcpServers: [] });
  const forkId = forked.result?.sessionId;
  check(
    forkId && forkId !== sessionId,
    "session/fork",
    JSON.stringify(forked.result ?? forked.error),
  );
  if (forkId) {
    const deleted = await reloaded.request("session/delete", { sessionId: forkId });
    const after = await reloaded.request("session/list", { cwd: work });
    check(
      !deleted.error && !after.result?.sessions?.some((s) => s.sessionId === forkId),
      "session/delete removes the fork",
      JSON.stringify(deleted.error ?? after.result),
    );
  }
  await reloaded.stop();
}

console.log(failures === 0 ? "\nsmoke test passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
