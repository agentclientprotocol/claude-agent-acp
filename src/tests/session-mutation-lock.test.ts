import { describe, expect, it } from "vitest";
import { SessionMutationLock } from "../session-mutation-lock.js";

describe("SessionMutationLock", () => {
  it("waits for every prompt reservation before admitting an exclusive mutation", async () => {
    const lock = new SessionMutationLock();
    const releaseFirst = lock.reservePrompt("session-1") as () => void;
    const releaseSecond = lock.reservePrompt("session-1") as () => void;
    const exclusive = lock.acquireExclusive("session-1") as Promise<() => void>;
    let acquired = false;
    void exclusive.then(() => {
      acquired = true;
    });

    releaseFirst();
    await Promise.resolve();
    expect(acquired).toBe(false);
    releaseSecond();
    const releaseExclusive = await exclusive;
    expect(acquired).toBe(true);
    releaseExclusive();
  });

  it("holds new prompt reservations behind an exclusive mutation", async () => {
    const lock = new SessionMutationLock();
    const releaseExclusive = lock.acquireExclusive("session-1") as () => void;
    const prompt = lock.reservePrompt("session-1") as Promise<() => void>;
    let admitted = false;
    void prompt.then(() => {
      admitted = true;
    });

    await Promise.resolve();
    expect(admitted).toBe(false);
    releaseExclusive();
    const releasePrompt = await prompt;
    expect(admitted).toBe(true);
    releasePrompt();
  });

  it("keeps different session ids independent", () => {
    const lock = new SessionMutationLock();
    const releaseFirst = lock.acquireExclusive("session-1") as () => void;
    const releaseSecond = lock.acquireExclusive("session-2") as () => void;
    expect(releaseFirst).toBeTypeOf("function");
    expect(releaseSecond).toBeTypeOf("function");
    releaseFirst();
    releaseSecond();
  });
});
