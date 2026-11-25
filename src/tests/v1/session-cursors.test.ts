import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  forkSession as forkClaudeSession,
  getSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClientCapabilities } from "@agentclientprotocol/sdk/unstable";
import { ClaudeAcpAgent } from "../../v1/acp-agent.js";
import type { AcpClient } from "../../acp-client.js";
import { LastReportedEntity } from "../../session-cursors.js";
import { Pushable } from "../../utils.js";
import { initializeClient } from "../helpers.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, forkSession: vi.fn(), getSessionMessages: vi.fn() };
});

type History = Awaited<ReturnType<typeof getSessionMessages>>;

const WITH_CURSORS: ClientCapabilities = { session: { cursors: {} } };

function user(uuid: string, content: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: "user",
    uuid,
    session_id: "s1",
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: { role: "user", content },
    ...extra,
  };
}

function assistant(uuid: string, content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    uuid,
    session_id: "s1",
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: { id: `msg_${uuid}`, role: "assistant", model: "claude-sonnet-4", content, usage: {} },
    ...extra,
  };
}

/** The history of a session: the user messages that get a cursor are `u2` and `u6`. */
const history = [
  user("u1", "First prompt"),
  assistant("a1", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }]),
  // A tool result is no user message.
  user("r1", [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }]),
  assistant("a2", [{ type: "text", text: "Done" }]),
  user("u2", "Second prompt"),
  assistant("a3", [{ type: "text", text: "Sub" }], { parent_tool_use_id: "toolu_2" }),
  // A subagent's prompt.
  user("s1", "Subagent task", { parent_tool_use_id: "toolu_2" }),
  // A local command that a replay does not show.
  user("c1", "<command-name>/compact</command-name><command-message>compact</command-message>"),
  assistant("a4", [{ type: "text", text: "Answer" }]),
  user("u6", "Third prompt"),
] as unknown as History;

function setup(capabilities: ClientCapabilities) {
  const updates: any[] = [];
  const agent = new ClaudeAcpAgent(
    {
      sessionUpdate: async (notification: any) => {
        updates.push(notification.update);
      },
    } as unknown as AcpClient,
    { log: () => {}, error: () => {} },
  );
  const cursors = () => updates.filter((update) => update.sessionUpdate === "cursor_update");
  const replay = async (messages: History = history) => {
    vi.mocked(getSessionMessages).mockResolvedValueOnce(messages);
    await (
      agent as unknown as { replaySessionHistory(sessionId: string): Promise<void> }
    ).replaySessionHistory("s1");
  };
  return { agent, updates, cursors, replay, ready: () => initializeClient(agent, capabilities) };
}

const cursorOf = (uuid: string, anchor: unknown) => ({
  sessionUpdate: "cursor_update",
  cursorId: `before:${uuid}`,
  capabilities: { fork: {} },
  anchor,
});

beforeEach(() => {
  vi.mocked(getSessionMessages).mockReset();
  vi.mocked(forkClaudeSession).mockReset();
});

