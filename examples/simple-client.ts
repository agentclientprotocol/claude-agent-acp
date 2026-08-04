/**
 * Example: a dead-simple interactive ACP client for this agent.
 *
 * This is the "no editor required" way to exercise the agent: it launches
 * `dist/index.js` as a subprocess, speaks ACP over its stdio using the SDK, and
 * prints every JSON-RPC message that crosses the wire in both directions. Each
 * line you type becomes a `session/prompt`; the agent's answer streams back as
 * `session/update` notifications.
 *
 * Every message is preceded by a header line naming its direction:
 *
 *   [agent] ◂   inbound  — everything the agent sends us
 *   [user]  ▸   outbound — everything we send the agent, including our own
 *                          permission answers and `session/cancel`
 *
 * The label and the arrow carry the direction, so it survives NO_COLOR and
 * redirection to a file (`2> wire.log`). The JSON itself is printed in full,
 * flush left and undecorated — select it and you have valid JSON on the
 * clipboard. This exists to show you the protocol, not to summarize it.
 *
 * There are four ways for a client to get a message to this agent, and all four
 * are reachable from the prompt so you can watch what each one looks like on
 * the wire. Plain text is the first; the rest are `!`-prefixed commands, chosen
 * so they cannot be confused with the agent's own slash commands (`/compact`
 * and friends are ordinary prompt text here). `!!` escapes a literal `!`.
 *
 *   <text>          `session/prompt`. Typed mid-turn it is *buffered* by this
 *                   client and sent once the running turn responds.
 *   !steer <text>   `_session/steering` — injected into the turn that is
 *                   already running, so it can change course between tool
 *                   calls. Answers "injected", or "startedNewTurn" if the turn
 *                   beat us to the finish. An injected reply streams as
 *                   `session/update` notifications *within* that turn: its
 *                   `stopReason` waits for the steered work to finish. The
 *                   "startedNewTurn" output belongs to a detached turn no
 *                   `session/prompt` of ours tracks. See ./steering.ts.
 *   !queue <text>   `session/prompt` sent mid-turn anyway. The agent advertises
 *                   `promptQueueing`, so it takes the backlog instead of us —
 *                   same ordering, different owner.
 *   !cancel         `session/cancel` for the running turn, as Ctrl-C does.
 *
 * Run (build the agent first so `dist/index.js` exists):
 *
 *   npm run build
 *   node examples/simple-client.ts
 *
 * or, equivalently, `npm run example:simple-client`.
 *
 * To debug the agent itself, pass a port. The agent is then rebuilt with source
 * maps and started under `--inspect-brk=<port>`, i.e. paused before its first
 * line, so you can attach (IntelliJ: Run → Attach to Node.js/Chrome; VS Code:
 * "Attach to Node Process"), set breakpoints in `src/*.ts`, and resume:
 *
 *   node examples/simple-client.ts --debug-port=9229
 *
 * The client will sit waiting for `initialize` until you attach and resume —
 * that is expected, ACP has no request timeout.
 *
 * (Node < 22.18 needs `node --experimental-strip-types examples/simple-client.ts`.)
 *
 * Keys: Enter sends (or buffers), Ctrl-C cancels the running turn (again to
 * quit), Ctrl-D drains anything buffered and exits. `!help` lists the commands.
 *
 * Flags: --debug-port=<port>, --no-build, --help.
 * Env:   AGENT_ENTRY (default dist/index.js), CWD (default process.cwd()).
 *
 * Requires the agent to be authenticated, since it talks to the real model.
 *
 * Note: this client does not advertise the `elicitation` capability, so the
 * agent disables its AskUserQuestion tool instead of asking us to render a
 * form. That is the one intentional behaviour difference from a full client.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_VERSION,
  client as acpClient,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
// Type-only: Node's type stripping does not elide value imports, and these two
// exist only in the .d.ts — importing them normally is a runtime SyntaxError.
import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

// ---------------------------------------------------------------- steering

/**
 * The steering extension (../steering_protocol.md, and ./steering.ts for a
 * scripted walkthrough). It is not part of ACP proper, so it has no entry in
 * `methods` and is sent as a raw method name with hand-written types.
 */
