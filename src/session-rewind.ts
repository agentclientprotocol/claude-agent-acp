/**
 * `_session/rewind` (AIR -> agent): removes a user message and everything after
 * it from the context of the same Claude session, the one the client holds. A
 * fork would answer the same intent with a second session, so the edited
 * message would no longer run in the conversation that the user is looking at.
 *
 * The position is a session cursor (see `session-cursors.ts`): the one before
 * the user message to drop. The adapter resumes the stored conversation of the
 * session at the entry before that message (`resumeSessionAt`). Claude Code
 * deletes nothing: the dropped entries stay in the transcript as an orphan
 * branch, and `rewind.json` records the cut until the next prompt writes a
 * branch that descends from it.
 *
 * Every read of the stored history of a session cuts it at the point
 * (`cutAtRewindPoint`: replays, forks, v2's prompt keys), and every resume of
 * it stops there (`prepareRewoundResume`). The point is removed by the first
 * resume after the CLI stored a prompt on the rewound branch; until then the
 * file stays and cuts nothing, since the stored history no longer holds the
 * dropped prompt. v1 and v2 share this: both resume through
 * `prepareRewoundResume` and read through `cutAtRewindPoint`.
 */
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import {
  getSessionMessages,
  type SessionMessage,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isCompactSummaryMessage } from "./context-compaction.js";
import { isReplayHiddenMetaMessage } from "./message-filters.js";
import {
  findTranscript,
  loadFullSessionHistory,
  readHistoryAcrossCompactions,
} from "./resumed-session.js";
import { cursorMessageId, forkPointOf } from "./session-cursors.js";

export const SESSION_REWIND_METHOD = "_session/rewind";

export type SessionRewindRequest = {
  sessionId: string;
  /** A cursor that the session announced, before the user message to drop. */
  cursorId: string;
};

/** Why the conversation was left as it was. */
export type SessionRewindRefusal =
  /** Claude is working, or a prompt is queued. */
  | "busy"
  /** A background task or subagent is running. */
  | "backgroundWork"
  /** The message is before the newest compaction of the conversation. */
  | "beforeCompaction"
  /** The session's context was cleared into another Claude session. */
  | "clearedContext"
  /** Claude Code refused the cut. The session goes on as it was. */
  | "providerRefused"
  /** The rewind point could not be written. Nothing changed. */
  | "persistFailed";

export type SessionRewindResponse = {
  rewound: boolean;
  reason?: SessionRewindRefusal;
};

export function parseSessionRewindRequest(params: unknown): SessionRewindRequest {
  if (!params || typeof params !== "object") {
    throw RequestError.invalidParams(undefined, "rewind params must be an object");
  }
  const { sessionId, cursorId } = params as Record<string, unknown>;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw RequestError.invalidParams(undefined, "rewind params require a non-empty sessionId");
  }
  if (typeof cursorId !== "string" || cursorId.length === 0) {
    throw RequestError.invalidParams(undefined, "rewind params require a non-empty cursorId");
  }
  return { sessionId, cursorId };
}

