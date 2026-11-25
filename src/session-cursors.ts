/**
 * Session cursors (the unstable session cursors RFD): the positions of a
 * session that a method can act at.
 *
 * The adapter announces one kind: the position before a user message that the
 * session's history stores, with the `fork` capability. `session/fork` with
 * its `cursorId` copies the history before that message, so a client can edit
 * the message or ask again from there. The first entry of a history has no
 * cursor: nothing is before it, and Claude Code forks at an entry, not before
 * the first one.
 *
 * A `cursorId` is derived from the uuid of its user message, which Claude Code
 * stores. So it is the same live, in every replay and after a restart, and
 * the adapter keeps no cursors of its own: a fork finds the position in the
 * stored history.
 */
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { isCompactSummaryMessage } from "./context-compaction.js";
import { isReplayHiddenMetaMessage, stripLocalCommandMetadata } from "./message-filters.js";

/** What the cursor ids start with. The rest is the uuid of the user message. */
const BEFORE_MESSAGE = "before:";

/** The entity that a cursor is anchored to. */
export type CursorEntity =
  | { type: "user_message" | "agent_message" | "agent_thought"; messageId: string }
  | { type: "tool_call"; toolCallId: string }
  | { type: "compaction"; compactionId: string };

/** The side of its {@link CursorEntity} that a cursor lies on. */
export type CursorAnchor = CursorEntity & { position: "before" | "after" };

/** The `cursor_update` of the cursor before the user message `messageId`. */
export function forkCursorUpdate(messageId: string) {
  return {
    ...forkCursorBase(messageId),
    anchor: { type: "user_message" as const, messageId, position: "before" as const },
  };
}

/**
 * The cursor before the user message `messageId` for a client that holds no
 * such user message: `anchor` places it (see {@link LastReportedEntity}), and the
 * `cursorId` stays that of the message.
 */
export function anchoredForkCursorUpdate(messageId: string, anchor: CursorAnchor) {
  return { ...forkCursorBase(messageId), anchor };
}

/**
 * `update` with the `rewind` capability added: the cursor is also a position
 * that `_session/rewind` accepts. For a client that declared `sessionRewind`.
 */
export function withRewindCapability<U extends { capabilities: { fork: object } }>(
  update: U,
): U & { capabilities: { fork: object; rewind: object } } {
  return { ...update, capabilities: { ...update.capabilities, rewind: {} } };
}

/** The uuid of the user message that `cursorId` lies before, or undefined for an id that is no cursor. */
export function cursorMessageId(cursorId: string): string | undefined {
  return cursorId.startsWith(BEFORE_MESSAGE) ? cursorId.slice(BEFORE_MESSAGE.length) : undefined;
}

function forkCursorBase(messageId: string) {
  return {
    sessionUpdate: "cursor_update" as const,
    cursorId: `${BEFORE_MESSAGE}${messageId}`,
    capabilities: { fork: {} },
  };
}

/**
 * The last entity per session that a client can anchor a cursor to: an agent
 * message or thought with a `messageId`, a tool call, a compaction or a user
 * message with a `messageId`. v1 does not report a prompt that the client
 * sent, so its cursor lies `after` the entity before it. Each session update
 * that goes to the client passes through {@link sending}, a replay too.
 * Output of a subagent (a `parentToolUseId` in its `_meta`) is not on the
 * session's own timeline and is left out.
 *
 * It also records, for each cursor that the agent announces, the entity that
 * the client held right before that position ({@link recordCursor}). A rewind
 * to the cursor leaves the client with exactly that entity.
 */
export class LastReportedEntity {
  private readonly bySession = new Map<string, CursorEntity>();
  /** Per session, in announcement order: the entity before each announced cursor. */
  private readonly beforeCursor = new Map<string, Map<string, CursorEntity | undefined>>();

