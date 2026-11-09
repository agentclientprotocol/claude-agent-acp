#!/usr/bin/env node
// Runs each case against both ACP v2 cores (the bridge and the native core)
// with the bundled Claude Code CLI, records every client-visible message,
// normalizes what varies between runs, and diffs the two.
//
// This uses the real CLI and costs API usage. Build first (`npm run build`).
//
//   node scripts/compare-v2-cores.mjs [--out DIR] [--cores bridge,native] [case ...]
//   node scripts/compare-v2-cores.mjs --reshape DIR [case ...]   # re-diff a run's raw files
//
// Writes, per case and core, `<case>.<core>.raw.jsonl` (normalized ids, full
// payloads) and `<case>.<core>.shape.txt` (one line per message, model text
// collapsed), then prints a unified diff of the shapes. Each session runs on
// the session's haiku model, in a fresh temp cwd with `file.txt` ("one").
//
// Claude's own choices still vary between runs (an extra Read before an Edit,
// how many chunks a reply streams in, when a config echo lands relative to
// the response): run a case again before reading a difference as the core's.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const v2 = await import(
  join(root, "node_modules/@agentclientprotocol/sdk/dist/v2/unstable/acp.js")
);

const args = process.argv.slice(2);
let outDir = join(tmpdir(), `compare-v2-cores-${Date.now()}`);
let cores = ["bridge", "native"];
let reshape = false;
const selected = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") outDir = resolve(args[++i]);
  else if (args[i] === "--cores") cores = args[++i].split(",");
  else if (args[i] === "--reshape") {
    reshape = true;
    outDir = resolve(args[++i]);
  } else selected.push(args[i]);
}
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One adapter process and its client connection, recording what the client sees. */
class Run {
  constructor(core, cwd, record) {
    this.core = core;
    this.cwd = cwd;
    this.record = record;
    this.waiters = [];
    this.permissionAnswer = "allow_once";
  }

  log(entry) {
    this.record.push({ t: Date.now(), ...entry });
    for (const w of [...this.waiters]) {
      if (w.test(entry)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(entry);
      }
    }
  }

