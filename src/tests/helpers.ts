/**
 * Shared test doubles. Deliberately vitest-free so `vi.mock` async factories
 * can `await import("./helpers.js")` without ordering hazards; tests supply
 * their own vi.fn spies via `overrides`.
 */

import type { ClientCapabilities, InitializeRequest } from "@agentclientprotocol/sdk";

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
    getContextUsage: async () => DEFAULT_CONTEXT_USAGE,
    close: () => {},
    interrupt: async () => undefined,
    [Symbol.asyncIterator]: async function* () {},
    ...overrides,
  };
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