const STEERING_METHOD = "_session/steering";

type SteeringRequest = {
  sessionId: string;
  prompt: Array<{ type: "text"; text: string }>;
};

/** Both outcomes are successes; they say where the message landed, not whether
 *  it worked. "startedNewTurn" means the turn finished before we got there. */
type SteeringResponse = {
  outcome: "injected" | "startedNewTurn";
};

// ---------------------------------------------------------------- arguments

const ARGV = process.argv.slice(2);

/** Reads `--name=value` or `--name value`; returns "" for a valueless flag. */
function flag(name: string): string | undefined {
  const index = ARGV.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (index === -1) return undefined;
  const [, ...rest] = ARGV[index].split("=");
  return rest.length > 0 ? rest.join("=") : (ARGV[index + 1] ?? "");
}

if (ARGV.includes("--help") || ARGV.includes("-h")) {
  process.stdout.write(
    [
      "Usage: node examples/simple-client.ts [--debug-port=<port>] [--no-build]",
      "",
      "  --debug-port=<port>  rebuild with source maps and start the agent under",
      "                       --inspect-brk=<port>, paused until a debugger attaches",
      "  --no-build           skip the tsc rebuild and use dist/ as-is",
      "",
      "Env: AGENT_ENTRY (default dist/index.js), CWD (default process.cwd()).",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

// The built agent entry. Rebuilt below unless --no-build is passed.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_ENTRY = process.env.AGENT_ENTRY ?? path.join(repoRoot, "dist", "index.js");
const CWD = process.env.CWD ?? process.cwd();
const BUILD = !ARGV.includes("--no-build");

const debugPortArg = flag("debug-port");
const DEBUG_PORT = debugPortArg === undefined ? undefined : Number(debugPortArg);
if (
  DEBUG_PORT !== undefined &&
  (!Number.isInteger(DEBUG_PORT) || DEBUG_PORT < 1 || DEBUG_PORT > 65535)
) {
  process.stderr.write(`--debug-port expects a port between 1 and 65535, got "${debugPortArg}"\n`);
  process.exit(1);
}

/** Shown by `!help`, and once at startup. */
const HELP = [
  "<text>          send it — as a new turn, or buffered until this turn ends",
  "!steer <text>   inject into the running turn (_session/steering)",
  "!queue <text>   send session/prompt now and let the agent queue it",
  "!cancel         session/cancel the running turn (same as Ctrl-C)",
  "!help           this list; !! sends a line that really starts with '!'",
];

// How long to wait for a cancelled turn to settle, and for the agent to exit
// after we close its stdin, before escalating during shutdown.
const CANCEL_TIMEOUT_MS = 5_000;
const EXIT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------- output

const COLOR = process.stderr.isTTY === true && !process.env.NO_COLOR;
const paint = (code: string, text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (text: string) => paint("2", text);

const TTY = process.stdin.isTTY === true && process.stderr.isTTY === true;
const startedAt = Date.now();

let rl: readline.Interface | null = null;
let shuttingDown = false;
let queue: string[] = [];
// How many `session/prompt` requests are awaiting a response. Usually 0 or 1;
// `!queue` deliberately drives it higher to exercise the agent's own queueing.
let inFlight = 0;
const turnRunning = () => inFlight > 0;
let cancelRequested = false;
let lastUpdateKind = "";
// False until `initialize` returns — an agent still paused under --inspect-brk
// will never act on stdin EOF, so shutdown skips straight to signalling it.
let agentReady = false;

/**
 * The single writer for everything this process prints. It wipes the half-typed
 * input line, writes the block, then asks readline to redraw its prompt with the
 * buffer intact — without this, streamed output and typing shred each other.
 * (One caveat: a soft-wrapped input line leaves a stale fragment behind, since
 * clearLine only clears the row the cursor is on.)
 */
function writeBlock(text: string) {
  if (TTY) {
    readline.cursorTo(process.stderr, 0);
    readline.clearLine(process.stderr, 0);
  }
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
  if (TTY) rl?.prompt(true);
}

function log(message: string) {
  writeBlock(`${dim("[client]")} ${message}`);
}

function refreshPrompt() {
  if (!rl) return;
  const queued = queue.length > 0 ? `[${queue.length} queued] ` : "";
  const running = inFlight > 1 ? `[${inFlight} turns] ` : "";
  const busy = turnRunning() ? dim(`⋯ ${lastUpdateKind} `) : "";
  rl.setPrompt(`${busy}${running}${queued}› `);
  if (TTY) rl.prompt(true);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- wire log

/** A permissive view of the JSON-RPC union, purely for the summary line. */
type WireMessage = {
  id?: string | number | null;
  method?: string;
  params?: { update?: { sessionUpdate?: string } };
  result?: { stopReason?: string };
  error?: { code: number; message: string };
};

/** One-line summary: method (plus session update kind), or which reply this is. */
function describe(message: AnyMessage): string {
  const wire = message as WireMessage;
  const id = wire.id === undefined || wire.id === null ? "" : ` #${wire.id}`;
  if (wire.method !== undefined) {
    const kind = wire.params?.update?.sessionUpdate;
    return `${wire.method}${kind ? ` · ${kind}` : ""}${id}`;
  }
  if (wire.error !== undefined) {
    return `error${id} · ${wire.error.code} ${wire.error.message}`;
  }
  const stopReason = wire.result?.stopReason;
  return `result${id}${stopReason ? ` · ${stopReason}` : ""}`;
}

/**
 * Prints one JSON-RPC message. The SDK exposes no logging hook, so this is
 * called from a stream tap (see `tapStream`) that sits between the SDK and the
 * transport — what you see is exactly what is written to / read from the pipe.
 */
function logMessage(direction: "agent" | "user", message: AnyMessage) {
  const inbound = direction === "agent";
  const color = inbound ? "36" : "35";
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(3);
  const header = [
    dim(`+${elapsed}s`),
    paint(`1;${color}`, inbound ? "[agent]" : "[user] "),
    paint(color, inbound ? "◂" : "▸"),
    dim(describe(message)),
  ].join(" ");
  // The body is printed flush left and unadorned so that selecting it in the
  // terminal yields valid JSON you can paste straight into a tool.
  writeBlock(`${header}\n${JSON.stringify(message, null, 2)}`);
}

/**
 * Wraps a transport stream so every message is logged post-parse/pre-stringify.
 * A TransformStream per direction is the only complete interposition point: the
 * SDK reads inbound with a single reader and takes a fresh writer per outbound
 * message, and both survive being handed a transform.
 */
function tapStream(inner: Stream): Stream {
  const inbound = new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller) {
      logMessage("agent", message);
      controller.enqueue(message);
    },
  });
  const outbound = new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller) {
      logMessage("user", message);
      controller.enqueue(message);
    },
  });
  // The SDK never closes its writable, so this pipe only settles on failure —
  // typically the agent died and its stdin is gone. Teardown handles the rest;
  // without the catch this would be an unhandled rejection.
  outbound.readable.pipeTo(inner.writable).catch((err) => {
    if (!shuttingDown) log(`transport write failed: ${err}`);
  });
  return { readable: inner.readable.pipeThrough(inbound), writable: outbound.writable };
}

