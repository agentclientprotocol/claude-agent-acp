import {
  importSessionToStore,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { assistantMessageText } from "./session-failure-extension.js";

/**
 * One message of the client's view of the conversation, as the AIR history
 * extensions (`session/fork`, `_session/rewind`) name it.
 *
 * The id alone is not enough: the client sees ids this adapter minted for the
 * messages it streamed, and the SDK keys its rewind APIs on transcript uuids.
 * The fingerprint of the message text, together with its 1-based occurrence
 * among the same-role messages of the visible prefix, identifies a message
 * whose id this adapter never saw — a user prompt, or an assistant message of
 * a session that another connection streamed.
 */
export type SessionHistoryPoint = {
  messageId: string;
  messageFingerprint?: string;
  messageOccurrence?: number;
};

/** Reads a history point out of a request payload, or `undefined` when the
 *  payload names no usable message. */
export function historyPoint(raw: unknown): SessionHistoryPoint | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { messageId, messageFingerprint, messageOccurrence } = raw as Record<string, unknown>;
  const id = typeof messageId === "string" ? messageId.trim() : "";
  if (!id) return undefined;
  const fingerprintValue =
    typeof messageFingerprint === "string" ? messageFingerprint.trim() : undefined;
  return {
    messageId: id,
    ...(fingerprintValue ? { messageFingerprint: fingerprintValue } : {}),
    // AIR computes this with count(...) over the visible prefix, so it is 1-based.
    ...(typeof messageOccurrence === "number" &&
    Number.isSafeInteger(messageOccurrence) &&
    messageOccurrence > 0
      ? { messageOccurrence }
      : {}),
  };
}

export function historyPointMessageIdCandidates(messageId: string): string[] {
  // Older AIR builds sent their visible segment id. Prefer the exact id before its ACP source id.
  const protocolMessageId = messageId.replace(/:segment:\d+$/, "");
  return protocolMessageId === messageId ? [messageId] : [messageId, protocolMessageId];
}

export async function loadFullSessionHistory(
  sessionId: string,
  cwd: string,
): Promise<SessionStoreEntry[]> {
  // getSessionMessages returns only the active parentUuid chain. The import keeps inactive branches that AIR can still reference.
  const entries: SessionStoreEntry[] = [];
  const store: SessionStore = {
    append: async (_key, batch) => {
      entries.push(...batch);
    },
    load: async () => null,
  };
  await importSessionToStore(sessionId, store, { dir: cwd, includeSubagents: false });
  return entries;
}

export type MessageIdForGrouping = (message: {
  type?: string;
  uuid?: string | null;
  message?: unknown;
}) => string | undefined;

/** The messages of one client-visible message id: the text its fingerprint
 *  covers, and the uuid of its last transcript entry. */
export type HistoryGroup = { uuid?: string; text: string };
export type HistoryGroups = Map<string, HistoryGroup>;

/** An entry of the main conversation: not a subagent's, and not the transcript
 *  of a tool the main loop ran. */
function isMainChainEntry(entry: SessionStoreEntry): boolean {
  return (
    entry.isSidechain !== true && entry.parent_tool_use_id == null && entry.parent_agent_id == null
  );
}

/** The text of a user entry that carries a prompt, and `undefined` for every
 *  other user entry: a tool_result carrier, or a meta entry the CLI wrote. */
export function userPromptText(entry: SessionStoreEntry): string | undefined {
  if (entry.isMeta === true) return undefined;
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (
    Array.isArray(content) &&
    content.some((block) => (block as { type?: unknown } | null)?.type === "tool_result")
  ) {
    return undefined;
  }
  return assistantMessageText(entry.message);
}

