import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AcpClient, fixture, point, textOf, until, alive, repo } from "./harness.mjs";
import { checkpointPreview } from "./checkpoint-preview.mjs";

async function fresh(f, options, servers) {
  const c = new AcpClient(f);
  await c.initialize();
  assert.deepEqual(c.capabilities.runtime.reads, [
    "context",
    "usage",
    "mcp",
    "commands",
    "agents",
    "queuedMessages",
  ]);
  assert.deepEqual(c.capabilities.runtime.controls, [
    "reloadSkills",
    "reloadPlugins",
    "reloadOutputStyles",
    "reconnectMcp",
    "toggleMcp",
    "backgroundTask",
    "cancelQueuedMessage",
  ]);
  await c.create(options, servers);
  return c;
}
const rpc = (c, method, fields = {}) => c.request(method, { sessionId: c.sid, ...fields });
const state = (c) => rpc(c, "_session/mcp/state");
const runtime = (c, resource) => rpc(c, "_session/runtime/read", { resource });
function ok(result) {
  assert.equal(result.version, 1);
  assert.equal(result.status, "ok", JSON.stringify(result));
  return result.data;
}
function connected(result, expected) {
  const servers = ok(result);
  assert.ok(Array.isArray(servers));
  assert.deepEqual(servers.map((s) => s.name).sort(), [...expected].sort());
  for (const server of servers) {
    assert.equal(server.status, "connected");
    assert.equal(server.serverInfo.name, "native-contract-mcp");
    assert.deepEqual(server.toolNames, []);
    assert.equal(server.config, undefined);
  }
}
async function awaitConnected(c, expected) {
  const result = await until(async () => {
    const response = await runtime(c, "mcp");
    const servers = ok(response);
    assert.ok(Array.isArray(servers));
    if (servers.some((s) => s.status === "pending")) return false;
    return response;
  }, "native MCP connections");
  connected(result, expected);
}

async function rewind(f, index) {
  f.rawMessages = true;
  let c = await fresh(f);
  const expected = [];
  for (let i = 0; i < 3; i++) {
    const start = c.messages.length;
    await c.prompt(`NATIVE_USER_${i}`);
    // ACP result settlement precedes the CLI's trailing idle. The semantic
    // guard assertions below intentionally require idle; busy is NOT success.
    await until(
      () =>
        c.messages
          .slice(start)
          .some(
            (frame) =>
              frame.method === "_claude/sdkMessage" &&
              frame.params.message.type === "system" &&
              frame.params.message.subtype === "session_state_changed" &&
              frame.params.message.state === "idle",
          ),
      "native idle after rewind fixture prompt",
    );
    expected.push(
      { role: "user", text: `NATIVE_USER_${i}` },
      { role: "assistant", text: `NATIVE_REPLY_${i}` },
    );
  }
  assert.equal(f.requests.length, 3, "three real prompts must reach the local provider");
  const history = await f.history(c.sid);
  assert.deepEqual(
    history.map((r) => ({ role: r.type, text: textOf(r.message.content) })),
    expected,
  );
  const target = index * 2;
  const params = {
    beforeMessage: point(history[target]),
    ...(target ? { resumeAtMessage: point(history[target - 1]) } : {}),
  };
  // Invalid guards must not mutate the native branch or start a prompt.
  await assert.rejects(
    rpc(c, "_session/rewind", {
      ...params,
      beforeMessage: { ...params.beforeMessage, messageFingerprint: "sha256:" + "0".repeat(64) },
    }),
    { code: -32602 },
  );
  if (index > 0)
    await assert.rejects(rpc(c, "_session/rewind", { beforeMessage: params.beforeMessage }), {
      code: -32602,
    });
  assert.deepEqual(await rpc(c, "_session/rewind", params), { rewound: true, sessionId: c.sid });
  const persisted = (await f.transcript(c.sid)).findLast(
    (row) => row.type === "last-prompt" && row.explicit === true,
  );
  assert.equal(persisted?.rewound, true, "ACP success requires the native anchor on disk");
  assert.equal(persisted.leafUuid, target ? history[target - 1].uuid : null);
  assert.equal(f.requests.length, 3, "rewind must not resend");
  const sid = c.sid,
    loadParams = c.params,
    oldPid = c.child.pid;
  await c.stop();
  c = new AcpClient(f);
  await c.initialize();
  c.sid = sid;
  c.params = loadParams;
  assert.notEqual(c.child.pid, oldPid, "must restart the ACP process");
  const start = c.messages.length;
  const loaded = await c.request("session/load", loadParams);
  assert.equal(loaded.sessionId, sid);
  assert.deepEqual(
    c.replay(start),
    expected.slice(0, target),
    "restart without resend must replay only the retained branch",
  );
  assert.equal(f.requests.length, 3, "load must not generate a model request");
  await c.prompt("NATIVE_EDITED_RESEND");
  assert.equal(f.requests.length, 4);
  const messages = f.requests.at(-1).messages;
  // Native can add system-reminder blocks; compare all authored sentinel text and order.
  const authored = messages.flatMap((m) =>
    Array.from(
      textOf(m.content).matchAll(/NATIVE_(?:USER_\d+|REPLY_\d+|EDITED_RESEND)/g),
      (match) => ({ role: m.role, text: match[0] }),
    ),
  );
  assert.deepEqual(
    authored,
    [...expected.slice(0, target), { role: "user", text: "NATIVE_EDITED_RESEND" }],
    "resend provider context must exclude every discarded user AND assistant",
  );
  assert.equal(c.sid, sid);
  await c.stop();
}