describe("session cursors on v1", () => {
  describe("replay", () => {
    it("announces a cursor right after each user message that a fork can start before", async () => {
      const { updates, cursors, replay, ready } = setup(WITH_CURSORS);
      await ready();
      await replay();

      // The first message, a tool result, a subagent's message and a hidden command get none.
      expect(cursors()).toEqual([
        cursorOf("u2", { type: "user_message", messageId: "u2", position: "before" }),
        cursorOf("u6", { type: "user_message", messageId: "u6", position: "before" }),
      ]);
      // The anchor names the messageId that the replayed message carries.
      for (const cursor of cursors()) {
        const index = updates.indexOf(cursor);
        expect(updates[index - 1]).toMatchObject({
          sessionUpdate: "user_message_chunk",
          messageId: cursor.anchor.messageId,
        });
      }
    });

    it.each([
      ["declares no cursors", {}],
      ["declares them as null", { session: { cursors: null } }],
    ])("sends no cursor to a client that %s", async (_, capabilities) => {
      const { cursors, replay, ready } = setup(capabilities as ClientCapabilities);
      await ready();
      await replay();
      expect(cursors()).toEqual([]);
    });
  });

  describe("live prompt", () => {
    /** A session that answers each prompt with one agent message, and the prompts' uuids. */
    function liveSession(capabilities: ClientCapabilities) {
      const harness = setup(capabilities);
      const input = new Pushable<any>();
      const prompts: string[] = [];
      async function* answers() {
        for await (const prompt of input) {
          prompts.push(prompt.uuid);
          yield userEcho(prompt);
          yield assistant(`live-${prompts.length}`, [{ type: "text", text: "Answer" }], {
            session_id: "test-session",
          });
          yield successfulResultMessage();
          yield { type: "system", subtype: "session_state_changed", state: "idle" };
        }
      }
      harness.agent.sessions["test-session"] = mockSessionState({
        query: wrapQuery(answers()),
        input,
      });
      const prompt = (text: string) =>
        harness.agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text }] });
      return { ...harness, prompt, prompts };
    }

    it("announces the cursor after the entity before it, which a later replay issues too", async () => {
      const { cursors, prompt, prompts, replay, ready } = liveSession(WITH_CURSORS);
      await ready();
      await prompt("First");
      // The first prompt of a session has nothing before it, and a slash command gets none.
      await prompt("/context");
      expect(cursors()).toEqual([]);
      await prompt("Second");

      expect(cursors()).toEqual([
        cursorOf(prompts[2]!, {
          type: "agent_message",
          messageId: "msg_live-2",
          position: "after",
        }),
      ]);

      // The stored history of those prompts, as Claude Code writes it.
      await replay([
        user(prompts[0]!, "First"),
        assistant("a1", [{ type: "text", text: "Answer" }]),
        user(prompts[2]!, "Second"),
      ] as unknown as History);
      expect(cursors().at(-1)).toEqual(
        cursorOf(prompts[2]!, { type: "user_message", messageId: prompts[2]!, position: "before" }),
      );
    });

    it("sends no cursor to a client that declares none", async () => {
      const { cursors, prompt, ready } = liveSession({});
      await ready();
      await prompt("First");
      await prompt("Second");
      expect(cursors()).toEqual([]);
    });
  });

  describe("session/fork at a cursor", () => {
    async function fork(cursorId: string) {
      const { agent, replay, cursors, ready } = setup(WITH_CURSORS);
      await ready();
      vi.spyOn(agent as any, "validateCwd").mockResolvedValue(undefined);
      vi.spyOn(agent as any, "getOrCreateSession").mockResolvedValue({
        sessionId: "forked",
        modes: null,
        configOptions: [],
      });
      await replay();
      const announced = cursors().map((cursor) => cursor.cursorId);
      vi.mocked(getSessionMessages).mockResolvedValueOnce(history);
      vi.mocked(forkClaudeSession).mockResolvedValueOnce({ sessionId: "forked" });
      const response = agent.unstable_forkSession({
        sessionId: "s1",
        cwd: "/workspace",
        mcpServers: [],
        cursorId,
      });
      return { announced, response };
    }

    it("forks the history before the announced cursor's message", async () => {
      const { announced, response } = await fork("before:u6");
      expect(announced).toContain("before:u6");
      await expect(response).resolves.toMatchObject({ sessionId: "forked" });
      expect(forkClaudeSession).toHaveBeenCalledWith("s1", { upToMessageId: "a4" });
    });

    it.each(["before:u1", "before:s1", "cur_unknown"])(
      "rejects %s with -32602",
      async (cursorId) => {
        const { announced, response } = await fork(cursorId);
        expect(announced).not.toContain(cursorId);
        await expect(response).rejects.toMatchObject({ code: -32602, data: { cursorId } });
        expect(forkClaudeSession).not.toHaveBeenCalled();
      },
    );
  });
});

