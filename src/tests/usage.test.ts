import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  buildUsageConfigOption,
  formatContextUsage,
  formatFiveHour,
  formatResetAt,
  formatResetIn,
  formatTokens,
  formatWeek,
} from "../usage.js";

// All time-based helpers are tested against a fixed wall clock to keep
// outputs deterministic regardless of when the suite runs.
const NOW_MS = Date.UTC(2026, 3, 18, 12, 0, 0); // 2026-04-18T12:00:00Z
const NOW_S = Math.floor(NOW_MS / 1000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_MS));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("formatContextUsage", () => {
  it("returns placeholder when context is null", () => {
    expect(formatContextUsage(null)).toEqual({
      label: "Ctx: —",
      tooltip: "Context usage not yet available.",
    });
  });

  it("returns placeholder when size is 0", () => {
    expect(formatContextUsage({ used: 100, size: 0 })).toEqual({
      label: "Ctx: —",
      tooltip: "Context usage not yet available.",
    });
  });

  it("formats a typical percentage", () => {
    expect(formatContextUsage({ used: 45_000, size: 200_000 })).toEqual({
      label: "Ctx: 23%",
      tooltip: "Context: 45k / 200k tokens (23%)",
    });
  });

  it("rounds to the nearest whole percent", () => {
    // 92_345 / 200_000 = 46.1725% → rounds to 46%
    expect(formatContextUsage({ used: 92_345, size: 200_000 }).label).toBe("Ctx: 46%");
  });

  it("handles over-limit usage without clamping", () => {
    expect(formatContextUsage({ used: 250_000, size: 200_000 }).label).toBe("Ctx: 125%");
  });

  it("uses M suffix for >=1M contexts", () => {
    const res = formatContextUsage({ used: 500_000, size: 1_000_000 });
    expect(res.tooltip).toBe("Context: 500k / 1.00M tokens (50%)");
  });
});

describe("formatTokens", () => {
  it("returns raw number for <1k", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("returns k-scaled string for 1k-999k", () => {
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(45_678)).toBe("46k");
    expect(formatTokens(999_999)).toBe("1000k");
  });

  it("returns M-scaled string with 2 decimals for >=1M", () => {
    expect(formatTokens(1_000_000)).toBe("1.00M");
    expect(formatTokens(1_234_567)).toBe("1.23M");
  });
});

describe("formatResetIn", () => {
  it("returns null when resetsAt is undefined", () => {
    expect(formatResetIn(undefined)).toBeNull();
  });

  it("returns null when resetsAt is in the past", () => {
    expect(formatResetIn(NOW_S - 60)).toBeNull();
  });

  it("returns null when resetsAt is exactly now", () => {
    expect(formatResetIn(NOW_S)).toBeNull();
  });

  it("formats a future reset as H:MM", () => {
    // 2h 15m in the future
    expect(formatResetIn(NOW_S + 2 * 3600 + 15 * 60)).toBe("2:15");
  });

  it("pads single-digit minutes", () => {
    expect(formatResetIn(NOW_S + 3600 + 5 * 60)).toBe("1:05");
  });

  it("handles large hour counts (no cap)", () => {
    expect(formatResetIn(NOW_S + 25 * 3600 + 30 * 60)).toBe("25:30");
  });

  it("rounds down to the minute", () => {
    // 1h 0m 59s → floor to 1:00
    expect(formatResetIn(NOW_S + 3600 + 59)).toBe("1:00");
  });
});

describe("formatResetAt", () => {
  it("returns null when resetsAt is undefined", () => {
    expect(formatResetAt(undefined)).toBeNull();
  });

  it("includes a timezone name for same-day resets", () => {
    const result = formatResetAt(NOW_S + 3 * 3600);
    expect(result).not.toBeNull();
    // The exact local-time formatting varies by host TZ, but the short
    // timezone name should always appear (e.g. "UTC", "EDT", "PST", …).
    expect(result).toMatch(/[A-Z]{2,5}/);
  });

  it("includes weekday+month+day for cross-day resets", () => {
    // 3 days later
    const result = formatResetAt(NOW_S + 3 * 86400);
    expect(result).not.toBeNull();
    // Expect a weekday abbreviation (Mon, Tue, …) followed by a month
    // abbreviation and day-of-month.
    expect(result).toMatch(/^[A-Za-z]{3}, [A-Za-z]{3} \d+/);
  });
});

describe("formatFiveHour", () => {
  it("returns null when info is undefined", () => {
    expect(formatFiveHour(undefined)).toBeNull();
  });

  it("returns null when neither utilization nor resetsAt are present", () => {
    expect(formatFiveHour({ status: "allowed" })).toBeNull();
  });

  it("returns null when resetsAt is in the past and utilization is missing", () => {
    expect(formatFiveHour({ status: "allowed", resetsAt: NOW_S - 60 })).toBeNull();
  });

  it("shows utilization only when resetsAt is missing", () => {
    const result = formatFiveHour({ status: "allowed", utilization: 0.62 });
    expect(result).not.toBeNull();
    expect(result!.label).toBe("5h 62%");
    expect(result!.tooltip).toBe("5-hour limit: 62% used");
  });

  it("shows time-until only when utilization is missing", () => {
    const result = formatFiveHour({ status: "allowed", resetsAt: NOW_S + 2 * 3600 + 15 * 60 });
    expect(result).not.toBeNull();
    expect(result!.label).toBe("5h 2:15");
    // Tooltip still explains that utilization is unknown before the threshold.
    expect(result!.tooltip).toContain("usage unknown until threshold");
    expect(result!.tooltip).toContain("resets at");
  });

  it("shows both utilization and time-until when available", () => {
    const result = formatFiveHour({
      status: "allowed",
      utilization: 0.62,
      resetsAt: NOW_S + 2 * 3600 + 15 * 60,
    });
    expect(result).not.toBeNull();
    expect(result!.label).toBe("5h 62% 2:15");
    expect(result!.tooltip).toContain("5-hour limit: 62% used");
    expect(result!.tooltip).toContain("resets at");
  });

  it("appends approaching-limit status to tooltip", () => {
    const result = formatFiveHour({ status: "allowed_warning", utilization: 0.85 });
    expect(result!.tooltip).toContain("status: approaching limit");
  });

  it("appends limit-reached status to tooltip", () => {
    const result = formatFiveHour({ status: "rejected", utilization: 1.0 });
    expect(result!.tooltip).toContain("status: limit reached");
  });
});

