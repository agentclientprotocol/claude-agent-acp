import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseSessionRewindRequest,
  rewindClaudeSession,
  resolveHistoryPoint,
  type SessionHistoryPoint,
} from "../session-rewind.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, getSessionMessages: vi.fn() };
});

describe("session rewind", () => {
  beforeEach(() => {
    vi.mocked(getSessionMessages).mockReset();
  });

  it("accepts a selected user point and an optional retained assistant point", () => {
    const point = {
      messageId: "message-1",
      messageFingerprint: `sha256:${"a".repeat(64)}`,
      messageOccurrence: 1,
    };

    expect(
      parseSessionRewindRequest({
        sessionId: "session-1",
        beforeMessage: point,
        resumeAtMessage: point,
      }),
    ).toEqual({ sessionId: "session-1", beforeMessage: point, resumeAtMessage: point });
  });

  it("resolves a restored message through its fingerprint occurrence", async () => {
    const point: SessionHistoryPoint = {
      messageId: "stale-message-id",
      messageFingerprint: "sha256:25e2b6b106523880e27763084ffa6a0756335be0d7106022535365b9ad39b4b1",
      messageOccurrence: 2,
    };
    vi.mocked(getSessionMessages).mockResolvedValue([
      userMessage("user-1", "message-1", "repeat"),
      userMessage("user-2", "message-2", "repeat"),
    ] as never);

    const resolved = await resolveHistoryPoint("session-1", point, "user", messageId);

    expect(resolved.uuid).toBe("user-2");
  });

  it("recreates the same session at the retained provider boundary", async () => {
    const session = {
      activeTurn: undefined,
      turnQueue: [],
      cwd: "/workspace",
      creationParams: { cwd: "/workspace", mcpServers: [] },
    };
    vi.mocked(getSessionMessages).mockResolvedValue([
      userMessage("previous-user-uuid", "previous-user-id", "previous prompt"),
      assistantMessage("visible-assistant-uuid", "assistant-id", "answer"),
      assistantMessage("structured-output-uuid", "structured-id", "hidden output"),
      toolResultMessage("tool-result-uuid"),
      assistantMessage("retained-chain-uuid", "hidden-assistant-id", "audit result"),
      userMessage("selected-user-uuid", "selected-user-id", "edit me"),
    ] as never);
    const teardown = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue({ sessionId: "session-1" });

    const response = await rewindClaudeSession(
      {
        sessionId: "session-1",
        beforeMessage: historyPoint("selected-user-id", "edit me"),
        resumeAtMessage: historyPoint("assistant-id", "answer"),
      },
      dependencies(session, teardown, create),
    );

    expect(response).toEqual({ rewound: true });
    expect(teardown).toHaveBeenCalledWith("session-1");
    expect(create).toHaveBeenCalledWith(
      { cwd: "/workspace", mcpServers: [] },
      {
        resume: "session-1",
        resumeSessionAt: "retained-chain-uuid",
        resumeDropsTurn: "selected-user-uuid",
      },
    );
  });

  it("rejects a retained assistant that is not the selected prompt boundary", async () => {
    const session = { cwd: "/workspace", turnQueue: [] };
    vi.mocked(getSessionMessages).mockResolvedValue([
      userMessage("older-user", "older-user-id", "older prompt"),
      assistantMessage("older-assistant", "older-id", "answer"),
      userMessage("retained-user", "retained-user-id", "retained prompt"),
      assistantMessage("retained-assistant", "retained-id", "latest"),
      userMessage("selected-user", "selected-user-id", "edit me"),
    ] as never);
    const teardown = vi.fn();

    await expect(
      rewindClaudeSession(
        {
          sessionId: "session-1",
          beforeMessage: historyPoint("selected-user-id", "edit me"),
          resumeAtMessage: historyPoint("older-id", "answer"),
        },
        dependencies(session, teardown, vi.fn()),
      ),
    ).rejects.toThrow("resumeAtMessage is not the assistant message immediately preceding");
    expect(teardown).not.toHaveBeenCalled();
  });

  it("plain-resumes and reports false when resumeDropsTurn refuses the boundary", async () => {
    const session = { cwd: "/workspace", turnQueue: [] };
    vi.mocked(getSessionMessages).mockResolvedValue([
      assistantMessage("retained-assistant", "assistant-id", "answer"),
      userMessage("selected-user", "selected-user-id", "edit me"),
    ] as never);
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("Resume rejected by --resume-drops-turn: changed tail"))
      .mockResolvedValueOnce({ sessionId: "session-1" });

    await expect(
      rewindClaudeSession(
        {
          sessionId: "session-1",
          beforeMessage: historyPoint("selected-user-id", "edit me"),
          resumeAtMessage: historyPoint("assistant-id", "answer"),
        },
        dependencies(session, vi.fn().mockResolvedValue(undefined), create),
      ),
    ).resolves.toEqual({ rewound: false });
    expect(create).toHaveBeenLastCalledWith(
      { cwd: "/workspace", mcpServers: [] },
      { resume: "session-1" },
    );
  });

  it("restores the original session and rethrows an unexpected rewind failure", async () => {
    const session = { cwd: "/workspace", turnQueue: [] };
    vi.mocked(getSessionMessages).mockResolvedValue([
      userMessage("selected-user", "selected-id", "edit me"),
    ] as never);
    const failure = new Error("query ended before acknowledgement");
    const create = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({});

    await expect(
      rewindClaudeSession(
        {
          sessionId: "session-1",
          beforeMessage: historyPoint("selected-id", "edit me"),
        },
        dependencies(session, vi.fn().mockResolvedValue(undefined), create),
      ),
    ).rejects.toBe(failure);
    expect(create).toHaveBeenLastCalledWith(
      { cwd: "/workspace", mcpServers: [] },
      { resume: "session-1" },
    );
  });

  it("keeps an active session unchanged", async () => {
    const teardown = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn();

    await expect(
      rewindClaudeSession(
        {
          sessionId: "session-1",
          beforeMessage: historyPoint("message-1", "edit me"),
        },
        dependencies({ activeTurn: {}, turnQueue: [], cwd: "/workspace" }, teardown, create),
      ),
    ).resolves.toEqual({ rewound: false });
    expect(teardown).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(getSessionMessages).not.toHaveBeenCalled();
  });
});

