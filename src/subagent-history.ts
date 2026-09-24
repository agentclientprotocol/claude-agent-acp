import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { findTranscript } from "./resumed-session.js";

/** Where the subagent transcripts of a session are. */
export interface SubagentHistory {
  /** The subagent id of each Agent or Task tool use that launched a subagent. */
  ids: Map<string, string>;
  /**
   * The project directory of the session, as the SDK takes it in `dir`. With
   * it, the SDK reads a subagent transcript without a search of every project.
   */
  dir?: string;
}

/**
 * Finds the subagent transcripts of a session.
 *
 * Claude keeps the history of a subagent in its own transcript,
 * `<session>/subagents/agent-<id>.jsonl`, next to the session transcript.
 * The `agent-<id>.meta.json` file beside it names the launching tool use.
 * The ids are empty for a session without a local transcript.
 */
export async function subagentHistory(sessionId: string): Promise<SubagentHistory> {
  const ids = new Map<string, string>();
  const transcript = await findTranscript(sessionId);
  if (!transcript) return { ids };
  const directory = path.join(path.dirname(transcript), sessionId, "subagents");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return { ids };
  }
  await Promise.all(
    names.map(async (name) => {
      const match = /^agent-(.+)\.meta\.json$/.exec(name);
      if (!match) return;
      try {
        const meta: unknown = JSON.parse(await readFile(path.join(directory, name), "utf8"));
        const toolUseId = (meta as { toolUseId?: unknown } | null)?.toolUseId;
        if (typeof toolUseId === "string") ids.set(toolUseId, match[1]!);
      } catch {
        // A damaged meta file leaves its subagent without history.
      }
    }),
  );
  if (ids.size === 0) return { ids };
  // The folder name encodes the project directory, and the encoding loses
  // characters. The session info reads it back from the transcript.
  const dir = (await getSessionInfo(sessionId).catch(() => undefined))?.cwd;
  return dir ? { ids, dir } : { ids };
}
