import { describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { makeMockQuery } from "./helpers.js";
import { setSelectedModel } from "../session-config-options.js";
import {
  readNativeConfiguration,
  matchesNativeModel,
  selectNativeEffort,
  type NativeConfiguration,
} from "../session-observation.js";

const offered: ModelInfo[] = [
  {
    value: "sonnet[1m]",
    resolvedModel: "claude-sonnet-5-5[1m]",
    displayName: "Sonnet",
    description: "",
  },
];

function nativeQuery({ restoreContext = true, effort = "high" as string | undefined } = {}) {
  const prior = { model: "claude-fable-5-2", rawMaxTokens: 777777, totalTokens: 42 };
  const state = { ...prior };
  const events: string[] = [];
  const getContextUsage = vi.fn(async (_options: unknown) => {
    events.push(`read:${state.model}:${state.rawMaxTokens}`);
    return {
      ...state,
      categories: [],
      maxTokens: state.rawMaxTokens,
      percentage: 0,
      gridRows: [],
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      isAutoCompactEnabled: false,
      apiUsage: null,
    };
  });
  const original = new Error("the native write failed after applying");
  const setModel = vi.fn(async (model?: string) => {
    events.push(`model:${model}`);
    state.model = model!;
    if (model === "sonnet[1m]") {
      state.model = "claude-sonnet-5-5";
      state.rawMaxTokens = 1000000;
      throw original;
    }
    if (restoreContext) state.rawMaxTokens = prior.rawMaxTokens;
  });
  const applyFlagSettings = vi.fn(async () => {
    events.push("effort");
  });
  const close = vi.fn();
  const query = {
    ...makeMockQuery(),
    getContextUsage,
    setModel,
    applyFlagSettings,
    close,
    getSettings: async () => (effort === undefined ? {} : { effective: { effortLevel: effort } }),
  };
  const observations: NativeConfiguration[] = [];
  const native = {
    query,
    models: offered,
    publish: async (actual: NativeConfiguration) => {
      observations.push(actual);
    },
    invalidate: async () => {
      events.push("invalidate");
    },
  };
  return {
    query,
    state,
    native,
    original,
    setModel,
    applyFlagSettings,
    close,
    getContextUsage,
    events,
    observations,
  };
}

describe("standard native model verification", () => {
  it("joins a possibly applied write and restores exact unlisted model/context before effort", async () => {
    const test = nativeQuery();
    await expect(setSelectedModel(test.query, { value: "sonnet[1m]" }, test.native)).rejects.toBe(
      test.original,
    );
    expect(test.events).toEqual([
      "read:claude-fable-5-2:777777",
      "invalidate",
      "model:sonnet[1m]",
      "model:claude-fable-5-2",
      "read:claude-fable-5-2:777777",
      "effort",
      "read:claude-fable-5-2:777777",
    ]);
    expect(test.observations.at(-1)).toMatchObject({
      model: "claude-fable-5-2",
      size: 777777,
      effort: "high",
    });
    expect(test.close).not.toHaveBeenCalled();
    expect(
      test.getContextUsage.mock.calls.every(
        ([options]) => JSON.stringify(options) === '{"detail":"summary"}',
      ),
    ).toBe(true);
  });

  it("publishes context loss and closes the failed Query when exact restoration is unavailable", async () => {
    const test = nativeQuery({ restoreContext: false });
    await expect(
      setSelectedModel(test.query, { value: "sonnet[1m]" }, test.native),
    ).rejects.toThrow("Native restoration failed");
    expect(test.observations.at(-1)).toMatchObject({ model: "claude-fable-5-2", size: 1000000 });
    expect(test.applyFlagSettings).not.toHaveBeenCalled();
    expect(test.close).toHaveBeenCalledOnce();
  });

  it("does not write when native effort is unknown", async () => {
    const test = nativeQuery();
    Object.assign(test.query, { getSettings: async () => ({}) });
    await expect(
      setSelectedModel(test.query, { value: "sonnet[1m]" }, test.native),
    ).rejects.toThrow("did not report native effort");
    expect(test.setModel).not.toHaveBeenCalled();
  });

  it.each(["model", "context"] as const)(
    "refuses an acknowledgement contradicted by native %s",
    async (contradiction) => {
      const test = nativeQuery();
      test.setModel.mockImplementation(async (value) => {
        if (value === "sonnet[1m]") {
          test.state.model = contradiction === "model" ? "claude-fable-5-2" : "claude-sonnet-5-5";
          test.state.rawMaxTokens = contradiction === "context" ? 200000 : 1000000;
        } else {
          test.state.model = value!;
          test.state.rawMaxTokens = 777777;
        }
      });
      await expect(
        setSelectedModel(test.query, { value: "sonnet[1m]" }, test.native),
      ).rejects.toThrow("did not apply the selected model and context");
      expect(test.observations.at(-1)).toMatchObject({ model: "claude-fable-5-2", size: 777777 });
    },
  );

  it("does not use a cached window when the fresh native read fails", async () => {
    const test = nativeQuery();
    test.getContextUsage.mockRejectedValueOnce(new Error("context unavailable"));
    await expect(readNativeConfiguration(test.query)).rejects.toThrow("context unavailable");
    expect(test.setModel).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "joins an effort failure and proves restoration=%s",
    async (canRestore) => {
      const test = nativeQuery();
      let effort = "high";
      Object.assign(test.query, {
        getSettings: async () => ({
          effective: { effortLevel: effort },
          applied: { ultracodeRequested: true },
        }),
      });
      test.applyFlagSettings.mockImplementation(async (flags?: unknown) => {
        if ((flags as { effortLevel?: string }).effortLevel === "low") {
          effort = "low";
          throw test.original;
        }
        if (canRestore) effort = "high";
      });
      const operation = selectNativeEffort(
        test.query,
        "low",
        test.native.publish,
        test.native.invalidate,
      );
      if (canRestore) await expect(operation).rejects.toBe(test.original);
      else await expect(operation).rejects.toThrow("Native restoration failed");
      expect(test.applyFlagSettings.mock.calls).toEqual([
        [{ effortLevel: "low", ultracode: true }],
        [{ effortLevel: "high", ultracode: true }],
      ]);
      expect(test.setModel).not.toHaveBeenCalled();
      expect(test.close).toHaveBeenCalledTimes(canRestore ? 0 : 1);
    },
  );

  it("verifies the exact current option even when an SDK alias has moved", async () => {
    const test = nativeQuery();
    test.native.models = [
      { ...offered[0], value: test.state.model, resolvedModel: "claude-fable-5-3" },
    ];
    await setSelectedModel(test.query, { value: test.state.model }, test.native);
    expect(test.setModel).not.toHaveBeenCalled();
  });

  it.each(["sonnet[1m]", "sonnet-1m"])(
    "checks the context lane of %s with the model owner's parser",
    (value) => {
      const models = [{ ...offered[0], value, resolvedModel: "claude-sonnet-5-5-1m" }];
      expect(
        matchesNativeModel(value, models, { model: "claude-sonnet-5-5", size: 200000, used: 0 }),
      ).toBe(false);
      expect(
        matchesNativeModel(value, models, { model: "claude-sonnet-5-5", size: 1000000, used: 0 }),
      ).toBe(true);
    },
  );
});
