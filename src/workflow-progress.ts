/**
 * The phases and agents of a running workflow, from the `workflow_progress`
 * snapshot that Claude Code attaches to a workflow's `task_progress`.
 *
 * The SDK does not type `workflow_progress` (SDK 0.3.319, CLI 2.1.319). Its
 * agents do not stream through the root query either, so this snapshot is
 * the only per-agent data the adapter gets. The shape below is what the CLI
 * sends: a full list of `workflow_phase` and `workflow_agent` entries on
 * some progress reports and none on others. Entries that don't match it are
 * skipped, so a change in the CLI drops the list instead of the card.
 */
import type { ToolCallContent } from "@agentclientprotocol/sdk/unstable";
import type { TaskProgressFields } from "./async-tasks.js";
import { textContent } from "./tool-calls/content.js";

export type WorkflowPhase = { index: number; title: string };

export type WorkflowAgent = {
  label: string;
  /** `start` while it runs and `done` when it finished, as the CLI names them. */
  state: string;
  phaseIndex?: number;
  attempt?: number;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  lastToolName?: string;
  lastToolSummary?: string;
};

export type WorkflowSnapshot = { phases: WorkflowPhase[]; agents: WorkflowAgent[] };

/** What a workflow card shows: the task's progress fields and its latest phase and agent list. */
export type WorkflowCardProgress = TaskProgressFields & { workflow?: WorkflowSnapshot };

/**
 * The latest workflow activity, as the title and the one replaceable body of
 * the workflow's tool call. Undefined when no progress came. For example, the
 * title `Workflow: Probe: probe` and the body:
 *
 * ```
 * Run a probe
 *
 * Last activity: probe
 *
 * 4,003 tokens · 2 tool calls · 1s
 * ```
 */
export function workflowCard(
  progress: WorkflowCardProgress | undefined,
): { title: string; content: ToolCallContent[] } | undefined {
  if (!progress || Object.keys(progress).length === 0) return undefined;
  const activity = progress.description ?? progress.summary;
  const usage = progress.usage;
  const text = [
    progress.summary ?? progress.description,
    progress.lastToolName ? `Last activity: ${progress.lastToolName}` : undefined,
    usage
      ? `${usage.totalTokens.toLocaleString("en-US")} tokens · ${usage.toolUses.toLocaleString("en-US")} tool calls · ${Math.floor(usage.durationMs / 1000)}s`
      : undefined,
    progress.workflow ? workflowSnapshotText(progress.workflow) : undefined,
  ]
    .filter((part) => part !== undefined)
    .join("\n\n");
  return {
    title: activity ? `Workflow: ${activity}` : "Workflow",
    content: [textContent(text)],
  };
}

/** Reads a `workflow_progress` value. Undefined when it holds no phase or agent. */
export function workflowSnapshot(value: unknown): WorkflowSnapshot | undefined {
  if (!Array.isArray(value)) return undefined;
  const phases: WorkflowPhase[] = [];
  const agents: WorkflowAgent[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (entry.type === "workflow_phase") {
      const title = text(entry.title);
      if (typeof entry.index === "number" && title) phases.push({ index: entry.index, title });
    } else if (entry.type === "workflow_agent") {
      const label = text(entry.label);
      const state = text(entry.state);
      if (!label || !state) continue;
      agents.push({
        label,
        state,
        ...numbers(entry, ["phaseIndex", "attempt", "tokens", "toolCalls", "durationMs"]),
        ...strings(entry, ["lastToolName", "lastToolSummary"]),
      });
    }
  }
  return phases.length > 0 || agents.length > 0 ? { phases, agents } : undefined;
}

/**
 * The snapshot as Markdown: each phase as a heading with its agents below,
 * after the agents that have no known phase. For example:
 *
 * ```
 * **Count**
 * - two: done · 14,629 tokens · 0 tool calls · 1s
 * - three: running · Bash: echo 3
 *
 * **Sum**
 * - not started
 * ```
 */
export function workflowSnapshotText(snapshot: WorkflowSnapshot): string {
  const known = new Set(snapshot.phases.map((phase) => phase.index));
  const unphased = snapshot.agents.filter(
    (agent) => agent.phaseIndex === undefined || !known.has(agent.phaseIndex),
  );
  const sections = unphased.length > 0 ? [unphased.map(agentLine).join("\n")] : [];
  for (const phase of snapshot.phases) {
    const agents = snapshot.agents.filter((agent) => agent.phaseIndex === phase.index);
    const lines = agents.length > 0 ? agents.map(agentLine) : ["- not started"];
    sections.push([`**${phase.title}**`, ...lines].join("\n"));
  }
  return sections.join("\n\n");
}

function agentLine(agent: WorkflowAgent): string {
  const state = agent.state === "start" ? "running" : agent.state;
  const attempt =
    agent.attempt !== undefined && agent.attempt > 1 ? ` (attempt ${agent.attempt})` : "";
  const parts = [`${agent.label}: ${state}${attempt}`];
  if (agent.tokens !== undefined) parts.push(`${agent.tokens.toLocaleString("en-US")} tokens`);
  if (agent.toolCalls !== undefined) {
    parts.push(`${agent.toolCalls.toLocaleString("en-US")} tool calls`);
  }
  if (agent.durationMs !== undefined) parts.push(`${Math.floor(agent.durationMs / 1000)}s`);
  // A finished agent's last tool is history; a running one's is what it does now.
  if (agent.state === "start" && agent.lastToolName) {
    parts.push(
      agent.lastToolSummary
        ? `${agent.lastToolName}: ${agent.lastToolSummary}`
        : agent.lastToolName,
    );
  }
  return `- ${parts.join(" · ")}`;
}

function numbers<K extends string>(record: Record<string, unknown>, keys: K[]) {
  return Object.fromEntries(
    keys.flatMap((key) => (typeof record[key] === "number" ? [[key, record[key]]] : [])),
  ) as Partial<Record<K, number>>;
}

function strings<K extends string>(record: Record<string, unknown>, keys: K[]) {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = text(record[key]);
      return value ? [[key, value]] : [];
    }),
  ) as Partial<Record<K, string>>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
