import { describe, expect, it, vi } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { awaitNativeExit, boundedNativeMutation } from "../native-mutation.js";

describe("native mutation lifetime", () => {
  it("does not release on timeout until native shutdown completes", async () => {
    let exit!: () => void;
    const shutdown = vi.fn(
      () =>
        new Promise<void>((r) => {
          exit = r;
        }),
    );
    const pending = boundedNativeMutation(
      () => new Promise(() => {}),
      shutdown,
      new AbortController(),
      10,
    ).catch((e) => e);
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    exit();
    expect(await pending).toMatchObject({ message: expect.stringContaining("uncertain") });
  });
  it("reports an unconfirmed process exit instead of claiming shutdown", async () => {
    const query = { transport: { waitForExit: () => new Promise(() => {}) } } as unknown as Query;
    await expect(awaitNativeExit(query, 10)).rejects.toThrow("exit timed out");
  });
  it("does not mistake a transport error while the child is alive for exit", async () => {
    const query = {
      transport: {
        process: { exitCode: null, signalCode: null },
        waitForExit: async () => {
          throw new Error("lost pipe");
        },
      },
    } as unknown as Query;
    await expect(awaitNativeExit(query, 10)).rejects.toThrow("lost pipe");
  });
  it.each([
    {},
    { [Symbol.asyncDispose]: async () => {} },
    { transport: {} },
    { transport: { waitForExit: true } },
    { transport: { waitForExit: () => undefined } },
  ])("requires a credible exit observer even when disposal finishes (%#)", async (query) => {
    await expect(awaitNativeExit(query as unknown as Query, 10)).rejects.toThrow(
      "shutdown unconfirmed",
    );
  });

  it.each([
    {},
    { exitCode: null },
    { signalCode: null },
    { exitCode: undefined, signalCode: undefined },
    { exitCode: NaN },
    { exitCode: Infinity },
    { exitCode: -1 },
    { exitCode: "0" },
    { exitCode: null, signalCode: "" },
    { exitCode: null, signalCode: 42 },
  ])("does not consume a rejected observer with missing or invalid state (%#)", async (process) => {
    const query = {
      transport: {
        process,
        waitForExit: async () => {
          throw new Error("observer failed");
        },
      },
    } as unknown as Query;
    await expect(awaitNativeExit(query, 10)).rejects.toThrow("observer failed");
  });

  it.each([{ exitCode: 0 }, { exitCode: 1 }, { exitCode: null, signalCode: "SIGTERM" }])(
    "accepts a confirmed exit despite observer rejection (%#)",
    async (process) => {
      const query = {
        transport: {
          process,
          waitForExit: async () => {
            throw new Error("child ended");
          },
        },
      } as unknown as Query;
      await expect(awaitNativeExit(query, 10)).resolves.toBeUndefined();
    },
  );
});