describe("the entity that a live cursor anchors to", () => {
  const send = (tracker: LastReportedEntity, update: Record<string, unknown>, sessionId = "s") =>
    tracker.sending({ sessionId, update: update as any });

  it("is the last tool call, compaction or message that the client holds, without subagent output", () => {
    const tracker = new LastReportedEntity();
    expect(tracker.after("s")).toBeUndefined();
    send(tracker, { sessionUpdate: "agent_message_chunk", messageId: "m1" });
    send(tracker, { sessionUpdate: "agent_message_chunk" }); // no messageId to anchor to
    expect(tracker.after("s")).toEqual({
      type: "agent_message",
      messageId: "m1",
      position: "after",
    });
    send(tracker, { sessionUpdate: "tool_call", toolCallId: "t1" });
    send(tracker, { sessionUpdate: "tool_call_update", toolCallId: "t2" });
    send(tracker, {
      sessionUpdate: "tool_call",
      toolCallId: "t3",
      _meta: { claudeCode: { parentToolUseId: "toolu_agent" } },
    });
    expect(tracker.after("s")).toEqual({ type: "tool_call", toolCallId: "t1", position: "after" });
    send(tracker, { sessionUpdate: "compaction_update", compactionId: "c1" });
    expect(tracker.after("s")).toEqual({
      type: "compaction",
      compactionId: "c1",
      position: "after",
    });
  });

  it("is forgotten with the session and its children", () => {
    const tracker = new LastReportedEntity();
    send(tracker, { sessionUpdate: "tool_call", toolCallId: "t1" });
    send(tracker, { sessionUpdate: "tool_call", toolCallId: "t2" }, "s:replay-subagent:x");
    tracker.forget("s");
    expect(tracker.after("s")).toBeUndefined();
    expect(tracker.after("s:replay-subagent:x")).toBeUndefined();
  });
});

describe("the entity before an announced cursor", () => {
  const entity = (messageId: string) => ({ type: "agent_message" as const, messageId });

  it("is the last entity of a rewound session, and the records from the cut on are dropped", () => {
    const tracker = new LastReportedEntity();
    tracker.recordCursor("s", "before:u2", entity("m1"));
    tracker.recordCursor("s", "before:u3", entity("m2"));
    tracker.recordCursor("s", "before:u4", entity("m3"));
    tracker.sending({
      sessionId: "s",
      update: { sessionUpdate: "tool_call", toolCallId: "t" },
    });

    tracker.rewind("s", "before:u3");
    expect(tracker.after("s")).toEqual({ ...entity("m2"), position: "after" });
    // `before:u3` and `before:u4` are gone: no entity to anchor to.
    tracker.rewind("s", "before:u4");
    expect(tracker.after("s")).toBeUndefined();
    tracker.rewind("s", "before:u2");
    expect(tracker.after("s")).toEqual({ ...entity("m1"), position: "after" });
  });

  it("is none for a cursor recorded without one, and for an unknown cursor", () => {
    const tracker = new LastReportedEntity();
    tracker.recordCursor("s", "before:u2", undefined);
    tracker.sending({ sessionId: "s", update: { sessionUpdate: "tool_call", toolCallId: "t" } });
    tracker.rewind("s", "before:u2");
    expect(tracker.after("s")).toBeUndefined();
    tracker.sending({ sessionId: "s", update: { sessionUpdate: "tool_call", toolCallId: "t" } });
    tracker.rewind("s", "before:unknown");
    expect(tracker.after("s")).toBeUndefined();
  });

  it("is forgotten with the session", () => {
    const tracker = new LastReportedEntity();
    tracker.recordCursor("s", "before:u2", entity("m1"));
    tracker.forget("s");
    tracker.rewind("s", "before:u2");
    expect(tracker.after("s")).toBeUndefined();
  });
});
