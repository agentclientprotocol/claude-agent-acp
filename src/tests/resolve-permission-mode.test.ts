import { describe, it, expect } from "vitest";
import { resolvePermissionMode } from "../acp-agent.js";

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

  it("throws on non-string values", () => {
    expect(() => resolvePermissionMode(123)).toThrow("expected a string");
    expect(() => resolvePermissionMode(true)).toThrow("expected a string");
    expect(() => resolvePermissionMode({})).toThrow("expected a string");
  });

  it("throws on empty string", () => {
    expect(() => resolvePermissionMode("")).toThrow("expected a non-empty string");
    expect(() => resolvePermissionMode("  ")).toThrow("expected a non-empty string");
  });

  it("throws on unknown mode", () => {
    expect(() => resolvePermissionMode("yolo")).toThrow("Invalid permissions.defaultMode: yolo");
  });
});
