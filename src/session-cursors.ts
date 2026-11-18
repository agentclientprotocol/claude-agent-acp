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

/** The `cursor_update` of the cursor before the user message `messageId`. */
export function forkCursorUpdate(messageId: string) {
  return {
    sessionUpdate: "cursor_update" as const,
    cursorId: `${BEFORE_MESSAGE}${messageId}`,
    capabilities: { fork: {} },
    anchor: { type: "user_message" as const, messageId, position: "before" as const },
  };
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
  if (!message || message.type !== "user" || !message.uuid) return false;
  if (!messages[index - 1]?.uuid) return false;
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