async function files(f) {
  await writeFile(join(f.cwd, "tracked.txt"), "ORIGINAL\n");
  await writeFile(join(f.cwd, "untracked.txt"), "USER_CHANGE\n");
  const c = await fresh(f, { tools: ["Read", "Edit"], permissionMode: "acceptEdits" });
  await c.prompt("NATIVE_EDIT_TRACKED_FILE");
  assert.equal(
    f.requests.length,
    3,
    "Read, Edit and final answer must each make a provider request",
  );
  for (const [index, id] of [
    [1, "tool_1"],
    [2, "tool_2"],
  ]) {
    const results = f.requests[index].messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content : [],
    );
    const result = results.find((b) => b.type === "tool_result" && b.tool_use_id === id);
    assert.ok(result, `native ${id} result missing`);
    assert.notEqual(result.is_error, true, JSON.stringify(result));
  }
  assert.equal(await readFile(join(f.cwd, "tracked.txt"), "utf8"), "CHANGED\n");
  const before = await f.history(c.sid);
  const user = before.find(
    (r) => r.type === "user" && textOf(r.message.content) === "NATIVE_EDIT_TRACKED_FILE",
  );
  assert.ok(user);
  const params = { beforeMessage: point(user), dryRun: true };
  const preview = await checkpointPreview(() => rpc(c, "_session/rewind_files", params), c.sid);
  assert.equal(preview.sessionId, c.sid);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.canRewind, true, `Native checkpoint preview: ${JSON.stringify(preview)}`);
  assert.deepEqual(preview.filesChanged, [join(f.cwd, "tracked.txt")]);
  assert.equal(
    await readFile(join(f.cwd, "tracked.txt"), "utf8"),
    "CHANGED\n",
    "preview cannot restore",
  );
  const restored = await rpc(c, "_session/rewind_files", { ...params, dryRun: false });
  assert.equal(restored.sessionId, c.sid);
  assert.equal(restored.dryRun, false);
  assert.equal(restored.canRewind, true, `Native checkpoint restore: ${JSON.stringify(restored)}`);
  assert.equal(await readFile(join(f.cwd, "tracked.txt"), "utf8"), "ORIGINAL\n");
  assert.equal(await readFile(join(f.cwd, "untracked.txt"), "utf8"), "USER_CHANGE\n");
  assert.deepEqual(
    await f.history(c.sid),
    before,
    "file restore must preserve conversation history",
  );
  assert.equal(f.requests.length, 3, "file controls cannot generate prompts");
  await c.stop();
}

