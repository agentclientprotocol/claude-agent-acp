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
 * The wire protocol has three moving parts:
 *
 *   1. The agent advertises support in its `initialize` response, at the
 *      top-level `_meta.steering` (a sibling of `agentCapabilities`).
 *   2. The client calls the `_session/steering` request with `{ sessionId,
 *      prompt }` while a turn is running.
 *   3. The agent replies with an `outcome`:
 *        - "injected"       the message joined the running turn;
 *        - "startedNewTurn" the turn had already finished and the legacy
 *                           detached fallback was used;
 *        - "promptRequired" the turn had already finished, but this request
 *                           explicitly opted into Host-owned prompt delivery.
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
import {
  client as acpClient,
  methods,
  ndJsonStream,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk";

/** The steering extension method, per the ACP steering wire protocol. */
const STEERING_METHOD = "_session/steering";

/** Params for a `_session/steering` request — the same shape as the relevant
 *  subset of a `session/prompt`. */
type SteeringRequest = {
  sessionId: string;
  prompt: Array<{ type: "text"; text: string }>;
  _meta?: { steering?: { idleBehavior?: "promptRequired" } };
};

/** Result of a `_session/steering` request. `injected` means the message joined
 *  the running turn; `promptRequired` means the turn had already settled, so the
 *  message was NOT consumed and must be (re)sent through a normal
 *  `session/prompt`. Both are successes. */
type SteeringResponse =
  | { outcome: "injected" }
  | { outcome: "startedNewTurn" }
  | { outcome: "promptRequired"; reason: "noRunningTurn" };

/** The existing steering capability advertised at the top-level `_meta.steering`
 *  of the `initialize` result. The idle behavior is selected per request. */
type SteeringCapability = {
  supported?: boolean;
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
  });

  try {
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

    try {
      const agent = connection.agent;

      // 1. Initialize and confirm the agent advertises steering. Per the wire
      //    protocol the capability lives at the TOP-LEVEL `_meta` of the initialize
      //    result — a sibling of `agentCapabilities`, not nested inside it.
      const init = await agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });
      const steering = (init._meta as { steering?: SteeringCapability } | null | undefined)
        ?.steering;
      if (steering?.supported !== true) {
        throw new Error("agent does not advertise steering support");
      }
      log("agent advertises steering support");

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
        // Opt into the host-owned idle fallback. Without this request metadata,
        // the Adapter preserves its legacy `startedNewTurn` behavior.
        _meta: { steering: { idleBehavior: "promptRequired" } },
      };
      const result = await agent.request<SteeringResponse>(STEERING_METHOD, steerRequest);
      log(`steer outcome: ${result.outcome}`);

      if (result.outcome === "promptRequired") {
        // The target turn already settled, so steering did not consume the message.
        // Start a normal session/prompt on the same session to deliver it — that
        // request owns the continuation's updates and terminal response.
        log(`steer fallback: ${result.reason}; starting a normal session/prompt`);
        const continuationRequest: PromptRequest = {
          sessionId: steerRequest.sessionId,
          prompt: steerRequest.prompt,
        };
        const continuation = await agent.request<PromptResponse, PromptRequest>(
          methods.agent.session.prompt,
          continuationRequest,
        );
        log(`continuation stopReason: ${continuation.stopReason}`);
      }

      // 5. Await the original turn. With outcome "injected" the steer already
      //    reshaped the output above; the promptRequired branch owns its own turn.
      const response = await turn;
      log(`original turn stopReason: ${response.stopReason}`);
      process.stdout.write("\n----- end of agent output -----\n");
    } finally {
      connection.close();
    }
  } finally {
    child.kill();
  }
}

main().catch((err) => {
  log(`fatal: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
