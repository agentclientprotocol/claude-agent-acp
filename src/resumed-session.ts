import {
  getSessionMessages,
  type SessionMessage,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { randomBytes } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { claudeConfigDir } from "./paths.js";
import {
  chainUuids,
  entriesByUuid,
  loadFullSessionHistory,
  newestMainChainUuid,
  userPromptText,
} from "./session-history-point.js";
import { SessionTiming } from "./session-timing.js";

/** The size of one backward read of a transcript. */
const TAIL_CHUNK_BYTES = 64 * 1024;

type ResumeLogger = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type ResumedSessionSnapshot = {
  messages?: SessionMessage[];
  model?: string;
};

/** Return the concrete model recorded by the last real assistant response.
 * Claude Code restores a resumed query from this same transcript field.
 * Synthetic assistant records use angle-bracket placeholders and do not
 * describe a model the resumed query can run. */
export function resumedModelFromTranscript(messages: SessionMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const entry = messages[index];
    if (
      entry?.type !== "assistant" ||
      entry.parent_tool_use_id != null ||
      entry.parent_agent_id != null ||
      !entry.message ||
      typeof entry.message !== "object"
    ) {
      continue;
    }
    const model = concreteModel((entry.message as { model?: unknown }).model);
    if (model) return model;
  }
  return undefined;
}

/** The model name, or undefined for a missing or a synthetic `<…>` model. */
function concreteModel(model: unknown): string | undefined {
  if (typeof model !== "string") return undefined;
  const name = model.trim();
  return name.length > 0 && !/^<[^>]+>$/.test(name) ? name : undefined;
}

/** Read the resume model from the local transcript without starting a Claude
 * control request. This is intentionally on the load critical path. */
export async function readResumedSession(
  sessionId: string,
  logger?: ResumeLogger,
): Promise<ResumedSessionSnapshot> {
  const timing = new SessionTiming(logger, "models", sessionId);
  try {
    // Deliberately search all project directories, matching replaySessionHistory.
    // A client may reopen a session from a worktree or normalized path that is
    // different from the directory under which Claude persisted the transcript.
    const messages = await activeSessionMessages(sessionId, logger);
    const model = resumedModelFromTranscript(messages);
    timing.phase("read-transcript", ` messages=${messages.length} model=${model ?? "unknown"}`);
    return { messages, model };
  } catch (error) {
    timing.phase("read-transcript", " outcome=error");
    logger?.error(`Failed to read transcript for resumed session ${sessionId}:`, error);
    return {};
  }
}

/** What a resume restores from the end of the local transcript. */
export type ResumedTail = {
  model?: string;
  /** The last permission mode of the main thread. See {@link TailScan}. */
  permissionMode?: string;
};

/**
 * Read the resume model and the permission mode of a session from the end
 * of its local transcript.
 *
 * A resume needs only these two values, not the messages. The transcript file
 * is read backwards until both are known, so the cost does not grow with the
 * length of the session. A session without a local transcript file falls back
 * to {@link readResumedSession} for the model.
 *
 * A caller that already has the model passes `withModel: false`. The read then
 * looks for the permission mode only and has no fallback.
 */
export async function readResumedTail(
  sessionId: string,
  logger?: ResumeLogger,
  withModel = true,
): Promise<ResumedTail> {
  const timing = new SessionTiming(logger, "models", sessionId);
  try {
    const filePath = await findTranscript(sessionId);
    if (filePath) {
      const tail = await lastTailRecords(filePath, withModel);
      timing.phase(
        "read-transcript-tail",
        ` model=${tail.model ?? "unknown"} permissionMode=${tail.permissionMode ?? "unknown"}`,
      );
      return tail;
    }
  } catch (error) {
    timing.phase("read-transcript-tail", " outcome=error");
    logger?.error(`Failed to read the transcript tail of resumed session ${sessionId}:`, error);
  }
  return withModel ? { model: (await readResumedSession(sessionId, logger)).model } : {};
}

/** The local transcript of a session in any project directory, as the SDK looks it up. */
export async function findTranscript(sessionId: string): Promise<string | undefined> {
  const projects = path.join(claudeConfigDir(), "projects");
  let directories: string[];
  try {
    directories = await readdir(projects);
  } catch {
    return undefined;
  }
  for (const directory of directories) {
    const candidate = path.join(projects, directory, `${sessionId}.jsonl`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Not in this project directory.
    }
  }
  return undefined;
}

/** The model of the last real assistant record and the last permission mode
 * of the main thread in a JSONL transcript. */