async function runtimeCase(f) {
  const c = await fresh(f);
  await c.prompt("NATIVE_RUNTIME_HISTORY");
  const before = await f.history(c.sid);
  for (const resource of ["commands", "agents", "mcp"])
    assert.ok(Array.isArray(ok(await runtime(c, resource))));
  const usage = ok(await runtime(c, "usage"));
  assert.ok(usage.session && typeof usage.session === "object");
  assert.equal(typeof usage.rate_limits_available, "boolean");
  const context = ok(await runtime(c, "context"));
  assert.ok(Array.isArray(context.categories));
  assert.equal(typeof context.totalTokens, "number");
  assert.ok(context.maxTokens > 0);
  const skills = ok(await rpc(c, "_session/runtime/control", { action: "reloadSkills" }));
  assert.ok(Array.isArray(skills.skills));
  const plugins = ok(await rpc(c, "_session/runtime/control", { action: "reloadPlugins" }));
  assert.ok(Array.isArray(plugins.commands));
  assert.ok(Array.isArray(plugins.agents));
  assert.ok(Array.isArray(plugins.mcpServers));
  const styles = ok(await rpc(c, "_session/runtime/control", { action: "reloadOutputStyles" }));
  assert.ok(Array.isArray(styles.available_output_styles));
  assert.ok(styles.available_output_styles.every((s) => typeof s === "string"));
  assert.deepEqual(await f.history(c.sid), before);
  assert.equal(f.requests.length, 1, "runtime controls must not submit prompts");
  await c.stop();
}

function mcp(name, marker, hang = false) {
  return {
    name,
    command: process.execPath,
    args: [join(repo, "scripts/native/mock-mcp.mjs"), marker, ...(hang ? ["hang"] : [])],
    env: [],
  };
}
async function mcpCase(f) {
  const host = mcp("host", join(f.root, "host.pid"));
  const second = mcp("second", join(f.root, "second.pid"));
  const c = await fresh(
    f,
    {
      mcpServers: {
        protected: {
          type: "stdio",
          command: process.execPath,
          args: [join(repo, "scripts/native/mock-mcp.mjs"), join(f.root, "protected.pid")],
        },
      },
    },
    [host],
  );
  await c.prompt("NATIVE_MCP_HISTORY");
  const before = await f.history(c.sid);
  const initial = await state(c);
  assert.deepEqual(initial, {
    version: 1,
    revision: 0,
    uncertain: false,
    servers: [{ name: "host", type: "stdio" }],
  });
  await awaitConnected(c, ["host", "protected"]);
  const set = await rpc(c, "_session/mcp/set", {
    expectedRevision: initial.revision,
    mcpServers: [host, second],
  });
  assert.equal(set.status, "ok");
  assert.equal(set.revision, 1);
  assert.deepEqual(set.failedServers, []);
  assert.deepEqual([...set.added].sort(), ["host", "protected", "second"]);
  await awaitConnected(c, ["host", "second", "protected"]);
  await assert.rejects(rpc(c, "_session/mcp/set", { expectedRevision: 0, mcpServers: [] }), {
    code: -32602,
  });
  await assert.rejects(
    rpc(c, "_session/mcp/set", {
      expectedRevision: 1,
      mcpServers: [{ ...host, name: "protected" }],
    }),
    { code: -32602 },
  );
  const empty = await rpc(c, "_session/mcp/set", { expectedRevision: 1, mcpServers: [] });
  assert.equal(empty.status, "ok");
  assert.equal(empty.revision, 2);
  assert.deepEqual(empty.failedServers, []);
  assert.deepEqual([...empty.removed].sort(), ["host", "second"]);
  await awaitConnected(c, ["protected"]);
  await rpc(c, "session/close");
  c.params.mcpServers = [];
  const loaded = await c.request("session/load", c.params);
  assert.equal(loaded.sessionId, c.sid);
  const recreated = await state(c);
  assert.equal(recreated.revision, 3);
  assert.equal(recreated.uncertain, false);
  assert.deepEqual(recreated.servers, []);
  await assert.rejects(rpc(c, "_session/mcp/set", { expectedRevision: 2, mcpServers: [] }), {
    code: -32602,
  });
  await awaitConnected(c, ["protected"]);
  assert.deepEqual(await f.history(c.sid), before);
  assert.equal(f.requests.length, 1);
  await c.stop();
}

