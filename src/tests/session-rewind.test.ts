import { createHash } from "node:crypto";
import type { Query, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSessionHistory } from "../session-history.js";
import { nativeRewind, NativeRewindUncertain } from "../native-rewind-control.js";
import {
  parseSessionRewindRequest,
  rewindClaudeSession,
  type RewindSessionState,
  type SessionRewindDependencies,
  type SessionHistoryPoint,
} from "../session-rewind.js";

vi.mock("../session-history.js", () => ({ readSessionHistory: vi.fn() }));
function point(id: string, text = id): SessionHistoryPoint {
  return {
    messageId: id,
    messageFingerprint: "sha256:" + createHash("sha256").update(text).digest("hex"),
    messageOccurrence: 1,
  };
}
function message(id: string, type: "user" | "assistant", content: unknown = id): SessionMessage {
  return {
    uuid: id,
    type,
    session_id: "sid",
    parent_tool_use_id: null,
    message: { role: type, content },
  } as SessionMessage;
}
const history = [
  message("u1", "user"),
  message("a1", "assistant"),
  message("u2", "user"),
  message("a2", "assistant"),
  message("u3", "user"),
];
function fixture() {
  const request = vi.fn(async (r: Record<string, unknown>) => ({
    response: { rewound: true, targetMessageUuid: r.target_message_uuid },
  }));
  const session: RewindSessionState = {
    query: { request } as unknown as Query,
    turnQueue: [],
  };
  const deps: SessionRewindDependencies = {
    getSession: () => session,
    cancel: vi.fn(async () => {}),
    invalidate: vi.fn(),
    committed: vi.fn(),
    messageIdForGrouping: (m) => m.uuid,
  };
  return { session, deps, request };
}
beforeEach(() => {
  vi.mocked(readSessionHistory).mockReset();
  vi.mocked(readSessionHistory).mockResolvedValue(history);
});
describe("native conversation rewind", () => {
  it("clears the first prompt without creating a session or supplying a boundary", async () => {
    const f = fixture();
    expect(
      await rewindClaudeSession({ sessionId: "sid", beforeMessage: point("u1") }, f.deps),
    ).toEqual({ rewound: true, sessionId: "sid" });
    expect(f.request).toHaveBeenCalledWith({
      subtype: "rewind_conversation",
      target_message_uuid: "u1",
      last_seen_user_message_uuid: "u3",
      interrupt_if_running: false,
    });
  });
  it("lets the CLI discard multiple turns, retaining hidden tool/system entries", async () => {
    const f = fixture();
    vi.mocked(readSessionHistory).mockResolvedValue([
      history[0],
      history[1],
      message("tool", "user", [{ type: "tool_result", tool_use_id: "x" }]),
      ...history.slice(2),
    ]);
    expect(
      await rewindClaudeSession(
        { sessionId: "sid", beforeMessage: point("u2"), resumeAtMessage: point("a1") },
        f.deps,
      ),
    ).toMatchObject({ rewound: true });
    expect(f.request.mock.calls[0][0]).toMatchObject({
      target_message_uuid: "u2",
      last_seen_user_message_uuid: "u3",
    });
  });
  it("rejects a missing non-initial boundary before mutating", async () => {
    const f = fixture();
    await expect(
      rewindClaudeSession({ sessionId: "sid", beforeMessage: point("u2") }, f.deps),
    ).rejects.toThrow("resumeAtMessage is required");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("validates fingerprints even when the id matches", async () => {
    const f = fixture();
    await expect(
      rewindClaudeSession({ sessionId: "sid", beforeMessage: point("u1", "changed") }, f.deps),
    ).rejects.toThrow("fingerprint");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("keeps restored-id fingerprint occurrence compatibility", async () => {
    const f = fixture();
    expect(
      await rewindClaudeSession({ sessionId: "sid", beforeMessage: point("old-id", "u1") }, f.deps),
    ).toMatchObject({ rewound: true });
  });
  it("rejects empty, multimodal and repeated-content fallback identities", async () => {
    for (const messages of [
      [message("new-id", "user", "")],
      [message("new-id", "user", [{ type: "text", text: "same" }, { type: "image" }])],
      [message("a", "user", "same"), message("b", "user", "same")],
    ]) {
      vi.mocked(readSessionHistory).mockResolvedValue(messages);
      const f = fixture();
      await expect(
        rewindClaudeSession(
          {
            sessionId: "sid",
            beforeMessage: point(
              "old-id",
              messages[0].message &&
                messages.length === 1 &&
                (messages[0].message as { content: unknown }).content === ""
                ? ""
                : "same",
            ),
          },
          f.deps,
        ),
      ).rejects.toThrow("not found");
      expect(f.request).not.toHaveBeenCalled();
    }
  });
  it("uses an observed echo across cancellation instead of an unobserved queued UUID", async () => {
    const f = fixture();
    f.session.turnQueue = [{ promptUuid: "not-yet-echoed" }];
    f.session.lastObservedUserMessageUuid = "observed-running";
    f.deps.cancel = vi.fn(async () => {
      f.session.turnQueue = [];
    });
    expect(
      await rewindClaudeSession(
        { sessionId: "sid", beforeMessage: point("u1"), interruptIfRunning: true },
        f.deps,
      ),
    ).toMatchObject({ rewound: true });
    expect(f.request.mock.calls[0][0].last_seen_user_message_uuid).toBe("observed-running");
  });

  it.each(["is_meta", "isMeta", "isCompactSummary"])(
    "rejects %s system-generated user targets",
    async (marker) => {
      const f = fixture();
      vi.mocked(readSessionHistory).mockResolvedValue([
        { ...message("meta", "user"), [marker]: true },
      ]);
      await expect(
        rewindClaudeSession({ sessionId: "sid", beforeMessage: point("meta") }, f.deps),
      ).rejects.toThrow("not found");
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it("rejects tool-result targets", async () => {
    const f = fixture();
    vi.mocked(readSessionHistory).mockResolvedValue([
      message("tool", "user", [{ type: "tool_result" }]),
    ]);
    await expect(
      rewindClaudeSession({ sessionId: "sid", beforeMessage: point("tool", "") }, f.deps),
    ).rejects.toThrow("not found");
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(["busy", "background_tasks", "session_closed"])(
    "refuses %s without reading or mutating",
    async (reason) => {
      const f = fixture();
      if (reason === "busy") f.session.activeTurn = {};
      if (reason === "background_tasks") f.session.liveBackgroundTasks = new Map([["task", {}]]);
      if (reason === "session_closed") f.session.queryClosed = true;
      expect(
        await rewindClaudeSession({ sessionId: "sid", beforeMessage: point("u1") }, f.deps),
      ).toEqual({ rewound: false, reason });
      expect(readSessionHistory).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it("explicit cancellation settles the turn before the native request", async () => {
    const f = fixture();
    let finish!: () => void;
    f.session.turnQueue = [
      {
        completion: new Promise<void>((r) => {
          finish = r;
        }),
      },
    ];
    f.deps.cancel = vi.fn(async () => {
      f.session.turnQueue = [];
      finish();
    });
    expect(
      await rewindClaudeSession(
        { sessionId: "sid", beforeMessage: point("u1"), interruptIfRunning: true },
        f.deps,
      ),
    ).toMatchObject({ rewound: true });
    expect(f.deps.cancel).toHaveBeenCalledWith("sid");
  });
  it("invalid targets never cancel active work", async () => {
    const f = fixture();
    f.session.activeTurn = {};
    await expect(
      rewindClaudeSession(
        { sessionId: "sid", beforeMessage: point("missing"), interruptIfRunning: true },
        f.deps,
      ),
    ).rejects.toThrow("not found");
    expect(f.deps.cancel).not.toHaveBeenCalled();
  });
  it("checks query ownership after reading history", async () => {
    const f = fixture();
    f.deps.getSession = vi.fn().mockReturnValueOnce(f.session).mockReturnValue(undefined);
    expect(
      await rewindClaudeSession({ sessionId: "sid", beforeMessage: point("u1") }, f.deps),
    ).toEqual({ rewound: false, reason: "state_changed" });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("returns unsupported without replacing the query", async () => {
    const f = fixture();
    f.request.mockRejectedValue(
      new Error("Unsupported control request subtype: rewind_conversation"),
    );
    expect(
      await rewindClaudeSession({ sessionId: "sid", beforeMessage: point("u1") }, f.deps),
    ).toEqual({ rewound: false, reason: "unsupported" });
    expect(f.deps.invalidate).not.toHaveBeenCalled();
  });
  it("closes uncertain mutations and never retries", async () => {
    const f = fixture();
    f.request.mockRejectedValue(new Error("transport lost"));
    await expect(
      rewindClaudeSession({ sessionId: "sid", beforeMessage: point("u1") }, f.deps),
    ).rejects.toBeInstanceOf(NativeRewindUncertain);
    expect(f.deps.invalidate).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledOnce();
  });
  it("bounds a missing native acknowledgement", async () => {
    const f = fixture();
    f.request.mockImplementation(() => new Promise(() => {}));
    await expect(nativeRewind(f.session.query, "u1", "u3", 10)).rejects.toThrow("timed out");
  });
  it("rejects invalid interrupt options", () => {
    expect(() =>
      parseSessionRewindRequest({
        sessionId: "sid",
        beforeMessage: point("u1"),
        interruptIfRunning: "yes",
      }),
    ).toThrow();
  });
});
