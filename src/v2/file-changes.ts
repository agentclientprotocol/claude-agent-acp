/**
 * AIR's agent file-change report (`agentFileChangeReport`) on a v2
 * session: a `session/prompt` asks for it in `_meta.jetbrains.air`, and the
 * turn that serves the prompt ends with one `session_info_update` that lists
 * the files it changed.
 *
 * v1 sends the report before the prompt's response, which comes at the
 * turn's end. A v2 prompt is answered at its insertion, so the report goes
 * out at the end of the turn that the prompt started or joined, before the
 * turn's idle. Building the report is shared with v1 (`file-change-audit.ts`):
 * a dry-run rewind of the prompt's checkpoint, and the file-tool edits of
 * subagents, which no checkpoint holds.
 */
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import {
  createNativeFileChangeReporter,
  recordSubagentFileEdits,
  type FileChangeReportUnavailableReason,
  type NativeFileChangeReporter,
  type NativeFileChangeReportTurn,
} from "../file-change-audit.js";

type ToolUses = Record<string, { name: string; input: unknown } | undefined>;

export class TurnFileChanges {
  /** The reports of the prompts that are not inserted yet, by prompt uuid. */
  private readonly pending = new Map<string, NativeFileChangeReportTurn>();
  /** The reports of the prompts that the open turn serves. */
  private readonly turn: NativeFileChangeReportTurn[] = [];
  /** The tool uses of subagents in the open turn, for their file edits. */
  private subagentToolUses: ToolUses = {};

  private constructor(private readonly reporter: NativeFileChangeReporter) {}

  /**
   * The reports of a session, or undefined when the client did not declare
   * `agentFileChangeReport`. `publish` sends one report's `_meta`.
   */
  static create(
    supported: boolean,
    options: Parameters<typeof createNativeFileChangeReporter>[0],
  ): TurnFileChanges | undefined {
    return supported ? new TurnFileChanges(createNativeFileChangeReporter(options)) : undefined;
  }

  /** A `session/prompt` came: its `_meta` may ask for a report. */
  requested(promptUuid: string, meta: unknown): void {
    const fileChangeReport = this.reporter.request(meta);
    if (fileChangeReport) this.pending.set(promptUuid, { promptUuid, fileChangeReport });
  }

  /** The prompt failed before Claude Code inserted it: -32800 for a cancel, or another error. */
  promptFailed(promptUuid: string, error: unknown): void {
    const report = this.pending.get(promptUuid);
    if (!report) return;
    this.pending.delete(promptUuid);
    const cancelled =
      error instanceof RequestError && error.code === RequestError.requestCancelled().code;
    this.reporter.finish(report.fileChangeReport, cancelled ? "cancelled" : "providerError");
  }

  /** Claude Code inserted the prompt: the open turn serves it. */
  promptStarted(promptUuid: string): void {
    const report = this.pending.get(promptUuid);
    if (!report) return;
    this.pending.delete(promptUuid);
    this.turn.push(report);
  }

  /**
   * The open turn goes on in a fresh context (`clear-context.ts`), with the
   * plan's prompt `planUuid`. `/clear` reset Claude Code's file history, so
   * the checkpoints of the turn's own prompts are gone: its reports read the
   * plan prompt's checkpoint. v1 sends the plan with the turn's prompt uuid
   * instead (`clear-context-coordinator.ts`).
   */
  contextCleared(planUuid: string): void {
    for (const report of this.turn) report.promptUuid = planUuid;
  }

  /** A message of the query: a subagent's file-tool edits go into the open turn's reports. */
  message(message: SDKMessage): void {
    if (this.turn.length === 0) return;
    if (message.type !== "assistant" && message.type !== "user") return;
    const parent = message.parent_tool_use_id;
    if (parent === null) return;
    const content = message.message.content;
    if (!Array.isArray(content)) return;
    if (message.type === "assistant") {
      for (const block of content) {
        if (block.type === "tool_use") {
          this.subagentToolUses[block.id] = { name: block.name, input: block.input };
        }
      }
      return;
    }
    for (const report of this.turn) {
      recordSubagentFileEdits(report, parent, content, this.subagentToolUses);
    }
  }

  /**
   * The open turn ends with `stopReason`. A turn that ended normally reads
   * each report from its prompt's checkpoint, which takes up to
   * `AGENT_FILE_CHANGE_REPORT_TIMEOUT_MS`: the returned promise resolves once
   * every report went out, and the turn's idle waits for it. A cancelled or
   * failed turn sends its reports `unavailable` at once.
   */
  turnEnding(
    stopReason: string,
    query: Pick<Query, "rewindFiles"> | undefined,
  ): Promise<void> | undefined {
    if (this.turn.length === 0) return undefined;
    if (stopReason === "cancelled" || stopReason === "error" || !query) {
      this.turnClosed(stopReason === "cancelled");
      return undefined;
    }
    const reports = this.turn.splice(0);
    this.subagentToolUses = {};
    return Promise.all(reports.map((report) => this.reporter.report(report, query))).then(() => {});
  }

  /**
   * The open turn closed. The reports that {@link turnEnding} did not read,
   * such as of a turn that ended without a result, go out `unavailable`:
   * `cancelled` after a cancel, else `providerError`.
   */
  turnClosed(cancelled: boolean): void {
    const reason: FileChangeReportUnavailableReason = cancelled ? "cancelled" : "providerError";
    for (const report of this.turn.splice(0)) this.reporter.finish(report.fileChangeReport, reason);
    this.subagentToolUses = {};
  }
}