async function hangingClose(f) {
  const c = await fresh(f);
  await c.prompt("NATIVE_HANG_HISTORY");
  const initial = await state(c);
  const marker = join(f.root, "hung.pid");
  let settled = false;
  const pending = rpc(c, "_session/mcp/set", {
    expectedRevision: initial.revision,
    mcpServers: [mcp("hanging", marker, true)],
  })
    .then(
      (result) => ({ result }),
      (error) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  const pid = Number(
    await until(() => readFile(marker, "utf8").catch(() => null), "hanging MCP start"),
  );
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && alive(pid));
  assert.equal(settled, false, "MCP set must actually be pending when close begins");
  const start = Date.now();
  await rpc(c, "session/close");
  assert.ok(Date.now() - start < 20_000, "close must remain bounded");
  const outcome = await pending;
  assert.equal(outcome.result, undefined, "interrupted set cannot report success");
  assert.equal(outcome.error?.code, -32603);
  assert.match(outcome.error.data.details, /uncertain|interrupted/i);
  await until(() => !alive(pid), "hung MCP child exit after session close", 5_000);
  const loaded = await c.request("session/load", c.params);
  assert.equal(loaded.sessionId, c.sid);
  const after = await state(c);
  assert.equal(after.revision, initial.revision + 1);
  assert.equal(after.uncertain, false);
  assert.deepEqual(after.servers, []);
  connected(await runtime(c, "mcp"), []);
  assert.equal(f.requests.length, 1);
  await c.stop();
}

async function contextFull(f) {
  // A deterministic fixture count, not a tokenizer or an accuracy assertion.
  f.countTokens = (body) => Math.ceil(JSON.stringify(body).length / 4);
  const c = await fresh(f);
  assert.ok(c.capabilities.runtime.context.details.includes("full"));
  assert.equal(c.capabilities.runtime.context.defaultDetail, "summary");
  assert.equal(c.capabilities.runtime.context.fullMayUseNetwork, true);
  await c.prompt("NATIVE_CONTEXT_FULL");
  const before = await f.history(c.sid);
  assert.deepEqual(
    before.filter((row) => row.type === "assistant").map((row) => textOf(row.message.content)),
    ["NATIVE_REPLY_0"],
  );
  const countsBefore = f.countRequests.length;
  ok(await runtime(c, "context"));
  ok(await rpc(c, "_session/runtime/read", { resource: "context", detail: "summary" }));
  assert.equal(f.countRequests.length, countsBefore, "summary must not call count_tokens");
  for (const fields of [
    { resource: "context", detail: null },
    { resource: "context", detail: "FULL" },
    { resource: "context", detail: false },
    { resource: "context", detail: "full", hidden: true },
    ...["usage", "mcp", "commands", "agents", "queuedMessages"].map((resource) => ({
      resource,
      detail: "full",
    })),
  ]) {
    await assert.rejects(rpc(c, "_session/runtime/read", fields), { code: -32602 });
  }
  assert.equal(f.countRequests.length, countsBefore, "invalid detail must not dispatch counts");
  const full = ok(await rpc(c, "_session/runtime/read", { resource: "context", detail: "full" }));
  assert.ok(
    f.countRequests.length > countsBefore,
    "explicit full must reach the fake count_tokens endpoint",
  );
  assert.ok(Array.isArray(full.categories) && full.categories.length > 0);
  for (const category of full.categories) {
    assert.equal(typeof category.name, "string");
    assert.ok(Number.isFinite(category.tokens) && category.tokens >= 0);
    assert.ok(
      ["used", "free", "buffer", "deferred"].includes(category.kind),
      JSON.stringify(category),
    );
  }
  assert.ok(full.categories.some((category) => category.kind === "used"));
  assert.ok(full.categories.some((category) => category.kind === "free"));
  assert.ok(full.rawMaxTokens > 0 && full.maxTokens > 0);
  assert.ok(Number.isFinite(full.totalTokens));
  assert.equal(f.requests.length, 1, "full diagnostics cannot generate a prompt");
  assert.deepEqual(await f.history(c.sid), before, "context reads cannot change authored history");
  const countsAfter = f.countRequests.length;
  ok(await runtime(c, "context"));
  assert.equal(f.countRequests.length, countsAfter, "full must not persist as the default");
  console.log(
    JSON.stringify({
      case: "context-full",
      countRequests: countsAfter - countsBefore,
      categories: full.categories.map(({ name, kind, tokens }) => ({ name, kind, tokens })),
    }),
  );
  await c.stop();
}

