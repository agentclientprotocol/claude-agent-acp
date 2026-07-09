/**
 * Example: mid-turn steering over ACP with the `_session/steering` extension.
 *
 * "Steering" lets a client deliver a follow-up message to a turn that is still
 * running, instead of waiting for it to finish and sending a fresh
 * `session/prompt`. This is what powers "the user typed something while the
 * agent was still working" — the new message joins the in-flight turn so the
 * agent can adapt immediately (it shines in multi-step / tool-using turns,
 * where the message slots in between tool calls).
 *
 * The wire protocol (see ../steering_protocol.md) has three moving parts:
 *
 *   1. The agent advertises support in its `initialize` response, at the
 *      top-level `_meta.steering.supported` (a sibling of `agentCapabilities`).
 *   2. The client calls the `_session/steering` request with `{ sessionId,
 *      prompt }` while a turn is running.
 *   3. The agent replies with an `outcome`:
 *        - "injected"       the message joined the running turn;
 *        - "startedNewTurn" the turn had already finished (an unavoidable race),
 *                           so the message began a fresh turn instead.
 *      Both are success outcomes — the message is never dropped and the race is
 *      never surfaced as an error.
 *
 * This example launches the agent as a subprocess, starts a deliberately
 * long-running prompt, and — as soon as the agent begins streaming — injects a
 * steering message and prints the outcome. All agent output is streamed to
 * stdout so you can watch the turn change course.
 *
 * Run (build the agent first so `dist/index.js` exists):
 *
 *   npm run build
 *   node examples/steering.ts
 *
 * (Node < 22.18 needs `node --experimental-strip-types examples/steering.ts`.)
 *
 * Override the prompts with the PROMPT / STEER env vars. Requires the agent to
 * be authenticated, since it talks to the real model.
 */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { client as acpClient, methods, ndJsonStream } from "@agentclientprotocol/sdk";

/** The steering extension method, per the ACP steering wire protocol. */
const STEERING_METHOD = "_session/steering";

/** Params for a `_session/steering` request — the same shape as the relevant
 *  subset of a `session/prompt`. */
type SteeringRequest = {
  sessionId: string;
  prompt: Array<{ type: "text"; text: string }>;
};

/** Result of a `_session/steering` request. Both values are successes: they
 *  tell the client where the message landed, not whether it succeeded. */
type SteeringResponse = {
  outcome: "injected" | "startedNewTurn";
};

// The built agent entry. Run `npm run build` first so this exists.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_ENTRY = process.env.AGENT_ENTRY ?? path.join(repoRoot, "dist", "index.js");
const CWD = process.env.CWD ?? process.cwd();

// A deliberately long-running first prompt, and the follow-up injected while it
// is still streaming. Override either via env vars to experiment.
const PROMPT =
  process.env.PROMPT ??
  "Count slowly from 1 to 30, one number per line, with a short sentence of " +
    "commentary after each. Do not stop early.";
const STEER =
  process.env.STEER ?? "Actually stop counting and instead reply with exactly one line: STEERED-OK";

function log(msg: string) {
  process.stderr.write(`\x1b[2m[client]\x1b[0m ${msg}\n`);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // An ACP client launches the agent as a subprocess and speaks JSON-RPC over
  // its stdin/stdout. stderr is inherited so the agent's own logs stay visible.
  const child = spawn(process.execPath, [AGENT_ENTRY], {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });
  child.on("error", (err) => {
    log(`failed to spawn agent (${AGENT_ENTRY}): ${err}`);
    process.exit(1);
  });

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
  );

  // Resolves the first time the agent streams assistant text — our signal that
  // the turn is genuinely underway and therefore steerable.
  let signalFirstOutput = () => {};
  const firstOutput = new Promise<void>((resolve) => (signalFirstOutput = resolve));

  const connection = acpClient({ name: "steering-example" })
    .onNotification(methods.client.session.update, (ctx) => {
      const update = ctx.params.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        process.stdout.write(update.content.text);
        signalFirstOutput();
      }
    })
    // Auto-approve permission prompts so the turn is never blocked on us.
    .onRequest(methods.client.session.requestPermission, (ctx) => {
      const options = ctx.params.options;
      const option = options.find((o) => o.kind === "allow_once") ?? options[0];
      return { outcome: { outcome: "selected", optionId: option.optionId } };
    })
    // Minimal file-system stubs; the example prompts don't touch files.
    .onRequest(methods.client.fs.readTextFile, () => ({ content: "" }))
    .onRequest(methods.client.fs.writeTextFile, () => ({}))
    .connect(stream);

  const agent = connection.agent;

  // 1. Initialize and confirm the agent advertises steering. Per the wire
  //    protocol the capability lives at the TOP-LEVEL `_meta` of the initialize
  //    result — a sibling of `agentCapabilities`, not nested inside it.
  const init = await agent.request(methods.agent.initialize, {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  const meta = init._meta as { steering?: { supported?: boolean } } | null | undefined;
  const steeringSupported = meta?.steering?.supported === true;
  log(`agent advertises steering: ${steeringSupported}`);
  if (!steeringSupported) {
    log("agent does not advertise steering; the steering request may be rejected.");
  }

  // 2. Open a session.
  const { sessionId } = await agent.request(methods.agent.session.new, {
    cwd: CWD,
    mcpServers: [],
  });
  log(`session: ${sessionId}`);

  // 3. Start a long turn, but DON'T await it yet — we need it in flight so we
  //    can steer it. Its output streams through the notification handler above.
  log(`prompt: ${PROMPT}`);
  process.stdout.write("\n----- agent output -----\n");
  const turn = agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: PROMPT }],
  });

  // 4. Once the turn is producing output, inject the follow-up. Wait for the
  //    first streamed chunk (with a fallback) plus a beat, so the steer clearly
  //    lands mid-turn.
  await Promise.race([firstOutput, delay(5000)]);
  await delay(1000);

  process.stdout.write("\n");
  log(`steer: ${STEER}`);
  const steerRequest: SteeringRequest = {
    sessionId,
    prompt: [{ type: "text", text: STEER }],
  };
  try {
    const result = await agent.request<SteeringResponse>(STEERING_METHOD, steerRequest);
    log(`steer outcome: ${result.outcome}`);
  } catch (err) {
    log(`steer rejected: ${err}`);
  }

  // 5. Await the turn. With outcome "injected" the steer already reshaped the
  //    output above; with "startedNewTurn" the follow-up runs as a fresh turn
  //    that may still be streaming, so linger briefly to capture it.
  const response = await turn.catch((err: unknown) => {
    log(`turn error: ${err}`);
    return undefined;
  });
  if (response) log(`turn stopReason: ${response.stopReason}`);
  await delay(3000);
  process.stdout.write("\n----- end of agent output -----\n");

  connection.close();
  child.kill();
}

main().catch((err) => {
  log(`fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