function groupsOf(
  entries: SessionStoreEntry[],
  messageIdForGrouping: MessageIdForGrouping,
  textOf: (entry: SessionStoreEntry) => string | undefined,
): HistoryGroups {
  const groups: HistoryGroups = new Map();
  for (const entry of entries) {
    if (!isMainChainEntry(entry)) continue;
    const text = textOf(entry);
    if (text === undefined) continue;
    const messageId = messageIdForGrouping(entry);
    if (!messageId) continue;
    const group = groups.get(messageId) ?? { text: "" };
    if (typeof entry.uuid === "string" && entry.uuid.length > 0) group.uuid = entry.uuid;
    group.text += text;
    groups.set(messageId, group);
  }
  return groups;
}

/** The assistant messages of the main conversation, keyed by the id the client
 *  was given. One id can span several entries, which the client saw as one
 *  message. */
export function assistantGroups(
  entries: SessionStoreEntry[],
  messageIdForGrouping: MessageIdForGrouping,
): HistoryGroups {
  return groupsOf(entries, messageIdForGrouping, (entry) =>
    entry.type === "assistant" ? (assistantMessageText(entry.message) ?? "") : undefined,
  );
}

/** The user prompts of the main conversation, keyed by their transcript uuid —
 *  the id this adapter reports for a user message. */
export function userPromptGroups(
  entries: SessionStoreEntry[],
  messageIdForGrouping: MessageIdForGrouping,
): HistoryGroups {
  return groupsOf(entries, messageIdForGrouping, (entry) =>
    entry.type === "user" ? userPromptText(entry) : undefined,
  );
}

export function fingerprint(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function fingerprintOccurrenceOnBranch(
  targetUuid: string,
  expectedFingerprint: string,
  entries: SessionStoreEntry[],
  groups: HistoryGroups,
  messageIdForGrouping: MessageIdForGrouping,
): number {
  const entriesByUuid = new Map(
    entries.flatMap((entry) => (typeof entry.uuid === "string" ? [[entry.uuid, entry]] : [])),
  );
  const seenGroups = new Set<string>();
  let occurrence = 0;
  let cursor: string | undefined = targetUuid;
  while (cursor) {
    const entry = entriesByUuid.get(cursor);
    if (!entry) break;
    const messageId = isMainChainEntry(entry) ? messageIdForGrouping(entry) : undefined;
    if (messageId && !seenGroups.has(messageId)) {
      seenGroups.add(messageId);
      const group = groups.get(messageId);
      if (group && fingerprint(group.text) === expectedFingerprint) occurrence++;
    }
    cursor = typeof entry.parentUuid === "string" ? entry.parentUuid : undefined;
  }
  return occurrence;
}

/**
 * The transcript uuid of the message the client named, resolved against one
 * kind of `groups` (assistant messages or user prompts). The id wins when the
 * transcript knows it; otherwise the fingerprint and its occurrence decide,
 * and an ambiguous pair resolves to nothing rather than to a guess.
 */
export function resolveHistoryPointUuid(
  entries: SessionStoreEntry[],
  groups: HistoryGroups,
  point: SessionHistoryPoint,
  messageIdForGrouping: MessageIdForGrouping,
): string | undefined {
  const candidates = historyPointMessageIdCandidates(point.messageId);
  const exact = candidates.map((candidate) => groups.get(candidate)?.uuid).find(Boolean);
  if (exact) return exact;
  if (!point.messageFingerprint || !point.messageOccurrence) return undefined;

  const fingerprintMatches = [...groups.values()].filter(
    (group) => group.uuid && fingerprint(group.text) === point.messageFingerprint,
  );
  // If only one persisted message has this content, the fingerprint already
  // identifies it even when an older client supplied an incompatible index.
  if (fingerprintMatches.length === 1) return fingerprintMatches[0]?.uuid;

  const occurrenceMatches = fingerprintMatches.filter(
    (group) =>
      group.uuid &&
      fingerprintOccurrenceOnBranch(
        group.uuid,
        point.messageFingerprint!,
        entries,
        groups,
        messageIdForGrouping,
      ) === point.messageOccurrence,
  );
  return occurrenceMatches.length === 1 ? occurrenceMatches[0]?.uuid : undefined;
}