async function queueCancel(f) {
  const release = Promise.withResolvers();
  f.beforeReply = async (_body, index) => {
    if (index === 0) await release.promise;
  };
  f.rawMessages = true;
  const c = await fresh(f);
  assert.ok(c.capabilities.runtime.reads.includes("queuedMessages"));
  assert.ok(c.capabilities.runtime.controls.includes("cancelQueuedMessage"));
  const prompt = (text) => rpc(c, "session/prompt", { prompt: [{ type: "text", text }] });
  const lifecycle = (id, state) =>
    c.messages.some(
      (frame) =>
        frame.method === "_claude/sdkMessage" &&
        frame.params.message.type === "command_lifecycle" &&
        frame.params.message.command_uuid === id &&
        frame.params.message.state === state,
    );
  const pending = [];
  try {
    let foregroundDone = false;
    const foreground = prompt("NATIVE_QUEUE_FOREGROUND").then((result) => {
      foregroundDone = true;
      return result;
    });
    pending.push(foreground);
    foreground.catch(() => {});
    await until(() => f.requests.length === 1, "foreground reached paused fake provider");
    const removed = prompt("NATIVE_QUEUE_REMOVE");
    pending.push(removed);
    removed.catch(() => {});
    const firstList = await until(async () => {
      const data = ok(await runtime(c, "queuedMessages"));
      return data.messages.length === 1 && data.messages;
    }, "first pending adapter prompt");
    const removeId = firstList[0].messageId;
    let keptDone = false;
    const kept = prompt("NATIVE_QUEUE_KEEP").then((result) => {
      keptDone = true;
      return result;
    });
    pending.push(kept);
    kept.catch(() => {});
    const both = await until(async () => {
      const data = ok(await runtime(c, "queuedMessages"));
      return data.messages.length === 2 && data.messages;
    }, "two pending adapter prompts");
    const keepId = both.find((message) => message.messageId !== removeId).messageId;
    await until(
      () => lifecycle(removeId, "queued") && lifecycle(keepId, "queued"),
      "both messages queued in native CLI",
    );
    const response = ok(
      await rpc(c, "_session/runtime/control", {
        action: "cancelQueuedMessage",
        messageId: removeId,
      }),
    );
    assert.deepEqual(response, { messageId: removeId, cancelled: true });
    assert.deepEqual(
      await removed,
      { stopReason: "cancelled" },
      "pending session/prompt must settle without usage",
    );
    await until(() => lifecycle(removeId, "cancelled"), "native cancelled lifecycle");
    assert.equal(foregroundDone, false, "single cancellation must not end foreground");
    assert.equal(keptDone, false, "single cancellation must not settle another queued prompt");
    assert.equal(f.requests.length, 1, "foreground is still held by fake provider");
    assert.deepEqual(ok(await runtime(c, "queuedMessages")).messages, [{ messageId: keepId }]);
    await assert.rejects(
      rpc(c, "_session/runtime/control", { action: "cancelQueuedMessage", messageId: removeId }),
      { code: -32602 },
    );
    release.resolve();
    assert.equal((await foreground).stopReason, "end_turn");
    assert.equal((await kept).stopReason, "end_turn");
    assert.equal(f.requests.length, 2);
    const history = await f.history(c.sid);
    assert.deepEqual(
      history.filter((row) => row.type === "assistant").map((row) => textOf(row.message.content)),
      ["NATIVE_REPLY_0", "NATIVE_REPLY_1"],
    );
    const authored = f.requests
      .at(-1)
      .messages.flatMap((message) =>
        Array.from(
          textOf(message.content).matchAll(/NATIVE_QUEUE_(?:FOREGROUND|REMOVE|KEEP)/g),
          (match) => match[0],
        ),
      );
    assert.deepEqual(authored, ["NATIVE_QUEUE_FOREGROUND", "NATIVE_QUEUE_KEEP"]);
    assert.equal(lifecycle(removeId, "started"), false);
    assert.equal(lifecycle(keepId, "started"), true);
    assert.deepEqual(ok(await runtime(c, "queuedMessages")).messages, []);
    console.log(
      JSON.stringify({
        case: "queue-cancel",
        cancelled: true,
        removedPrompt: "cancelled",
        foreground: "end_turn",
        keptPrompt: "end_turn",
        providerRequests: f.requests.length,
      }),
    );
    await c.stop();
  } finally {
    release.resolve();
    // Reject outstanding harness promises on failure before fixture cleanup kills the child.
    c.rejectPending(new Error("queue-cancel case ended"));
    await Promise.allSettled(pending);
  }
}

