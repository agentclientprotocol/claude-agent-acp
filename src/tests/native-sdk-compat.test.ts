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
import { setSessionMcpServers, type SessionMcpState } from "../session-mcp-set.js";

vi.mock("../session-history.js", () => ({ readSessionHistory: vi.fn() }));
vi.mock("../session-rewind-persistence.js", () => ({
  prepareRewindPersistence: vi.fn(async () => ({ sessionId: "sid", anchors: [], retained: [] })),
  confirmRewindPersistence: vi.fn(async () => {}),
}));

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

describe("native MCP acknowledgement compatibility", () => {
  it.each([
    undefined,
    null,
    [],
    {},
    { errors: {} },
    { added: [], removed: [], errors: null },
    { added: [], removed: [], errors: [] },
    { added: "host", removed: [], errors: {} },
    { added: [1], removed: [], errors: {} },
    { added: [], removed: [null], errors: {} },
    { added: [], removed: [], errors: { host: true } },
    { response: { added: [], removed: [], errors: {} } },
  ])("invalidates unknown SDK shapes before committing the revision (%#)", async (reply) => {
    const host = { name: "host", command: "node", args: [], env: [] };
    const state: SessionMcpState = { revision: 7, hostServers: [host], protectedServers: {} };
    const query = {
      mcpServerStatus: vi.fn(async () => []),
      setMcpServers: vi.fn(async () => reply),
    };
    const invalidate = vi.fn();
    await expect(
      setSessionMcpServers(
        query as unknown as Query,
        state,
        { sessionId: "s", expectedRevision: 7, mcpServers: [] },
        "s",
        invalidate,
      ),
    ).rejects.toThrow("uncertain");
    expect(state).toEqual({
      revision: 7,
      hostServers: [host],
      protectedServers: {},
      uncertain: true,
    });
    expect(invalidate).toHaveBeenCalledOnce();
    expect(query.setMcpServers).toHaveBeenCalledOnce();
    await expect(
      setSessionMcpServers(
        query as unknown as Query,
        state,
        { sessionId: "s", expectedRevision: 7, mcpServers: [] },
        "s",
        invalidate,
      ),
    ).rejects.toThrow("uncertain");
    expect(query.setMcpServers).toHaveBeenCalledOnce();
  });
});