async function lastTailRecords(filePath: string, withModel: boolean): Promise<ResumedTail> {
  const handle = await open(filePath, "r");
  const scan = new TailScan(withModel);
  try {
    let end = (await handle.stat()).size;
    // The bytes of the line whose start is not read yet, in file order.
    let pending: Buffer[] = [];
    while (end > 0) {
      const start = Math.max(0, end - TAIL_CHUNK_BYTES);
      let chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      for (let at = chunk.lastIndexOf(0x0a); at >= 0; at = chunk.lastIndexOf(0x0a)) {
        if (scan.visit(Buffer.concat([chunk.subarray(at + 1), ...pending]))) return scan.tail;
        pending = [];
        chunk = chunk.subarray(0, at);
      }
      pending.unshift(chunk);
      end = start;
    }
    scan.visit(Buffer.concat(pending));
    return scan.tail;
  } finally {
    await handle.close();
  }
}

type TranscriptRecord = {
  type?: unknown;
  isSidechain?: unknown;
  message?: { model?: unknown };
  permissionMode?: unknown;
  origin?: { kind?: unknown };
  attachment?: { type?: unknown };
};

/**
 * Reads the lines of a transcript from the end and keeps what a resume needs.
 *
 * Claude Code records the permission mode on each prompt record of type `user`.
 * The `permission-mode` records of the CLI metadata block are not used: they
 * can disagree with the prompts, and the SDK does not write them.
 * The SDK writes no record when it leaves plan mode through ExitPlanMode.
 * It writes a `plan_mode_exit` attachment only, without the new mode. Thus a
 * `plan` mode before a later plan exit is not the current mode, and the scan
 * gives no mode.
 *
 * The mode search stops at the first mode record or at the last human prompt.
 * Each human prompt of a current Claude Code has the mode, so a prompt without
 * it means that the transcript does not record modes. A compaction does not
 * stop the search: the mode of the prompt before it is still current.
 */
class TailScan {
  readonly tail: ResumedTail = {};
  private modeDone = false;
  private planExited = false;

  constructor(private readonly withModel: boolean) {}

  /** Visit the previous line. Return true when the scan has all it needs. */
  visit(line: Buffer): boolean {
    let parsed: TranscriptRecord | null | undefined;
    // Most lines have no marker of interest. The check skips their JSON parse.
    const record = (marker: string): TranscriptRecord | undefined => {
      if (line.indexOf(marker) < 0) return undefined;
      if (parsed === undefined) parsed = parseMainThreadRecord(line);
      return parsed ?? undefined;
    };
    if (this.withModel && this.tail.model === undefined) {
      const entry = record('"assistant"');
      if (entry?.type === "assistant") this.tail.model = concreteModel(entry.message?.model);
    }
    if (!this.modeDone) this.visitForMode(record);
    return (!this.withModel || this.tail.model !== undefined) && this.modeDone;
  }

  private visitForMode(record: (marker: string) => TranscriptRecord | undefined): void {
    const modeEntry = record('"permissionMode"');
    if (
      modeEntry?.type === "user" &&
      typeof modeEntry.permissionMode === "string" &&
      modeEntry.permissionMode.trim() !== ""
    ) {
      const mode = modeEntry.permissionMode.trim();
      this.modeDone = true;
      if (!(this.planExited && mode === "plan")) this.tail.permissionMode = mode;
      return;
    }
    if (record('"plan_mode_exit"')?.attachment?.type === "plan_mode_exit") {
      this.planExited = true;
      return;
    }
    const human = record('"human"');
    if (human?.type === "user" && human.origin?.kind === "human") this.modeDone = true;
  }
}

/** The parsed record of one line, or null for a subagent record or a bad line. */
function parseMainThreadRecord(line: Buffer): TranscriptRecord | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;
  const record = entry as TranscriptRecord;
  return record.isSidechain === true ? null : record;
}

/** The messages of the conversation the session continues, as
 *  `getSessionMessages` returns them, cut at a pending rewind point. */
export async function activeSessionMessages(
  sessionId: string,
  logger?: ResumeLogger,
): Promise<SessionMessage[]> {
  const messages = await getSessionMessages(sessionId);
  const pending = (await rewoundSession(sessionId, logger))?.pending;
  if (!pending) return messages;
  const at = messages.findIndex((message) => message.uuid === pending.droppedPromptUuid);
  return at === -1 ? messages : messages.slice(0, at);
}

/** A rewind: the entry the session resumed at, and the prompt it dropped. */
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

/** Records the last rewind of a session (see {@link rewoundSession}). */
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

/** Where the conversation of a rewound session ends (see {@link rewoundSession}). */
export type RewoundSession = {
  leaf: string;
  /** The text of the last user prompt up to `leaf`, for the `last-prompt` line. */
  lastPrompt?: string;
  pending?: RewindPoint;
};