async function sdkContract(f) {
  const child = f.spawn(join(repo, "scripts/native/sdk-contract.mjs"));
  let stdout = "";
  child.stdout.on("data", (b) => {
    stdout += b;
  });
  const exit = await Promise.race([
    child.finished,
    child.failure,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("SDK contract worker timed out")), 30_000);
      child.finished.finally(() => clearTimeout(timer));
    }),
  ]);
  assert.equal(exit.code, 0, child.stderrText);
  assert.deepEqual(JSON.parse(stdout), {
    request: true,
    rewind: true,
    exit: true,
    cancelledDequeued: false,
    cancelledAbsent: false,
  });
  assert.equal(f.requests.length, 1);
}

const cases = {
  first: (f) => rewind(f, 0),
  historical: (f) => rewind(f, 1),
  latest: (f) => rewind(f, 2),
  files,
  runtime: runtimeCase,
  mcp: mcpCase,
  "hanging-close": hangingClose,
  "sdk-contract": sdkContract,
  "context-full": contextFull,
  "queue-cancel": queueCancel,
};
const args = process.argv.slice(2);
const rewindOnly = args.includes("--rewind-only");
const injectWrongReply = args.includes("--inject-wrong-reply");
const selected = args.filter((arg) => !["--rewind-only", "--inject-wrong-reply"].includes(arg));
const rewindCases = ["first", "historical", "latest", "sdk-contract"];
for (const name of selected) assert.ok(Object.hasOwn(cases, name), `Unknown native case: ${name}`);
if (rewindOnly)
  for (const name of selected) assert.ok(rewindCases.includes(name), `Not a rewind case: ${name}`);
let failed = 0;
for (const name of selected.length ? selected : rewindOnly ? rewindCases : Object.keys(cases)) {
  const f = await fixture(name, rewindOnly ? ["sessionRewind"] : undefined);
  f.injectWrongReply = injectWrongReply;
  const start = Date.now();
  let caseError;
  try {
    await cases[name](f);
    assert.deepEqual(f.faults, [], "local provider or ACP protocol failed");
    console.log(`PASS ${name} (${Date.now() - start}ms)`);
  } catch (error) {
    caseError = error;
    failed++;
    console.error(`FAIL ${name}:`, error);
    console.error("provider requests", f.requests.length, "faults", f.faults);
    for (const child of f.children)
      if (child.stderrText) console.error(child.stderrText.slice(-6000));
  } finally {
    try {
      await f.cleanup();
    } catch (error) {
      failed++;
      caseError ??= error;
      console.error(`FAIL ${name} cleanup:`, error);
    } finally {
      await f.saveEvidence(caseError);
    }
  }
}
if (failed) process.exitCode = 1;
