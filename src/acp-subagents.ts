import type {
  ClientCapabilities,
  SessionCapabilities,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  AIR_NATIVE_SUBAGENT_SESSIONS_CAPABILITY,
  clientSupportsAirCapability,
} from "./air-extension.js";

export { AIR_NATIVE_SUBAGENT_SESSIONS_CAPABILITY } from "./air-extension.js";

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
  description: string;
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

export type AsyncTaskState = "running" | "paused" | "completed" | "failed" | "stopped";

export type AsyncTaskSpawnedUpdate = {
  sessionUpdate: "async_task_spawned";
  asyncTaskId: string;
  name: string;
  taskType: string;
  description: string;
  showInTranscript: boolean;
  outputFilePath?: string;
  toolCallId?: string;
  _meta?: Record<string, unknown> | null;
};

export type AsyncTaskProgressUpdate = {
  sessionUpdate: "async_task_progress";
  asyncTaskId: string;
  description?: string;
  summary?: string;
  lastToolName?: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
  _meta?: Record<string, unknown> | null;
};

export type AsyncTaskStateUpdate = {
  sessionUpdate: "async_task_state_update";
  asyncTaskId: string;
  state: AsyncTaskState;
  summary?: string;
  _meta?: Record<string, unknown> | null;
};

export type AcpSessionUpdate =
  | SessionNotification["update"]
  | SubagentSpawnedUpdate
  | SubagentStateUpdate
  | AsyncTaskSpawnedUpdate
  | AsyncTaskProgressUpdate
  | AsyncTaskStateUpdate;

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
  if (typeof subagents === "object" && subagents !== null && !Array.isArray(subagents)) {
    return true;
  }

  return clientSupportsAirCapability(capabilities, AIR_NATIVE_SUBAGENT_SESSIONS_CAPABILITY);
}

/** The only cast needed until the TypeScript SDK publishes PR #1992. */
export function asSdkSessionNotification(
  notification: AcpSessionNotification,
): SessionNotification {
  return notification as SessionNotification;
}
