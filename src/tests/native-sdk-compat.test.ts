import { createHash } from "node:crypto";
import type { Query, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { readSessionHistory } from "../session-history.js";
import { rewindClaudeSession, type SessionRewindDependencies } from "../session-rewind.js";
import {
  nativeRewind,
  NativeRewindUncertain,
  NativeRewindUnsupported,
} from "../native-rewind-control.js";

vi.mock("../session-history.js", () => ({ readSessionHistory: vi.fn() }));

describe("pinned SDK private rewind acknowledgement compatibility", () => {
  it.each([{}, { request: null }, { request: true }, { request: {} }])(
    "refuses a missing or non-callable request bridge (%#)",
    async (query) => {
      await expect(nativeRewind(query as unknown as Query, "u1", "u1")).rejects.toBeInstanceOf(
        NativeRewindUnsupported,
      );
    },
  );

  it.each([
    undefined,
    null,
    true,
    [],
    {},
    { rewound: true, targetMessageUuid: "u1" },
    { response: null },
    { response: [] },
    { response: {} },
    { response: { rewound: "true" } },
    { response: { rewound: 1 } },
    { response: { rewound: true } },
    { response: { rewound: true, targetMessageUuid: "other" } },
    { response: { rewound: true, targetMessageUuid: 123 } },
  ])("never commits an unknown native envelope or wrong target (%#)", async (reply) => {
    const request = vi.fn(async () => reply);
    const session = { query: { request } as unknown as Query, turnQueue: [] };
    const deps: SessionRewindDependencies = {
      getSession: () => session,
      cancel: vi.fn(async () => {}),
      invalidate: vi.fn(),
      committed: vi.fn(),
      messageIdForGrouping: (m) => m.uuid,
    };
    vi.mocked(readSessionHistory).mockResolvedValue([
      {
        uuid: "u1",
        type: "user",
        session_id: "s",
        parent_tool_use_id: null,
        message: { role: "user", content: "hello" },
      } as SessionMessage,
    ]);
    await expect(
      rewindClaudeSession(
        {
          sessionId: "s",
          beforeMessage: {
            messageId: "u1",
            messageOccurrence: 1,
            messageFingerprint: "sha256:" + createHash("sha256").update("hello").digest("hex"),
          },
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(NativeRewindUncertain);
    expect(request).toHaveBeenCalledOnce();
    expect(deps.invalidate).toHaveBeenCalledOnce();
    expect(deps.committed).not.toHaveBeenCalled();
  });

  it("preserves this binding when invoking the private request", async () => {
    const query = {
      marker: "private-query",
      async request(this: { marker: string }, request: Record<string, unknown>) {
        expect(this.marker).toBe("private-query");
        expect(request).toEqual({
          subtype: "rewind_conversation",
          target_message_uuid: "u1",
          last_seen_user_message_uuid: "u3",
          interrupt_if_running: false,
        });
        return { response: { rewound: true, targetMessageUuid: "u1" } };
      },
    };
    await expect(nativeRewind(query as unknown as Query, "u1", "u3")).resolves.toEqual({
      rewound: true,
      targetMessageUuid: "u1",
    });
  });
});