  sending(notification: {
    sessionId: string;
    update: { sessionUpdate: string; _meta?: unknown } & Record<string, unknown>;
  }): void {
    const { sessionId, update } = notification;
    const meta = update._meta as { claudeCode?: { parentToolUseId?: unknown } } | null | undefined;
    if (meta?.claudeCode?.parentToolUseId) return;
    const messageId = typeof update.messageId === "string" ? update.messageId : undefined;
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        if (messageId) this.bySession.set(sessionId, { type: "user_message", messageId });
        break;
      case "agent_message_chunk":
        if (messageId) this.bySession.set(sessionId, { type: "agent_message", messageId });
        break;
      case "agent_thought_chunk":
        if (messageId) this.bySession.set(sessionId, { type: "agent_thought", messageId });
        break;
      case "tool_call":
        if (typeof update.toolCallId === "string") {
          this.bySession.set(sessionId, { type: "tool_call", toolCallId: update.toolCallId });
        }
        break;
      case "compaction_update":
        if (typeof update.compactionId === "string") {
          this.bySession.set(sessionId, { type: "compaction", compactionId: update.compactionId });
        }
        break;
      default:
    }
  }

  /** The position after the last entity of the session, if the client holds one. */
  after(sessionId: string): CursorAnchor | undefined {
    const entity = this.bySession.get(sessionId);
    return entity && { ...entity, position: "after" };
  }

  /** The last entity of the session that the client holds, if any. */
  last(sessionId: string): CursorEntity | undefined {
    return this.bySession.get(sessionId);
  }

  /** The agent announces `cursorId`; `before` is the entity the client holds right before it. */
  recordCursor(sessionId: string, cursorId: string, before: CursorEntity | undefined): void {
    let records = this.beforeCursor.get(sessionId);
    if (!records) this.beforeCursor.set(sessionId, (records = new Map()));
    records.set(cursorId, before);
  }

  /**
   * The session is rewound to `cursorId`: the client drops the entities from
   * there on, so the entity recorded for the cursor is its last one (none for
   * a cursor that has no record: the next prompt then gets no cursor). The
   * records of the cursors at and after the cut go too.
   */
  rewind(sessionId: string, cursorId: string): void {
    const records = this.beforeCursor.get(sessionId);
    const before = records?.get(cursorId);
    if (before) this.bySession.set(sessionId, before);
    else this.bySession.delete(sessionId);
    if (!records?.has(cursorId)) return;
    let cut = false;
    for (const id of [...records.keys()]) {
      cut ||= id === cursorId;
      if (cut) records.delete(id);
    }
  }

  /** The client no longer holds the session's entities: it closed, or a replay rebuilds them. */
  forget(sessionId: string): void {
    for (const map of [this.bySession, this.beforeCursor]) {
      for (const id of map.keys()) {
        if (id === sessionId || id.startsWith(`${sessionId}:`)) map.delete(id);
      }
    }
  }
}

/**
 * Whether a prompt with this content gets a cursor when it is inserted live.
 * A slash command does not: Claude Code stores a command as command metadata
 * or not at all, so a replay shows no user message for it and a fork finds no
 * cursor (see {@link hasForkCursor}). Text that only starts like a command
 * gets its cursor in the next replay.
 */
export function promptGetsCursor(prompt: ReadonlyArray<{ type: string; text?: unknown }>): boolean {
  const first = prompt.find((block) => block.type === "text");
  return !(typeof first?.text === "string" && first.text.trimStart().startsWith("/"));
}

/**
 * Whether the entry `index` of the stored history `messages` is a user
 * message with a cursor before it: one that a replay shows as a user message
 * under its uuid, and that follows an entry that a fork can end with. A
 * replay announces the cursor of each such message, and a fork accepts no
 * other.
 */
export function hasForkCursor(messages: readonly SessionMessage[], index: number): boolean {
  const message = messages[index];
  if (!message || !messages[index - 1]?.uuid) return false;
  return isShownUserMessage(message);
}

/** Whether a replay shows `message` as a user message of the session's own conversation. */
function isShownUserMessage(message: SessionMessage): boolean {
  if (message.type !== "user" || !message.uuid) return false;
  if (message.parent_tool_use_id !== null) return false;
  if (isReplayHiddenMetaMessage(message) || isCompactSummaryMessage(message)) return false;
  // `null`: the message was command metadata alone, which a replay does not show.
  const content = stripLocalCommandMetadata(
    (message.message as { content?: unknown } | undefined)?.content,
  );
  if (typeof content === "string") return content.length > 0;
  // A message of tool results alone is no user message.
  return (
    Array.isArray(content) &&
    content.some((block) => (block as { type?: unknown } | null)?.type !== "tool_result")
  );
}

/**
 * The uuid of the entry that a fork at `cursorId` ends with: the entry before
 * the cursor's user message in the stored history `messages`. Undefined for
 * an id that is no cursor of that history (see {@link hasForkCursor}).
 */
export function forkPointOf(
  cursorId: string,
  messages: readonly SessionMessage[],
): string | undefined {
  if (!cursorId.startsWith(BEFORE_MESSAGE)) return undefined;
  const messageId = cursorId.slice(BEFORE_MESSAGE.length);
  const index = messages.findIndex((message) => message.uuid === messageId);
  return hasForkCursor(messages, index) ? messages[index - 1]!.uuid : undefined;
}
