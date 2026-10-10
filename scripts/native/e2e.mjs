import assert from "node:assert/strict";
import { join } from "node:path";
import { AcpClient, fixture, point, textOf, repo } from "./harness.mjs";

async function fresh(f, options, servers) {
  const c = new AcpClient(f);
  await c.initialize();
  await c.create(options, servers);
  return c;
}
const rpc = (c, method, fields = {}) => c.request(method, { sessionId: c.sid, ...fields });
async function rewind(f, index) {
  let c = await fresh(f);
  const expected = [];
  for (let i = 0; i < 3; i++) {
    await c.prompt(`NATIVE_USER_${i}`);
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
  assert.deepEqual(JSON.parse(stdout), { request: true, rewind: true, exit: true });
  assert.equal(f.requests.length, 1);
}

const cases = {
  first: (f) => rewind(f, 0),
  historical: (f) => rewind(f, 1),
  latest: (f) => rewind(f, 2),
  "sdk-contract": sdkContract,
};
const args = process.argv.slice(2);
const rewindOnly = true; // This checkout exposes only conversation rewind cases.
const injectWrongReply = args.includes("--inject-wrong-reply");
const selected = args.filter((arg) => !["--rewind-only", "--inject-wrong-reply"].includes(arg));
const rewindCases = ["first", "historical", "latest", "sdk-contract"];
for (const name of selected) assert.ok(Object.hasOwn(cases, name), `Unknown native case: ${name}`);
if (rewindOnly)
  for (const name of selected) assert.ok(rewindCases.includes(name), `Not a rewind case: ${name}`);
let failed = 0;
for (const name of selected.length ? selected : rewindOnly ? rewindCases : Object.keys(cases)) {
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
