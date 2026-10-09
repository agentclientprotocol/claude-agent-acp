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
  it("requires an explicit full detail and preserves native category diagnostics", async () => {
    const data = { totalTokens: 42, categories: [{ name: "system", tokens: 12 }] };
    const getContextUsage = vi.fn(async () => data);
    const request = parseRuntimeReadRequest({
      sessionId: "s",
      resource: "context",
      detail: "full",
    });
    if (request.resource !== "context") throw new Error("wrong resource");
    expect(
      await readRuntime({ getContextUsage } as unknown as RuntimeQuery, request, signal()),
    ).toEqual({
      version: 1,
      status: "ok",
      data,
    });
    expect(getContextUsage).toHaveBeenCalledExactlyOnceWith({ detail: "full" });
    expect(parseRuntimeReadRequest({ sessionId: "s", resource: "context" })).toMatchObject({
      detail: "summary",
    });
  });
  it.each([null, false, "FULL", "", {}])("rejects invalid context detail (%j)", (detail) => {
    expect(() =>
      parseRuntimeReadRequest({ sessionId: "s", resource: "context", detail }),
    ).toThrow();
  });
  it.each(["usage", "commands", "queuedMessages"])("rejects detail on %s", (resource) => {
    expect(() => parseRuntimeReadRequest({ sessionId: "s", resource, detail: "full" })).toThrow();
  });
  it.each([undefined, null, "", "  ", "a\nb", 3, ["one", "two"]])(
    "rejects invalid message id (%j)",
    (messageId) => {
      expect(() =>
        parseRuntimeControlRequest({ sessionId: "s", action: "cancelQueuedMessage", messageId }),
      ).toThrow();
    },
  );
  it("rejects bulk control, reordering and promotion", () => {
    for (const params of [
      { action: "cancelQueuedMessage", messageId: "one", messageIds: ["two"] },
      { action: "reorderQueuedMessages" },
      { action: "promoteQueuedMessage", messageId: "one" },
    ])
      expect(() => parseRuntimeControlRequest({ sessionId: "s", ...params })).toThrow();
  });
  it.each([true, false])(
    "reports the native cancellation boolean %s with query binding",
    async (cancelled) => {
      const query = {
        marker: "query",
        async cancelAsyncMessage(this: { marker: string }, uuid: string) {
          expect(this.marker).toBe("query");
          expect(uuid).toBe("one");
          return cancelled;
        },
      };
      expect(
        await controlRuntime(query, {
          sessionId: "s",
          action: "cancelQueuedMessage",
          messageId: "one",
        }),
      ).toEqual({
        version: 1,
        status: "ok",
        data: { messageId: "one", cancelled },
      });
    },
  );
  it.each([undefined, null, 1, "true", {}, { cancelled: true }])(
    "refuses malformed cancellation ACK (%j)",
    async (ack) => {
      await expect(
        controlRuntime(
          { cancelAsyncMessage: async () => ack },
          {
            sessionId: "s",
            action: "cancelQueuedMessage",
            messageId: "one",
          },
        ),
      ).rejects.toThrow("acknowledgement");
    },
  );
  it("reports missing cancellation support and propagates native rejection", async () => {
    const request = { sessionId: "s", action: "cancelQueuedMessage", messageId: "one" } as const;
    expect(await controlRuntime({}, request)).toMatchObject({ reason: "unsupported" });
    await expect(
      controlRuntime(
        {
          cancelAsyncMessage: async () => {
            throw new Error("unknown control");
          },
        },
        request,
      ),
    ).rejects.toThrow("unknown control");
  });
  it("does not fall back or retry full diagnostics after an error", async () => {
    const getContextUsage = vi.fn(async () => {
      throw new Error("count unavailable");
    });
    await expect(
      readRuntime(
        { getContextUsage },
        { sessionId: "s", resource: "context", detail: "full" },
        signal(),
      ),
    ).rejects.toThrow("count unavailable");
    expect(getContextUsage).toHaveBeenCalledExactlyOnceWith({ detail: "full" });
  });
  it.each(["timeout", "cancelled", "stale"])(
    "bounds full diagnostics after %s without a retry",
    async (reason) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const ack = Promise.withResolvers<never>();
      const getContextUsage = vi.fn(() => ack.promise);
      let current = true;
      try {
        const reading = readRuntime(
          { getContextUsage },
          { sessionId: "s", resource: "context", detail: "full" },
          controller.signal,
          () => current,
        );
        if (reason === "timeout") await vi.advanceTimersByTimeAsync(5000);
        if (reason === "cancelled") controller.abort();
        if (reason === "stale") {
          current = false;
          ack.resolve({} as never);
        }
        expect(await reading).toEqual({ version: 1, status: "unavailable", reason });
        ack.reject(new Error("late count failure"));
        await Promise.resolve();
        expect(getContextUsage).toHaveBeenCalledExactlyOnceWith({ detail: "full" });
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
