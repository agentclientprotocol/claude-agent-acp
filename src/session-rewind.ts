import { RequestError } from "@agentclientprotocol/sdk";
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import {
  assistantGroups,
  historyPoint,
  historyPointMessageIdCandidates,
  loadFullSessionHistory,
  resolveHistoryPointUuid,
  userPromptGroups,
  userPromptText,
  type MessageIdForGrouping,
  type SessionHistoryPoint,
} from "./session-history-point.js";

/**
 * `_session/rewind` (AIR -> agent).
 *
 * Drops one user turn and every later message from the conversation, and keeps
 * the provider session: the agent resumes its own stored conversation up to the
 * last retained entry. A fork would answer the same client intent with a second
 * session — another transcript, another id, and none of the original's subagent
 * history — so the edited prompt would no longer run against the conversation
 * the user is looking at.
 */
export const SESSION_REWIND_METHOD = "_session/rewind";

export type SessionRewindRequest = {
  sessionId: string;
  /** The user message excluded from the retained conversation. */
  beforeMessage: SessionHistoryPoint;
  /** The last agent message retained before it. Absent for the first user turn. */
  resumeAtMessage?: SessionHistoryPoint;
};

export type SessionRewindResponse = {
  /** False when the conversation was left as it was — the client then keeps its
   *  own transcript too. A rewind the agent cannot resolve is an error instead. */
  rewound: boolean;
};

export function parseSessionRewindRequest(params: unknown): SessionRewindRequest {
  if (!params || typeof params !== "object") {
    throw RequestError.invalidParams(undefined, "rewind params must be an object");
  }
  const { sessionId, beforeMessage, resumeAtMessage } = params as Record<string, unknown>;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw RequestError.invalidParams(undefined, "rewind params require a non-empty sessionId");
  }
  const before = historyPoint(beforeMessage);
  if (!before) {
    throw RequestError.invalidParams(
      undefined,
      "rewind params require a beforeMessage with a messageId",
    );
  }
  const resumeAt = historyPoint(resumeAtMessage);
  return {
    sessionId,
    beforeMessage: before,
    ...(resumeAt ? { resumeAtMessage: resumeAt } : {}),
  };
}

export type SessionRewindPlan = {
  /** The dropped prompt, for `resumeDropsTurn`: the CLI refuses the resume when
   *  the discarded range holds anything this turn does not account for. */
  droppedPromptUuid: string;
  /** The last entry of the retained conversation, for `resumeSessionAt`. The
   *  parent of the dropped prompt is that entry whatever its kind — the
   *  structured output of the kept turn, a tool result, an assistant message —
   *  which is exactly where the SDK requires the resume to fork. Undefined when
   *  the dropped prompt opens the conversation and nothing is retained. */
  resumeSessionAt?: string;
  /** `messageId -> uuid` of the retained conversation only, so the recreated
   *  session cannot resolve a later fork or rewind against a dropped message. */
  retainedMessageIdToUuid: Map<string, string>;
};

type SessionRewindDependencies = {
  cwd: string;
  liveMessageIdToUuid?: ReadonlyMap<string, string>;
  messageIdForGrouping: MessageIdForGrouping;
};

export async function planSessionRewind(
  request: SessionRewindRequest,
  dependencies: SessionRewindDependencies,
): Promise<SessionRewindPlan> {
  const entries = await loadFullSessionHistory(request.sessionId, dependencies.cwd);
  const byUuid = new Map(
    entries.flatMap((entry) => (typeof entry.uuid === "string" ? [[entry.uuid, entry]] : [])),
  );
  const isUserPrompt = (uuid: string | undefined) => {
    const entry = uuid ? byUuid.get(uuid) : undefined;
    return entry?.type === "user" && userPromptText(entry) !== undefined;
  };

  const liveUuid = historyPointMessageIdCandidates(request.beforeMessage.messageId)
    .map((candidate) => dependencies.liveMessageIdToUuid?.get(candidate))
    .find(isUserPrompt);
  const droppedPromptUuid =
    liveUuid ??
    resolveHistoryPointUuid(
      entries,
      userPromptGroups(entries, dependencies.messageIdForGrouping),
      request.beforeMessage,
      dependencies.messageIdForGrouping,
    ) ??
    promptAfterRetainedMessage(entries, byUuid, request, dependencies);
  if (!droppedPromptUuid) {
    throw RequestError.invalidParams(
      { messageId: request.beforeMessage.messageId },
      `Rewind point message ${request.beforeMessage.messageId} was not found in session ${request.sessionId}`,
    );
  }

  const parentUuid = byUuid.get(droppedPromptUuid)?.parentUuid;
  const resumeSessionAt = typeof parentUuid === "string" && parentUuid ? parentUuid : undefined;
  return {
    droppedPromptUuid,
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    retainedMessageIdToUuid: retainedMessageIdToUuid(
      resumeSessionAt,
      byUuid,
      dependencies.messageIdForGrouping,
    ),
  };
}

