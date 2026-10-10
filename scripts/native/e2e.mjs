import assert from "node:assert/strict";
import { join } from "node:path";
import { AcpClient, fixture, textOf, until, repo } from "./harness.mjs";
async function fresh(f) {
  const c = new AcpClient(f);
  await c.initialize();
  await c.create();
  assert.deepEqual(c.capabilities.runtime.reads, ["context", "queuedMessages"]);
  assert.deepEqual(c.capabilities.runtime.controls, ["cancelQueuedMessage"]);
  for (const name of ["sessionRewind", "sessionRewindFiles", "sessionMcp"])
    assert.equal(c.capabilities[name], undefined);
  return c;
}
const rpc = (c, method, fields = {}) => c.request(method, { sessionId: c.sid, ...fields });
const runtime = (c, resource) => rpc(c, "_session/runtime/read", { resource });
function ok(result) {
  assert.equal(result.version, 1);
  assert.equal(result.status, "ok", JSON.stringify(result));
  return result.data;
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
  const queueContract = f.capabilities.includes("runtime");
  const child = f.spawn(
    join(repo, "scripts/native/sdk-contract.mjs"),
    queueContract ? ["--queue-contract"] : [],
  );
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
    exit: true,
    ...(queueContract ? { cancelledDequeued: false, cancelledAbsent: false } : {}),
  });
  assert.equal(f.requests.length, 1);
}

const cases = {
  "context-full": contextFull,
  "queue-cancel": queueCancel,
  "sdk-contract": sdkContract,
};
const args = process.argv.slice(2);
const injectWrongReply = args.includes("--inject-wrong-reply");
const selected = args.filter((arg) => arg !== "--inject-wrong-reply");
for (const name of selected) assert.ok(Object.hasOwn(cases, name), `Unknown native case: ${name}`);
let failed = 0;
for (const name of selected.length ? selected : Object.keys(cases)) {
  const f = await fixture(name);
  f.injectWrongReply = injectWrongReply;
  const start = Date.now();
  try {
    await cases[name](f);
    assert.deepEqual(f.faults, [], "local provider or ACP protocol failed");
    console.log(`PASS ${name} (${Date.now() - start}ms)`);
  } catch (error) {
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
      console.error(`FAIL ${name} cleanup:`, error);
    }
  }
}
if (failed) process.exitCode = 1;