type Logger = { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

/** The stored history of a session, as a replay shows it. */
export type RewindableHistory = {
  /** Every message of the conversation the session continues, from its first
   *  prompt on, across compactions. A rewind cursor is one of this list. */
  visible: readonly SessionMessage[];
  /** The part of `visible` that the newest compaction left: where Claude Code
   *  can resume. */
  current: readonly SessionMessage[];
};

/** What the rewind needs from the agent that holds the session. */
export type SessionRewindHost = {
  logger: Logger;
  /** The context of the session was cleared into another Claude session. */
  clearedContext: boolean;
  /** Whether Claude works, or a prompt is queued: `startTurn`'s check. */
  claudeIsWorking(): boolean;
  /** Whether a background task or subagent runs. Closing the query ends it. */
  hasBackgroundWork(): boolean;
  loadHistory(): Promise<RewindableHistory>;
  /**
   * Closes the query and recreates the same session by resuming its
   * conversation, stopped at `resumeAt.resumeSessionAt` when it is set. Restores
   * the user's model, mode, agent, effort and Fast mode, and starts the reader.
   */
  replaceQuery(resumeAt?: { resumeSessionAt: string; resumeDropsTurn?: string }): Promise<void>;
  /**
   * The session is rewound to `cursorId`. The next prompt's cursor anchors to
   * the entity that the client held before that cursor.
   */
  rewound(cursorId: string): void;
  /** Deals with a session whose query is closed and could not be resumed,
   *  and returns the error the rewind fails with. */
  abandon(error: unknown): Promise<unknown>;
};

/**
 * Drops the user message of `request.cursorId` and everything after it.
 *
 * `{ rewound: true }` means that the cut is live and recorded in `rewind.json`;
 * `{ rewound: false, reason }` means that the conversation and the rewind point
 * are unchanged. The transcript can still gain the `last-prompt` line that any
 * resume writes: `prepareRewoundResume` runs before the refusals that follow
 * it, and with a stale point that is not pending it also deletes `rewind.json`,
 * as any resume does. A cursor that the session's history does not hold is a
 * bad request (-32602): the rewind never acts at another position.
 *
 * The point is written before the query is replaced, and restored to what it
 * was when the cut does not happen. A crash between the write and the cut
 * leaves a point that the next resume applies. When the restore fails too, the
 * request fails with an internal error instead of `rewound: false`, since the
 * next resume applies a cut that was reported as not made.
 */
export async function rewindSession(
  request: SessionRewindRequest,
  host: SessionRewindHost,
): Promise<SessionRewindResponse> {
  const { sessionId, cursorId } = request;
  const refuse = (reason: SessionRewindRefusal): SessionRewindResponse => {
    host.logger.log(`Rewind of session ${sessionId} refused: ${reason}`);
    return { rewound: false, reason };
  };
  // AIR stops the turn before it rewinds. Work still running here would be
  // killed with the query.
  const busy = (): SessionRewindResponse | undefined =>
    host.claudeIsWorking()
      ? refuse("busy")
      : host.hasBackgroundWork()
        ? refuse("backgroundWork")
        : undefined;
  const refusal = busy();
  if (refusal) return refusal;
  // The transcript of the session holds the conversation from before the
  // clear, which the cursor would be resolved against.
  if (host.clearedContext) return refuse("clearedContext");

  const history = await host.loadHistory();
  const resumeSessionAt = forkPointOf(cursorId, history.visible);
  const droppedPromptUuid = cursorMessageId(cursorId);
  if (!resumeSessionAt || !droppedPromptUuid) {
    throw RequestError.invalidParams(
      { cursorId },
      `Cursor ${cursorId} is not a rewind position of session ${sessionId}`,
    );
  }
  // Claude Code resumes a compacted conversation from its newest compaction on
  // and finds no entry before it ("No message found with message.uuid of ...").
  if (!history.current.some((message) => message.uuid === resumeSessionAt)) {
    return refuse("beforeCompaction");
  }
  // Before the query closes: marks the branch a second rewind resumes on.
  const earlierCut = await prepareRewoundResume(sessionId, host.logger);
  // Read after the preparation, which removes a point that is no longer pending.
  const previousPoint = await readRewindPoint(sessionId, host.logger);
  const dropped = history.visible.findIndex((message) => message.uuid === droppedPromptUuid);
  // `resumeDropsTurn` makes Claude Code refuse a cut that discards anything
  // the named turn does not account for, so it can guard only the last turn:
  // the turns after an earlier one are always in the discarded range.
  const dropsOneTurn = !history.visible.slice(dropped + 1).some(startsTurn);

  try {
    await writeRewindPoint(sessionId, { resumeSessionAt, droppedPromptUuid });
  } catch (error) {
    host.logger.error(`Failed to record the rewind point of session ${sessionId}:`, error);
    return refuse("persistFailed");
  }
  // Puts `rewind.json` back, for a cut that does not happen. A failure leaves
  // the new point in place, which the next resume of the session applies.
  const restorePoint = async () => {
    try {
      if (previousPoint) await writeRewindPoint(sessionId, previousPoint);
      else await clearRewindPoint(sessionId);
      return true;
    } catch (error) {
      host.logger.error(
        `Failed to restore the rewind point of session ${sessionId}; the next resume applies the cut:`,
        error,
      );
      return false;
    }
  };
  const pointNotRemoved = () =>
    RequestError.internalError(
      undefined,
      `The rewind of session ${sessionId} did not happen, but its rewind point could not be removed. The next load of the session applies the cut.`,
    );
  // Claude Code can start a cycle on its own while the transcript is read,
  // prepared or the point is written. Nothing is awaited between this check
  // and `replaceQuery`, whose first statement closes the query synchronously.
  const lateRefusal = busy();
  if (lateRefusal) {
    if (!(await restorePoint())) throw pointNotRemoved();
    return lateRefusal;
  }

  try {
    await host.replaceQuery({
      resumeSessionAt,
      ...(dropsOneTurn ? { resumeDropsTurn: droppedPromptUuid } : {}),
    });
  } catch (error) {
    // Claude Code refuses a cut deterministically, so retrying fails again.
    // Recover once into the conversation as it was: the query of the session is
    // already closed, and a session the client cannot prompt is worse than one
    // that was not rewound.
    host.logger.log(
      `Rewind of session ${sessionId} ${isRewindRefusal(error) ? "was refused by Claude Code" : `failed: ${error}`}; resuming the conversation as it was`,
    );
    // Before the recovery resume, which reads `rewind.json` and would stop at
    // the new point. If the file cannot be restored, only the earlier cut is used.
    const restored = await restorePoint();
    try {
      const recoveredCut = restored
        ? ((await prepareRewoundResume(sessionId, host.logger)) ?? earlierCut)
        : earlierCut;
      await host.replaceQuery(recoveredCut ? { resumeSessionAt: recoveredCut } : undefined);
    } catch (recoveryError) {
      throw await host.abandon(recoveryError);
    }
    // After the recovery, so the session can be prompted.
    if (!restored) throw pointNotRemoved();
    return { rewound: false, reason: "providerRefused" };
  }
  host.rewound(cursorId);
  return { rewound: true };
}

/** Whether Claude Code refused the cut (see `resumeDropsTurn` of the SDK options). */
export function isRewindRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Resume rejected by --resume-drops-turn:");
}

