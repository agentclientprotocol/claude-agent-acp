import { describe, it, expect, vi } from "vitest";
import { resolvePermissionMode, type Logger } from "../acp-agent.js";

function mockLogger() {
  const error = vi.fn<(...args: any[]) => void>();
  const log = vi.fn<(...args: any[]) => void>();
  const logger: Logger = { log, error };
  return { logger, error, log };
}

describe("resolvePermissionMode", () => {
  it("returns 'default' when no mode is provided", () => {
    expect(resolvePermissionMode()).toBe("default");
    expect(resolvePermissionMode(undefined)).toBe("default");
  });

  it("resolves exact canonical modes", () => {
    expect(resolvePermissionMode("default")).toBe("default");
    expect(resolvePermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(resolvePermissionMode("dontAsk")).toBe("dontAsk");
    expect(resolvePermissionMode("plan")).toBe("plan");
    expect(resolvePermissionMode("bypassPermissions")).toBe("bypassPermissions");
  });

  it("resolves case-insensitive aliases", () => {
    expect(resolvePermissionMode("DontAsk")).toBe("dontAsk");
    expect(resolvePermissionMode("DONTASK")).toBe("dontAsk");
    expect(resolvePermissionMode("AcceptEdits")).toBe("acceptEdits");
    expect(resolvePermissionMode("bypass")).toBe("bypassPermissions");
  });

  it("trims whitespace", () => {
    expect(resolvePermissionMode("  dontAsk  ")).toBe("dontAsk");
  });

  it("falls back to 'default' and logs on non-string values", () => {
    for (const value of [123, true, {}]) {
      const { logger, error } = mockLogger();
      expect(resolvePermissionMode(value, logger)).toBe("default");
      expect(error).toHaveBeenCalledWith(expect.stringContaining("expected a string"));
    }
  });

  it("falls back to 'default' and logs on empty string", () => {
    for (const value of ["", "  "]) {
      const { logger, error } = mockLogger();
      expect(resolvePermissionMode(value, logger)).toBe("default");
      expect(error).toHaveBeenCalledWith(expect.stringContaining("expected a non-empty string"));
    }
  });

  it("falls back to 'default' and logs on unknown mode", () => {
    const { logger, error } = mockLogger();
    expect(resolvePermissionMode("yolo", logger)).toBe("default");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("yolo"));
  });
});
