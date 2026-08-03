import { describe, expect, it } from "vitest";
import type { ModelUsage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ACCOUNTING_USAGE_METHOD,
  ACCOUNTING_USAGE_VERSION,
  createAccountingUsageState,
  recordAccountingResult,
} from "../accounting-usage.js";

function modelUsage(
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens: number,
  cacheCreationInputTokens: number,
): ModelUsage {
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 200000,
    maxOutputTokens: 64000,
  };
}

function result(
  uuid: string,
  models: Record<string, ModelUsage>,
  usage = {
    input_tokens: 1,
    output_tokens: 2,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 4,
  },
): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: usage as SDKResultMessage["usage"],
    modelUsage: models,
    permission_denials: [],
    uuid: uuid as SDKResultMessage["uuid"],
    session_id: "sdk-session",
  };
}

describe("accounting usage snapshot state", () => {
  it("exports the negotiated extension identity", () => {
    expect(ACCOUNTING_USAGE_METHOD).toBe("_claude/accountingUsage");
    expect(ACCOUNTING_USAGE_VERSION).toBe(1);
  });

  it("uses the full first aggregate snapshot as the first delta", () => {
    const state = createAccountingUsageState();

    const event = recordAccountingResult(
      state,
      "acp-session",
      result("result-1", { sonnet: modelUsage(10, 5, 20, 3) }),
      "user_turn",
    );

    expect(event).toMatchObject({
      source: "model_usage_delta",
      snapshotReset: false,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedReadTokens: 20,
        cachedWriteTokens: 3,
        totalTokens: 38,
      },
    });
  });

  it("subtracts successive cumulative snapshots component by component", () => {
    const state = createAccountingUsageState();
    recordAccountingResult(
      state,
      "acp-session",
      result("result-1", { sonnet: modelUsage(10, 5, 20, 3) }),
      "user_turn",
    );

    const event = recordAccountingResult(
      state,
      "acp-session",
      result("result-2", { sonnet: modelUsage(14, 7, 29, 8) }),
      "user_turn",
    );

    expect(event?.usage).toEqual({
      inputTokens: 4,
      outputTokens: 2,
      cachedReadTokens: 9,
      cachedWriteTokens: 5,
      totalTokens: 20,
    });
  });

  it("aggregates all model rows before computing a delta", () => {
    const state = createAccountingUsageState();

    const event = recordAccountingResult(
      state,
      "acp-session",
      result("result-1", {
        sonnet: modelUsage(10, 2, 20, 3),
        opus: modelUsage(7, 5, 11, 4),
      }),
      "user_turn",
    );

    expect(event?.usage).toEqual({
      inputTokens: 17,
      outputTokens: 7,
      cachedReadTokens: 31,
      cachedWriteTokens: 7,
      totalTokens: 62,
    });
  });

  it("emits a zero delta when model keys change but aggregate totals do not", () => {
    const state = createAccountingUsageState();
    recordAccountingResult(
      state,
      "acp-session",
      result("result-1", { sonnet: modelUsage(10, 5, 20, 3) }),
      "user_turn",
    );

    const event = recordAccountingResult(
      state,
      "acp-session",
      result("result-2", { "sonnet-latest": modelUsage(10, 5, 20, 3) }),
      "user_turn",
    );

    expect(event).toMatchObject({
      snapshotReset: false,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        totalTokens: 0,
      },
    });
  });

  it("treats a component decrease as a new snapshot baseline", () => {
    const state = createAccountingUsageState();
    recordAccountingResult(
      state,
      "acp-session",
      result("result-1", { sonnet: modelUsage(10, 5, 20, 3) }),
      "user_turn",
    );

    const event = recordAccountingResult(
      state,
      "acp-session",
      result("result-2", { sonnet: modelUsage(4, 2, 8, 1) }),
      "user_turn",
    );

    expect(event).toMatchObject({
      source: "model_usage_delta",
      snapshotReset: true,
      usage: {
        inputTokens: 4,
        outputTokens: 2,
        cachedReadTokens: 8,
        cachedWriteTokens: 1,
        totalTokens: 15,
      },
    });
  });

  it("falls back to normalized result usage when modelUsage is empty", () => {
    const state = createAccountingUsageState();
    const sdkResult = result("result-1", {}, {
      input_tokens: 2,
      output_tokens: 3,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 7,
    });

    const event = recordAccountingResult(state, "acp-session", sdkResult, "autonomous");

    expect(event).toMatchObject({
      scope: "autonomous",
      source: "result_usage_fallback",
      snapshotReset: false,
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        cachedReadTokens: 5,
        cachedWriteTokens: 7,
        totalTokens: 17,
      },
      resultUsage: {
        inputTokens: 2,
        outputTokens: 3,
        cachedReadTokens: 5,
        cachedWriteTokens: 7,
        totalTokens: 17,
      },
    });
    expect(state.previousModelUsageTotals).toBeNull();
  });

  it.each([
    ["NaN", Number.NaN],
    ["negative", -1],
    ["null", null],
  ])("uses fallback for a model row with an invalid %s counter", (_label, invalid) => {
    const state = createAccountingUsageState();
    const invalidModel = {
      ...modelUsage(10, 5, 20, 3),
      inputTokens: invalid,
    } as unknown as ModelUsage;

    const event = recordAccountingResult(
      state,
      "acp-session",
      result("result-1", { sonnet: invalidModel }),
      "user_turn",
    );

    expect(event).toMatchObject({
      source: "result_usage_fallback",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cachedReadTokens: 3,
        cachedWriteTokens: 4,
        totalTokens: 10,
      },
    });
    expect(state.previousModelUsageTotals).toBeNull();
  });

  it("deduplicates result UUIDs without changing the previous snapshot", () => {
    const state = createAccountingUsageState();
    recordAccountingResult(
      state,
      "acp-session",
      result("duplicate", { sonnet: modelUsage(10, 5, 20, 3) }),
      "user_turn",
    );

    const duplicate = recordAccountingResult(
      state,
      "acp-session",
      result("duplicate", { sonnet: modelUsage(100, 50, 200, 30) }),
      "user_turn",
    );
    const next = recordAccountingResult(
      state,
      "acp-session",
      result("result-2", { sonnet: modelUsage(14, 7, 29, 8) }),
      "user_turn",
    );

    expect(duplicate).toBeNull();
    expect(next?.usage).toEqual({
      inputTokens: 4,
      outputTokens: 2,
      cachedReadTokens: 9,
      cachedWriteTokens: 5,
      totalTokens: 20,
    });
  });
});
