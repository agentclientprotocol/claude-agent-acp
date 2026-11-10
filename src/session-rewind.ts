import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { rewoundSession, writeRewindPoint } from "./resumed-session.js";
import {
  assistantGroups,
  chainUuids,
  entriesByUuid,
  historyPoint,
  historyPointMessageIdCandidates,
  loadFullSessionHistory,
  newestMainChainUuid,
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
  /** The dropped prompt. */
  droppedPromptUuid: string;
  /** The last entry of the retained conversation, for `resumeSessionAt`. The
   *  parent of the dropped prompt is that entry whatever its kind — the
   *  structured output of the kept turn, a tool result, an assistant message —
   *  which is exactly where the SDK requires the resume to fork. Undefined when
   *  the dropped prompt opens the conversation and nothing is retained. */
  resumeSessionAt?: string;
  /** Whether the dropped turn is the last one. `resumeDropsTurn` makes the CLI
   *  refuse a resume that discards anything the named turn does not account
   *  for, so it can guard only the rewind of the last turn: the turns after an
   *  earlier one are always in the discarded range. */
  dropsOneTurn: boolean;
  /** Whether a compaction follows `resumeSessionAt` on the active branch.
   *  Claude Code resumes a compacted conversation from its newest compaction
   *  boundary on, and does not find an entry before it ("No message found
   *  with message.uuid of …"). */
  beforeCompaction: boolean;
  /** `messageId -> uuid` of the retained conversation only, so the recreated
   *  session cannot resolve a later fork or rewind against a dropped message. */
  retainedMessageIdToUuid: Map<string, string>;
};