/** Whether a message opens a turn: a prompt of the user, not a tool result or injected context. */
function startsTurn(message: SessionMessage): boolean {
  if (
    message.type !== "user" ||
    message.parent_tool_use_id !== null ||
    isReplayHiddenMetaMessage(message) ||
    isCompactSummaryMessage(message)
  ) {
    return false;
  }
  const content = (message.message as { content?: unknown } | undefined)?.content;
  return !(
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => (block as { type?: unknown } | null)?.type === "tool_result")
  );
}

/**
 * The history of `sessionId` that a cursor of it is resolved against: the
 * conversation the session continues, cut at its rewind point.
 */
export async function loadRewindableHistory(
  sessionId: string,
  logger?: Logger,
): Promise<RewindableHistory> {
  const current = await cutAtRewindPoint(sessionId, await getSessionMessages(sessionId), logger);
  return { current, visible: await readHistoryAcrossCompactions(sessionId, current, logger) };
}

/**
 * `stored`, the `getSessionMessages` chain of `sessionId`, without the branch
 * that a pending rewind dropped. Cut before reading across compactions: the
 * newest leaf is the last retained message.
 */
export async function cutAtRewindPoint<M extends { uuid?: string | null }>(
  sessionId: string,
  stored: readonly M[],
  logger?: Logger,
): Promise<M[]> {
  return activeSessionMessages(stored, await readRewindPoint(sessionId, logger));
}

/**
 * The entry that a fork of the whole of `sessionId` ends at while a rewind is
 * pending, or undefined when there is none: the newest leaf then still lies in
 * the dropped branch.
 */
export async function pendingRewindEnd(
  sessionId: string,
  logger?: Logger,
): Promise<string | undefined> {
  const point = await readRewindPoint(sessionId, logger);
  if (!point) return undefined;
  const stored = await getSessionMessages(sessionId);
  return stored.some((message) => message.uuid === point.droppedPromptUuid)
    ? point.resumeSessionAt
    : undefined;
}

/**
 * `entries`, the records of the whole transcript of `sessionId` with its
 * inactive branches, without the dropped prompt of a rewind and the records
 * that descend from it. A record comes after its parent in the transcript.
 */
export async function withoutRewoundBranch(
  sessionId: string,
  entries: SessionStoreEntry[],
  logger?: Logger,
): Promise<SessionStoreEntry[]> {
  const point = await readRewindPoint(sessionId, logger);
  if (!point) return entries;
  const dropped = new Set<string>([point.droppedPromptUuid]);
  return entries.filter((entry) => {
    if (typeof entry.uuid !== "string") return true;
    const parent = entry.parentUuid || entry.logicalParentUuid;
    const inDropped =
      entry.uuid === point.droppedPromptUuid || (typeof parent === "string" && dropped.has(parent));
    if (inDropped) dropped.add(entry.uuid);
    return !inDropped;
  });
}

/**
 * The messages of the conversation that a session continues, given its stored
 * `history` and its `rewindPoint`. A rewind leaves the dropped branch in the
 * transcript, and until the next prompt writes a branch from the point,
 * `history` still ends in the dropped branch: it is cut before the dropped
 * prompt. Once a branch descends from the point, `history` no longer holds the
 * dropped prompt and is returned as it is.
 */
