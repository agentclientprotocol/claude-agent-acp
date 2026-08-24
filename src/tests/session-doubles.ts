/**
 * Shared session-level test doubles for the agent suites.
 *
 * Distinct from `helpers.ts`, which is deliberately vitest-free so `vi.mock`
 * factories can `await import` it; these need `vi.fn` spies, so they live apart.
 */

import { vi } from "vitest";
import { randomUUID } from "crypto";
import { SessionTitles } from "../session-titles.js";

/** Stand-in agent for a `SessionTitles` whose test doesn't care about titles:
 *  swallows the publish and the log, and never matches the identity check. */
function inertTitleAgent() {
  return {
    client: { sessionUpdate: async () => {} },
    logger: { error: () => {} },
    sessions: {},
  } as any;
}

/** Build the replayed `user` message the SDK echoes back for a pushed prompt,
 *  used by mock generators to promote a turn to active. */
export function userEcho(u: any) {
  return {
    type: "user",
    message: u.message,
    parent_tool_use_id: null,
    uuid: u.uuid,
    session_id: "test-session",
    isReplay: true,
  };
}

/** Wrap a mock async generator with the `Query` methods the agent calls outside
 *  of iteration — `close()` (teardown/closeQueryStream), `interrupt()` (cancel),
 *  and `setModel()` — so a bare generator doesn't trip "x is not a function". */
export function wrapQuery(generator: AsyncGenerator<any>) {
  return Object.assign(generator, {
    interrupt: vi.fn(async () => {}),
    close: vi.fn(),
    setModel: vi.fn(async () => {}),
  }) as any;
}

/** The common `Session` mock fields, with per-test overrides spread on top.
 *  Centralizes the boilerplate (usage accumulator, caches, controllers) so a new
 *  Session field is added in one place rather than every inline literal.
 *
 *  Pass `agent` when the test exercises titles — `SessionTitles` publishes and
 *  logs through it, and compares `agent.sessions[sessionId]` to spot a session
 *  replaced mid-generation. */
export function mockSessionState(
  overrides: Record<string, any> = {},
  agent?: any,
  sessionId = "test-session",
) {
  return {
    cancelled: false,
    cwd: "/test",
    sessionFingerprint: JSON.stringify({ cwd: "/test", mcpServers: [] }),
    titles: new SessionTitles(agent ?? inertTitleAgent(), sessionId),
    modes: { currentModeId: "default", availableModes: [] },
    models: { currentModelId: "default", availableModels: [] },
    modelInfos: [],
    settingsManager: { dispose: vi.fn() },
    accumulatedUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    },
    accumulatedModelUsage: {},
    lastModelUsageReading: {},
    configOptions: [],
    agents: [],
    currentAgent: "default",
    abortController: new AbortController(),
    emitRawSDKMessages: false,
    forwardSubagentText: false,
    contextWindowSize: 200000,
    contextWindowAuthoritative: false,
    providerCacheKey: "default",
    taskState: new Map(),
    toolUseCache: {},
    emittedToolCalls: new Set(),
    liveBackgroundTasks: new Map(),
    emittedAssistantText: false,
    owedTrailingIdles: 0,
    messageIdToUuid: new Map(),
    sessionFailureState: { epoch: randomUUID(), revisions: new Map(), active: new Map() },
    fileChangeReportRequestIds: new Set(),
    ...overrides,
  } as any;
}

/** One successful turn: echo the pushed prompt, emit a result, go idle. Shared
 *  by suites that only need a session to reach turn-end. */
export function successfulResultMessage(overrides: Record<string, any> = {}) {
  return {
    type: "result" as const,
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
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: "test-session",
    ...overrides,
  };
}
