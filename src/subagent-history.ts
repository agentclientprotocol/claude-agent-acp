import {
  getSessionInfo,
  getSubagentMessages,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { findTranscript } from "./resumed-session.js";

/** What the metadata file of a subagent says about it. */
export interface SubagentRecord {
  /** The SDK agent id, the name of its transcript. */
  agentId: string;
  /** The `name` that the Agent call gave it. */
  name?: string;
  /** Its role, the `subagent_type` of the Agent call. */
  agentType?: string;
  /** The short `description` of the Agent call. */
  description?: string;
  /** Whether the Agent call ran it in the background. */
  background: boolean;
  /** Whether the user stopped it. */
  stoppedByUser: boolean;
}

/** Where the subagent transcripts of a session are. */
export interface SubagentHistory {
  /** The subagent of each Agent or Task tool use that launched one. */
  agents: Map<string, SubagentRecord>;
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
  const agents = new Map<string, SubagentRecord>();
  const transcript = await findTranscript(sessionId);
  if (!transcript) return { agents };
  const directory = path.join(path.dirname(transcript), sessionId, "subagents");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return { agents };
  }
  await Promise.all(
    names.map(async (name) => {
      const match = /^agent-(.+)\.meta\.json$/.exec(name);
      if (!match) return;
      try {
        const meta = JSON.parse(await readFile(path.join(directory, name), "utf8")) as Record<
          string,
          unknown
        > | null;
        if (typeof meta?.toolUseId !== "string") return;
        const text = (value: unknown) => (typeof value === "string" ? value : undefined);
        agents.set(meta.toolUseId, {
          agentId: match[1]!,
          name: text(meta.name),
          agentType: text(meta.agentType),
          description: text(meta.description),
          background: meta.requestShape === "background",
          stoppedByUser: meta.stoppedByUser === true,
        });
      } catch {
        // A damaged meta file leaves its subagent without history.
      }
    }),
  );
  if (agents.size === 0) return { agents };
  // The folder name encodes the project directory, and the encoding loses
  // characters. The session info reads it back from the transcript.
  const dir = (await getSessionInfo(sessionId).catch(() => undefined))?.cwd;
  return dir ? { agents, dir } : { agents };
}

/**
 * The transcript of the subagent `agentId` of a session, or an empty list
 * when it cannot be read. With the project directory, the SDK skips its
 * search of every project; a session opened from another directory falls
 * back to that search.
 */
export async function readSubagentMessages(
  sessionId: string,
  agentId: string,
  history: SubagentHistory,
  logger: { error(...args: unknown[]): void },
): Promise<SessionMessage[]> {
  try {
    if (history.dir) {
      const messages = await getSubagentMessages(sessionId, agentId, { dir: history.dir });
      if (messages.length > 0) return messages;
    }
    return await getSubagentMessages(sessionId, agentId);
  } catch (error) {
    logger.error(`Failed to read the history of subagent ${agentId}:`, error);
    return [];
  }
}
