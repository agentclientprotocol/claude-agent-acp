import { getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { access, open, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

/**
 * Read the resume model of a session from the end of its local transcript.
 *
 * A resume needs only the model, not the messages. The transcript file is
 * read backwards until the last real assistant record of the main thread, so
 * the cost does not grow with the length of the session. A session without a
 * local transcript file falls back to {@link readResumedSession}.
 */
export async function readResumedModel(
  sessionId: string,
  logger?: ResumeLogger,
): Promise<string | undefined> {
  const timing = new SessionTiming(logger, "models", sessionId);
  try {
    const filePath = await findTranscript(sessionId);
    if (filePath) {
      const model = await lastAssistantModel(filePath);
      timing.phase("read-transcript-tail", ` model=${model ?? "unknown"}`);
      return model;
    }
  } catch (error) {
    timing.phase("read-transcript-tail", " outcome=error");
    logger?.error(`Failed to read the transcript tail of resumed session ${sessionId}:`, error);
  }
  return (await readResumedSession(sessionId, logger)).model;
}

/** The local transcript of a session in any project directory, as the SDK looks it up. */
async function findTranscript(sessionId: string): Promise<string | undefined> {
  const projects = path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    "projects",
  );
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

/** The model of the last real assistant record of the main thread in a JSONL transcript. */
async function lastAssistantModel(filePath: string): Promise<string | undefined> {
  const handle = await open(filePath, "r");
  try {
    let end = (await handle.stat()).size;
    // The bytes of the line whose start is not read yet, in file order.
    let pending: Buffer[] = [];
    while (end > 0) {
      const start = Math.max(0, end - TAIL_CHUNK_BYTES);
      let chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      for (let at = chunk.lastIndexOf(0x0a); at >= 0; at = chunk.lastIndexOf(0x0a)) {
        const model = assistantModelOfLine(Buffer.concat([chunk.subarray(at + 1), ...pending]));
        if (model) return model;
        pending = [];
        chunk = chunk.subarray(0, at);
      }
      pending.unshift(chunk);
      end = start;
    }
    return assistantModelOfLine(Buffer.concat(pending));
  } finally {
    await handle.close();
  }
}

function assistantModelOfLine(line: Buffer): string | undefined {
  // Most lines are not assistant records. The check skips their JSON parse.
  if (line.indexOf('"assistant"') < 0) return undefined;
  let entry: unknown;
  try {
    entry = JSON.parse(line.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as { type?: unknown; isSidechain?: unknown; message?: { model?: unknown } };
  if (record.type !== "assistant" || record.isSidechain === true) return undefined;
  return concreteModel(record.message?.model);
}
