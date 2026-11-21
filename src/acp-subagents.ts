import {
  RequestError,
  type ClientCapabilities,
  type SessionCapabilities,
  type SessionNotification,
} from "@agentclientprotocol/sdk/unstable";
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
 *   it.
 * - `air`: the earlier draft of that RFD, which AIR implements:
 *   `subagent_spawned` and `subagent_state_update`, typed below. AIR gets it,
 *   whichever capability it declares (`docs/air-extensions.md`).
 */
export type SubagentForm = "rfd" | "air";

/**
 * The error of a client's request that names a child session, other than
 * `session/cancel`: invalid params (-32602), as the RFD asks, not the -32002
 * of an unknown session. `method` completes "the client cannot … it".
 */
export function restrictedChild(sessionId: string, method: string): RequestError {
  return RequestError.invalidParams(
    { sessionId },
    `${sessionId} is a subagent session: the client cannot ${method} it. Its parent session runs it.`,
  );
}

/**
 * The child sessions that the sessions of one connection announced with
 * `subagent_update`, while they run or in the replay of a `session/load` or
 * `session/resume`. The client knows such a session, so a request that names
 * it fails as {@link restrictedChild} says, and not as a request of an unknown
 * session.
 *
 * A child is known from its announcement until the client ends its root
 * session ({@link rootClosed}): with `session/close`, or a request that closes
 * the session too, such as `session/delete`. Nothing else removes it: after a
 * conversation reset (`/clear`), a restart of the root's query or the end of
 * the root's Claude Code process, the client still holds the child.
 *
 * AIR's draft announces a child with `subagent_spawned` and keeps its own
 * rules, so its children are never known here.
 */
export class AnnouncedChildren {
  /** The root session of each announced child session, by the child's id. */
  private readonly rootByChild = new Map<string, string>();

  /**
   * Takes a session update that goes to the client. A `subagent_update`
   * announces the child session it names, or reports on one that is known
   * already. The update's own session is the child's parent, which can be a
   * child itself: its root is the child's too.
   */
  sending(notification: {
    sessionId: string;
    update: { sessionUpdate: string; sessionId?: unknown };
  }): void {
    const { sessionId: parent, update } = notification;
    if (update.sessionUpdate !== "subagent_update" || typeof update.sessionId !== "string") return;
    this.rootByChild.set(update.sessionId, this.rootByChild.get(parent) ?? parent);
  }

  /** Whether `sessionId` is a child session that the client knows. */
  has(sessionId: string): boolean {
    return this.rootByChild.has(sessionId);
  }

  /** The root session of the child session `sessionId`, when the client knows it. */
  rootOf(sessionId: string): string | undefined {
    return this.rootByChild.get(sessionId);
  }

  /** The client ended the session `rootSessionId`, and can no longer name its children. */
  rootClosed(rootSessionId: string): void {
    for (const [child, root] of this.rootByChild) {
      if (root === rootSessionId) this.rootByChild.delete(child);
    }
  }
}

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
