import {
  getSessionInfo,
  getSubagentMessages,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { isNativeSubagentControlTool, type HistoricalSubagent } from "./native-subagents.js";
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
  const directory = subagentsDirectory(transcript, sessionId);
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

/** The folder of the subagent transcripts, next to the session transcript `transcript`. */
function subagentsDirectory(transcript: string, sessionId: string): string {
  return path.join(path.dirname(transcript), sessionId, "subagents");
}

/**
 * The agent that the Agent or Task call `launchId` launched, from the subagent
 * history of the session `sessionId`.
 */
export async function subagentLaunchedBy(
  sessionId: string,
  launchId: string,
): Promise<string | undefined> {
  return (await subagentHistory(sessionId)).agents.get(launchId)?.agentId;
}

/**
 * The agent `agentId` and its ancestors, root first, from the subagent history
 * of the session `sessionId`. The runtime restores an agent from it when Claude
 * Code resumes one that ran before the session was loaded or resumed.
 *
 * The metadata file of an agent names the call that launched it, but not the
 * agent that made the call. So the parent of a launch is the session whose
 * transcript has the call, as in the replay: the session's own transcript, or
 * an agent's. The list is empty when the agent or one of its ancestors has no
 * metadata, or no transcript has its launch.
 */
export async function subagentLineage(
  sessionId: string,
  agentId: string,
  logger: { error(...args: unknown[]): void },
): Promise<HistoricalSubagent[]> {
  const history = await subagentHistory(sessionId);
  const launchOf = new Map<string, { launchId: string; record: SubagentRecord }>();
  for (const [launchId, record] of history.agents) {
    launchOf.set(record.agentId, { launchId, record });
  }
  if (!launchOf.has(agentId)) return [];

  // The SDK's readers return only the active chain, which starts after the
  // last compaction, so the launch calls come from the transcript files.
  const transcript = await findTranscript(sessionId);
  if (!transcript) return [];
  const rootLaunches = await readLaunchIdsFromTranscript(transcript, null, logger);
  const agentLaunches = new Map<string, Set<string>>();
  /** The agent whose transcript has the launch `launchId`, `null` for the root's. */
  const launcherOf = async (launchId: string): Promise<string | null | undefined> => {
    if (rootLaunches.has(launchId)) return null;
    for (const candidate of launchOf.keys()) {
      let launches = agentLaunches.get(candidate);
      if (!launches) {
        launches = await readLaunchIdsFromTranscript(
          path.join(subagentsDirectory(transcript, sessionId), `agent-${candidate}.jsonl`),
          candidate,
          logger,
        );
        agentLaunches.set(candidate, launches);
      }
      if (launches.has(launchId)) return candidate;
    }
    return undefined;
  };

  const lineage: HistoricalSubagent[] = [];
  let current: string | null = agentId;
  while (current !== null) {
    const launch = launchOf.get(current);
    // A cycle, or an ancestor without metadata.
    if (!launch || lineage.some((entry) => entry.agentId === current)) return [];
    const launcher = await launcherOf(launch.launchId);
    if (launcher === undefined) return [];
    lineage.unshift({
      agentId: current,
      launchId: launch.launchId,
      ...(launcher !== null ? { parentAgentId: launcher } : {}),
      ...(launch.record.name ? { name: launch.record.name } : {}),
      ...(launch.record.agentType ? { agentType: launch.record.agentType } : {}),
      ...(launch.record.description ? { description: launch.record.description } : {}),
    });
    current = launcher;
  }
  return lineage;
}

/** The ids of the Agent and Task calls that launched subagents in `content`. */
export function subagentLaunchIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    typeof block === "object" &&
    block !== null &&
    block.type === "tool_use" &&
    typeof block.id === "string" &&
    isNativeSubagentControlTool(block.name)
      ? [block.id as string]
      : [],
  );
}

/**
 * The ids of the launch calls in the transcript `file`, every record of it,
 * including those before a compaction. `owner` is the agent the transcript
 * belongs to, null for the session's. The session's transcript can hold
 * sidechain records, which are an agent's, not the root's; an agent's
 * transcript keeps only the records of that agent. A file that cannot be read
 * has no launches, so the agent is not placed under the root.
 */
async function readLaunchIdsFromTranscript(
  file: string,
  owner: string | null,
  logger: { error(...args: unknown[]): void },
): Promise<Set<string>> {
  const launches = new Set<string>();
  const stream = createReadStream(file, { encoding: "utf8" });
  try {
    for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!line.includes('"tool_use"')) continue;
      let record: {
        type?: unknown;
        isSidechain?: unknown;
        agentId?: unknown;
        message?: { content?: unknown };
      } | null;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type !== "assistant") continue;
      if (
        owner === null
          ? record.isSidechain === true
          : record.agentId !== undefined && record.agentId !== owner
      ) {
        continue;
      }
      for (const id of subagentLaunchIds(record.message?.content)) launches.add(id);
    }
  } catch (error) {
    logger.error(`Failed to read the transcript ${file}:`, error);
    return new Set();
  } finally {
    stream.destroy();
  }
  return launches;
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
