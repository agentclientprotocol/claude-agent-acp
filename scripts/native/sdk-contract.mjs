// This worker runs only inside harness.mjs's isolated environment.
import assert from "node:assert/strict";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeCliPath } from "../../dist/acp-agent.js";
import { awaitNativeExit } from "../../dist/native-mutation.js";
import { nativeRewind } from "../../dist/native-rewind-control.js";
import { randomUUID } from "node:crypto";

assert.equal(process.env.ANTHROPIC_API_KEY, "native-e2e-dummy-key");
assert.match(process.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
const uuid = randomUUID();
let release;
const input = new Promise((r) => {
  release = r;
});
const q = query({
  prompt: (async function* () {
    yield {
      type: "user",
      uuid,
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content: "NATIVE_SDK_CONTRACT" },
    };
    await input;
  })(),
  options: {
    cwd: process.cwd(),
    pathToClaudeCodeExecutable: await claudeCliPath(),
    env: process.env,
    model: "claude-sonnet-4-5-20250929",
    settingSources: [],
    tools: [],
    strictMcpConfig: true,
    settings: { disableAllHooks: true, autoMemoryEnabled: false },
    promptSuggestions: false,
  },
});
try {
  assert.equal(typeof q.request, "function", "SDK private request disappeared");
  assert.equal(typeof q.transport?.waitForExit, "function", "SDK exit observer disappeared");
  let resultSeen = false;
  const iterator = q[Symbol.asyncIterator]();
  for (;;) {
    const { value: message, done } = await iterator.next();
    if (done) break;
    if (message.type === "result") {
      assert.equal(message.subtype, "success");
      assert.equal(message.is_error, false);
      resultSeen = true;
      break;
    }
  }
  assert.equal(resultSeen, true);
  assert.ok(q.transport.process && typeof q.transport.process.once === "function");
  // Exercise the raw private envelope as well as the production bridge.
  const refused = await q.request({
    subtype: "rewind_conversation",
    target_message_uuid: randomUUID(),
    last_seen_user_message_uuid: uuid,
    interrupt_if_running: false,
  });
  assert.equal(refused.response.rewound, false);
  assert.equal(typeof refused.response.reason, "string");
  const accepted = await nativeRewind(q, uuid, uuid);
  assert.equal(accepted.rewound, true);
  assert.equal(accepted.targetMessageUuid, uuid);
  const transport = q.transport;
  const exit = transport.waitForExit();
  assert.equal(typeof exit?.then, "function");
  let exited = false;
  void exit.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );
  await Promise.resolve();
  assert.equal(exited, false, "exit observer resolved while native was still running");
  q.close();
  await awaitNativeExit(q);
  assert.equal(exited, true);
  assert.ok(
    Number.isInteger(transport.process.exitCode) ||
      /^SIG[A-Z0-9]+$/.test(transport.process.signalCode ?? ""),
    "observer must correspond to actual OS exit",
  );
  console.log(JSON.stringify({ request: true, rewind: true, exit: true }));
} finally {
  release();
  q.close();
  await awaitNativeExit(q);
}