describe("formatWeek", () => {
  const baseInfo = (u: number): SDKRateLimitInfo => ({
    status: "allowed",
    utilization: u,
    resetsAt: NOW_S + 3 * 86400,
  });

  it("returns null when no weekly info is present", () => {
    expect(formatWeek(undefined, undefined, undefined)).toBeNull();
  });

  it("returns null when primary info has no utilization", () => {
    // Weekly data arrives only once a warning threshold is crossed — the
    // SDK emits resetsAt alone in normal state, which we should hide.
    expect(
      formatWeek({ status: "allowed", resetsAt: NOW_S + 86400 }, undefined, undefined),
    ).toBeNull();
  });

  it("formats opus utilization as label with Opus in tooltip", () => {
    const result = formatWeek(baseInfo(0.18), undefined, undefined);
    expect(result!.label).toBe("Week: 18%");
    expect(result!.tooltip).toContain("Weekly Opus: 18% used");
  });

  it("appends Sonnet line to tooltip when both present", () => {
    const result = formatWeek(baseInfo(0.18), baseInfo(0.07), undefined);
    expect(result!.label).toBe("Week: 18%");
    expect(result!.tooltip).toContain("Weekly Opus: 18% used");
    expect(result!.tooltip).toContain("Weekly Sonnet: 7% used");
  });

  it("uses the generic seven_day bucket when opus is missing", () => {
    const result = formatWeek(undefined, undefined, baseInfo(0.42));
    expect(result!.label).toBe("Week: 42%");
    expect(result!.tooltip).toContain("Weekly: 42% used");
  });

  it("falls back to sonnet-only when it's the only bucket with utilization", () => {
    const result = formatWeek(undefined, baseInfo(0.33), undefined);
    expect(result!.label).toBe("Week: 33%");
    expect(result!.tooltip).toContain("Weekly Sonnet: 33% used");
  });
});

describe("buildUsageConfigOption", () => {
  it("always includes context and hidden options", () => {
    const opt = buildUsageConfigOption("context", null, {});
    expect(opt.id).toBe("usage");
    expect(opt.type).toBe("select");
    const values = (opt as { options: { value: string }[] }).options.map((o) => o.value);
    expect(values).toEqual(["context", "hidden"]);
  });

  it("omits five_hour when data is not useful", () => {
    const opt = buildUsageConfigOption(
      "context",
      { used: 10, size: 100 },
      {
        five_hour: { status: "allowed" },
      },
    );
    const values = (opt as { options: { value: string }[] }).options.map((o) => o.value);
    expect(values).not.toContain("five_hour");
  });

  it("includes five_hour when utilization is known", () => {
    const opt = buildUsageConfigOption("context", null, {
      five_hour: { status: "allowed", utilization: 0.5 },
    });
    const values = (opt as { options: { value: string }[] }).options.map((o) => o.value);
    expect(values).toContain("five_hour");
  });

  it("omits week when no utilization is present on any weekly bucket", () => {
    const opt = buildUsageConfigOption("context", null, {
      seven_day: { status: "allowed", resetsAt: NOW_S + 86400 },
    });
    const values = (opt as { options: { value: string }[] }).options.map((o) => o.value);
    expect(values).not.toContain("week");
  });

  it("includes week when opus utilization is present", () => {
    const opt = buildUsageConfigOption("week", null, {
      seven_day_opus: { status: "allowed", utilization: 0.2 },
    });
    const values = (opt as { options: { value: string }[] }).options.map((o) => o.value);
    expect(values).toContain("week");
  });

  it("renders an empty-named hidden option", () => {
    const opt = buildUsageConfigOption("hidden", { used: 10, size: 100 }, {});
    const hidden = (opt as { options: { value: string; name: string }[] }).options.find(
      (o) => o.value === "hidden",
    );
    expect(hidden).toBeDefined();
    expect(hidden!.name).toBe("");
  });

  it("preserves currentValue when the preferred view is available", () => {
    const opt = buildUsageConfigOption("five_hour", null, {
      five_hour: { status: "allowed", utilization: 0.5 },
    });
    expect((opt as { currentValue: string }).currentValue).toBe("five_hour");
  });

  it("falls back currentValue to context when preferred view is absent", () => {
    // User previously selected five_hour, but no five_hour data this turn.
    const opt = buildUsageConfigOption("five_hour", { used: 10, size: 100 }, {});
    expect((opt as { currentValue: string }).currentValue).toBe("context");
  });

  it("keeps hidden as currentValue when explicitly selected", () => {
    const opt = buildUsageConfigOption("hidden", null, {});
    expect((opt as { currentValue: string }).currentValue).toBe("hidden");
  });
});