/**
 * The dropped prompt found through the message retained before it: the nearest
 * user prompt descending from it, or the prompt that opens the conversation
 * when nothing is retained.
 *
 * The client identifies a user prompt by the fingerprint of the text it shows,
 * which the transcript need not spell the same way — a prompt the client
 * decorated, or one an older build of this adapter rewrote on its way to the
 * CLI. The retained message is an agent message, whose id this adapter minted
 * and the transcript therefore knows, so it resolves when the prompt does not.
 */
function promptAfterRetainedMessage(
  entries: SessionStoreEntry[],
  byUuid: Map<string, SessionStoreEntry>,
  request: SessionRewindRequest,
  dependencies: SessionRewindDependencies,
): string | undefined {
  // With nothing retained the only prompt this could name is the one that
  // opens the conversation, and an unresolvable point is no evidence that it
  // is that one. Dropping the whole conversation on a guess is the one outcome
  // worse than refusing the rewind.
  if (!request.resumeAtMessage) return undefined;
  const retainedUuid = resolveHistoryPointUuid(
    entries,
    assistantGroups(entries, dependencies.messageIdForGrouping),
    request.resumeAtMessage,
    dependencies.messageIdForGrouping,
  );
  if (!retainedUuid) return undefined;

  const distanceToRetained = (entry: SessionStoreEntry): number | undefined => {
    let distance = 0;
    let cursor = typeof entry.parentUuid === "string" ? entry.parentUuid : undefined;
    while (cursor) {
      distance++;
      if (cursor === retainedUuid) return distance;
      cursor = (byUuid.get(cursor)?.parentUuid as string | undefined) || undefined;
    }
    return undefined;
  };

  const ranked = entries
    .filter((entry) => entry.type === "user" && userPromptText(entry) !== undefined)
    .flatMap((entry) => {
      const distance = typeof entry.uuid === "string" ? distanceToRetained(entry) : undefined;
      return distance === undefined ? [] : [{ uuid: entry.uuid as string, distance }];
    })
    .sort((a, b) => a.distance - b.distance);
  // Two prompts equally close to the retained message are two branches of it,
  // and nothing in the request says which one the client sees.
  if (ranked.length === 0 || ranked[0]!.distance === ranked[1]?.distance) return undefined;
  return ranked[0]!.uuid;
}

/** Walks the retained conversation from its last entry back to the root. The
 *  first entry a walk upwards meets for a message id is that message's last
 *  entry — the uuid the forward-reading map would have ended up holding. */
function retainedMessageIdToUuid(
  resumeSessionAt: string | undefined,
  byUuid: Map<string, SessionStoreEntry>,
  messageIdForGrouping: MessageIdForGrouping,
): Map<string, string> {
  const retained = new Map<string, string>();
  let cursor = resumeSessionAt;
  while (cursor) {
    const entry = byUuid.get(cursor);
    if (!entry) break;
    const messageId = messageIdForGrouping(entry);
    if (messageId && typeof entry.uuid === "string" && !retained.has(messageId)) {
      retained.set(messageId, entry.uuid);
    }
    cursor = (entry.parentUuid as string | undefined) || undefined;
  }
  return retained;
}

/** The CLI refuses a truncating resume whose discarded range holds more than
 *  the turn the caller declared it would drop — a message the session absorbed
 *  that the client never saw. The refusal is deterministic, so a caller
 *  recovers into the untruncated conversation instead of retrying. */
export function isRewindRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Resume rejected by --resume-drops-turn:");
}
