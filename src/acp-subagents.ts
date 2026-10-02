import type {
  ClientCapabilities,
  ContentBlock,
  SessionCapabilities,
  SessionNotification,
  StopReason,
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
 * TypeScript SDK does not contain it yet (`unstable_subagents`, merged
 * 2026-09-15 in the Rust schema, isn't in a published `@agentclientprotocol/sdk`
 * release). Keep the compatibility boundary in this file so it can be replaced
 * by SDK exports without changing lifecycle code when the draft ships.
 *
 * This reflects the reworked RFD (one upsert-style `subagent_update` plus
 * `session_message`/`session_message_chunk`), not the original two-notification
 * shape (`subagent_spawned` + `subagent_state_update`) #1017 implemented before
 * the rework landed.
 */
export type SubagentCapabilities = {
  /** Omitted or `null` means unsupported; an object (including `{}`) means supported. */
  cancel?: Record<string, unknown> | null;
  _meta?: Record<string, unknown> | null;
};

/**
 * The child's current foreground-work snapshot, mirrored onto the parent's
 * `subagent_update.state`. Same shape as v2's `state_update`. A whole-object
 * replacement, not a nested patch -- see `SubagentUpdate.state`.
 */
export type SubagentWorkState =
  | { state: "running"; _meta?: Record<string, unknown> | null }
  | { state: "requires_action"; _meta?: Record<string, unknown> | null }
  | { state: "unknown"; _meta?: Record<string, unknown> | null }
  | {
      state: "idle";
      /** Omitted or `null` means not reported. */
      stopReason?: StopReason | null;
      _meta?: Record<string, unknown> | null;
    };

/**
 * Notifies the Client that the enclosing parent session created and owns a
 * child session. The first update for an unknown `sessionId` announces the
 * association; later updates patch its metadata without creating a new child
 * or transferring ownership.
 *
 * Only `sessionId` is required. Every other field is a nullable patch:
 * omitted means unchanged, `null` clears it, a concrete value replaces it
 * wholesale (see `docs/rfds/subagents.mdx`).
 */
export type SubagentUpdate = {
  sessionUpdate: "subagent_update";
  sessionId: string;
  title?: string | null;
  description?: string | null;
  capabilities?: SubagentCapabilities | null;
  state?: SubagentWorkState | null;
  _meta?: Record<string, unknown> | null;
};

/**
 * Reports a session's outgoing or incoming message to or from another
 * session -- not a response to the human user, not a tool call. An upsert:
 * supplying `content` replaces all content accumulated for `messageId` so
 * far; omitting it leaves prior content in place (for a metadata-only patch
 * or a later chunk to append to).
 */
export type SessionMessageUpdate = {
  sessionUpdate: "session_message";
  messageId: string;
  senderSessionId?: string | null;
  recipientSessionId?: string | null;
  content?: ContentBlock[] | null;
  _meta?: Record<string, unknown> | null;
};

/** Appends one content block to an in-progress `session_message`. */
export type SessionMessageChunkUpdate = {
  sessionUpdate: "session_message_chunk";
  messageId: string;
  senderSessionId?: string | null;
  recipientSessionId?: string | null;
  content: ContentBlock;
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
  | SubagentUpdate
  | SessionMessageUpdate
  | SessionMessageChunkUpdate
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
