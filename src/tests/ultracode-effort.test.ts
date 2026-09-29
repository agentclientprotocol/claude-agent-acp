import { describe, it, expect } from "vitest";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  ULTRACODE_EFFORT_ID,
  buildEffortConfigOption,
  effortFlagSettings,
  modelSupportsEffort,
  settingsEffortForModel,
} from "../session-effort.js";

const XHIGH_MODEL: ModelInfo = {
  value: "opus",
  displayName: "Opus",
  description: "",
  supportsEffort: true,
  supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
};
const NO_XHIGH_MODEL: ModelInfo = {
  value: "sonnet",
  displayName: "Sonnet",
  description: "",
  supportsEffort: true,
  supportedEffortLevels: ["low", "medium", "high"],
};

const optionValues = (option: ReturnType<typeof buildEffortConfigOption>) =>
  option?.type === "select"
    ? option.options.flatMap((o) => ("value" in o ? [o.value] : o.options.map((n) => n.value)))
    : [];

describe("UltraCode effort", () => {
  it("is offered only on models that support xhigh", () => {
    expect(
      optionValues(buildEffortConfigOption([XHIGH_MODEL], "opus", undefined, false)),
    ).toContain(ULTRACODE_EFFORT_ID);
    expect(
      optionValues(buildEffortConfigOption([NO_XHIGH_MODEL], "sonnet", undefined, false)),
    ).not.toContain(ULTRACODE_EFFORT_ID);
  });

  it("keeps UltraCode as the current value where supported and clamps it elsewhere", () => {
    expect(
      buildEffortConfigOption([XHIGH_MODEL], "opus", ULTRACODE_EFFORT_ID, false)?.currentValue,
    ).toBe(ULTRACODE_EFFORT_ID);
    expect(
      buildEffortConfigOption([NO_XHIGH_MODEL], "sonnet", ULTRACODE_EFFORT_ID, false)?.currentValue,
    ).toBe("default");
  });

  it("enables the session flag and clears an ordinary effort pin", () => {
    expect(effortFlagSettings(ULTRACODE_EFFORT_ID, "high")).toEqual({
      ultracode: true,
      effortLevel: null,
    });
  });

  it("turns UltraCode off in the same update when leaving it", () => {
    expect(effortFlagSettings("high", ULTRACODE_EFFORT_ID)).toEqual({
      ultracode: false,
      effortLevel: "high",
    });
    expect(effortFlagSettings("default", ULTRACODE_EFFORT_ID)).toEqual({
      ultracode: false,
      effortLevel: null,
    });
  });

  it("leaves sessions that never used UltraCode on the plain effort update", () => {
    expect(effortFlagSettings("low", "medium")).toEqual({ effortLevel: "low" });
  });

  it("treats UltraCode as supported wherever xhigh is", () => {
    expect(modelSupportsEffort(XHIGH_MODEL, ULTRACODE_EFFORT_ID)).toBe(true);
    expect(modelSupportsEffort(NO_XHIGH_MODEL, ULTRACODE_EFFORT_ID)).toBe(false);
    expect(modelSupportsEffort(NO_XHIGH_MODEL, "high")).toBe(true);
  });

  it("reads an UltraCode session setting back as the UltraCode effort", () => {
    expect(
      settingsEffortForModel({ ultracode: true, effortLevel: "high" } as never, XHIGH_MODEL),
    ).toBe(ULTRACODE_EFFORT_ID);
  });
});
