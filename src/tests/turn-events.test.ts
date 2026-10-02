/**
 * The turn lifecycle that the agent reports through `TurnEvents`, which each
 * ACP version maps to its own messages. A scripted SDK query stands in for
 * Claude Code: it echoes each prompt, then runs the turn's script.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { AcpClient, ClaudeAcpAgent } from "../acp-agent.js";
import type { TurnEvents } from "../turn-events.js";
import { DEFAULT_CONTEXT_USAGE } from "./helpers.js";
import { randomUUID } from "node:crypto";

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({
  ...(await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  )),
  query: mockQuery,
}));

// The agent reads the CLI's auth status on each prompt; keep it off the real CLI.
vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  execFile: (...args: unknown[]) =>
    (args[args.length - 1] as (error: Error) => void)(new Error("no CLI in tests")),
}));

vi.mock("../tools.js", async () => ({
  ...(await vi.importActual<typeof import("../tools.js")>("../tools.js")),
  registerHookCallback: vi.fn(),
}));

type QueryOptions = {
  sessionId?: string;
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    extra: Record<string, unknown>,
  ) => Promise<unknown>;
};

/** The SDK side of one turn, after the echo of its prompt. */
type TurnScript = (options: QueryOptions) => AsyncGenerator<Record<string, unknown>>;

