import { describe, it, expect, beforeEach, vi } from "vitest";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import {
  parseRewindPointsRequest,
  parseRewindRequest,
  type AcpClient,
  type ClaudeAcpAgent as ClaudeAcpAgentType,
} from "../acp-agent.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...actual,
    // Every test here drives the transcript, so unlike acp-agent.test.ts there
    // is no reason to delegate to the real reader.
    getSessionMessages: vi.fn(),
  };
});

type TranscriptMessage = Awaited<ReturnType<typeof getSessionMessages>>[number];

/** A transcript entry with the fields `unstable_rewindPoints` reads. */
function message(overrides: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return {
    type: "user",
    uuid: "u1",
    session_id: "s1",
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: { role: "user", content: [{ type: "text", text: "a prompt" }] },
    ...overrides,
  } as TranscriptMessage;
}

describe("file rewind", () => {
  let ClaudeAcpAgent: typeof ClaudeAcpAgentType;
  let agent: ClaudeAcpAgentType;
  let rewindFiles: ReturnType<typeof vi.fn>;
  let teardownSession: ReturnType<typeof vi.fn>;
  let createSession: ReturnType<typeof vi.fn>;

  /** Install a session whose query records `rewindFiles` calls.  Only the two
   *  fields the rewind path touches are stubbed; nothing here starts a real
   *  SDK query. */
  function injectSession(
    sessionId: string,
    overrides: {
      queryClosed?: boolean;
      messageIdToUuid?: Map<string, string>;
      turnQueue?: { settled: boolean }[];
      creationParams?: unknown;
    } = {},
  ) {
    (agent.sessions as Record<string, unknown>)[sessionId] = {
      queryClosed: overrides.queryClosed ?? false,
      messageIdToUuid:
        overrides.messageIdToUuid ??
        // For a user turn the ACP id IS the uuid, so an identity mapping is
        // what the message loop would really have recorded.
        new Map<string, string>([
          ["u1", "u1"],
          ["u2", "u2"],
        ]),
      turnQueue: overrides.turnQueue ?? [],
      creationParams: overrides.creationParams ?? { cwd: "/repo", mcpServers: [] },
      query: { rewindFiles },
    };
  }

  /** A four-message transcript: prompt, reply, prompt, reply. Rewinding the
   *  conversation to `u2` resumes at `a1` and drops the last two. */
  function conversation(): TranscriptMessage[] {
    return [
      message({ uuid: "u1", message: { role: "user", content: [{ type: "text", text: "one" }] } }),
      message({
        type: "assistant",
        uuid: "a1",
        message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "ok" }] },
      }),
      message({ uuid: "u2", message: { role: "user", content: [{ type: "text", text: "two" }] } }),
      message({
        type: "assistant",
        uuid: "a2",
        message: { id: "msg_2", role: "assistant", content: [{ type: "text", text: "ok" }] },
      }),
    ];
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.mocked(getSessionMessages).mockReset();
    rewindFiles = vi.fn(async () => ({ canRewind: true, skippedLinks: 0 }));
    ClaudeAcpAgent = (await import("../acp-agent.js")).ClaudeAcpAgent;
    agent = new ClaudeAcpAgent({ sessionUpdate: async () => {} } as unknown as AcpClient, {
      log: () => {},
      error: () => {},
    });
    // Stub the session lifecycle rather than exercise it: rebuilding a real
    // query would start a Claude subprocess. What matters here is that the
    // rewind asks for the right rebuild, which the live end-to-end run covers.
    teardownSession = vi.fn(async () => {});
    createSession = vi.fn(async () => ({ sessionId: "s1", modes: null, configOptions: [] }));
    (agent as unknown as Record<string, unknown>).teardownSession = teardownSession;
    (agent as unknown as Record<string, unknown>).createSession = createSession;
  });

  describe("capability", () => {
    it("advertises the methods and the modes it accepts", async () => {
      const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

      expect(
        (response.agentCapabilities as { _meta?: { claudeCode?: { rewindSession?: unknown } } })
          ._meta?.claudeCode?.rewindSession,
      ).toEqual({ modes: ["files", "conversation", "both"] });
    });

    it("does not collide with the `rewind` key #872 proposes for fork", async () => {
      const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

      const claudeCode = (
        response.agentCapabilities as { _meta?: { claudeCode?: Record<string, unknown> } }
      )._meta?.claudeCode;
      expect(claudeCode).toHaveProperty("rewindSession");
      expect(claudeCode).not.toHaveProperty("rewind");
    });
  });

  describe("param validation", () => {
    it("rejects rewind_points params that are not an object", () => {
      expect(() => parseRewindPointsRequest(null)).toThrow(/must be an object/);
      expect(() => parseRewindPointsRequest("s1")).toThrow(/must be an object/);
    });

    it("rejects a rewind_points request with no sessionId", () => {
      expect(() => parseRewindPointsRequest({})).toThrow(/non-empty sessionId/);
      expect(() => parseRewindPointsRequest({ sessionId: "" })).toThrow(/non-empty sessionId/);
    });

    it("rejects a rewind request with no messageId", () => {
      expect(() => parseRewindRequest({ sessionId: "s1" })).toThrow(/non-empty messageId/);
      expect(() => parseRewindRequest({ sessionId: "s1", messageId: "" })).toThrow(
        /non-empty messageId/,
      );
    });

    it("rejects a non-boolean dryRun rather than coercing it", () => {
      expect(() => parseRewindRequest({ sessionId: "s1", messageId: "m1", dryRun: "yes" })).toThrow(
        /dryRun must be a boolean/,
      );
    });

    it("normalizes an absent dryRun and mode to their defaults", () => {
      expect(parseRewindRequest({ sessionId: "s1", messageId: "m1" })).toEqual({
        sessionId: "s1",
        messageId: "m1",
        mode: "files",
        dryRun: false,
      });
    });

    it("accepts each rewind mode", () => {
      for (const mode of ["files", "conversation", "both"] as const) {
        expect(parseRewindRequest({ sessionId: "s1", messageId: "m1", mode }).mode).toBe(mode);
      }
    });

    it("rejects an unknown mode rather than silently rewinding files", () => {
      expect(() =>
        parseRewindRequest({ sessionId: "s1", messageId: "m1", mode: "everything" }),
      ).toThrow(/mode must be one of/);
    });
  });

  describe("unstable_rewindPoints", () => {
    it("rejects an unknown session", async () => {
      await expect(agent.unstable_rewindPoints({ sessionId: "missing" })).rejects.toThrow(
        "Session not found",
      );
    });

    it("returns one 1-based entry per top-level user message, in transcript order", async () => {
      injectSession("s1");
      vi.mocked(getSessionMessages).mockResolvedValueOnce([
        message({
          uuid: "u1",
          message: { role: "user", content: [{ type: "text", text: "one" }] },
        }),
        message({
          uuid: "u2",
          message: { role: "user", content: [{ type: "text", text: "two" }] },
        }),
      ]);

      const { points } = await agent.unstable_rewindPoints({ sessionId: "s1" });

      expect(points).toEqual([
        { messageId: "u1", resumeAtMessageId: null, text: "one", index: 1 },
        { messageId: "u2", resumeAtMessageId: null, text: "two", index: 2 },
      ]);
    });

    it("skips assistant turns", async () => {
      injectSession("s1");
      vi.mocked(getSessionMessages).mockResolvedValueOnce([
        message({ uuid: "u1" }),
        message({
          type: "assistant",
          uuid: "a1",
          message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "reply" }] },
        }),
      ]);

      const { points } = await agent.unstable_rewindPoints({ sessionId: "s1" });

      expect(points.map((point) => point.messageId)).toEqual(["u1"]);
    });

    it("skips subagent messages, which are not rewind targets", async () => {
      injectSession("s1");
      vi.mocked(getSessionMessages).mockResolvedValueOnce([
        message({ uuid: "u1" }),
        message({ uuid: "sub", parent_tool_use_id: "toolu_1" }),
      ]);

      const { points } = await agent.unstable_rewindPoints({ sessionId: "s1" });

      expect(points.map((point) => point.messageId)).toEqual(["u1"]);
    });

    it("skips tool results and synthetic <...> envelopes", async () => {
      injectSession("s1");
      vi.mocked(getSessionMessages).mockResolvedValueOnce([
        message({
          uuid: "envelope",
          message: {
            role: "user",
            content: [{ type: "text", text: "<system-reminder>ignore me</system-reminder>" }],
          },
        }),
        message({
          uuid: "toolresult",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1" }] },
        }),
        message({ uuid: "real" }),
      ]);

      const { points } = await agent.unstable_rewindPoints({ sessionId: "s1" });

      expect(points).toEqual([
        { messageId: "real", resumeAtMessageId: null, text: "a prompt", index: 1 },
      ]);
    });

    it("accepts string content as well as block arrays, and collapses whitespace", async () => {
      injectSession("s1");
      vi.mocked(getSessionMessages).mockResolvedValueOnce([
        message({ uuid: "u1", message: { role: "user", content: "  plain\n\n  string  " } }),
        message({
          uuid: "u2",
          message: {
            role: "user",
            content: [
              { type: "text", text: "first" },
              { type: "image", source: {} },
              { type: "text", text: "second" },
            ],
          },
        }),
      ]);

      const { points } = await agent.unstable_rewindPoints({ sessionId: "s1" });

      expect(points.map((point) => point.text)).toEqual(["plain string", "first second"]);
    });

    it("truncates a long prompt rather than shipping a whole pasted file", async () => {
      injectSession("s1");
      vi.mocked(getSessionMessages).mockResolvedValueOnce([
        message({ message: { role: "user", content: [{ type: "text", text: "x".repeat(1000) }] } }),
      ]);

      const { points } = await agent.unstable_rewindPoints({ sessionId: "s1" });

      expect(points[0].text).toHaveLength(300);
    });

    it("returns no points for a session that has only ever been resumed empty", async () => {
      injectSession("s1");
      vi.mocked(getSessionMessages).mockResolvedValueOnce([]);

      await expect(agent.unstable_rewindPoints({ sessionId: "s1" })).resolves.toEqual({
        points: [],
      });
    });
  });

  describe("unstable_rewind", () => {
    it("rejects an unknown session", async () => {
      await expect(
        agent.unstable_rewind({ sessionId: "missing", messageId: "u1" }),
      ).rejects.toThrow("Session not found");
    });

    it("rejects a session whose query stream has already closed", async () => {
      injectSession("s1", { queryClosed: true });

      await expect(agent.unstable_rewind({ sessionId: "s1", messageId: "u1" })).rejects.toThrow(
        /session has ended/i,
      );
      expect(rewindFiles).not.toHaveBeenCalled();
    });

    it("passes a user messageId through, since for a user turn it IS the uuid", async () => {
      injectSession("s1");

      await agent.unstable_rewind({ sessionId: "s1", messageId: "u1" });

      expect(rewindFiles).toHaveBeenCalledWith("u1", { dryRun: false });
    });

    it("falls back to a transcript scan when the id is not in the map", async () => {
      injectSession("s1", { messageIdToUuid: new Map() });
      vi.mocked(getSessionMessages).mockResolvedValueOnce(conversation());

      await agent.unstable_rewind({ sessionId: "s1", messageId: "u2" });

      // Nothing cached, so the uuid came from `getSessionMessages`.
      expect(getSessionMessages).toHaveBeenCalledWith("s1");
      expect(rewindFiles).toHaveBeenCalledWith("u2", { dryRun: false });
    });

    it("resolves an uncached assistant msg_ id, which the old map lookup could not", async () => {
      // The docs invite clients to reuse the `messageId` they saw on agent
      // message chunks, and those carry the API `msg_…` id rather than a uuid.
      // With an empty map the previous `get(id) ?? id` handed `msg_1` straight
      // to `rewindFiles`, which does not know it.
      injectSession("s1", { messageIdToUuid: new Map() });
      vi.mocked(getSessionMessages).mockResolvedValueOnce(conversation());

      await agent.unstable_rewind({ sessionId: "s1", messageId: "msg_1" });

      expect(rewindFiles).toHaveBeenCalledWith("a1", { dryRun: false });
    });

    it("prefers the in-memory map over a transcript read", async () => {
      injectSession("s1", { messageIdToUuid: new Map([["msg_abc", "uuid-abc"]]) });

      await agent.unstable_rewind({ sessionId: "s1", messageId: "msg_abc" });

      expect(getSessionMessages).not.toHaveBeenCalled();
      expect(rewindFiles).toHaveBeenCalledWith("uuid-abc", { dryRun: false });
    });

    it("rejects an id that matches nothing rather than handing it to the SDK", async () => {
      injectSession("s1", { messageIdToUuid: new Map() });
      vi.mocked(getSessionMessages).mockResolvedValueOnce(conversation());

      await expect(agent.unstable_rewind({ sessionId: "s1", messageId: "nope" })).rejects.toThrow(
        /No message with id/,
      );
      expect(rewindFiles).not.toHaveBeenCalled();
    });

    it("forwards dryRun so a client can preview without touching the tree", async () => {
      injectSession("s1");

      await agent.unstable_rewind({ sessionId: "s1", messageId: "u1", dryRun: true });

      expect(rewindFiles).toHaveBeenCalledWith("u1", { dryRun: true });
    });

    it("returns the SDK result under `files`, including a refusal", async () => {
      injectSession("s1");
      rewindFiles.mockResolvedValueOnce({ canRewind: false, error: "no checkpoint" });

      await expect(agent.unstable_rewind({ sessionId: "s1", messageId: "u1" })).resolves.toEqual({
        files: { canRewind: false, error: "no checkpoint" },
      });
    });

    it("refuses while a turn is still running", async () => {
      injectSession("s1", { turnQueue: [{ settled: false }] });

      await expect(agent.unstable_rewind({ sessionId: "s1", messageId: "u1" })).rejects.toThrow(
        /while a turn is running/,
      );
      expect(rewindFiles).not.toHaveBeenCalled();
    });

    it("pairs each user turn with the assistant message before it", async () => {
      injectSession("s1");
      vi.mocked(getSessionMessages).mockResolvedValueOnce([
        message({
          uuid: "u1",
          message: { role: "user", content: [{ type: "text", text: "one" }] },
        }),
        message({
          type: "assistant",
          uuid: "a1",
          message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "ok" }] },
        }),
        message({
          uuid: "u2",
          message: { role: "user", content: [{ type: "text", text: "two" }] },
        }),
      ]);

      const { points } = await agent.unstable_rewindPoints({ sessionId: "s1" });

      // The first prompt has nothing before it, so it has no conversation
      // anchor; the second resumes at the assistant that closed turn one.
      expect(points).toEqual([
        { messageId: "u1", resumeAtMessageId: null, text: "one", index: 1 },
        { messageId: "u2", resumeAtMessageId: "a1", text: "two", index: 2 },
      ]);
    });

    it("ignores a subagent assistant message as a conversation anchor", async () => {
      injectSession("s1");
      vi.mocked(getSessionMessages).mockResolvedValueOnce([
        message({ uuid: "u1" }),
        message({
          type: "assistant",
          uuid: "a1",
          message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "ok" }] },
        }),
        message({
          type: "assistant",
          uuid: "sub-a",
          parent_tool_use_id: "toolu_1",
          message: { id: "msg_2", role: "assistant", content: [{ type: "text", text: "sub" }] },
        }),
        message({
          uuid: "u2",
          message: { role: "user", content: [{ type: "text", text: "two" }] },
        }),
      ]);

      const { points } = await agent.unstable_rewindPoints({ sessionId: "s1" });

      expect(points[1].resumeAtMessageId).toBe("a1");
    });

    it("does not touch the transcript in files mode", async () => {
      injectSession("s1");

      await agent.unstable_rewind({ sessionId: "s1", messageId: "u1", mode: "files" });

      expect(teardownSession).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
    });

    it("rebuilds the query resuming at the preceding assistant message", async () => {
      injectSession("s1", { creationParams: { cwd: "/repo", mcpServers: [], _meta: { tag: 1 } } });
      vi.mocked(getSessionMessages).mockResolvedValueOnce(conversation());

      const result = await agent.unstable_rewind({
        sessionId: "s1",
        messageId: "u2",
        mode: "conversation",
      });

      expect(result).toEqual({ conversation: { rewound: true, messagesDropped: 2 } });
      expect(teardownSession).toHaveBeenCalledWith("s1");
      // Rebuilt from the ORIGINAL request, so the client's _meta survives.
      expect(createSession).toHaveBeenCalledWith(
        { cwd: "/repo", mcpServers: [], _meta: { tag: 1 } },
        { resume: "s1", resumeSessionAt: "a1" },
      );
      // Conversation mode leaves the working tree alone.
      expect(rewindFiles).not.toHaveBeenCalled();
    });

    it("previews the drop count without tearing anything down", async () => {
      injectSession("s1");
      vi.mocked(getSessionMessages).mockResolvedValueOnce(conversation());

      const result = await agent.unstable_rewind({
        sessionId: "s1",
        messageId: "u2",
        mode: "conversation",
        dryRun: true,
      });

      expect(result).toEqual({ conversation: { rewound: false, messagesDropped: 2 } });
      expect(teardownSession).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
    });

    it("refuses to rewind the conversation past the first prompt", async () => {
      injectSession("s1");
      vi.mocked(getSessionMessages).mockResolvedValueOnce(conversation());

      const result = await agent.unstable_rewind({
        sessionId: "s1",
        messageId: "u1",
        mode: "conversation",
      });

      expect(result.conversation?.rewound).toBe(false);
      expect(result.conversation?.error).toMatch(/nothing precedes/);
      expect(teardownSession).not.toHaveBeenCalled();
    });

    it("reports a messageId that is not in this session", async () => {
      injectSession("s1");
      vi.mocked(getSessionMessages).mockResolvedValueOnce(conversation());

      const result = await agent.unstable_rewind({
        sessionId: "s1",
        messageId: "nope",
        mode: "conversation",
      });

      expect(result.conversation?.error).toMatch(/not found/);
      expect(teardownSession).not.toHaveBeenCalled();
    });

    it("does both halves in order, files before the query is replaced", async () => {
      injectSession("s1");
      vi.mocked(getSessionMessages).mockResolvedValueOnce(conversation());

      const result = await agent.unstable_rewind({
        sessionId: "s1",
        messageId: "u2",
        mode: "both",
      });

      expect(result).toEqual({
        files: { canRewind: true, skippedLinks: 0 },
        conversation: { rewound: true, messagesDropped: 2 },
      });
      // `rewindFiles` lives on the live query, so it has to run before the
      // conversation half tears that query down.
      expect(rewindFiles.mock.invocationCallOrder[0]).toBeLessThan(
        teardownSession.mock.invocationCallOrder[0],
      );
    });

    it("leaves the conversation alone when the file half is refused in both mode", async () => {
      injectSession("s1");
      rewindFiles.mockResolvedValueOnce({ canRewind: false, error: "no checkpoint" });

      const result = await agent.unstable_rewind({
        sessionId: "s1",
        messageId: "u2",
        mode: "both",
      });

      // Half a rewind is worse than none: the agent would forget edits that
      // are still sitting on disk.
      expect(result.files?.canRewind).toBe(false);
      expect(result.conversation?.rewound).toBe(false);
      expect(teardownSession).not.toHaveBeenCalled();
    });

    it("returns the dry-run preview counts unchanged", async () => {
      injectSession("s1");
      rewindFiles.mockResolvedValueOnce({
        canRewind: true,
        filesChanged: ["/repo/a.ts"],
        insertions: 3,
        deletions: 1,
      });

      await expect(
        agent.unstable_rewind({ sessionId: "s1", messageId: "u1", dryRun: true }),
      ).resolves.toEqual({
        files: {
          canRewind: true,
          filesChanged: ["/repo/a.ts"],
          insertions: 3,
          deletions: 1,
        },
      });
    });
  });
});
