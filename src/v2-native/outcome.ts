/**
 * How a turn of a native ACP v2 session ends: the stop reason, usage, error
 * and `_meta.quota` of its `idle`, read from Claude Code's result the way the
 * bridge reads it (`turnOutcome`, `autonomousCycleEnd` and `v2Foreground` of
 * the v1 core and `v2/prompt.ts`).
 */
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  AUTONOMOUS_RESULT_ORIGINS,
  getMatchingModelUsage,
  isLoginRequiredText,
} from "../acp-agent.js";
import {
  modelUsageIncrement,
  normalizeModelUsage,
  quotaMeta,
  resumedFirstResultModelUsage,
  tallyTotal,
  type AccumulatedUsage,
  type ModelTokenTally,
} from "../usage-quota.js";

/** A result that ended a turn, with what the turn spent. */
export type TurnEnd = {
  result: SDKResultMessage;
  usage: v2.Usage;
  _meta: ReturnType<typeof quotaMeta>;
};

/**
 * The idle members this core reports. Typed as those members, so the checker
 * matches each stop reason to its own, which it cannot against the whole
 * union with its custom and unknown members.
 */
export type IdleOutcome = Extract<
  v2.IdleStateUpdate,
  {
    stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | "error";
  }
>;

/**
 * The stop reason, usage and `_meta.quota` of an idle, from the result that
 * ended the turn. Work that ended without a result reports neither usage nor
 * quota. A failed turn reports its error instead, as the bridge does.
 */
export function idleOutcome(end: TurnEnd | undefined, cancelled: boolean): IdleOutcome {
  const spent = end ? { usage: end.usage, _meta: end._meta } : {};
  if (cancelled) return { stopReason: "cancelled", ...spent };
  if (!end) return { stopReason: "end_turn" };
  const { result } = end;
  // A refusal can come on any subtype, also with `is_error`.
  if (result.stop_reason === "refusal") return { stopReason: "refusal", ...spent };
  if (result.subtype === "error_max_turns") return { stopReason: "max_turn_requests", ...spent };
  if (result.stop_reason === "max_tokens") return { stopReason: "max_tokens", ...spent };
  if (result.subtype !== "success" || result.is_error) {
    const text = result.subtype === "success" ? result.result : result.errors.join("\n");
    const error =
      result.subtype === "success" && isLoginRequiredText(text)
        ? RequestError.authRequired()
        : RequestError.internalError(undefined, text || `Claude Code ended with ${result.subtype}`);
    return { stopReason: "error", error: { code: error.code, message: error.message } };
  }
  return { stopReason: "end_turn", ...spent };
}

/**
 * Whether `result` is a placeholder: Claude Code answers background-task
 * notifications that queued up with one model call, and gives each but the
 * last a result with `num_turns: 0` before that call runs. The cycle goes on
 * to the last one's result.
 */
export function isPlaceholderResult(result: SDKResultMessage): boolean {
  return (
    result.origin != null &&
    AUTONOMOUS_RESULT_ORIGINS.has(result.origin.kind) &&
    result.num_turns === 0 &&
    !result.is_error
  );
}

/**
 * What each result spent. `result.modelUsage` is a running total of the
 * query, so a result's rows are its increment over the previous reading. A
 * resumed query's first reading continues the totals of its transcript, so
 * that result's row is its own `usage`, under the model of the last
 * assistant message (see `resumedFirstResultModelUsage`).
 */
export class ResultUsage {
  private reading: ModelTokenTally | undefined;
  private model: string | null = null;

  constructor(resumed: boolean) {
    this.reading = resumed ? undefined : {};
  }

  /** An assistant message of the main conversation, by `model`. */
  assistant(model: string | undefined): void {
    if (model && model !== "<synthetic>") this.model = model;
  }

  /** What `result` spent. Every result moves the reading on, also a placeholder. */
  record(result: SDKResultMessage): TurnEnd {
    const tally: AccumulatedUsage = {
      inputTokens: result.usage.input_tokens ?? 0,
      outputTokens: result.usage.output_tokens ?? 0,
      cachedReadTokens: result.usage.cache_read_input_tokens ?? 0,
      cachedWriteTokens: result.usage.cache_creation_input_tokens ?? 0,
    };
    const reading = normalizeModelUsage(result.modelUsage);
    const key =
      this.model === null
        ? null
        : (getMatchingModelUsage(result.modelUsage ?? {}, this.model)?.key ?? this.model);
    const rows =
      this.reading === undefined
        ? resumedFirstResultModelUsage(result.usage, key)
        : modelUsageIncrement(reading, this.reading);
    this.reading = reading;
    return {
      result,
      usage: { ...tally, totalTokens: tallyTotal(tally) },
      _meta: quotaMeta(tally, rows),
    };
  }
}
