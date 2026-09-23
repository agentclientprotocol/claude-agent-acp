import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { findTranscript } from "./resumed-session.js";

/**
 * The subagent ids of a session, by the id of the Agent or Task tool use that
 * launched each subagent.
 *
 * Claude keeps the history of a subagent in its own transcript,
 * `<session>/subagents/agent-<id>.jsonl`, next to the session transcript.
 * The `agent-<id>.meta.json` file beside it names the launching tool use.
 * The map is empty for a session without a local transcript.
 */
export async function subagentIdsByToolUse(sessionId: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const transcript = await findTranscript(sessionId);
  if (!transcript) return ids;
  const directory = path.join(path.dirname(transcript), sessionId, "subagents");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return ids;
  }
  for (const name of names) {
    const match = /^agent-(.+)\.meta\.json$/.exec(name);
    if (!match) continue;
    try {
      const meta: unknown = JSON.parse(await readFile(path.join(directory, name), "utf8"));
      const toolUseId = (meta as { toolUseId?: unknown } | null)?.toolUseId;
      if (typeof toolUseId === "string") ids.set(toolUseId, match[1]!);
    } catch {
      // A damaged meta file leaves its subagent without history.
    }
  }
  return ids;
}
