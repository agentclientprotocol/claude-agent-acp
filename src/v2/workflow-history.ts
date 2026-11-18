// Claude's SDK reads worker messages by agent ID. It omits the Workflow launch
// metadata from getSessionMessages, so recover the association from the
// native tool result and the matching run, never from assistant text.
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { workflowSnapshot, type WorkflowAgent } from "../workflow-progress.js";

export function workflowCalls(message: SessionMessage): string[] {
  if (message.type !== "assistant") return [];
  const blocks = (message.message as { content?: unknown } | null)?.content;
  return Array.isArray(blocks)
    ? blocks.flatMap((b) =>
        b?.type === "tool_use" && b.name === "Workflow" && typeof b.id === "string" ? [b.id] : [],
      )
    : [];
}

async function visitRecords(
  file: string,
  marker: string,
  visit: (record: Record<string, unknown>) => void,
): Promise<void> {
  const stream = createReadStream(file, { encoding: "utf8" });
  try {
    for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!line.includes(marker)) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record && typeof record === "object") visit(record);
    }
  } catch {
    // A file may not exist yet or may disappear during retention cleanup.
  } finally {
    stream.destroy();
  }
}

export type HistoricalWorkflowWorker = {
  agent: WorkflowAgent & { agentId: string };
  file: string;
};
function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
}

type Run = { runId: string; taskId: string };

async function readRun(folder: string, run: Run): Promise<HistoricalWorkflowWorker[]> {
  const directory = path.join(folder, "subagents", "workflows", run.runId);
  const agents = new Map<string, WorkflowAgent & { agentId: string }>();
  // The journal includes earlier attempts which may no longer appear in a
  // snapshot, and is available before the completed run is written.
  await visitRecords(path.join(directory, "journal.jsonl"), '"agentId"', (r) => {
    const agentId = r.agentId;
    if (!safeId(agentId)) return;
    if (r.type === "started" && typeof r.label === "string" && !agents.has(agentId)) {
      agents.set(agentId, { agentId, label: r.label, state: "unknown" });
    } else if (r.type === "result" && agents.has(agentId)) {
      agents.set(agentId, { ...agents.get(agentId)!, state: "done" });
    }
  });
  try {
    const summary = JSON.parse(
      await readFile(path.join(folder, "workflows", run.runId + ".json"), "utf8"),
    );
    if (summary && (summary.runId !== run.runId || summary.taskId !== run.taskId)) return [];
    if (summary) {
      const snapshot = workflowSnapshot(summary.workflowProgress);
      for (const agent of snapshot?.agents ?? []) {
        if (safeId(agent.agentId)) agents.set(agent.agentId, { ...agent, agentId: agent.agentId });
      }
    }
  } catch {
    /* A running Workflow has only its journal. */
  }
  return Array.from(agents.values(), (agent) => ({
    agent,
    file: path.join(directory, "agent-" + agent.agentId + ".jsonl"),
  }));
}

/** Only a result on the replayed chain for this owner's Workflow call may locate a run. */
export async function readWorkflowLaunches(
  rootId: string,
  ownerId: string,
  folder: string,
  ownerFile: string,
  messages: SessionMessage[],
): Promise<Map<string, HistoricalWorkflowWorker[]>> {
  const calls = new Set(messages.flatMap(workflowCalls));
  const results = new Map<string, string>();
  for (const m of messages) {
    if (m.type !== "user") continue;
    const blocks = (m.message as { content?: unknown } | null)?.content;
    if (!Array.isArray(blocks)) continue;
    const toolResults = blocks.filter((b) => b?.type === "tool_result");
    if (toolResults.length === 1 && calls.has(toolResults[0].tool_use_id))
      results.set(m.uuid, toolResults[0].tool_use_id);
  }
  const runs = new Map<string, Run>();
  if (results.size)
    await visitRecords(ownerFile, '"toolUseResult"', (r) => {
      if (
        r.type !== "user" ||
        r.sessionId !== rootId ||
        (ownerId === rootId ? r.isSidechain === true : r.agentId !== ownerId)
      )
        return;
      const callId = typeof r.uuid === "string" ? results.get(r.uuid) : undefined;
      const blocks = (r.message as { content?: unknown } | null)?.content;
      if (
        !callId ||
        !Array.isArray(blocks) ||
        !blocks.some((b) => b?.type === "tool_result" && b.tool_use_id === callId)
      )
        return;
      const t = r.toolUseResult as Record<string, unknown> | null;
      if (
        t?.taskType === "local_workflow" &&
        safeId(t.runId) &&
        t.runId.startsWith("wf_") &&
        typeof t.taskId === "string"
      ) {
        runs.set(callId, { runId: t.runId, taskId: t.taskId });
      }
    });
  const launches = new Map<string, HistoricalWorkflowWorker[]>();
  for (const [callId, run] of runs) launches.set(callId, await readRun(folder, run));
  return launches;
}
