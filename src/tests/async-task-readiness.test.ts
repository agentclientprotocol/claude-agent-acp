import { describe, expect, it, vi } from "vitest";
import { asyncTaskCliSource, normalizeAsyncTaskReadiness } from "../async-task-readiness.js";

describe("asyncTaskCliSource", () => {
  it("reports a configured binary when CLAUDE_CODE_EXECUTABLE is set", () => {
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "/usr/local/bin/claude");
    expect(asyncTaskCliSource()).toBe("configured");
    vi.unstubAllEnvs();
  });

  it("reports the bundled binary when CLAUDE_CODE_EXECUTABLE is unset", () => {
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", undefined as unknown as string);
    expect(asyncTaskCliSource()).toBe("bundled");
    vi.unstubAllEnvs();
  });

  it("reports the bundled binary for an empty CLAUDE_CODE_EXECUTABLE", () => {
    // `claudeCliPath()` tests the same value for truthiness and falls through
    // to the bundled binary on an empty string, so this must agree with it.
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "");
    expect(asyncTaskCliSource()).toBe("bundled");
    vi.unstubAllEnvs();
  });
});

describe("normalizeAsyncTaskReadiness", () => {
  it("reads a readiness latch", () => {
    expect(normalizeAsyncTaskReadiness({ readiness: "confirmed" })).toEqual({
      readiness: "confirmed",
    });
  });

  it("reads CLI provenance", () => {
    expect(normalizeAsyncTaskReadiness({ cli: { source: "bundled" } })).toEqual({
      cli: { source: "bundled" },
    });
  });

  it("reads both together", () => {
    expect(
      normalizeAsyncTaskReadiness({ readiness: "unconfirmed", cli: { source: "configured" } }),
    ).toEqual({ readiness: "unconfirmed", cli: { source: "configured" } });
  });

  it("drops unknown fields rather than passing them through", () => {
    expect(normalizeAsyncTaskReadiness({ readiness: "confirmed", extra: 1 })).toEqual({
      readiness: "confirmed",
    });
  });

  it.each([
    ["a non-object", "confirmed"],
    ["null", null],
    ["an array", [{ readiness: "confirmed" }]],
    ["an empty object", {}],
    ["an unknown readiness", { readiness: "armed" }],
    ["a null readiness", { readiness: null }],
    ["a non-object cli", { cli: "bundled" }],
    ["a null cli", { cli: null }],
    ["an unknown cli source", { cli: { source: "vendored" } }],
    ["a cli with no source", { cli: {} }],
    ["a valid latch beside a malformed cli", { readiness: "confirmed", cli: { source: 7 } }],
  ])("fails closed on %s", (_label, value) => {
    // A garbled frame must never read as proof that the lifecycle is live, so
    // the whole payload is dropped rather than partly trusted.
    expect(normalizeAsyncTaskReadiness(value)).toBeNull();
  });
});
