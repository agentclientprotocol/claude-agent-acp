import { readSessionHistory } from "./session-history.js";
import { type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { access, open, readdir } from "node:fs/promises";
import path from "node:path";
import { claudeConfigDir } from "./paths.js";
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
    const messages = await readSessionHistory(sessionId);
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
  uuid?: unknown;
  parentUuid?: unknown;
  explicit?: unknown;
  leafUuid?: unknown;
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
  private retainedParent: string | null | undefined;

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
    const anchor = record('"last-prompt"');
    if (
      anchor?.type === "last-prompt" &&
      anchor.explicit === true &&
      (anchor.leafUuid === null || typeof anchor.leafUuid === "string")
    ) {
      // Older anchors belong to discarded branches. Follow only the newest one.
      if (this.retainedParent === undefined) this.retainedParent = anchor.leafUuid;
      return this.retainedParent === null;
    }
    if (this.retainedParent !== undefined) {
      if (this.retainedParent === null) return true;
      const entry = record('"uuid"');
      if (entry?.uuid !== this.retainedParent) return false;
      this.retainedParent = typeof entry.parentUuid === "string" ? entry.parentUuid : null;
    }
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
