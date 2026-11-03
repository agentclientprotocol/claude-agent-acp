/**
 * Idle compaction wired into the agent (see `idle-compaction.ts` for the
 * timer's own rules): a scripted Claude Code answers each prompt it receives,
 * and fake timers move the clock.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AcpClient, ClaudeAcpAgent } from "../acp-agent.js";
import { initializeClient } from "./helpers.js";

const execFileSpy = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: execFileSpy };
});

/** What the mocked Claude Agent SDK answers. Reset before each test. */
const sdk = vi.hoisted(() => ({
  run: async function* (
    _prompts: AsyncIterable<SDKUserMessage>,
    _options: Options,
  ): AsyncGenerator<Record<string, unknown>> {},
  models: [
    { value: "claude-sonnet-4-6", displayName: "Claude Sonnet", description: "Fast" },
    { value: "claude-opus-4-6", displayName: "Claude Opus", description: "Smart" },
  ] as Array<Record<string, unknown>>,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  const { makeMockQuery } = await import("./helpers.js");
  return {
    ...actual,
    query: ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const messages = sdk.run(prompt, options);
      const controls = makeMockQuery({
        [Symbol.asyncIterator]: () => messages,
        initializationResult: async () => ({ models: sdk.models }),
      });
      return Object.assign(messages, controls);
    },
    getSessionMessages: vi.fn(async () => []),
  };
});

vi.mock("../tools.js", async () => ({
  ...(await vi.importActual<typeof import("../tools.js")>("../tools.js")),
  registerHookCallback: vi.fn(),
}));

const MINUTE_MS = 60_000;
const AIR_CLIENT_CAPABILITIES = {
  _meta: { jetbrains: { air: { version: 1, capabilities: [] as string[] } } },
};

/** As the CLI reports a request whose prompt cache lives one hour: 250k tokens of context. */
const LARGE_ONE_HOUR_USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 250_000,
  cache_creation: { ephemeral_1h_input_tokens: 250_000, ephemeral_5m_input_tokens: 0 },
};

let tempDir: string;
let cwd: string;