export function activeSessionMessages<M extends { uuid?: string | null }>(
  history: readonly M[],
  rewindPoint: RewindPoint | undefined,
): M[] {
  const at = rewindPoint
    ? history.findIndex((message) => message.uuid === rewindPoint.droppedPromptUuid)
    : -1;
  return at === -1 ? [...history] : history.slice(0, at);
}

/** A rewind: the entry the session resumes at, and the prompt it dropped. */
export type RewindPoint = {
  /** The last retained entry, for `resumeSessionAt`. */
  resumeSessionAt: string;
  /** The first entry of the dropped branch: the user prompt the rewind removed. */
  droppedPromptUuid: string;
};

/** `<projectDir>/<sessionId>/rewind.json`, beside the session's `subagents/`. */
async function rewindPointFile(sessionId: string): Promise<string | undefined> {
  const transcript = await findTranscript(sessionId);
  return transcript && path.join(path.dirname(transcript), sessionId, "rewind.json");
}

/** Records the last rewind of a session. */
export async function writeRewindPoint(sessionId: string, point: RewindPoint): Promise<void> {
  const target = await rewindPointFile(sessionId);
  if (!target) throw new Error(`Session ${sessionId} has no transcript`);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp.${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporary, JSON.stringify(point), { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * The last rewind of a session, or undefined for one that has none (no
 * `rewind.json`, ENOENT). A record that cannot be read (EACCES, EISDIR) or
 * parsed fails with an internal error: reading it as "no rewind" would show or
 * resume the dropped turns. The file stays, so the client can retry.
 */
export async function readRewindPoint(
  sessionId: string,
  logger?: Logger,
): Promise<RewindPoint | undefined> {
  try {
    const file = await rewindPointFile(sessionId);
    if (!file) return undefined;
    let point: Partial<RewindPoint>;
    try {
      point = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return undefined;
      throw error;
    }
    const { resumeSessionAt, droppedPromptUuid } = point ?? {};
    if (typeof resumeSessionAt !== "string" || typeof droppedPromptUuid !== "string") {
      throw new Error("rewind.json holds no resumeSessionAt and droppedPromptUuid");
    }
    return { resumeSessionAt, droppedPromptUuid };
  } catch (error) {
    logger?.error(`Failed to read the rewind point of session ${sessionId}:`, error);
    throw RequestError.internalError(
      undefined,
      `Session ${sessionId} was rewound, but its rewind point cannot be read (${error instanceof Error ? error.message : String(error)}). Try again.`,
    );
  }
}

/** Removes the record of the last rewind. */
export async function clearRewindPoint(sessionId: string): Promise<void> {
  const file = await rewindPointFile(sessionId);
  if (file) await rm(file, { force: true });
}

/**
 * Prepares the transcript of `sessionId` for a resume, and returns the entry
 * that a pending rewind point makes the resume stop at, if any.
 *
 * Claude Code resumes the branch of the leaf that the last `last-prompt` line
 * of the transcript names, and looks up `resumeSessionAt` on that branch only.
 * A process that resumed at a rewind point keeps writing that line with the
 * leaf it loaded until it exits, and a query restart starts the next process
 * before the closed one has exited, so the line can name the branch that the
 * rewind dropped. A second rewind then fails with "No message found with
 * message.uuid of ...", and a plain resume brings the dropped turns back. So
 * the line is written for the leaf of the session's conversation: explicit at
 * a pending rewind point, whose dropped branch descends from it, and plain at
 * the newest entry otherwise. Once the point is no longer pending, the plain
 * line is all the next process needs, and `rewind.json` is removed.
 */
export async function prepareRewoundResume(
  sessionId: string,
  logger?: Logger,
): Promise<string | undefined> {
  const point = await readRewindPoint(sessionId, logger);
  if (!point) return undefined;
  try {
    const history = await loadFullSessionHistory(sessionId);
    const byUuid = entriesByUuid(history);
    const newest = newestMainChainUuid(history);
    if (!newest) return undefined;
    const active = chainUuids(newest, byUuid);
    const pending = isPending(point, history, active);
    const leaf = pending ? point.resumeSessionAt : newest;
    await markResumedLeaf(sessionId, history, byUuid, leaf, pending);
    if (!pending) await clearRewindPoint(sessionId);
    return pending ? point.resumeSessionAt : undefined;
  } catch (error) {
    // A plain resume would bring the dropped turns back, so the resume fails
    // instead and the client can retry.
    logger?.error(`Failed to prepare the resume of rewound session ${sessionId}:`, error);
    throw RequestError.internalError(
      undefined,
      `Session ${sessionId} was rewound, but the cut could not be prepared (${error instanceof Error ? error.message : String(error)}). Try again.`,
    );
  }
}

/**
 * Whether the rewind is still to be applied: the dropped prompt is on the newest
 * conversation chain, or that chain does not pass through the point's resume
 * entry and holds nothing written after it (a branch from before the cut).
 * A chain through the resume entry without the dropped prompt is the edited
 * conversation, which a later entry of any other kind must not undo.
 */
function isPending(
  point: RewindPoint,
  history: SessionStoreEntry[],
  active: ReadonlySet<string>,
): boolean {
  const pointIndex = history.findIndex((entry) => entry.uuid === point.resumeSessionAt);
  if (pointIndex < 0) return false;
  if (active.has(point.droppedPromptUuid)) return true;
  if (active.has(point.resumeSessionAt)) return false;
  return !history.some((entry, index) => index > pointIndex && active.has(entry.uuid as string));
}

async function markResumedLeaf(
  sessionId: string,
  history: SessionStoreEntry[],
  byUuid: Map<string, SessionStoreEntry>,
  leaf: string,
  explicit: boolean,
): Promise<void> {
  const transcript = await findTranscript(sessionId);
  if (!transcript) return;
  const lines = (await readFile(transcript, "utf8")).split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (!line.includes('"last-prompt"')) continue;
    try {
      const record = JSON.parse(line);
      if (record.type !== "last-prompt") continue;
      if (record.leafUuid === leaf && (record.explicit === true) === explicit) return;
      break;
    } catch {
      continue;
    }
  }
  const branch = chainUuids(leaf, byUuid);
  const lastPrompt = history
    .filter((entry) => branch.has(entry.uuid as string) && entry.type === "user")
    .map(promptText)
    .findLast((text) => text !== undefined);
  const record = {
    type: "last-prompt",
    ...(lastPrompt !== undefined ? { lastPrompt } : {}),
    leafUuid: leaf,
    ...(explicit ? { explicit: true } : {}),
    sessionId,
  };
  const separator = lines.at(-1) === "" ? "" : "\n";
  await appendFile(transcript, `${separator}${JSON.stringify(record)}\n`);
}

/** The text of a user entry that carries a prompt, undefined for any other. */
function promptText(entry: SessionStoreEntry): string | undefined {
  if (entry.isMeta === true || isCompactSummaryMessage(entry)) return undefined;
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  if (content.some((block) => (block as { type?: unknown } | null)?.type === "tool_result")) {
    return undefined;
  }
  const text = content
    .map((block) => block as { type?: unknown; text?: unknown } | null)
    .flatMap((block) =>
      block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("");
  return text.length > 0 ? text : undefined;
}

/** An entry of the main conversation: not a subagent's, and not the transcript of a tool. */
function isMainChainEntry(entry: SessionStoreEntry): boolean {
  return (
    entry.isSidechain !== true && entry.parent_tool_use_id == null && entry.parent_agent_id == null
  );
}

/** The entry types that the SDK reads as the conversation's chain; other records
 *  (titles, tags, summaries) are metadata even when they carry a `uuid`. */
const CHAIN_ENTRY_TYPES: ReadonlySet<unknown> = new Set([
  "user",
  "assistant",
  "system",
  "attachment",
]);

/** The uuid of the newest entry of the main conversation: the leaf that
 *  `getSessionMessages` reads. Like it, skips `progress` entries. */
function newestMainChainUuid(entries: SessionStoreEntry[]): string | undefined {
  return entries.findLast(
    (entry) =>
      typeof entry.uuid === "string" &&
      CHAIN_ENTRY_TYPES.has(entry.type) &&
      isMainChainEntry(entry),
  )?.uuid;
}

/** The uuids of `leaf` and of every entry it descends from. A compaction
 *  boundary has no `parentUuid`; its `logicalParentUuid` carries the chain on. */
function chainUuids(
  leaf: string | undefined,
  byUuid: ReadonlyMap<string, SessionStoreEntry>,
): Set<string> {
  const chain = new Set<string>();
  let cursor = leaf;
  while (cursor && !chain.has(cursor)) {
    const entry = byUuid.get(cursor);
    if (!entry) break;
    chain.add(cursor);
    const parent = entry.parentUuid || entry.logicalParentUuid;
    cursor = typeof parent === "string" ? parent : undefined;
  }
  return chain;
}

function entriesByUuid(entries: SessionStoreEntry[]): Map<string, SessionStoreEntry> {
  return new Map(
    entries.flatMap((entry) => (typeof entry.uuid === "string" ? [[entry.uuid, entry]] : [])),
  );
}
