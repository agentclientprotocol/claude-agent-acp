import { getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
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
    const messages = await getSessionMessages(sessionId);
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
  /** The permission mode of the last main-thread user record. */
  permissionMode?: string;
};

/**
 * Read the resume model and the permission mode of a session from the end
 * of its local transcript.
 *
 * A resume needs only these two values, not the messages. The transcript file
 * is read backwards until both are found, so the cost does not grow with the
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

/** The resume model of a session. See {@link readResumedTail}. */
export async function readResumedModel(
  sessionId: string,
  logger?: ResumeLogger,
): Promise<string | undefined> {
  return (await readResumedTail(sessionId, logger)).model;
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

/** The model of the last real assistant record and the permission mode of the
 * last user record of the main thread in a JSONL transcript. */
async function lastTailRecords(filePath: string, withModel: boolean): Promise<ResumedTail> {
  const handle = await open(filePath, "r");
  const tail: ResumedTail = {};
  const visit = (line: Buffer): boolean => {
    if (withModel) tail.model ??= assistantModelOfLine(line);
    tail.permissionMode ??= permissionModeOfLine(line);
    return (!withModel || tail.model !== undefined) && tail.permissionMode !== undefined;
  };
  try {
    let end = (await handle.stat()).size;
    // The bytes of the line whose start is not read yet, in file order.
    let pending: Buffer[] = [];
    while (end > 0) {
      const start = Math.max(0, end - TAIL_CHUNK_BYTES);
      let chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      for (let at = chunk.lastIndexOf(0x0a); at >= 0; at = chunk.lastIndexOf(0x0a)) {
        if (visit(Buffer.concat([chunk.subarray(at + 1), ...pending]))) return tail;
        pending = [];
        chunk = chunk.subarray(0, at);
      }
      pending.unshift(chunk);
      end = start;
    }
    visit(Buffer.concat(pending));
    return tail;
  } finally {
    await handle.close();
  }
}

type TranscriptRecord = {
  type?: unknown;
  isSidechain?: unknown;
  message?: { model?: unknown };
  permissionMode?: unknown;
};

/** The parsed main-thread record of one line, if the line has `marker`. */
function mainThreadRecord(line: Buffer, marker: string): TranscriptRecord | undefined {
  // Most lines do not have the marker. The check skips their JSON parse.
  if (line.indexOf(marker) < 0) return undefined;
  let entry: unknown;
  try {
    entry = JSON.parse(line.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as TranscriptRecord;
  return record.isSidechain === true ? undefined : record;
}

function assistantModelOfLine(line: Buffer): string | undefined {
  const record = mainThreadRecord(line, '"assistant"');
  if (record?.type !== "assistant") return undefined;
  return concreteModel(record.message?.model);
}

/** Claude Code records the permission mode of the turn on a user record. */
function permissionModeOfLine(line: Buffer): string | undefined {
  const record = mainThreadRecord(line, '"permissionMode"');
  if (record?.type !== "user" || typeof record.permissionMode !== "string") return undefined;
  return record.permissionMode.trim() || undefined;
}
