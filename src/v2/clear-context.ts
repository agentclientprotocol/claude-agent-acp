/**
 * ExitPlanMode's "Yes, clear context" option on the v2 core: the
 * approved plan runs in a fresh context, in the same turn.
 *
 * The answer denies ExitPlanMode with an interrupt (`permissions/effects.ts`),
 * so the plan does not run in the old context. Claude Code ends that cycle
 * with an interruption result (`isExitPlanInterruptionResult`). The turn stays
 * open, and the session sends Claude Code `/clear`, which mounts a fresh
 * conversation (`conversation_reset`), sets the mode the user picked, and
 * sends the plan as the prompt "Implement the following plan". The turn ends
 * with that prompt's result, with the usage of the whole turn.
 *
 * The query stays, unlike v1's fresh query (`clear-context-coordinator.ts`):
 * `/clear` is Claude Code's own way to start a fresh conversation, and the
 * query's tasks, MCP servers and settings stay. The client sees the accepted plan's tool call `completed`, the
 * options with the new mode, a `usage_update` of an empty context, the plan
 * as the session's markdown plan, then the plan's run in the open turn, with
 * no `user_message` for the adapter's prompts.
 */
import type { AcpSessionNotification } from "../acp-subagents.js";
import type { ClearContextReset } from "../clear-context-coordinator.js";
import {
  acceptedPlanToolResult,
  isExitPlanInterruptionResult,
  observeExitPlanToolResults,
} from "../exit-plan.js";
import type { PermissionMode, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { quotaMeta, type AccumulatedUsage, type ModelTokenTally } from "../session-usage.js";
import type { TurnEnd } from "./outcome.js";

type Uuid = `${string}-${string}-${string}-${string}-${string}`;

/** What the session does for a fresh context. */
export interface ClearContextHost {
  /** Sends Claude Code the prompt `text` with `uuid`, as the adapter's own prompt. */
  push(text: string, uuid: Uuid): void;
  /** Sets the permission mode on the query and in the options. */
  enterMode(mode: PermissionMode): Promise<void>;
  /** Sends the fresh context's options, its empty usage, and the plan. */
  publish(plan: string): void;
  logError(message: string, error: unknown): void;
}

/** The turn while it continues in a fresh context. */
type Continuation = {
  reset: ClearContextReset;
  clearUuid: Uuid;
  planUuid: Uuid;
  /** The results of the turn so far: the old context's, and `/clear`'s. */
  carried: TurnEnd[];
  /** Whether the plan's prompt went out: once the fresh context is mounted. */
  planSent: boolean;
  /** Whether the plan's prompt started: its result ends the turn. */
  planStarted: boolean;
};

export class ClearContext {
  /** The plan the user accepted with clearing the context, until its interruption. */
  private accepted: ClearContextReset | undefined;
  /** An ExitPlanMode answer that interrupts the cycle, and whether its tool result came. */
  private interruption: { toolUseId: string; toolResultSeen: boolean } | undefined;
  private continuation: Continuation | undefined;
  /** The tool calls of the old context's tool uses, by id (`toolUseCache`). */
  private readonly toolUses: () => Record<string, { name: string } | undefined>;

  constructor(
    private readonly host: ClearContextHost,
    toolUses: () => Record<string, { name: string } | undefined>,
    private readonly newUuid: () => Uuid,
  ) {
    this.toolUses = toolUses;
  }

  /**
   * An ExitPlanMode answer that interrupts the cycle: "No, keep planning",
   * or a plan accepted with clearing the context (`reset`).
   */
  interrupting(toolUseId: string, reset: ClearContextReset | undefined): void {
    this.interruption = { toolUseId, toolResultSeen: false };
    this.accepted = reset;
  }

  /**
   * A user message of the main conversation. Returns the rewrite of its
   * updates: the accepted plan's tool result, which Claude Code reports as a
   * rejection, goes out `completed`, without the rejection's text.
   */
  toolResults(message: {
    type: string;
    tool_result_meta?: unknown;
    message?: { content?: unknown };
  }): ((notification: AcpSessionNotification) => AcpSessionNotification) | undefined {
    const state = {
      toolUseCache: this.toolUses(),
      pendingExitPlanModeInterruption: this.interruption,
      pendingExitPlanContextReset: this.accepted,
    };
    const acceptedToolUse = observeExitPlanToolResults(message, message.message?.content, state);
    this.interruption = state.pendingExitPlanModeInterruption;
    if (!acceptedToolUse) return undefined;
    return (notification) =>
      acceptedPlanToolResult(
        notification as Parameters<typeof acceptedPlanToolResult>[0],
        acceptedToolUse,
      ) as AcpSessionNotification;
  }

  /**
   * A result of the open turn. Returns whether the turn goes on: it is the
   * interruption of a plan accepted with clearing the context, or `/clear`'s.
   * The fresh context starts with the first.
   */
  holdsResult(message: SDKResultMessage, end: TurnEnd): boolean {
    const continuation = this.continuation;
    if (continuation) {
      if (continuation.planStarted) return false;
      continuation.carried.push(end);
      // Without a `conversation_reset` (an older Claude Code), `/clear`'s result shows it ran.
      this.mounted();
      return true;
    }
    const interruption = this.interruption;
    if (!interruption || !isExitPlanInterruptionResult(message, interruption)) return false;
    this.interruption = undefined;
    const reset = this.accepted;
    this.accepted = undefined;
    // "No, keep planning": the turn ends.
    if (!reset || reset.toolUseId !== interruption.toolUseId) return false;
    const clearUuid = this.newUuid();
    this.continuation = {
      reset,
      clearUuid,
      planUuid: this.newUuid(),
      carried: [end],
      planSent: false,
      planStarted: false,
    };
    this.host.push("/clear", clearUuid);
    return true;
  }

  /** Claude Code mounted a fresh conversation: the plan goes out in it. */
  conversationReset(): void {
    this.mounted();
  }

  /** Whether the open turn waits for the plan's prompt to start. */
  holdsTurn(): boolean {
    return this.continuation !== undefined && !this.continuation.planStarted;
  }

  /** Claude Code took in the prompt `uuid`. */
  promptStarted(uuid: string): void {
    if (this.continuation?.planUuid === uuid) this.continuation.planStarted = true;
  }

  /** Whether `uuid` is one of the adapter's prompts for the fresh context: the client gets no `user_message`. */
  ownsPrompt(uuid: string): boolean {
    return this.continuation?.clearUuid === uuid || this.continuation?.planUuid === uuid;
  }

  /**
   * The end of the turn that `end`'s result ends: with the usage of the
   * results before it in the turn, the old context's and `/clear`'s.
   */
  turnEnd(end: TurnEnd): TurnEnd {
    const carried = this.continuation?.carried;
    this.continuation = undefined;
    return carried && carried.length > 0 ? combinedEnd([...carried, end]) : end;
  }

  /**
   * The turn ends otherwise (a cancel, a close): the fresh context goes on
   * without the plan. Returns the uuids of the adapter's prompts that Claude
   * Code may still run, whose work the client did not see.
   */
  stop(): string[] {
    this.interruption = undefined;
    this.accepted = undefined;
    const continuation = this.continuation;
    this.continuation = undefined;
    if (!continuation || continuation.planStarted) return [];
    return continuation.planSent
      ? [continuation.clearUuid, continuation.planUuid]
      : [continuation.clearUuid];
  }

  /** The fresh context is mounted: the mode, the plan, and the plan's prompt. */
  private mounted(): void {
    const continuation = this.continuation;
    if (!continuation || continuation.planSent) return;
    continuation.planSent = true;
    const { mode, plan } = continuation.reset;
    // Nothing orders the mode before the plan's prompt but this chain: the
    // prompt goes out once Claude Code took the mode.
    void this.host
      .enterMode(mode)
      .catch((error: unknown) => this.host.logError("Failed to set the plan's mode", error))
      .then(() => {
        if (this.continuation !== continuation) return;
        this.host.publish(plan);
        this.host.push(`Implement the following plan:\n\n${plan}`, continuation.planUuid);
      });
  }
}

/** The end of a turn of several results: the last result, with their usage summed. */
function combinedEnd(ends: TurnEnd[]): TurnEnd {
  const total: AccumulatedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
  };
  const rows: ModelTokenTally = {};
  for (const { _meta } of ends) {
    add(total, _meta.quota.token_count);
    for (const row of _meta.quota.model_usage) {
      add(
        (rows[row.model] ??= {
          inputTokens: 0,
          outputTokens: 0,
          cachedReadTokens: 0,
          cachedWriteTokens: 0,
        }),
        row.token_count,
      );
    }
  }
  const last = ends[ends.length - 1];
  const meta = quotaMeta(total, rows);
  return {
    result: last.result,
    usage: { ...total, totalTokens: meta.quota.token_count.totalTokens },
    _meta: meta,
  };
}

function add(
  into: AccumulatedUsage,
  count: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cachedWriteTokens: number;
  },
): void {
  into.inputTokens += count.inputTokens;
  into.outputTokens += count.outputTokens;
  into.cachedReadTokens += count.cachedInputTokens;
  into.cachedWriteTokens += count.cachedWriteTokens;
}
