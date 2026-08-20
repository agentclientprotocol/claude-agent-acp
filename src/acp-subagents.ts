import type {
  ClientCapabilities,
  SessionCapabilities,
  SessionNotification,
} from "@agentclientprotocol/sdk";

/**
 * Temporary typed surface for agentclientprotocol/agent-client-protocol#1992.
 *
 * The wire contract is already defined by the ACP draft, but the published
 * TypeScript SDK does not contain it yet. Keep the compatibility boundary in
 * this file so it can be replaced by SDK exports without changing lifecycle
 * code when the draft ships.
 */
export type SubagentSessionCapabilities = {
  cancel?: boolean;
  close?: boolean;
  _meta?: Record<string, unknown> | null;
};

export type SubagentSpawnedUpdate = {
  sessionUpdate: "subagent_spawned";
  subagentSessionId: string;
  name: string;
  task: string;
  capabilities: SubagentSessionCapabilities;
  _meta?: Record<string, unknown> | null;
};

export type SubagentState = "completed" | "failed" | "cancelled";

export type SubagentStateUpdate = {
  sessionUpdate: "subagent_state_update";
  subagentSessionId: string;
  state: SubagentState;
  _meta?: Record<string, unknown> | null;
};

export type AcpSessionUpdate =
  SessionNotification["update"] | SubagentSpawnedUpdate | SubagentStateUpdate;

export type AcpSessionNotification = Omit<SessionNotification, "update"> & {
  update: AcpSessionUpdate;
};

export type SubagentAwareSessionCapabilities = SessionCapabilities & {
  subagents?: Record<string, never>;
};

export function clientSupportsSubagents(capabilities?: ClientCapabilities | null): boolean {
  const subagents = (
    capabilities as (ClientCapabilities & { subagents?: unknown }) | null | undefined
  )?.subagents;
  return typeof subagents === "object" && subagents !== null && !Array.isArray(subagents);
}

/** The only cast needed until the TypeScript SDK publishes PR #1992. */
export function asSdkSessionNotification(
  notification: AcpSessionNotification,
): SessionNotification {
  return notification as SessionNotification;
}