function dependencies(
  session: {
    activeTurn?: unknown;
    turnQueue?: unknown[];
    cwd: string;
    creationParams?: { cwd: string; mcpServers: never[] };
  },
  teardownSession: (sessionId: string) => Promise<void>,
  createSession: (params: unknown, options: unknown) => Promise<unknown>,
) {
  return {
    waitForProviderUpdate: async () => {},
    getSession: () => session,
    teardownSession,
    createSession,
    messageIdForGrouping: messageId,
  };
}

function historyPoint(messageIdValue: string, text: string): SessionHistoryPoint {
  const fingerprints: Record<string, string> = {
    "edit me": "sha256:1dc7a2282a4e1f70f7b1a8875276d79e41adbd00b4b78bcc9c17908a80d3bfd8",
    answer: "sha256:0db52f4076c082518412afd3dd3576e2cb0c63703fd7fed5e23ade60efef31d9",
  };
  return {
    messageId: messageIdValue,
    messageFingerprint: fingerprints[text],
    messageOccurrence: 1,
  };
}

function userMessage(uuid: string, providerMessageId: string, text: string) {
  return {
    type: "user" as const,
    uuid,
    session_id: "session-1",
    message: { id: providerMessageId, role: "user", content: text },
  };
}

function assistantMessage(uuid: string, providerMessageId: string, text: string) {
  return {
    type: "assistant" as const,
    uuid,
    session_id: "session-1",
    message: { id: providerMessageId, role: "assistant", content: [{ type: "text", text }] },
  };
}

function toolResultMessage(uuid: string) {
  return {
    type: "user" as const,
    uuid,
    session_id: "session-1",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1" }] },
  };
}

function messageId(message: unknown): string | undefined {
  return (message as { message?: { id?: string } }).message?.id;
}
