import type {
  ClientCapabilities,
  SessionCapabilities,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  AIR_NATIVE_SUBAGENT_SESSIONS_CAPABILITY,
  clientSupportsAirCapability,
  isAirClient,
} from "./air-extension.js";

export { AIR_NATIVE_SUBAGENT_SESSIONS_CAPABILITY } from "./air-extension.js";

/**
 * How a client gets native subagent sessions.
 *
 * - `rfd`: the subagents RFD (agentclientprotocol/agent-client-protocol#1992,
 *   as revised): `subagent_update` and `session_message`, which the SDK types.
 *   A client that declares `clientCapabilities.subagents` and is not AIR gets
 *   it. (ACP v2 clients do not get subagents yet.)
 * - `air`: the earlier draft of that RFD, which AIR implements:
 *   `subagent_spawned` and `subagent_state_update`, typed below. AIR gets it,
 *   whichever capability it declares (`docs/air-extensions.md`).
 */
export type SubagentForm = "rfd" | "air";

/** The form of native subagent sessions that the client gets, or none. */
export function subagentForm(capabilities?: ClientCapabilities | null): SubagentForm | undefined {
  if (!clientSupportsSubagents(capabilities)) return undefined;
  return isAirClient(capabilities) ? "air" : "rfd";
}

/**
 * The earlier draft of the subagents RFD, which AIR implements and the SDK
 * does not type.
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
  /**
   * Adapter extension: the exact prompt of the subagent. A client can show it
   * as the first user message of the subagent session. It is absent when the
   * adapter does not know the prompt.
   */
  prompt?: string;
  capabilities: SubagentSessionCapabilities;
  _meta?: Record<string, unknown> | null;
};

export type SubagentState = "completed" | "failed" | "cancelled" | "disconnected";

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
  canStop: boolean;
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
  /** Latest durable task log path. May arrive after spawn. */
  outputFilePath?: string;
  /** Originating tool call, when correlation becomes known after spawn. */
  toolCallId?: string;
  _meta?: Record<string, unknown> | null;
};

export type AsyncTaskStateUpdate = {
  sessionUpdate: "async_task_state_update";
  asyncTaskId: string;
  state: AsyncTaskState;
  summary?: string;
  /** Latest durable task log path, including terminal-only SDK reports. */
  outputFilePath?: string;
  /** Originating tool call, including terminal-only late correlation. */
  toolCallId?: string;
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

/** The cast that AIR's draft updates and the async task updates need. */
export function asSdkSessionNotification(
  notification: AcpSessionNotification,
): SessionNotification {
  return notification as SessionNotification;
}
