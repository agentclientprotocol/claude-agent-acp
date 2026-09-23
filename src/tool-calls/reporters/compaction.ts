import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  type ContextCompactionMetadata,
  createContextCompactionMeta,
} from "../../context-compaction-meta.js";
import { textContent } from "../content.js";

type CompactionFacts = Omit<ContextCompactionMetadata, "version">;
type ToolCallUpdate = SessionNotification["update"];

const TITLE = "Compact conversation";

/**
 * The synthetic "Compact conversation" tool call, for a client without the
 * ACP compaction updates.
 *
 * AIR detects it by `_meta.jetbrains.air.contextCompaction`, which holds the
 * trigger, the token counts, the duration, and the error. The error also goes
 * to `content` once, because it is the result to show. No `rawOutput` repeats
 * the facts for AIR.
 *
 * Every other client gets the upstream fields: the tool name `compact`, and
 * the facts in `rawOutput`. It gets no AIR key.
 */
export const compactionToolCall = {
  started(compactionId: string, airClient = false): ToolCallUpdate {
    return {
      sessionUpdate: "tool_call",
      toolCallId: compactionId,
      title: TITLE,
      kind: "think",
      status: "in_progress",
      _meta: meta({}, airClient),
    };
  },

  inProgress(compactionId: string, airClient = false): ToolCallUpdate {
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: compactionId,
      status: "in_progress",
      _meta: meta({}, airClient),
    };
  },

  /** The terminal report. A missed opening makes it the first report, a `tool_call`. */
  finished(
    compactionId: string,
    status: "completed" | "failed" | undefined,
    facts: CompactionFacts,
    first: boolean,
    airClient = false,
  ): ToolCallUpdate {
    const errorContent =
      status === "failed" && facts.error
        ? { content: [textContent(`Compaction failed: ${facts.error}`)] }
        : {};
    const rawOutput = !airClient && Object.keys(facts).length > 0 ? { rawOutput: facts } : {};
    if (first) {
      return {
        sessionUpdate: "tool_call",
        toolCallId: compactionId,
        title: TITLE,
        kind: "think",
        status: status ?? "completed",
        ...errorContent,
        ...rawOutput,
        _meta: meta(facts, airClient),
      };
    }
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: compactionId,
      ...(status ? { status } : {}),
      ...errorContent,
      ...rawOutput,
      _meta: meta(facts, airClient),
    };
  },
};

/** The compaction facts for AIR, and the upstream tool name for every other client. */
function meta(facts: CompactionFacts, airClient: boolean): Record<string, unknown> {
  return airClient ? createContextCompactionMeta(facts) : { claudeCode: { toolName: "compact" } };
}
