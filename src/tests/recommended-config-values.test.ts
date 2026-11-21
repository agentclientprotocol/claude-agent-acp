import { describe, expect, it } from "vitest";
import type { ClientCapabilities, SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  buildConfigOptions,
  clientSupportsModelReasoningEfforts,
  clientSupportsRecommendedConfigValue,
  orderedConfigOptions,
} from "../session-config-options.js";
import {
  AIR_MODEL_REASONING_EFFORTS_CAPABILITY,
  AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY,
} from "../air-extension.js";
import { recommendedEffortLevel } from "../session-effort.js";

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

describe("model reasoning efforts", () => {
  const EFFORTS_PRESENTATION = { useRecommendedValue: false, modelReasoningEfforts: true };

  function effortsMeta(values: string[], recommended: string) {
    return { jetbrains: { air: { version: 1, reasoningEfforts: { values, recommended } } } };
  }

  function entries(options: ReturnType<typeof buildConfigOptions>) {
    return selectOption(options, "model").options as Array<{
      value: string;
      _meta?: Record<string, unknown>;
    }>;
  }

  function entry(options: ReturnType<typeof buildConfigOptions>, value: string) {
    return entries(options).find((candidate) => candidate.value === value);
  }

  it("is enabled through the common AIR capability list", () => {
    const air = (capabilities: string[]) => ({
      _meta: { jetbrains: { air: { version: 1, capabilities } } },
    });
    expect(clientSupportsModelReasoningEfforts(air([AIR_MODEL_REASONING_EFFORTS_CAPABILITY]))).toBe(
      true,
    );
    expect(
      clientSupportsModelReasoningEfforts(air([AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY])),
    ).toBe(false);
    expect(clientSupportsModelReasoningEfforts(undefined)).toBe(false);
  });

  it("recommends medium when offered, else the first level", () => {
    expect(recommendedEffortLevel(["low", "medium", "high"])).toBe("medium");
    expect(recommendedEffortLevel(["high", "max"])).toBe("high");
    expect(recommendedEffortLevel([])).toBeUndefined();
  });

  it("names each model's levels in SDK order with the recommended one", () => {
    const infos = MODEL_INFOS.map((model) =>
      model.value === "opus"
        ? {
            ...model,
            supportedEffortLevels: [
              "low",
              "medium",
              "high",
              "xhigh",
              "max",
            ] as ModelInfo["supportedEffortLevels"],
          }
        : model.value === "sonnet"
          ? {
              ...model,
              supportedEffortLevels: ["high", "max"] as ModelInfo["supportedEffortLevels"],
            }
          : model,
    );
    const options = buildConfigOptions(
      MODES,
      MODELS,
      infos,
      undefined,
      [],
      "default",
      undefined,
      EFFORTS_PRESENTATION,
    );
    expect(entry(options, "opus")?._meta).toEqual(
      effortsMeta(["low", "medium", "high", "xhigh", "max"], "medium"),
    );
    expect(entry(options, "sonnet")?._meta).toEqual(effortsMeta(["high", "max"], "high"));
  });

  it("gives a model without effort support no metadata", () => {
    const options = buildConfigOptions(
      MODES,
      MODELS,
      [
        ...MODEL_INFOS.filter((model) => model.value !== "opus"),
        { ...MODEL_INFOS[1], supportsEffort: false },
      ],
      undefined,
      [],
      "default",
      undefined,
      EFFORTS_PRESENTATION,
    );
    expect(entry(options, "haiku")).not.toHaveProperty("_meta");
    expect(entry(options, "opus")).not.toHaveProperty("_meta");
  });

  it("gives the default row the efforts of the model it resolves to", () => {
    const options = buildConfigOptions(
      MODES,
      MODELS,
      MODEL_INFOS,
      undefined,
      [],
      "default",
      undefined,
      EFFORTS_PRESENTATION,
    );
    expect(entry(options, "default")?._meta).toEqual(
      effortsMeta(["low", "medium", "high"], "medium"),
    );
    // The effort option's levels have a `default` row; the entry has none.
    const effort = selectOption(options, "effort");
    expect(effort.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "default" })]),
    );
  });

  it("gives the default row no metadata when it resolves to no listed model", () => {
    const options = buildConfigOptions(
      MODES,
      MODELS,
      MODEL_INFOS.map((model) =>
        model.value === "default" ? { ...model, resolvedModel: "claude-sonnet-9" } : model,
      ),
      undefined,
      [],
      "default",
      undefined,
      EFFORTS_PRESENTATION,
    );
    expect(entry(options, "default")).not.toHaveProperty("_meta");
    expect(entry(options, "opus")?._meta).toEqual(effortsMeta(["low", "medium", "high"], "medium"));
  });

  it("gives a running model that the picker does not list its efforts", () => {
    const options = buildConfigOptions(
      MODES,
      {
        currentModelId: "opus",
        availableModels: MODELS.availableModels.filter((model) => model.modelId !== "opus"),
      },
      MODEL_INFOS,
      undefined,
      [],
      "default",
      undefined,
      EFFORTS_PRESENTATION,
    );
    expect(entry(options, "opus")?._meta).toEqual(effortsMeta(["low", "medium", "high"], "medium"));
  });

  it("matches the effort option's recommendation for the current model", () => {
    const infos = MODEL_INFOS.map((model) =>
      model.value === "opus"
        ? { ...model, supportedEffortLevels: ["high", "max"] as ModelInfo["supportedEffortLevels"] }
        : model,
    );
    for (const currentModelId of ["opus", "sonnet"]) {
      const options = buildConfigOptions(
        MODES,
        { ...MODELS, currentModelId },
        infos,
        undefined,
        [],
        "default",
        undefined,
        { useRecommendedValue: true, modelReasoningEfforts: true },
      );
      const recommended = (
        entry(options, currentModelId)?._meta as {
          jetbrains: { air: { reasoningEfforts: { recommended: string } } };
        }
      ).jetbrains.air.reasoningEfforts.recommended;
      expect(selectOption(options, "effort")._meta).toEqual(recommendedMeta(recommended));
    }
  });

  it("keeps both recommendations next to each other", () => {
    const options = buildConfigOptions(
      MODES,
      MODELS,
      MODEL_INFOS,
      undefined,
      [],
      "default",
      undefined,
      { useRecommendedValue: true, modelReasoningEfforts: true },
    );
    const model = selectOption(options, "model");
    expect(model._meta).toEqual(recommendedMeta("sonnet"));
    expect(entries(options).map((candidate) => candidate.value)).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
    expect(entry(options, "sonnet")?._meta).toEqual(
      effortsMeta(["low", "medium", "high"], "medium"),
    );
  });

  it.each([
    ["without the capability", undefined],
    ["with only recommendedValue", RECOMMENDED_PRESENTATION],
  ])("adds no entry metadata %s", (_name, presentation) => {
    const options = buildConfigOptions(
      MODES,
      MODELS,
      MODEL_INFOS,
      undefined,
      [],
      "default",
      undefined,
      presentation,
    );
    for (const candidate of entries(options)) expect(candidate).not.toHaveProperty("_meta");
  });
});

describe("config option order", () => {
  const TOGGLE = { supported: true, enabled: false, useBooleanOption: true };
  /** The options of a root session that has all six. */
  const allSix = () =>
    buildConfigOptions(
      MODES,
      MODELS,
      MODEL_INFOS,
      undefined,
      [{ name: "reviewer", description: "Reviews code" }],
      "default",
      TOGGLE,
      undefined,
      TOGGLE,
    );

  it("builds a root session's options as model, effort, Fast mode, ultracode, mode, agent", () => {
    expect(allSix().map((option) => option.id)).toEqual([
      "model",
      "effort",
      "fast",
      "ultracode",
      "mode",
      "agent",
    ]);
  });

  it("orders options by id, and puts other ids last in the order they came", () => {
    const other = (id: string): SessionConfigOption => ({
      id,
      name: id,
      type: "boolean",
      currentValue: false,
    });
    const options = [other("zeta"), ...allSix().reverse(), other("alpha")];
    expect(orderedConfigOptions(options).map((option) => option.id)).toEqual([
      "model",
      "effort",
      "fast",
      "ultracode",
      "mode",
      "agent",
      "zeta",
      "alpha",
    ]);
  });
});