function result(sessionId: string) {
  return {
    type: "result",
    subtype: "success",
    stop_reason: "end_turn",
    is_error: false,
    result: "done",
    errors: [],
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

/** Scripts the query of the next session: each prompt runs the next turn script. */
function scriptTurns(turns: TurnScript[], end: "stay open" | "end stream" = "stay open") {
  const promptUuids: string[] = [];
  mockQuery.mockImplementation(
    ({ prompt, options }: { prompt: AsyncIterable<any>; options: QueryOptions }) => {
      const sessionId = options.sessionId ?? "session";
      async function* run() {
        const input = prompt[Symbol.asyncIterator]();
        for (const turn of turns) {
          const { value, done } = await input.next();
          if (done) return;
          promptUuids.push(value.uuid);
          yield {
            type: "user",
            message: value.message,
            parent_tool_use_id: null,
            uuid: value.uuid,
            session_id: sessionId,
            isReplay: true,
          };
          for await (const message of turn(options)) yield message;
        }
        if (end === "stay open") await input.next();
      }
      return Object.assign(run(), {
        initializationResult: async () => ({
          models: [{ value: "default", displayName: "Default", description: "" }],
        }),
        setModel: async () => {},
        setPermissionMode: async () => {},
        supportedCommands: async () => [],
        mcpServerStatus: async () => [],
        getContextUsage: async () => DEFAULT_CONTEXT_USAGE,
        close: () => {},
        interrupt: async () => {},
        stopTask: async () => {},
      });
    },
  );
  return promptUuids;
}

/** Records the events of one turn as readable strings. */
function recordEvents() {
  const log: string[] = [];
  const done = Promise.withResolvers<void>();
  const events: TurnEvents = {
    inserted: (messageId) => log.push(`inserted ${messageId}`),
    awaitingUser: () => log.push("awaitingUser"),
    resumed: () => log.push("resumed"),
    ended: (outcome) => {
      log.push(`ended ${outcome.stopReason}`);
      done.resolve();
    },
    failed: (error) => {
      log.push(`failed ${error instanceof Error ? error.message : String(error)}`);
      done.resolve();
    },
  };
  return { log, events, done: done.promise };
}

describe("turn events", () => {
  let agent: ClaudeAcpAgent;
  let permissionRequests: RequestPermissionRequest[];

  beforeEach(async () => {
    vi.resetModules();
    permissionRequests = [];
    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    agent = new ClaudeAcpAgent({
      sessionUpdate: async () => {},
      extNotification: async () => {},
      requestPermission: async (request: RequestPermissionRequest) => {
        permissionRequests.push(request);
        await new Promise((resolve) => setTimeout(resolve, 1));
        const allow = request.options.find((option) => option.kind === "allow_once");
        return { outcome: { outcome: "selected", optionId: allow!.optionId } };
      },
    } as unknown as AcpClient);
  });

  afterEach(async () => {
    await agent.dispose();
  });

  async function newSession() {
    const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    return sessionId;
  }

  const prompt = (sessionId: string, text: string) => ({
    sessionId,
    prompt: [{ type: "text" as const, text }],
  });

  it("reports a turn as inserted under the uuid of its user message, then ended", async () => {
    const promptUuids = scriptTurns([
      async function* (options) {
        yield result(options.sessionId!);
      },
    ]);
    const sessionId = await newSession();
    const turn = recordEvents();

    await agent.startTurn(prompt(sessionId, "hello"), turn.events);
    await turn.done;

    expect(turn.log).toEqual([`inserted ${promptUuids[0]}`, "ended end_turn"]);
  });

  it("reports waiting on a permission request, then resuming", async () => {
    scriptTurns([
      async function* (options) {
        await options.canUseTool(
          "Bash",
          { command: "ls" },
          { signal: new AbortController().signal, suggestions: [], toolUseID: "toolu_ls" },
        );
        yield {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_ls", content: "README.md" }],
          },
          parent_tool_use_id: null,
          uuid: randomUUID(),
          session_id: options.sessionId!,
        };
        yield result(options.sessionId!);
      },
    ]);
    const sessionId = await newSession();
    const turn = recordEvents();

    await agent.startTurn(prompt(sessionId, "list files"), turn.events);
    await turn.done;

    expect(permissionRequests).toHaveLength(1);
    expect(turn.log.slice(1)).toEqual(["awaitingUser", "resumed", "ended end_turn"]);
  });

  it("ends a queued turn that is cancelled before it is inserted, without inserting it", async () => {
    const release = Promise.withResolvers<void>();
    scriptTurns([
      async function* (options) {
        // Claude Code is busy with the first prompt when the cancel arrives.
        yield {
          type: "assistant",
          message: {
            id: "msg_working",
            type: "message",
            role: "assistant",
            model: "default",
            content: [{ type: "text", text: "Working on it" }],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          parent_tool_use_id: null,
          uuid: randomUUID(),
          session_id: options.sessionId!,
        };
        await release.promise;
      },
    ]);
    agent.forceCancelGraceMs = 10;
    const sessionId = await newSession();
    const first = recordEvents();
    const queued = recordEvents();

    await agent.startTurn(prompt(sessionId, "first"), first.events);
    await vi.waitFor(() => expect(first.log).toHaveLength(1));
    await agent.startTurn(prompt(sessionId, "second"), queued.events);
    await agent.cancel({ sessionId });
    await Promise.all([first.done, queued.done]);
    release.resolve();

    expect(first.log).toEqual([expect.stringMatching(/^inserted /), "ended cancelled"]);
    expect(queued.log).toEqual(["ended cancelled"]);
  });

  it("fails a queued turn without inserting it when the query ends", async () => {
    scriptTurns(
      [
        async function* (options) {
          yield result(options.sessionId!);
        },
      ],
      "end stream",
    );
    const sessionId = await newSession();
    const first = recordEvents();
    const queued = recordEvents();

    await agent.startTurn(prompt(sessionId, "first"), first.events);
    await agent.startTurn(prompt(sessionId, "second"), queued.events);
    await Promise.all([first.done, queued.done]);

    expect(first.log).toEqual([expect.stringMatching(/^inserted /), "ended end_turn"]);
    expect(queued.log).toEqual([expect.stringMatching(/^failed /)]);
  });

  it("rejects a prompt that it refuses before starting a turn, and reports nothing", async () => {
    const turn = recordEvents();

    await expect(agent.startTurn(prompt("no-such-session", "hello"), turn.events)).rejects.toThrow(
      "Session not found",
    );

    expect(turn.log).toEqual([]);
  });
});
