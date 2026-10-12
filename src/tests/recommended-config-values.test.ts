import { describe, expect, it } from "vitest";
import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { buildConfigOptions, clientSupportsRecommendedConfigValue } from "../acp-agent.js";
import { AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY } from "../air-extension.js";

const MODES = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Manual", description: "Always ask before making changes" },
    { id: "plan", name: "Plan", description: "Create a plan before making changes" },
  ],
};

const MODELS = {
  currentModelId: "default",
  availableModels: [
    { modelId: "default", name: "Default" },
    { modelId: "opus", name: "Claude Opus" },
    { modelId: "sonnet", name: "Claude Sonnet" },
    { modelId: "haiku", name: "Claude Haiku" },
  ],
};

const MODEL_INFOS: ModelInfo[] = [
  {
    value: "default",
    displayName: "Default",
    description: "",
    resolvedModel: "claude-sonnet-4-6",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    value: "opus",
    displayName: "Claude Opus",
    description: "Most capable",
    resolvedModel: "claude-opus-4-6",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    value: "sonnet",
    displayName: "Claude Sonnet",
    description: "Balanced",
    resolvedModel: "claude-sonnet-4-6",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    value: "haiku",
    displayName: "Claude Haiku",
    description: "Fastest",
    resolvedModel: "claude-haiku-4-5",
  },
];

const RECOMMENDED_PRESENTATION = { useRecommendedValue: true };

function recommendedMeta(value: string) {
  return { jetbrains: { air: { version: 1, recommendedValue: value } } };
}

function selectOption(options: ReturnType<typeof buildConfigOptions>, id: string) {
  const option = options.find((candidate) => candidate.id === id);
  expect(option).toMatchObject({ id, type: "select" });
  return option as Extract<(typeof options)[number], { type: "select" }>;
}

describe("recommended config value capability", () => {
  it("is enabled through the common AIR capability list", () => {
    const capabilities: ClientCapabilities = {
      _meta: {
        jetbrains: {
          air: {
            version: 1,
            capabilities: [AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY],
          },
        },
      },
    };

    expect(clientSupportsRecommendedConfigValue(capabilities)).toBe(true);
  });

  it("keeps legacy behavior for omitted and malformed AIR metadata", () => {
    expect(clientSupportsRecommendedConfigValue(undefined)).toBe(false);
    expect(clientSupportsRecommendedConfigValue(null)).toBe(false);
    expect(clientSupportsRecommendedConfigValue({})).toBe(false);
    expect(
      clientSupportsRecommendedConfigValue({
        _meta: {
          jetbrains: {
            air: { version: 1, capabilities: ["someOtherCapability"] },
          },
        },
      }),
    ).toBe(false);
    expect(
      clientSupportsRecommendedConfigValue({
        _meta: {
          jetbrains: {
            air: {
              version: "1",
              capabilities: [AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY],
            },
          },
        },
      }),
    ).toBe(false);
  });
});

describe("buildConfigOptions recommended values presentation", () => {
  it("retains default model and effort entries without the capability", () => {
    const options = buildConfigOptions(MODES, MODELS, MODEL_INFOS, undefined);

    const model = selectOption(options, "model");
    expect(model.currentValue).toBe("default");
    expect(model.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "default" })]),
    );
    expect(model._meta).toBeUndefined();

    const effort = selectOption(options, "effort");
    expect(effort.currentValue).toBe("default");
    expect(effort.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "default" })]),
    );
    expect(effort._meta).toBeUndefined();
  });

  it("omits default entries and advertises concrete recommendations", () => {
    const options = buildConfigOptions(
      MODES,
      MODELS,
      MODEL_INFOS,
      undefined,
      [],
      "default",
      undefined,
      RECOMMENDED_PRESENTATION,
    );

    const mode = selectOption(options, "mode");
    expect(mode.currentValue).toBe("default");
    expect(mode.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "default" })]),
    );
    expect(mode._meta).toBeUndefined();

    const model = selectOption(options, "model");
    expect(model.currentValue).toBe("sonnet");
    expect(model.options).toHaveLength(3);
    expect(model.options.map((option) => ("value" in option ? option.value : undefined))).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
    expect(model.options).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "default" })]),
    );
    expect(model._meta).toEqual(recommendedMeta("sonnet"));

    const effort = selectOption(options, "effort");
    expect(effort.currentValue).toBe("medium");
    expect(effort.options).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "default" })]),
    );
    expect(effort._meta).toEqual(recommendedMeta("medium"));
  });

  it("preserves explicit selections while keeping independent recommendations", () => {
    const options = buildConfigOptions(
      MODES,
      { ...MODELS, currentModelId: "opus" },
      MODEL_INFOS,
      "high",
      [],
      "default",
      undefined,
      RECOMMENDED_PRESENTATION,
    );

    expect(selectOption(options, "model")).toMatchObject({
      currentValue: "opus",
      _meta: recommendedMeta("sonnet"),
    });
    expect(selectOption(options, "effort")).toMatchObject({
      currentValue: "high",
      _meta: recommendedMeta("medium"),
    });
  });

  it("keeps the legacy model sentinel when the SDK recommendation is not selectable", () => {
    const options = buildConfigOptions(
      MODES,
      MODELS,
      MODEL_INFOS.filter((model) => model.value === "default"),
      undefined,
      [],
      "default",
      undefined,
      RECOMMENDED_PRESENTATION,
    );

    const model = selectOption(options, "model");
    expect(model.currentValue).toBe("default");
    expect(model.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "default" })]),
    );
    expect(model._meta).toBeUndefined();
  });

  it.each(["claude-sonnet-4-6[1m]", "claude-sonnet-5"])(
    "does not substitute a similar model for the unavailable default %s",
    (resolvedModel) => {
      const infos = MODEL_INFOS.map((model) =>
        model.value === "default" ? { ...model, resolvedModel } : model,
      );
      const options = buildConfigOptions(
        MODES,
        MODELS,
        infos,
        undefined,
        [],
        "default",
        undefined,
        RECOMMENDED_PRESENTATION,
      );
      expect(selectOption(options, "model")).toMatchObject({ currentValue: "default" });
      expect(selectOption(options, "model")._meta).toBeUndefined();
    },
  );

  it("matches equivalent SDK context suffix spellings exactly", () => {
    const infos = MODEL_INFOS.map((model) => ({
      ...model,
      resolvedModel:
        model.value === "default"
          ? "claude-sonnet-4-6-1m"
          : model.value === "sonnet"
            ? "claude-sonnet-4-6[1m]"
            : model.resolvedModel,
    }));
    const options = buildConfigOptions(
      MODES,
      MODELS,
      infos,
      undefined,
      [],
      "default",
      undefined,
      RECOMMENDED_PRESENTATION,
    );
    expect(selectOption(options, "model")).toMatchObject({
      currentValue: "sonnet",
      _meta: recommendedMeta("sonnet"),
    });
  });

  it("uses an available effort when medium is not supported", () => {
    const infos = MODEL_INFOS.map((model) => ({
      ...model,
      supportedEffortLevels: ["high", "max"] as ModelInfo["supportedEffortLevels"],
    }));
    const options = buildConfigOptions(
      MODES,
      MODELS,
      infos,
      undefined,
      [],
      "default",
      undefined,
      RECOMMENDED_PRESENTATION,
    );
    expect(selectOption(options, "effort")).toMatchObject({
      currentValue: "high",
      _meta: recommendedMeta("high"),
    });
  });
});
