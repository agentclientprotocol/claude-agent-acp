/**
 * How a turn of an ACP v2 session ends: the stop reason, usage, error
 * and `_meta.quota` of its `idle`. Whether Claude Code's result failed the
 * turn, and its stop reason or error text, follow the rules that the v1 core
 * reads its results with too (`resultEnd`). The error is the one v1 answers a
 * failed prompt with: an authentication failure is `authRequired`
 * (-32000), and any other carries the assistant message's error kind
 * (`data.errorKind`).
 */
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {
  SDKAssistantMessage,
  SDKAssistantMessageError,
  SDKRateLimitInfo,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AUTONOMOUS_RESULT_ORIGINS } from "../result-end.js";
import { isSyntheticLoginMessage } from "../message-filters.js";
import { resultEnd, turnErrorData } from "../result-end.js";
import { assistantMessageText, providerFailureCategory } from "../session-failure-extension.js";
import {
  getMatchingModelUsage,
  modelUsageIncrement,
  normalizeModelUsage,
  quotaMeta,
  resumedFirstResultModelUsage,
  tallyTotal,
  type AccumulatedUsage,
  type ModelTokenTally,
} from "../session-usage.js";

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

/** What a prompt's turn that ended without a result spent. */
const NOTHING_SPENT: AccumulatedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
};

/**
 * The stop reason, usage and `_meta.quota` of an idle, from the result that
 * ended the turn, and what its assistant messages reported (`report`).
 * `prompted`: a prompt started the turn. Without a result, such as when an
 * interrupt stopped the work before its result, a prompt's turn reports zero
 * usage and a zero quota, and a cycle that Claude Code started on its own
 * reports neither. A failed turn reports its error instead.
 */
export function idleOutcome(
  end: TurnEnd | undefined,
  cancelled: boolean,
  report?: TurnReport,
  prompted = false,
): IdleOutcome {
  const spent = end
    ? { usage: end.usage, _meta: end._meta }
    : prompted
      ? { usage: { ...NOTHING_SPENT, totalTokens: 0 }, _meta: quotaMeta(NOTHING_SPENT, {}) }
      : {};
  if (cancelled) return { stopReason: "cancelled", ...spent };
  // Claude Code's sign-in message fails the turn.
  if (report?.loginRequired) return failed(RequestError.authRequired());
  if (!end) return { stopReason: "end_turn", ...spent };
  const { result } = end;
  const ended = resultEnd(result);
  if (!("error" in ended)) return { stopReason: ended.stopReason, ...spent };
  const kind = report?.errorKind;
  // Only these subtypes read the assistant's error kind for the failure's
  // category.
  const authFailure =
    ended.loginRequired ||
    ((result.subtype === "success" || result.subtype === "error_during_execution") &&
      providerFailureCategory(kind) === "auth_required");
  return failed(
    authFailure
      ? // Claude Code's `/login` instruction is for its terminal, so that text
        // is left out. Any other says why the login failed, e.g. "Failed to
        // authenticate: this login reached its time limit and cannot be
        // renewed."
        RequestError.authRequired(undefined, ended.loginRequired ? undefined : ended.error)
      : RequestError.internalError(turnErrorData(kind, report?.rateLimit), ended.error),
  );
}

function failed(error: RequestError): IdleOutcome {
  return {
    stopReason: "error",
    error: {
      code: error.code,
      message: error.message,
      ...(error.data !== undefined ? { data: error.data } : {}),
    },
  };
}

/**
 * What the assistant messages of the open turn reported about its end: the
 * error kind and text of a failed API request, Claude Code's sign-in message,
 * and a refusal's explanation. Read from the main conversation's messages.
 */
export class TurnReport {
  errorKind: SDKAssistantMessageError | undefined;
  /** The turn's latest `rate_limit_event` info (see `turnErrorData`). */
  rateLimit: SDKRateLimitInfo | undefined;
  /** Claude Code showed its sign-in message ("Not logged in · Please run /login"). */
  loginRequired = false;
  /** The explanation of the turn's refusal. */
  refusalExplanation: string | undefined;
  /**
   * The text of the message that Claude Code wrote for a failed API request,
   * e.g. "API Error: Connection lost mid-response. The response above may be
   * incomplete.", until {@link takeApiError} reads it.
   */
  private apiError: string | undefined;

  /**
   * An assistant message of the main conversation. Returns whether the
   * client is not shown it as Claude's text:
   *
   * - Claude Code's sign-in message. Its `/login` instruction is for Claude
   *   Code's terminal, and the turn's idle fails with `authRequired` instead.
   * - The message that Claude Code wrote for a failed API request (`error` on
   *   a `<synthetic>` message). A notice carries it where the turn goes on
   *   past it. At the turn's end, the idle carries it when the turn fails,
   *   and a notice otherwise (see {@link takeApiError}).
   */
  assistant(message: SDKAssistantMessage): boolean {
    if (message.error) this.errorKind = message.error;
    if (message.message.stop_reason === "refusal") {
      this.refusalExplanation =
        message.message.stop_details?.explanation ?? this.refusalExplanation;
    }
    if (isSyntheticLoginMessage(message.message)) {
      this.loginRequired = true;
      return true;
    }
    if (!message.error || message.message.model !== "<synthetic>") return false;
    const text = assistantMessageText(message.message);
    if (!text) return false;
    this.apiError = text;
    return true;
  }

  /** The text of the turn's failed API request that no notice or idle reported yet. */
  takeApiError(): string | undefined {
    const text = this.apiError;
    this.apiError = undefined;
    return text;
  }

  /**
   * Claude Code's `model_refusal_no_fallback`: the explanation when the
   * refused message carried none (older CLIs, gateways that drop
   * `stop_details`). One for a turn that no user prompt started
   * (`refused_user_message_uuid: null`) is not this turn's.
   */
  refusalWithoutFallback(message: {
    api_refusal_explanation?: string | null;
    refused_user_message_uuid?: string | null;
    content: string;
  }): void {
    if (this.refusalExplanation || message.refused_user_message_uuid === null) return;
    this.refusalExplanation = message.api_refusal_explanation ?? message.content;
  }

  reset(): void {
    this.errorKind = undefined;
    this.rateLimit = undefined;
    this.loginRequired = false;
    this.refusalExplanation = undefined;
    this.apiError = undefined;
  }
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
