/**
 * Shared test doubles. Deliberately vitest-free so `vi.mock` async factories
 * can `await import("./helpers.js")` without ordering hazards; tests supply
 * their own vi.fn spies via `overrides`.
 */

import {
  RequestError,
  type ClientCapabilities,
  type InitializeRequest,
} from "@agentclientprotocol/sdk/unstable";

/** The context-usage report the base mock query returns. `rawMaxTokens`
 *  matches the agent's DEFAULT_CONTEXT_WINDOW so window-related assertions
 *  don't shift in tests that don't care about context usage. */
export const DEFAULT_CONTEXT_USAGE = { totalTokens: 0, rawMaxTokens: 200000 };

/**
 * Base stub for the SDK `query()` return object, covering the surface
 * ClaudeAcpAgent touches unconditionally at session creation. Tests pass
 * `overrides` for the parts they assert on (spies, custom models, rejecting
 * getContextUsage, …).
 *
 * When the agent starts calling a new SDK method on every session, add it
 * here once — the getContextUsage adoption required hand-editing ~10 inline
 * mocks across five files, and any missed copy didn't fail: it silently
 * rerouted that test through the error-fallback branch and re-polluted test
 * output.
 */
export function makeMockQuery(overrides: Record<string, unknown> = {}) {
  return {
    initializationResult: async () => ({ models: [] }),
    setModel: async () => {},
    setPermissionMode: async () => {},
    supportedCommands: async () => [],
    mcpServerStatus: async () => [],
    setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    getContextUsage: async () => DEFAULT_CONTEXT_USAGE,
    // No ultracode fields: session creation falls back to settings and the
    // model's effort levels, as with a CLI that does not report them.
    getSettings: async () => ({ applied: {} }),
    close: () => {},
    interrupt: async () => undefined,
    [Symbol.asyncIterator]: async function* () {},
    ...overrides,
  };
}

/**
 * The error `initializationResult()` rejects with when Claude Code refuses to
 * start with `CLAUDE_CODE_STARTUP_FAILURE_RESULTS` set, as SDK 0.3.316 builds
 * it from the CLI's error result (same message prefix and fields).
 */
export function startupFailure(reason: string, cliMessage: string): Error {
  return Object.assign(new Error(`Claude Code returned an error result: ${cliMessage}`), {
    telemetryMessage: "Claude Code returned an error result",
    errorClass: "error_result",
    startupFailureReason: reason,
  });
}

/**
 * Declares the client capabilities through `initialize`, as a real client
 * does. The agent reads its capability choices only there.
 */
export async function initializeClient(
  agent: { initialize(request: InitializeRequest): Promise<unknown> },
  clientCapabilities: ClientCapabilities,
): Promise<void> {
  await agent.initialize({ protocolVersion: 1, clientCapabilities });
}

/**
 * A request to a client that never answers it, as the SDK connection returns
 * it with `stopWaitingOnCancel`: it rejects with `-32800` once `signal`
 * aborts. The real connection also sends `$/cancel_request` then.
 */
export function heldRequest<T>(_params?: unknown, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    const cancel = () => reject(RequestError.requestCancelled(signal?.reason));
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
  });
}
