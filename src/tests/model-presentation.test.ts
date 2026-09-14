import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query, type ModelInfo, type Query } from "@anthropic-ai/claude-agent-sdk";
import { buildModelConfigOption, getAvailableModels } from "../session-model.js";

const OPUS: ModelInfo = {
  value: "opus[1m]",
  resolvedModel: "claude-opus-5[1m]",
  displayName: "Opus (1M context)",
  description: "Opus 5 with 1M context · Best for everyday, complex tasks",
};

describe("versioned model display names", () => {
  beforeEach(() => vi.stubEnv("ANTHROPIC_MODEL", undefined));
  afterEach(() => vi.unstubAllEnvs());

  it("adds standard-family versions and preserves model identity and recommendation", async () => {
    const models: ModelInfo[] = [
      { ...OPUS, value: "default", displayName: "Default (recommended)" },
      OPUS,
      { value: "sonnet[1m]", displayName: "Sonnet 5 (1M context)", description: "" },
      { value: "custom", displayName: "Custom Opus (1M context)", description: "" },
    ];
    const setModel = vi.fn();
    const state = await getAvailableModels(
      { setModel } as unknown as Query,
      models,
      models,
      { getSettings: () => ({}) },
      { log: vi.fn(), error: vi.fn() },
      false,
      "model-presentation-test",
    );

    expect(state.availableModels).toEqual(
      models.map((model) => ({
        modelId: model.value,
        name: model === OPUS ? "Opus 5" : model.displayName,
        description: model.description,
      })),
    );
    expect(buildModelConfigOption(state, models, true)).toMatchObject({
      currentValue: "opus[1m]",
      _meta: { jetbrains: { air: { recommendedValue: "opus[1m]" } } },
      options: expect.arrayContaining([
        { value: "opus[1m]", name: "Opus 5", description: OPUS.description },
      ]),
    });
    expect(OPUS.displayName).toBe("Opus (1M context)");
    expect(setModel).not.toHaveBeenCalled();
  });

  it("adds major and minor versions without changing custom or already-versioned names", async () => {
    const models: ModelInfo[] = [
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        displayName: "Sonnet",
        description: "Sonnet 5 · Efficient for routine tasks",
      },
      {
        value: "haiku",
        resolvedModel: "claude-haiku-4-5-20251001",
        displayName: "Claude Haiku",
        description: "Fast",
      },
      {
        value: "fable",
        resolvedModel: "claude-fable-5-1",
        displayName: "Fable",
        description: "Fable 5.1 · Creative model",
      },
      {
        value: "opus[1m]",
        resolvedModel: "claude-opus-5[1m]",
        displayName: "Opus 5 (1M context)",
        description: "",
      },
      { value: "custom", displayName: "My Sonnet", description: "" },
      { value: "future", displayName: "Haiku (1M context)", description: "" },
      { value: "custom-versioned", displayName: "Fable 5.1 (1M context)", description: "" },
    ];
    const state = await getAvailableModels(
      {} as Query,
      models,
      models,
      { getSettings: () => ({}) },
      { log: vi.fn(), error: vi.fn() },
      false,
      "model-presentation-test",
    );

    expect(state.availableModels.map((model) => model.name)).toEqual([
      "Sonnet 5",
      "Claude Haiku 4.5",
      "Fable 5.1",
      "Opus 5 (1M context)",
      "My Sonnet",
      "Haiku (1M context)",
      "Fable 5.1 (1M context)",
    ]);
  });

  it("only moves the context hint out of the name when the description retains it", async () => {
    const models: ModelInfo[] = [
      {
        value: "opus-described[1m]",
        resolvedModel: "claude-opus-5[1m]",
        displayName: "Opus 5 (1M context)",
        description: "Opus 5 with 1M context",
      },
      {
        value: "opus-undescribed[1m]",
        resolvedModel: "claude-opus-5[1m]",
        displayName: "Opus 5 (1M context)",
        description: "",
      },
      {
        value: "fable-undescribed[1m]",
        resolvedModel: "claude-fable-5-1[1m]",
        displayName: "Fable (1M context)",
        description: "",
      },
    ];
    const state = await getAvailableModels(
      {} as Query,
      models,
      models,
      { getSettings: () => ({}) },
      { log: vi.fn(), error: vi.fn() },
      false,
      "model-presentation-test",
    );

    expect(state.availableModels.map((model) => model.name)).toEqual([
      "Opus 5",
      "Opus 5 (1M context)",
      "Fable 5.1 (1M context)",
    ]);
  });

  it("keeps the suffix if another selectable model is already named Opus", async () => {
    const models = [OPUS, { ...OPUS, value: "opus", displayName: "Opus" }];
    const state = await getAvailableModels(
      {} as Query,
      models,
      models,
      { getSettings: () => ({}) },
      { log: vi.fn(), error: vi.fn() },
      false,
      "model-presentation-test",
    );
    expect(state.availableModels.map((model) => model.name)).toEqual(["Opus (1M context)", "Opus"]);
  });
});

// Account-dependent model availability requires the same authenticated environment
// as the adapter. No prompt is sent: inspect only the SDK initialization response.
it.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "the real SDK exposes one named Opus with the expected context suffix",
  async () => {
    let finishInput!: () => void;
    const inputGate = new Promise<void>((resolve) => {
      finishInput = resolve;
    });
    // Keep stdin open for initialization without ever submitting a prompt.
    // eslint-disable-next-line require-yield
    async function* input() {
      await inputGate;
    }
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 25000);
    const q = query({ prompt: input(), options: { persistSession: false, abortController } });
    try {
      const { models } = await q.initializationResult();
      const opusModels = models.filter(
        (model) =>
          model.value !== "default" &&
          /\bopus\b/i.test(`${model.value} ${model.resolvedModel} ${model.displayName}`),
      );
      expect(opusModels).toHaveLength(1);
      expect(opusModels[0]).toMatchObject({
        value: "opus[1m]",
        displayName: "Opus (1M context)",
        resolvedModel: expect.stringMatching(/^claude-opus-.*\[1m\]$/),
        description: expect.stringContaining("1M context"),
      });
    } finally {
      clearTimeout(timeout);
      finishInput();
      q.close();
    }
  },
  30000,
);