/**
 * Where the conversation of a rewound session ends, or `undefined` for a
 * session that was never rewound. The transcript keeps every branch a rewind
 * left behind:
 *
 * - `pending`: no entry descends from the last rewind point yet, other than
 *   through the prompt it dropped. A truncating resume writes nothing to the
 *   transcript, so it still ends inside the dropped turn until the next
 *   prompt, and the conversation ends at the point.
 * - Otherwise the conversation ends at the newest entry, the leaf that
 *   `getSessionMessages` reads.
 *
 * `entries` is the full history, when the caller has it.
 */
export async function rewoundSession(
  sessionId: string,
  logger?: ResumeLogger,
  entries?: SessionStoreEntry[],
): Promise<RewoundSession | undefined> {
  const file = await rewindPointFile(sessionId);
  if (!file) return undefined;
  try {
    let point: Partial<RewindPoint>;
    try {
      point = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return undefined;
      throw error;
    }
    const { resumeSessionAt, droppedPromptUuid } = point;
    const history = entries ?? (await loadFullSessionHistory(sessionId));
    const byUuid = entriesByUuid(history);
    const newest = newestMainChainUuid(history);
    if (!newest) return undefined;
    const active = chainUuids(newest, byUuid);
    const pending =
      typeof resumeSessionAt === "string" &&
      typeof droppedPromptUuid === "string" &&
      byUuid.has(resumeSessionAt) &&
      (!active.has(resumeSessionAt) || active.has(droppedPromptUuid))
        ? { resumeSessionAt, droppedPromptUuid }
        : undefined;
    const leaf = pending?.resumeSessionAt ?? newest;
    const branch = chainUuids(leaf, byUuid);
    const lastPrompt = history
      .filter((entry) => branch.has(entry.uuid as string) && entry.type === "user")
      .map(userPromptText)
      .findLast((text) => text !== undefined);
    return {
      leaf,
      ...(lastPrompt !== undefined ? { lastPrompt } : {}),
      ...(pending ? { pending } : {}),
    };
  } catch (error) {
    logger?.error(`Failed to read the rewind point of session ${sessionId}:`, error);
    return undefined;
  }
}

/**
 * Prepares the transcript of the session `sessionId` for a resume, and returns
 * the pending rewind point the resume must stop at, if any. Run before every
 * resume of a session.
 *
 * Claude Code resumes the branch of the leaf that the last `last-prompt` line
 * of the transcript names. A line without `explicit: true` stands for the
 * newest entry descending from its leaf, and Claude Code looks up
 * `resumeSessionAt` on that branch only. A process that resumed at a rewind
 * point keeps writing that line with the leaf it loaded until it exits, and a
 * query restart starts the next process before the closed one has exited, so
 * the line can name the branch the rewind dropped. A second rewind then fails
 * with "No message found with message.uuid of …", and a plain resume brings
 * the dropped turns back. So the line is written for the leaf of the
 * session's conversation: explicit at a pending rewind point, whose dropped
 * branch descends from it, and plain at the newest entry otherwise.
 *
 * Once the point is no longer pending, the plain line is all the next process
 * needs, and `rewind.json` is removed.
 */
export async function prepareRewoundResume(
  sessionId: string,
  logger?: ResumeLogger,
): Promise<string | undefined> {
  const rewound = await rewoundSession(sessionId, logger);
  if (!rewound) return undefined;
  await markResumedLeaf(sessionId, rewound);
  if (!rewound.pending) {
    const file = await rewindPointFile(sessionId);
    if (file) await rm(file, { force: true });
  }
  return rewound.pending?.resumeSessionAt;
}

async function markResumedLeaf(sessionId: string, rewound: RewoundSession): Promise<void> {
  const transcript = await findTranscript(sessionId);
  if (!transcript) return;
  const explicit = rewound.pending !== undefined;
  const lines = (await readFile(transcript, "utf8")).split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (!line.includes('"last-prompt"')) continue;
    try {
      const record = JSON.parse(line);
      if (record.type !== "last-prompt") continue;
      if (record.leafUuid === rewound.leaf && (record.explicit === true) === explicit) return;
      break;
    } catch {
      continue;
    }
  }
  const record = {
    type: "last-prompt",
    ...(rewound.lastPrompt !== undefined ? { lastPrompt: rewound.lastPrompt } : {}),
    leafUuid: rewound.leaf,
    ...(explicit ? { explicit: true } : {}),
    sessionId,
  };
  const separator = lines.at(-1) === "" ? "" : "\n";
  await appendFile(transcript, `${separator}${JSON.stringify(record)}\n`);
}
