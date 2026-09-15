import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  SessionRewindBootstrap,
  SessionRewindBootstrapCoordinator,
} from "../session-rewind-bootstrap.js";

describe("SessionRewindBootstrap", () => {
  it("acknowledges the first init frame", async () => {
    const bootstrap = new SessionRewindBootstrap(() => {});

    expect(bootstrap.observe(initMessage())).toBe("acknowledged");
    await expect(bootstrap.wait()).resolves.toBeUndefined();
  });

  it("cleans up and rejects a guarded resume refusal", async () => {
    const cleanup = vi.fn();
    const bootstrap = new SessionRewindBootstrap(cleanup);

    expect(bootstrap.observe(refusalMessage())).toBe("rejected");
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(bootstrap.wait()).rejects.toThrow(
      "Resume rejected by --resume-drops-turn: unexpected tail",
    );
  });

  it("rejects the handshake even when failed-session cleanup throws", async () => {
    const bootstrap = new SessionRewindBootstrap(() => {
      throw new Error("cleanup failed");
    });

    bootstrap.rejectTransport(new Error("transport failed"));

    await expect(bootstrap.wait()).rejects.toThrow("Failed to clean up rejected rewind bootstrap");
  });

  it("discards only the session that still owns the guarded query", () => {
    const expectedQuery = {};
    const currentSession = { query: expectedQuery };
    const discard = vi.fn();
    const coordinator = new SessionRewindBootstrapCoordinator({
      currentSession: () => currentSession,
      queryOf: (session) => session.query,
      discard,
    });

    const stale = coordinator.create("session-1", {});
    void stale.wait().catch(() => {});
    stale.rejectStreamEnd();
    expect(discard).not.toHaveBeenCalled();

    const current = coordinator.create("session-1", expectedQuery);
    void current.wait().catch(() => {});
    current.rejectStreamEnd();
    expect(discard).toHaveBeenCalledWith("session-1", currentSession);
  });
});

function initMessage(): SDKMessage {
  return { type: "system", subtype: "init" } as SDKMessage;
}

function refusalMessage(): SDKMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    errors: ["Resume rejected by --resume-drops-turn: unexpected tail"],
  } as SDKMessage;
}
