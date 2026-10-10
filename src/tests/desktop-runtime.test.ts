import { describe, expect, it, vi } from "vitest";
import {
  controlRuntime,
  parseRuntimeControlRequest,
  parseRuntimeReadRequest,
  readRuntime,
  runtimeCapability,
  type RuntimeQuery,
} from "../desktop-runtime.js";

describe("session runtime extension", () => {
  const signal = () => new AbortController().signal;
  it("only exposes named domain operations", () => {
    expect(runtimeCapability().controls).not.toContain("request");
    for (const params of [
      null,
      [],
      { sessionId: "s", resource: "config" },
      { sessionId: "s", resource: "mcp", method: "delete" },
    ]) {
      expect(() => parseRuntimeReadRequest(params)).toThrow();
    }
    for (const params of [
      { sessionId: "s", action: "request" },
      { sessionId: "s", action: "toggleMcp", serverName: "x", enabled: "false" },
      { sessionId: "s", action: "backgroundTask" },
    ]) {
      expect(() => parseRuntimeControlRequest(params)).toThrow();
    }
  });
  it("defaults plugin reload to the native cache impact check", async () => {
    const reloadPlugins = vi.fn(async () => ({
      commands: [],
      agents: [],
      plugins: [],
      mcpServers: [],
      error_count: 0,
      held: true,
    }));
    const response = await controlRuntime(
      { reloadPlugins },
      parseRuntimeControlRequest({ sessionId: "s", action: "reloadPlugins" }),
    );
    expect(reloadPlugins).toHaveBeenCalledWith({ holdOnCacheImpact: true });
    expect(response).toMatchObject({ status: "ok", data: { held: true } });
  });
  it("uses summary context without paid per-category counting", async () => {
    const getContextUsage = vi.fn(async () => ({ totalTokens: 42 }));
    const result = await readRuntime(
      { getContextUsage } as unknown as RuntimeQuery,
      { sessionId: "s", resource: "context" },
      signal(),
    );
    expect(getContextUsage).toHaveBeenCalledWith({ detail: "summary" });
    expect(result).toMatchObject({ status: "ok", data: { totalTokens: 42 } });
  });
  it("omits MCP environment, URL headers and provider diagnostics", async () => {
    const mcpServerStatus = vi.fn(async () => [
      {
        name: "local",
        status: "connected" as const,
        config: { command: "test", env: { TOKEN: "secret" } },
        error: "secret",
        tools: [{ name: "read" }],
      },
    ]);
    const result = await readRuntime(
      { mcpServerStatus },
      { sessionId: "s", resource: "mcp" },
      signal(),
    );
    expect(result).toEqual({
      version: 1,
      status: "ok",
      data: [{ name: "local", status: "connected", toolNames: ["read"] }],
    });
  });
  it("does not invent support on older runtimes", async () => {
    expect(await readRuntime({}, { sessionId: "s", resource: "agents" }, signal())).toMatchObject({
      status: "unavailable",
      reason: "unsupported",
    });
    expect(await controlRuntime({}, { sessionId: "s", action: "reloadSkills" })).toMatchObject({
      status: "unavailable",
      reason: "unsupported",
    });
  });
  it("does not dispatch an already cancelled read", async () => {
    const controller = new AbortController();
    controller.abort();
    const supportedAgents = vi.fn(async () => []);
    await readRuntime(
      { supportedAgents },
      { sessionId: "s", resource: "agents" },
      controller.signal,
    );
    expect(supportedAgents).not.toHaveBeenCalled();
  });
  it("discards a response from a replaced query", async () => {
    let current = true;
    const supportedAgents = vi.fn(async () => {
      current = false;
      return [];
    });
    expect(
      await readRuntime(
        { supportedAgents },
        { sessionId: "s", resource: "agents" },
        signal(),
        () => current,
      ),
    ).toMatchObject({ status: "unavailable", reason: "stale" });
  });
  it("bounds a stalled read and observes a late rejection", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const supportedAgents = () =>
      new Promise<never>((_resolve, fail) => {
        reject = fail;
      });
    const reading = readRuntime(
      { supportedAgents },
      { sessionId: "s", resource: "agents" },
      signal(),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(await reading).toMatchObject({ reason: "timeout" });
    reject(new Error("late"));
    await Promise.resolve();
    vi.useRealTimers();
  });
  it("backgrounds exactly the requested tool without claiming it stopped", async () => {
    const backgroundTasks = vi.fn(async () => false);
    expect(
      await controlRuntime(
        { backgroundTasks },
        { sessionId: "s", action: "backgroundTask", toolUseId: "tool-1" },
      ),
    ).toMatchObject({ data: { backgrounded: false } });
    expect(backgroundTasks).toHaveBeenCalledWith("tool-1");
  });
  it("leaves failed mutations as errors instead of reporting success", async () => {
    await expect(
      controlRuntime(
        {
          toggleMcpServer: async () => {
            throw new Error("denied");
          },
        },
        { sessionId: "s", action: "toggleMcp", serverName: "x", enabled: true },
      ),
    ).rejects.toThrow("denied");
  });
});