beforeEach(async () => {
  execFileSpy.mockImplementation((...invocation: unknown[]) => {
    const callback = invocation[invocation.length - 1] as (...a: unknown[]) => void;
    callback(null, { stdout: "", stderr: "" });
  });
  tempDir = await mkdtemp(path.join(os.tmpdir(), "idle-compaction-"));
  cwd = await mkdtemp(path.join(tempDir, "project-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(tempDir, "claude"));
  vi.stubEnv("CLAUDE_AGENT_ACP_IDLE_COMPACT_DELAY_MS", "");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(async () => {
  vi.useRealTimers();
  execFileSpy.mockReset();
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 10 });
});

function assistant(options: Options, usage: Record<string, unknown>, parent: string | null = null) {
  return {
    type: "assistant",
    message: {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Done." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    },
    parent_tool_use_id: parent,
    uuid: randomUUID(),
    session_id: options.sessionId,
  };
}

function result(options: Options) {
  return {
    type: "result",
    subtype: "success",
    stop_reason: "end_turn",
    is_error: false,
    result: "",
    errors: [],
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: options.sessionId,
  };
}

function system(options: Options, subtype: string, fields: Record<string, unknown>) {
  return { type: "system", subtype, ...fields, uuid: randomUUID(), session_id: options.sessionId };
}

/**
 * Claude Code takes in each prompt in order. A prompt answers with one
 * main-thread request (with `usage`, after `during`) and goes idle; `/compact`
 * answers with a compaction, as the CLI reports a manual one, and goes idle.
 * `received` lists the texts that Claude Code took in.
 */
function scriptClaudeCode({
  usage = LARGE_ONE_HOUR_USAGE,
  during,
  compactResult = "success",
}: {
  usage?: Record<string, unknown>;
  during?: (options: Options) => AsyncGenerator<any>;
  compactResult?: "success" | "failed";
} = {}) {
  const received: string[] = [];
  /** Resolves each time the consumer has handled an `idle` message. */
  let idleHandled = Promise.withResolvers<void>();
  sdk.run = async function* (prompts, options) {
    const input = prompts[Symbol.asyncIterator]();
    for (;;) {
      const { value, done } = await input.next();
      if (done) return;
      const text = (value.message.content as Array<{ text: string }>)[0].text;
      received.push(text);
      if (text === "/compact") {
        yield system(options, "status", { status: "compacting" });
        if (compactResult === "success") {
          yield system(options, "compact_boundary", {
            compact_metadata: { trigger: "manual", pre_tokens: 250_000, post_tokens: 12_000 },
          });
        }
        yield system(options, "status", {
          status: null,
          compact_result: compactResult,
          ...(compactResult === "failed" ? { compact_error: "too short" } : {}),
        });
      } else if (text === "/clear") {
        yield {
          type: "user",
          message: value.message,
          parent_tool_use_id: null,
          uuid: value.uuid,
          session_id: options.sessionId,
          isReplay: true,
        };
        yield {
          type: "conversation_reset",
          new_conversation_id: randomUUID(),
          uuid: randomUUID(),
          session_id: options.sessionId,
        };
      } else {
        yield {
          type: "user",
          message: value.message,
          parent_tool_use_id: null,
          uuid: value.uuid,
          session_id: options.sessionId,
          isReplay: true,
        };
        if (during) yield* during(options);
        yield assistant(options, usage);
      }
      yield result(options);
      yield system(options, "session_state_changed", { state: "idle" });
      idleHandled.resolve();
    }
  };
  return {
    received,
    /** Waits until the consumer has handled an `idle`, then re-arms for the next. */
    async untilIdle() {
      await idleHandled.promise;
      idleHandled = Promise.withResolvers();
    },
  };
}

async function connect(clientCapabilities: Record<string, unknown> = {}) {
  vi.resetModules();
  const { ClaudeAcpAgent } = await import("../acp-agent.js");
  const updates: Array<{ update: Record<string, any> }> = [];
  const client = {
    sessionUpdate: async (notification: { update: Record<string, any> }) => {
      updates.push(notification);
    },
  } as unknown as AcpClient;
  const logs: string[] = [];
  const agent: ClaudeAcpAgent = new ClaudeAcpAgent(client, {
    log: (message: string) => logs.push(message),
    error: () => {},
  });
  await initializeClient(agent, clientCapabilities);
  const session = await agent.newSession({ cwd, mcpServers: [] });
  return { agent, sessionId: session.sessionId, updates, logs };
}

async function promptHi(agent: ClaudeAcpAgent, id: string) {
  await agent.prompt({ sessionId: id, prompt: [{ type: "text", text: "hi" }] });
}

describe("idle compaction in the agent", () => {
  /** Idle after a large 1h request: `/compact` goes into the input at 54 minutes, not before. */
  it("compacts an idle session with a large context shortly before its one-hour cache expires, with no client prompt", async () => {
    const claude = scriptClaudeCode();
    const { agent, sessionId } = await connect();

    await promptHi(agent, sessionId);
    await claude.untilIdle();
    await vi.advanceTimersByTimeAsync(54 * MINUTE_MS - 1);
    expect(claude.received).toEqual(["hi"]);
    await vi.advanceTimersByTimeAsync(1);

    expect(claude.received).toEqual(["hi", "/compact"]);
    await agent.dispose();
  });

  /** A client prompt 30 minutes in moves the deadline, so 54 minutes after the first request passes quietly. */
  it("does not compact when a client prompt comes during the wait", async () => {
    const claude = scriptClaudeCode();
    const { agent, sessionId } = await connect();

    await promptHi(agent, sessionId);
    await claude.untilIdle();
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    await promptHi(agent, sessionId);
    await claude.untilIdle();
    // The second request moved the deadline: 54 minutes after the first has passed.
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);

    expect(claude.received).toEqual(["hi", "hi"]);
    await agent.dispose();
  });

  /** Only a subagent's request reports 1h, so the main thread has no TTL and nothing arms. */
  it("does not take a subagent's request for the session's cache TTL", async () => {
    const claude = scriptClaudeCode({
      // The main thread's large request wrote no cache; only the subagent's request reports 1h.
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 250_000,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      },
      during: async function* (options) {
        yield assistant(options, LARGE_ONE_HOUR_USAGE, "toolu_agent");
      },
    });
    const { agent, sessionId } = await connect();

    await promptHi(agent, sessionId);
    await claude.untilIdle();
    await vi.advanceTimersByTimeAsync(2 * 60 * MINUTE_MS);

    expect(claude.received).toEqual(["hi"]);
    await agent.dispose();
  });

  /** Switching the model during the wait drops the timer. */
  it("does not compact when the model changes during the wait", async () => {
    const claude = scriptClaudeCode();
    const { agent, sessionId } = await connect();

    await promptHi(agent, sessionId);
    await claude.untilIdle();
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
    await agent.setSessionConfigOption({ sessionId, configId: "model", value: "claude-opus-4-6" });
    await vi.advanceTimersByTimeAsync(2 * 60 * MINUTE_MS);

    expect(claude.received).toEqual(["hi"]);
    await agent.dispose();
  });

  /** Closing the session during the wait drops the timer. */
  it("does not compact once the session is closed", async () => {
    const claude = scriptClaudeCode();
    const { agent, sessionId } = await connect();

    await promptHi(agent, sessionId);
    await claude.untilIdle();
    await agent.closeSession({ sessionId });
    await vi.advanceTimersByTimeAsync(2 * 60 * MINUTE_MS);

    expect(claude.received).toEqual(["hi"]);
  });

  /** A failed `/compact` is not repeated while no new request arrives. */
  it("does not compact again for the same request after a compaction failed", async () => {
    const claude = scriptClaudeCode({ compactResult: "failed" });
    const { agent, sessionId, logs } = await connect();

    await promptHi(agent, sessionId);
    await claude.untilIdle();
    await vi.advanceTimersByTimeAsync(54 * MINUTE_MS);
    await claude.untilIdle();
    await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE_MS);

    expect(claude.received).toEqual(["hi", "/compact"]);
    expect(logs).toContain("[idle-compaction] compaction failed: too short");
    await agent.dispose();
  });

  /** A `/clear` during the wait forgets the request, so the next idle arms nothing. */
  it("does not compact for a request that a /clear dropped", async () => {
    const claude = scriptClaudeCode();
    const { agent, sessionId } = await connect();

    await promptHi(agent, sessionId);
    await claude.untilIdle();
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "/clear" }] });
    await claude.untilIdle();
    await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE_MS);

    expect(claude.received).toEqual(["hi", "/clear"]);
    await agent.dispose();
  });

  /** The steered turn settles at the idle, so only an `onIdle` after that settle can arm. */
  it("arms after the idle that settles a steered turn", async () => {
    const received: string[] = [];
    const release = Promise.withResolvers<void>();
    const idleHandled = Promise.withResolvers<void>();
    sdk.run = async function* (prompts, options) {
      const input = prompts[Symbol.asyncIterator]();
      const echo = (value: SDKUserMessage) => ({
        type: "user",
        message: value.message,
        parent_tool_use_id: null,
        uuid: value.uuid,
        session_id: options.sessionId,
        isReplay: true,
      });
      const { value: first } = await input.next();
      received.push((first.message.content as Array<{ text: string }>)[0].text);
      yield echo(first);
      await release.promise;
      yield assistant(options, LARGE_ONE_HOUR_USAGE);
      yield result(options);
      const { value: steer } = await input.next();
      received.push((steer.message.content as Array<{ text: string }>)[0].text);
      yield echo(steer);
      yield assistant(options, LARGE_ONE_HOUR_USAGE);
      yield result(options);
      yield system(options, "session_state_changed", { state: "idle" });
      idleHandled.resolve();
      for (;;) {
        const { value, done } = await input.next();
        if (done) return;
        received.push((value.message.content as Array<{ text: string }>)[0].text);
      }
    };
    const { agent, sessionId } = await connect();

    const prompted = promptHi(agent, sessionId);
    await vi.advanceTimersByTimeAsync(0);
    await agent.steer({ sessionId, prompt: [{ type: "text", text: "also X" }] });
    release.resolve();
    await prompted;
    await idleHandled.promise;
    await vi.advanceTimersByTimeAsync(54 * MINUTE_MS);

    expect(received).toEqual(["hi", "also X", "/compact"]);
    await agent.dispose();
  });

  /** AIR gets `trigger: "idle"` for the adapter's compaction and `"manual"` for a client's `/compact`. */
  it.each([
    { name: "an idle compaction", prompt: "hi", expected: "idle" },
    { name: "a manual /compact", prompt: "/compact", expected: "manual" },
  ])("tells AIR that $name has trigger $expected", async ({ prompt, expected }) => {
    const claude = scriptClaudeCode();
    const { agent, sessionId, updates } = await connect(AIR_CLIENT_CAPABILITIES);

    if (expected === "idle") {
      await promptHi(agent, sessionId);
      await claude.untilIdle();
      await vi.advanceTimersByTimeAsync(54 * MINUTE_MS);
      await vi.waitFor(() => expect(compactionTriggers(updates)).toHaveLength(1));
    } else {
      await agent.prompt({ sessionId, prompt: [{ type: "text", text: prompt }] });
    }

    expect(compactionTriggers(updates)).toEqual([expected]);
    await agent.dispose();
  });
});

/** The `trigger` of each compaction report that the client received. */
function compactionTriggers(updates: Array<{ update: Record<string, any> }>) {
  return updates.flatMap(({ update }) => {
    const trigger = update._meta?.jetbrains?.air?.contextCompaction?.trigger;
    return trigger ? [trigger] : [];
  });
}