  /** Resolves at the next recorded entry that passes `test`, or rejects after `ms`. */
  waitFor(test, ms = 90000, what = "event") {
    return new Promise((res, rej) => {
      const w = { test, resolve: res };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          rej(new Error(`timed out waiting for ${what}`));
        }
      }, ms);
    });
  }

  waitState(sessionId, state, ms) {
    return this.waitFor(
      (e) =>
        e.kind === "update" &&
        e.params.sessionId === sessionId &&
        e.params.update.sessionUpdate === "state_update" &&
        e.params.update.state === state,
      ms,
      `${state} on ${sessionId}`,
    );
  }

  async start(body) {
    const child = spawn("node", [join(root, "dist/index.js")], {
      env: {
        ...process.env,
        CLAUDE_AGENT_ACP_PROTOCOL: "v2",
        CLAUDE_AGENT_ACP_V2_CORE: this.core,
      },
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.cwd,
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const stream = v2.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    try {
      await v2
        .client({ name: "compare-v2-cores" })
        .onNotification(v2.methods.client.session.update, ({ params }) =>
          this.log({ kind: "update", params }),
        )
        .onNotification(v2.methods.client.elicitation.complete, ({ params }) =>
          this.log({ kind: "elicitation_complete", params }),
        )
        .onNotification(v2.methods.client.auth.statusUpdate, ({ params }) =>
          this.log({ kind: "auth_status", params }),
        )
        .onRequest(v2.methods.client.session.requestPermission, ({ params }) => {
          this.log({ kind: "permission", params });
          const option = params.options.find((o) => o.kind === this.permissionAnswer);
          const result = option
            ? { outcome: { outcome: "selected", optionId: option.optionId } }
            : { outcome: { outcome: "cancelled" } };
          this.log({ kind: "permission_answer", result });
          return result;
        })
        .onRequest(v2.methods.client.elicitation.create, ({ params }) => {
          this.log({ kind: "elicitation", params });
          const content = {};
          for (const [key, prop] of Object.entries(params.requestedSchema?.properties ?? {})) {
            const first = prop.oneOf?.[0]?.const ?? prop.enum?.[0];
            if (first !== undefined) content[key] = first;
          }
          const result = { action: "accept", content };
          this.log({ kind: "elicitation_answer", result });
          return result;
        })
        .connectWith(stream, async (agent) => {
          this.agent = agent;
          await body(this);
        });
    } finally {
      child.kill();
      if (stderr.trim())
        writeFileSync(join(outDir, `stderr.${this.core}.${Date.now()}.log`), stderr);
    }
  }

  async request(method, params) {
    this.log({ kind: "request", method, params });
    try {
      const result = await this.agent.request(method, params);
      this.log({ kind: "response", method, result });
      return result;
    } catch (error) {
      this.log({
        kind: "error",
        method,
        error: { code: error.code, message: error.message, data: error.data },
      });
      return undefined;
    }
  }

  async notify(method, params) {
    this.log({ kind: "notify", method, params });
    await this.agent.notify(method, params);
  }

  async initialize(capabilities = { elicitation: { form: {} } }) {
    return this.request(v2.methods.agent.initialize, {
      protocolVersion: 2,
      info: { name: "compare-v2-cores", version: "1" },
      capabilities,
    });
  }

  /** A new session on the cheapest (haiku) model, in `mode`. */
  async newSession(mode = "default") {
    const s = await this.request(v2.methods.agent.session.new, { cwd: this.cwd });
    const model = s.configOptions.find((o) => o.configId === "model");
    const haiku = flatOptions(model).find((o) => /haiku/i.test(`${o.value} ${o.name}`));
    if (haiku && model.currentValue !== haiku.value) {
      await this.setConfig(s.sessionId, "model", haiku.value);
    }
    // Set even "default": the user's settings can start a session in another mode.
    await this.setConfig(s.sessionId, "mode", mode);
    return s.sessionId;
  }

  setConfig(sessionId, configId, value) {
    return this.request(v2.methods.agent.session.setConfigOption, {
      sessionId,
      configId,
      type: "id",
      value,
    });
  }

  prompt(sessionId, text) {
    return this.request(v2.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  /** Prompts and waits for the turn's idle (the prompt answers at insertion). */
  async turn(sessionId, text, ms = 120000) {
    const idle = this.waitState(sessionId, "idle", ms);
    await this.prompt(sessionId, text);
    await idle;
  }

  close(sessionId) {
    return this.request(v2.methods.agent.session.close, { sessionId });
  }
}

function flatOptions(option) {
  return (option?.options ?? []).flatMap((o) => (o.options ? o.options : [o]));
}

/** Waits until `ms` pass with no recorded entry. */
async function quiet(run, ms = 3000, max = 60000) {
  const start = Date.now();
  while (Date.now() - start < max) {
    const last = run.record.at(-1)?.t ?? 0;
    if (Date.now() - last >= ms) return;
    await sleep(500);
  }
}

const CASES = {
  "plain-text": async (run) => {
    await run.initialize();
    const s = await run.newSession();
    await run.turn(s, "Reply with exactly the single word: pong");
    await quiet(run);
  },

  "bash-foreground": async (run) => {
    await run.initialize();
    const s = await run.newSession("bypassPermissions");
    await run.turn(
      s,
      "Use the Bash tool to run exactly: echo hello-bash . Then reply with just: done",
    );
    await quiet(run);
  },

  "edit-allow": async (run) => {
    await run.initialize();
    const s = await run.newSession("default");
    run.permissionAnswer = "allow_once";
    await run.turn(
      s,
      "Use the Edit tool on file.txt to replace the word one with the word two. Do not read it first beyond what Edit needs. Then reply with just: done",
    );
    await quiet(run);
  },

  "edit-reject": async (run) => {
    await run.initialize();
    const s = await run.newSession("default");
    run.permissionAnswer = "reject_once";
    await run.turn(
      s,
      "Use the Edit tool on file.txt to replace the word one with the word two. If it is rejected, do not retry, reply with just: rejected",
    );
    await quiet(run);
  },

  "cancel-queued": async (run) => {
    await run.initialize();
    const s = await run.newSession("bypassPermissions");
    // Not `sleep 30`: a user hook may block a standalone sleep, and Claude
    // then retries it in the background.
    const started = run.waitFor(
      (e) =>
        e.kind === "update" &&
        e.params.update.sessionUpdate === "terminal_update" &&
        /ping/.test(e.params.update.command ?? ""),
      90000,
      "the ping's terminal",
    );
    const p1 = run.prompt(
      s,
      "Use the Bash tool in the foreground (not run_in_background) to run exactly: ping -c 30 127.0.0.1 > /dev/null . Then reply with just: woke",
    );
    await started.catch(() => {});
    await sleep(2000);
    const p2 = run.prompt(s, "Reply with just: queued");
    await sleep(500);
    const idle = run.waitState(s, "idle", 60000);
    await run.notify(v2.methods.agent.session.cancel, { sessionId: s });
    await Promise.all([p1, p2]);
    await idle.catch(() => {});
    await quiet(run, 4000);
    await run.turn(s, "Reply with exactly the single word: ok");
    await quiet(run);
  },

  // A cancel right after the turn starts, before Claude has output anything.
  "cancel-at-start": async (run) => {
    await run.initialize();
    const s = await run.newSession("bypassPermissions");
    const running = run.waitState(s, "running", 60000);
    const idle = run.waitState(s, "idle", 60000);
    await run.prompt(s, "Write a 300 word story about a lighthouse.");
    await running.catch(() => {});
    await run.notify(v2.methods.agent.session.cancel, { sessionId: s });
    await idle.catch(() => {});
    await quiet(run, 4000);
    await run.turn(s, "Reply with exactly the single word: ok");
    await quiet(run);
  },

  "bash-background": async (run) => {
    await run.initialize();
    const s = await run.newSession("bypassPermissions");
    await run.turn(
      s,
      "Use the Bash tool with run_in_background set to true to run exactly: sleep 4; echo bg-done . Do not wait for it. Reply with just: launched",
    );
    await quiet(run, 15000, 90000);
  },

  "subagent-foreground": async (run) => {
    await run.initialize();
    const s = await run.newSession("bypassPermissions");
    await run.turn(
      s,
      "Use the Agent tool (subagent_type general-purpose, not in background) with the task: 'Run the Bash command echo sub-ok and reply with its output only.' Then reply with just what it said.",
      180000,
    );
    await quiet(run, 5000);
  },

  "subagent-background": async (run) => {
    await run.initialize();
    const s = await run.newSession("bypassPermissions");
    await run.turn(
      s,
      "Use the Agent tool with run_in_background true, subagent_type general-purpose, with the task: 'Run the Bash command sleep 3, then reply with the single word: finished.' Do not wait for it. Reply with just: launched",
      120000,
    );
    await quiet(run, 20000, 150000);
  },

  "ask-user-question": async (run) => {
    await run.initialize();
    const s = await run.newSession("default");
    await run.turn(
      s,
      "Use the AskUserQuestion tool to ask me exactly one question, 'Pick a color', with header 'Color' and the two options Red and Blue. Then reply with just the color I picked.",
    );
    await quiet(run);
  },

  "local-command-context": async (run) => {
    await run.initialize();
    const s = await run.newSession();
    await run.turn(s, "/context");
    await quiet(run);
  },

  "set-config": async (run) => {
    await run.initialize();
    const s = await run.newSession();
    await run.setConfig(s, "mode", "acceptEdits");
    await run.setConfig(s, "mode", "plan");
    await run.setConfig(s, "mode", "default");
    await run.setConfig(s, "mode", "not-a-mode");
    await run.setConfig(s, "model", "default");
    await run.setConfig(s, "model", "not-a-model");
    await quiet(run, 2000);
  },
};

// Resume needs two processes: the second resumes cold, from the transcript.
async function resumeCase(core, cwd, record) {
  let sessionId;
  await new Run(core, cwd, record).start(async (run) => {
    await run.initialize();
    sessionId = await run.newSession("bypassPermissions");
    await run.turn(
      sessionId,
      "Use the Bash tool to run exactly: echo resumed-ok . Then reply with just: done",
    );
    await quiet(run);
    await run.close(sessionId);
  });
  record.push({ t: Date.now(), kind: "restart" });
  await new Run(core, cwd, record).start(async (run) => {
    await run.initialize();
    await run.request(v2.methods.agent.session.resume, {
      sessionId,
      cwd,
      replayFrom: { type: "start" },
    });
    await quiet(run);
  });
}

/** Replaces what varies between runs: ids, timestamps, paths, numbers of usage. */
function normalizer(cwd) {
  const ids = new Map();
  const counters = {};
  const idFor = (kind, value) => {
    const key = `${kind}:${value}`;
    if (!ids.has(key)) {
      counters[kind] = (counters[kind] ?? 0) + 1;
      ids.set(key, `<${kind}${counters[kind]}>`);
    }
    return ids.get(key);
  };
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const toolu = /\b(toolu|call|msg|req)_[A-Za-z0-9]+/g;
  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g;
  const cwdPaths = [cwd, realpathSync(cwd)];
  const VOLATILE = new Set([
    "used",
    "size",
    "amount",
    "inputTokens",
    "outputTokens",
    "cachedReadTokens",
    "cachedWriteTokens",
    "cachedInputTokens",
    "reasoningOutputTokens",
    "totalTokens",
    "thoughtTokens",
    "durationMs",
    "duration_ms",
    "updatedAt",
    "timestamp",
    "createdAt",
    "costUSD",
    "total_cost_usd",
  ]);
  const walk = (value, key) => {
    if (typeof value === "string") {
      let s = value;
      // A background command's output file, and its task id.
      s = s.replace(/\/private\/tmp\/claude-\d+\/[^\s"']+/g, "<TASKFILE>");
      s = s.replace(
        /\b(with ID:?|task(?:_id)?[:=]?) ([a-z0-9]{9})\b/g,
        (_, p, id) => `${p} ${idFor("task", id)}`,
      );
      for (const p of cwdPaths) s = s.split(p).join("<CWD>");
      // Subagent ids (the agent id of a task) are child session ids.
      s = s.replace(/\ba[0-9a-f]{16}\b/g, (m) => idFor("agent", m));
      s = s.replace(uuid, (m) => idFor("id", m.toLowerCase()));
      s = s.replace(toolu, (m) => idFor("tool", m));
      s = s.replace(iso, "<time>");
      s = s.replace(/\/private\/var\/folders\/[^\s"']+|\/var\/folders\/[^\s"']+/g, "<TMP>");
      return s;
    }
    if (typeof value === "number" && VOLATILE.has(key)) return "<n>";
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (k === "t") continue;
        if (key === "rawInput" && k === "description" && typeof v === "string") {
          // Claude writes its own description of a command.
          out[k] = "<description>";
        } else if (k === "output" && typeof v?.data === "string") {
          // Terminal output is base64: compare it as text.
          out[k] = { ...walk(v, k), data: walk(Buffer.from(v.data, "base64").toString("utf8")) };
        } else out[k] = walk(v, k);
      }
      return out;
    }
    return value;
  };
  return (entry) => walk(entry);
}

// Differences the docs list (docs/v2-native-core.md): the native core has no
// effort, fast or ultracode options ("Not served yet") and does not list
// /remote-control ("Intended differences"). The shapes show the config ids
// once, in the session/new line, and leave these out everywhere else.
const SHOWN_CONFIG = new Set(["mode", "model"]);
const configValues = (options, all = false) =>
  (options ?? [])
    .filter((o) => all || SHOWN_CONFIG.has(o.configId ?? o.id))
    .map((o) => `${o.configId ?? o.id}=${o.currentValue}`)
    .join(",");
const commandCount = (commands) =>
  commands ? commands.filter((c) => c.name !== "remote-control").length : "-";

/** One line per message; consecutive chunks of the same session and kind are folded. */
function shape(entries) {
  const lines = [];
  let last;
  const echoLine = new Map();
  const heldResponses = new Map();
  // A child's config is shown in full: the filter is only for the root's options.
  const roots = new Set(
    entries.flatMap((e) =>
      e.kind === "response" && e.method === "session/new" ? [e.result.sessionId] : [],
    ),
  );
  for (const e of entries)
    if (e.kind === "request" && e.method === "session/resume") roots.add(e.params.sessionId);
  for (const e of entries) {
    let line;
    if (e.kind === "update") {
      const u = e.params.update;
      const s = e.params.sessionId;
      const kind = u.sessionUpdate;
      if (/_chunk$/.test(kind)) {
        const key = `${s} ${kind}`;
        if (last === key) continue;
        last = key;
        const text = u.content?.type === "text" ? u.content.text : u.content?.type;
        line = `${s} ${kind}${kind === "user_message_chunk" ? " " + JSON.stringify(text) : ""}`;
        lines.push(line);
        continue;
      }
      const rest = { ...u };
      delete rest.sessionUpdate;
      // Context usage follows the stream's timing, so only the turn's cost
      // report is compared (all usage updates are in the raw file).
      if (kind === "usage_update" && rest.cost === undefined) continue;
      if (kind === "usage_update") line = `${s} usage_update ${Object.keys(rest).sort().join(",")}`;
      else if (kind === "session_info_update")
        line = `${s} session_info_update ${Object.keys(rest).sort().join(",")}`;
      else if (kind === "available_commands_update")
        line = `${s} available_commands_update (${commandCount(u.availableCommands)} commands)`;
      else if (kind === "config_option_update")
        line = `${s} config_option_update ${configValues(
          u.configOptions ?? [u.configOption ?? rest],
          !roots.has(s),
        )}`;
      else if (kind === "subagent_update" && rest.title !== undefined)
        // The title is Claude's description of the task.
        line = `${s} subagent_update ${JSON.stringify({ ...rest, title: "<title>" })}`;
      else line = `${s} ${kind} ${JSON.stringify(rest)}`;
    } else if (e.kind === "response" && e.method === "session/new") {
      line = `response session/new ${e.result.sessionId} config=${configValues(
        e.result.configOptions,
      )} configIds=${e.result.configOptions.map((o) => o.configId).join(",")} commands=${commandCount(
        e.result.availableCommands,
      )}`;
    } else if (e.kind === "response" && e.method === "initialize") {
      line = `response initialize ${JSON.stringify(e.result.capabilities)}`;
    } else if (e.kind === "response" && e.method === "session/resume") {
      const { configOptions, availableCommands, ...rest } = e.result ?? {};
      line = `response session/resume ${JSON.stringify(rest)} config=${configValues(
        configOptions,
      )} commands=${commandCount(availableCommands)}`;
    } else if (e.kind === "response" && e.method === "session/set_config_option") {
      line = `response set_config_option ${configValues(e.result?.configOptions)} ${JSON.stringify({ ...e.result, configOptions: undefined })}`;
    } else if (e.kind === "request" || e.kind === "notify") {
      const { prompt, ...rest } = e.params ?? {};
      line = `${e.kind} ${e.method} ${JSON.stringify(rest)}${
        prompt ? " " + JSON.stringify(prompt[0]?.text) : ""
      }`;
    } else if (e.kind === "response" && e.method === "session/prompt") {
      // v2 gives the prompt response no order relative to its `user_message`
      // (prompt-lifecycle.mdx), so the shape puts it right after that update.
      line = `response session/prompt ${JSON.stringify(e.result)}`;
      const at = echoLine.get(e.result.messageId);
      last = undefined;
      if (at === undefined) heldResponses.set(e.result.messageId, line);
      else {
        lines.splice(at + 1, 0, line);
        for (const [id, i] of echoLine) if (i > at) echoLine.set(id, i + 1);
      }
      continue;
    } else {
      const { kind, method, ms: _ms, ...rest } = e;
      line = `${kind}${method ? " " + method : ""} ${JSON.stringify(rest)}`;
    }
    last = undefined;
    lines.push(line);
    if (e.kind === "update" && e.params.update.sessionUpdate === "user_message") {
      const id = e.params.update.messageId;
      echoLine.set(id, lines.length - 1);
      if (heldResponses.has(id)) lines.push(heldResponses.get(id));
      heldResponses.delete(id);
    }
  }
  lines.push(...heldResponses.values());
  return lines;
}

const caseNames = selected.length ? selected : [...Object.keys(CASES), "resume-replay"];
const summary = [];
for (const name of caseNames) {
  const shapes = {};
  for (const core of cores) {
    const rawFile = join(outDir, `${name}.${core}.raw.jsonl`);
    if (reshape) {
      if (!existsSync(rawFile)) continue;
      const lines = readFileSync(rawFile, "utf8").trim().split("\n");
      shapes[core] = shape(lines.map((l) => JSON.parse(l)));
      writeFileSync(join(outDir, `${name}.${core}.shape.txt`), shapes[core].join("\n") + "\n");
      continue;
    }
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), `v2cmp-${name}-`)));
    writeFileSync(join(cwd, "file.txt"), "one\n");
    const record = [];
    const started = Date.now();
    try {
      if (name === "resume-replay") await resumeCase(core, cwd, record);
      else await new Run(core, cwd, record).start(CASES[name]);
    } catch (error) {
      record.push({ t: Date.now(), kind: "harness_error", message: String(error) });
    }
    const normalize = normalizer(cwd);
    // `ms`: milliseconds since the first message, kept in the raw file only.
    const normalized = record.map((e) => ({ ms: e.t - record[0].t, ...normalize(e) }));
    writeFileSync(rawFile, normalized.map((e) => JSON.stringify(e)).join("\n") + "\n");
    shapes[core] = shape(normalized);
    writeFileSync(join(outDir, `${name}.${core}.shape.txt`), shapes[core].join("\n") + "\n");
    console.error(`${name} ${core}: ${record.length} messages, ${(Date.now() - started) / 1000}s`);
  }
  if (cores.every((c) => shapes[c])) {
    const [a, b] = cores.map((c) => join(outDir, `${name}.${c}.shape.txt`));
    const diff = spawnSync("diff", ["-u", a, b], { encoding: "utf8" }).stdout;
    summary.push({ name, same: !diff });
    if (diff) console.log(`\n=== ${name} differs\n${diff}`);
    else console.log(`\n=== ${name}: same`);
  }
}
console.log(`\nOutput in ${outDir}`);
for (const { name, same } of summary) console.log(`${same ? "same   " : "DIFFERS"} ${name}`);