// ---------------------------------------------------------------- build

/** Runs the repo's tsc, sending its diagnostics to our stderr. */
async function build(sourceMaps: boolean) {
  const localTsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const useLocal = existsSync(localTsc);
  const args = sourceMaps ? ["--sourceMap"] : [];
  log(`building agent (tsc${sourceMaps ? " --sourceMap" : ""}) …`);

  const child = useLocal
    ? spawn(process.execPath, [localTsc, ...args], { cwd: repoRoot, stdio: ["ignore", 2, 2] })
    : spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsc", ...args], {
        cwd: repoRoot,
        stdio: ["ignore", 2, 2],
      });

  const [code] = (await once(child, "exit")) as [number | null];
  if (code !== 0) {
    log(`build failed (tsc exit ${code}) — fix the errors above, or pass --no-build`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- main

async function main() {
  if (BUILD) {
    await build(DEBUG_PORT !== undefined);
  } else if (!existsSync(AGENT_ENTRY)) {
    log(`${AGENT_ENTRY} not found — run \`npm run build\` first, or unset --no-build`);
    process.exit(1);
  }

  // An ACP client launches the agent as a subprocess and speaks JSON-RPC over
  // its stdin/stdout. Its stderr is piped rather than inherited so that agent
  // logs go through writeBlock() and don't corrupt the readline input line.
  const nodeArgs =
    DEBUG_PORT === undefined ? [AGENT_ENTRY] : [`--inspect-brk=${DEBUG_PORT}`, AGENT_ENTRY];
  const child = spawn(process.execPath, nodeArgs, {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  child.on("error", (err) => {
    log(`failed to spawn agent (${AGENT_ENTRY}): ${err}`);
    process.exit(1);
  });
  // A write racing the agent's exit surfaces as an unhandled 'error' event that
  // would take this client down with it.
  child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") log(`agent stdin error: ${err}`);
  });
  child.stdout?.on("error", () => {});
  process.stderr.on("error", () => {});

  pumpAgentStderr(child);

  child.on("exit", (code, signal) => {
    if (!shuttingDown) log(`agent exited (code ${code}, signal ${signal})`);
  });

  const stream = tapStream(
    ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    ),
  );

  const connection = acpClient({ name: "simple-client" })
    // The tap already prints every update; this handler exists so the prompt line
    // can show what the agent is currently doing.
    .onNotification(methods.client.session.update, (ctx) => {
      lastUpdateKind = ctx.params.update.sessionUpdate;
    })
    // Auto-approve, chosen by `kind` and never by a hard-coded optionId: for
    // ExitPlanMode this agent uses permission-*mode* names as option ids
    // (auto / acceptEdits / default / plan / bypassPermissions).
    .onRequest(methods.client.session.requestPermission, (ctx) => {
      const options = ctx.params.options;
      const option = options.find((o) => o.kind === "allow_once") ?? options[0];
      if (!option) return { outcome: { outcome: "cancelled" } };
      log(`auto-approving permission: ${option.name} (${option.kind}/${option.optionId})`);
      return { outcome: { outcome: "selected", optionId: option.optionId } };
    })
    // Minimal file-system stubs. This agent performs its own file I/O inside the
    // Claude Agent SDK subprocess and never calls these today.
    .onRequest(methods.client.fs.readTextFile, () => ({ content: "" }))
    .onRequest(methods.client.fs.writeTextFile, () => ({}))
    .connect(stream);

  const agent = connection.agent;

  // Signals are wired up *before* the first request. Under --inspect-brk the
  // wait below is unbounded, and a client that dies without running shutdown()
  // orphans a paused agent still holding the debug port.
  const onInterrupt = () => {
    if (turnRunning() && !cancelRequested) {
      cancelRequested = true;
      const dropped = queue.length;
      queue = [];
      // A notification, not a request: every turn in flight settles through its
      // own session/prompt response, normally with stopReason "cancelled".
      void agent.notify(methods.agent.session.cancel, { sessionId });
      log(`sent session/cancel${dropped > 0 ? `, dropped ${dropped} queued line(s)` : ""}`);
      refreshPrompt();
      return;
    }
    void shutdown(turnRunning() ? "^C while cancelling" : "^C");
  };
  // In terminal mode readline puts stdin in raw mode and owns ^C, so this only
  // ever fires for an explicit `kill -INT`; with piped stdin it is the ^C path.
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // 1. Initialize. Under --inspect-brk the agent is paused before it reads a
  //    single byte, so this request stays unanswered until a debugger attaches
  //    and resumes it. ACP has no request timeout, so waiting is safe; the
  //    interval below just keeps the terminal from looking dead.
  let nudge: NodeJS.Timeout | undefined;
  if (DEBUG_PORT !== undefined) {
    log(`agent is PAUSED before its first line (--inspect-brk=${DEBUG_PORT})`);
    log(`attach a debugger to port ${DEBUG_PORT} and resume it — breakpoints go in src/*.ts`);
    nudge = setInterval(
      () => log(`still waiting for a debugger on port ${DEBUG_PORT} … (Ctrl-C to give up)`),
      10_000,
    );
  }
  let init;
  try {
    init = await agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    });
  } finally {
    if (nudge) clearInterval(nudge);
  }
  agentReady = true;
  log(`connected to ${init.agentInfo?.name ?? "agent"} ${init.agentInfo?.version ?? ""}`.trim());

  // Steering is advertised at the TOP-LEVEL `_meta` of the initialize result —
  // a sibling of `agentCapabilities`, not nested inside it. Prompt queueing is
  // a Claude-specific capability flag and does live inside.
  const initMeta = init._meta as { steering?: { supported?: boolean } } | null | undefined;
  const steeringSupported = initMeta?.steering?.supported === true;
  const queueMeta = init.agentCapabilities?._meta as
    { claudeCode?: { promptQueueing?: boolean } } | null | undefined;
  log(
    `agent supports: steering=${steeringSupported} ` +
      `promptQueueing=${queueMeta?.claudeCode?.promptQueueing === true}`,
  );

  // 2. Open a session.
  let sessionId: string;
  try {
    const session = await agent.request(methods.agent.session.new, { cwd: CWD, mcpServers: [] });
    sessionId = session.sessionId;
  } catch (err) {
    log(`session/new failed: ${err}`);
    log("if this is an auth error, log in first: node dist/index.js --cli auth login");
    await shutdown("session/new failed", 1);
    return;
  }
  log(`session ${sessionId} in ${CWD}`);

  // 3. Turns. There are four ways to get a message to the agent, and the client
  //    can drive all of them (see `handleCommand`); plain text uses the first.
  //
  //      session/prompt      a new turn, or — for text typed mid-turn — one
  //                          buffered here and sent when the turn responds
  //      session/prompt      sent mid-turn anyway, so the *agent* queues it
  //        (!queue)          (it advertises `_meta.claudeCode.promptQueueing`)
  //      _session/steering   injected into the turn that is already running
  //        (!steer)
  //      session/cancel      abandon the running turn
  //        (!cancel, ^C)
  let draining = false;

  /** One `session/prompt` round-trip. Several may be in flight at once when
   *  `!queue` is used; the agent runs them in order. */
  async function sendPrompt(text: string) {
    inFlight += 1;
    cancelRequested = false;
    refreshPrompt();
    try {
      const result = await agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      log(`turn ended: ${result.stopReason}`);
    } catch (err) {
      // The error response itself was already printed by the tap; this is
      // the human-readable "your prompt did not run".
      log(`prompt failed: ${err}`);
      if (connection.signal.aborted) queue = [];
    } finally {
      inFlight -= 1;
      refreshPrompt();
      exitWhenIdle();
    }
  }

  /** Sends the buffered lines one turn at a time, oldest first. */
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0 && !shuttingDown) {
        await sendPrompt(queue.shift()!);
        if (connection.signal.aborted) break;
      }
    } finally {
      draining = false;
      refreshPrompt();
      exitWhenIdle();
    }
  }

  /** A piped stdin ends; exiting has to wait for the work already handed out. */
  function exitWhenIdle() {
    if (inputClosed && !draining && queue.length === 0 && inFlight === 0) {
      void shutdown("input closed, queue drained");
    }
  }

  /**
   * Client-side commands, prefixed with `!` so they cannot collide with the
   * agent's own slash commands (`/compact` and friends, which are just prompt
   * text as far as this client is concerned). `!!` escapes a literal `!`.
   */
  function handleCommand(line: string) {
    const word = line.split(/\s+/)[0];
    const text = line.slice(word.length).trim();
    switch (word) {
      case "!steer":
        if (text.length === 0) {
          log("usage: !steer <message> — injects into the turn that is running");
          break;
        }
        if (!steeringSupported) log("agent did not advertise steering; trying anyway");
        void steer(text);
        break;
      case "!queue":
        if (text.length === 0) {
          log("usage: !queue <message> — sends session/prompt now, agent queues it");
          break;
        }
        void sendPrompt(text);
        break;
      case "!cancel":
        if (!turnRunning()) {
          log("nothing to cancel");
          break;
        }
        onInterrupt();
        break;
      case "!help":
        for (const entry of HELP) log(entry);
        break;
      default:
        log(`unknown command ${word} — try !help`);
        break;
    }
    refreshPrompt();
  }

  /** `_session/steering`: deliver a message to the turn already in progress. */
  async function steer(text: string) {
    const params: SteeringRequest = { sessionId, prompt: [{ type: "text", text }] };
    try {
      const result = await agent.request<SteeringResponse>(STEERING_METHOD, params);
      // Either way the steered message's own output arrives as `session/update`
      // notifications, not in this response. When it was injected, that output
      // lands inside the turn we steered — whose `stopReason` waits for it.
      log(
        result.outcome === "injected"
          ? "steer outcome: injected into the running turn"
          : "steer outcome: startedNewTurn — the turn had already finished, so the " +
              "agent began a new one that no session/prompt of ours is tracking",
      );
    } catch (err) {
      log(`steer rejected: ${err}`);
    }
  }

  let inputClosed = false;
  let steerHinted = false;

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: TTY,
    crlfDelay: Infinity,
    historySize: 200,
  });

  rl.on("line", (raw) => {
    const line = raw.trim();
    if (line.length === 0 || shuttingDown) {
      refreshPrompt();
      return;
    }
    if (line.startsWith("!") && !line.startsWith("!!")) {
      handleCommand(line);
      return;
    }
    // "!!steer …" is how you send text that begins with the command prefix.
    queue.push(line.startsWith("!!") ? line.slice(1) : line);
    if (turnRunning()) {
      log(`buffered — will send when this turn ends (${queue.length} queued)`);
      if (!steerHinted) {
        steerHinted = true;
        log("…or use !steer <text> to inject into the running turn instead");
      }
    }
    refreshPrompt();
    void drain();
  });

  rl.on("SIGINT", onInterrupt);

  rl.on("close", () => {
    inputClosed = true;
    exitWhenIdle();
  });

  void connection.closed.then(() => {
    if (!shuttingDown) void shutdown("connection closed");
  });

  for (const entry of HELP) log(entry);
  log("Enter sends, Ctrl-C cancels a turn, Ctrl-D exits");
  refreshPrompt();

  /**
   * Order matters here. The agent exits cleanly on stdin EOF (src/index.ts wires
   * `connection.closed` to `agent.dispose()`), whereas killing it skips disposal
   * and can orphan the Claude Agent SDK subprocess. Closing our connection first
   * would cancel the reader on the agent's stdout and make it die of EPIPE
   * mid-write, so that comes last.
   */
  async function shutdown(reason: string, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${reason})`);
    queue = [];
    rl?.removeAllListeners("close");
    rl?.close();

    if (turnRunning()) {
      if (!cancelRequested) {
        try {
          await agent.notify(methods.agent.session.cancel, { sessionId });
        } catch {
          // The connection may already be gone; teardown continues regardless.
        }
      }
      const deadline = Date.now() + CANCEL_TIMEOUT_MS;
      while (turnRunning() && Date.now() < deadline) await delay(50);
    }

    child.stdin?.end();
    const exited = await Promise.race([
      once(child, "exit").then(() => true),
      delay(agentReady ? EXIT_TIMEOUT_MS : 250).then(() => false),
    ]);
    if (!exited) {
      log("agent did not exit on stdin EOF; sending SIGTERM");
      child.kill("SIGTERM");
      const stopped = await Promise.race([
        once(child, "exit").then(() => true),
        delay(2_000).then(() => false),
      ]);
      if (!stopped) child.kill("SIGKILL");
    }

    connection.close();
    process.exit(exitCode);
  }
}

/** Streams the agent's stderr through writeBlock, flagging inspector messages. */
function pumpAgentStderr(child: ReturnType<typeof spawn>) {
  let buffered = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length === 0) continue;
      if (line.includes("Debugger listening on")) {
        writeBlock(paint("1;33", `[agent] ${line.trim()}`));
      } else if (line.includes("address already in use")) {
        writeBlock(paint("1;31", `[agent] ${line.trim()}`));
        log("that inspector port is taken — pass a different --debug-port");
      } else {
        writeBlock(dim(`[agent:stderr] ${line}`));
      }
    }
  });
}

main().catch((err) => {
  // Tearing down rejects whatever request main() is awaiting; that is the
  // teardown finishing its job, not a failure, and shutdown() owns the exit.
  if (shuttingDown) return;
  log(`fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