type SessionRewindDependencies = {
  liveMessageIdToUuid?: ReadonlyMap<string, string>;
  messageIdForGrouping: MessageIdForGrouping;
  logger?: { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
};

/** What the rewind needs from the agent that holds the live session. */
export type SessionRewindHost = SessionRewindDependencies & {
  logger: { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  /** The live session's map, which the recovery carries over unchanged. */
  liveMessageIdToUuid: Map<string, string>;
  /** Whether the session runs anything its query's close would kill: a turn,
   *  a queued prompt, a cycle Claude Code started on its own, or a background
   *  task or subagent. */
  isBusy(): boolean;
  closeQuery(): void;
  /** Replaces the closed query by a resume of the session's own conversation,
   *  stopped at `rewindTo` when it is set, and keeps the task list and the
   *  published failures of the session. */
  resume(options: {
    rewindTo?: string;
    rewindDropsTurn?: string;
    messageIdToUuid: Map<string, string>;
  }): Promise<void>;
  /** Puts the user's model, mode, effort, agent, Fast mode and ultracode back
   *  onto the resumed session. */
  restoreChoices(): Promise<void>;
  /** Deals with a session whose query is closed and could not be resumed,
   *  and returns the error the rewind fails with. */
  abandon(error: unknown): Promise<unknown>;
};

/**
 * Drops one user turn and everything after it from the conversation, keeping
 * the session the client already holds: the query is replaced by a resume of
 * the session's own stored conversation that stops at the last retained entry.
 * The session id, the transcript behind it and its `subagents/` history are
 * the ones the client was prompting all along — a fork would copy the
 * transcript into a second session instead, and copy none of the subagent
 * history with it.
 *
 * `{ rewound: false }` means the conversation was left as it was and the
 * client keeps its own history too. A point the transcript does not contain is
 * a bad request, not a refusal.
 */
export async function rewindSession(
  request: SessionRewindRequest,
  host: SessionRewindHost,
): Promise<SessionRewindResponse> {
  const refuse = (reason: string) => {
    host.logger.log(`Rewind of session ${request.sessionId} refused: ${reason}`);
    return { rewound: false };
  };
  // AIR stops the turn before it rewinds. Work still running here would be
  // killed with the query, and the dropped range would be decided against a
  // transcript that is still growing.
  if (host.isBusy()) return refuse("Claude is working");
  const plan = await planSessionRewind(request, host);
  // Claude Code has no entry before the first prompt to resume at, and it
  // refuses to start a new conversation under an id whose transcript exists
  // ("Session ID … is already in use").
  if (!plan.resumeSessionAt) return refuse("the first prompt cannot be dropped");
  if (plan.beforeCompaction) return refuse("the prompt is before the last compaction");
  // Claude Code can start a cycle on its own while the transcript is read.
  if (host.isBusy()) return refuse("Claude is working");

  host.closeQuery();
  try {
    await host.resume({
      rewindTo: plan.resumeSessionAt,
      ...(plan.dropsOneTurn ? { rewindDropsTurn: plan.droppedPromptUuid } : {}),
      messageIdToUuid: plan.retainedMessageIdToUuid,
    });
  } catch (error) {
    // The CLI validates the dropped range and refuses deterministically, so
    // the same rewind can only fail again. Recover once into the conversation
    // as it was: the query of the session is already closed, and a session the
    // client cannot prompt is worse than one that was not rewound.
    host.logger.log(
      `Rewind of session ${request.sessionId} ${isRewindRefusal(error) ? "was refused by the CLI" : `failed: ${error}`}; resuming the conversation as it was`,
    );
    try {
      await host.resume({ messageIdToUuid: host.liveMessageIdToUuid });
    } catch (recoveryError) {
      throw await host.abandon(recoveryError);
    }
    await host.restoreChoices();
    return { rewound: false };
  }
  try {
    await writeRewindPoint(request.sessionId, {
      resumeSessionAt: plan.resumeSessionAt,
      droppedPromptUuid: plan.droppedPromptUuid,
    });
  } catch (error) {
    // The live query is rewound either way; only a later resume of the session
    // before its next prompt would bring the dropped turns back.
    host.logger.error(`Failed to record the rewind point of session ${request.sessionId}:`, error);
  }
  await host.restoreChoices();
  return { rewound: true };
}

export async function planSessionRewind(
  request: SessionRewindRequest,
  dependencies: SessionRewindDependencies,
): Promise<SessionRewindPlan> {
  const history = await loadFullSessionHistory(request.sessionId);
  const byUuid = entriesByUuid(history);
  // The transcript keeps every branch an earlier rewind left behind, so the
  // same prompt text can be there twice. Only the branch the session
  // continues is the conversation the client shows.
  const rewound = await rewoundSession(request.sessionId, dependencies.logger, history);
  const active = chainUuids(rewound?.leaf ?? newestMainChainUuid(history), byUuid);
  const entries = history.filter((entry) => active.has(entry.uuid as string));
  const isUserPrompt = (uuid: string | undefined) => {
    const entry = uuid && active.has(uuid) ? byUuid.get(uuid) : undefined;
    return entry !== undefined && isPromptEntry(entry);
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
    promptAfterRetainedMessage(entries, request, dependencies);
  if (!droppedPromptUuid) {
    throw RequestError.invalidParams(
      { messageId: request.beforeMessage.messageId },
      `Rewind point message ${request.beforeMessage.messageId} was not found in session ${request.sessionId}`,
    );
  }

  const parentUuid = byUuid.get(droppedPromptUuid)?.parentUuid;
  const resumeSessionAt = typeof parentUuid === "string" && parentUuid ? parentUuid : undefined;
  const dropped = entries.findIndex((entry) => entry.uuid === droppedPromptUuid);
  const later = entries.slice(dropped + 1);
  return {
    droppedPromptUuid,
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    dropsOneTurn: !later.some((entry) => isUserPrompt(entry.uuid)),
    beforeCompaction: later.some(
      (entry) => entry.type === "system" && entry.subtype === "compact_boundary",
    ),
    retainedMessageIdToUuid: retainedMessageIdToUuid(
      resumeSessionAt,
      byUuid,
      dependencies.messageIdForGrouping,
    ),
  };
}

/**
 * The dropped prompt found through the message retained before it: the user
 * prompt that follows it on the active branch.
 *
 * The client identifies a user prompt by the fingerprint of the text it shows,
 * which the transcript need not spell the same way — a prompt the client
 * decorated, or one an older build of this adapter rewrote on its way to the
 * CLI. The retained message is an agent message, whose id this adapter minted
 * and the transcript therefore knows, so it resolves when the prompt does not.
 */
function promptAfterRetainedMessage(
  entries: SessionStoreEntry[],
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
  const retained = entries.findIndex((entry) => entry.uuid === retainedUuid);
  return entries.slice(retained + 1).find(isPromptEntry)?.uuid;
}

function isPromptEntry(entry: SessionStoreEntry): boolean {
  return entry.type === "user" && userPromptText(entry) !== undefined;
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
 *  recovers into the conversation as it was instead of retrying. */
export function isRewindRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Resume rejected by --resume-drops-turn:");
}
