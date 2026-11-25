import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  client as acpClient,
  type ClientCapabilities,
  type InitializeResponse,
} from "@agentclientprotocol/sdk/unstable";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { ClaudeAcpAgent, v1AgentApp } from "../../v1/acp-agent.js";
import type { AcpClient } from "../../acp-client.js";
import { AIR_SESSION_REWIND_CAPABILITY } from "../../air-extension.js";
import {
  initializeClient,
  makeMockQuery,
  transcriptAssistant,
  transcriptCompactBoundary,
  transcriptCompactSummary,
  transcriptUser,
  writeTranscript,
} from "../helpers.js";
import { writeRewindPoint } from "../../session-rewind.js";
import { successfulResultMessage, userEcho } from "./session-doubles.js";

const sdk = vi.hoisted(() => ({
  query: vi.fn(),
  getSessionMessages: vi.fn().mockResolvedValue([]),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({
  ...(await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  )),
  ...sdk,
  resolveSettings: async () => ({ effective: {}, sources: [], provenance: {} }),
  filterEscalatingDefaultMode: (result: any) => result.effective,
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

const MODELS = ["sonnet", "opus"].map((value) => ({
  value,
  displayName: value,
  description: "",
  resolvedModel: `claude-${value}-4-6`,
  supportsAutoMode: true,
  supportsFastMode: true,
  supportsEffort: true,
  supportedEffortLevels: ["low", "medium", "high", "xhigh"] as const,
}));

const air = (...capabilities: string[]): ClientCapabilities => ({
  session: { cursors: {} },
  _meta: { jetbrains: { air: { version: 1, capabilities } } },
});
const REWIND_CLIENT = air(AIR_SESSION_REWIND_CAPABILITY);

function user(uuid: string, content: unknown) {
  return {
    type: "user",
    uuid,
    session_id: "s",
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: { role: "user", content },
  };
}
function assistant(uuid: string) {
  return {
    type: "assistant",
    uuid,
    session_id: "s",
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: {
      id: `msg_${uuid}`,
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: uuid }],
    },
  };
}
/** Two turns: the cursors are before `u2` and `u3`. */
const HISTORY = [
  user("u1", "one"),
  assistant("a1"),
  user("u2", "two"),
  assistant("a2"),
  user("u3", "three"),
];

describe("_session/rewind on v1", { timeout: 10_000 }, () => {
  let agent: ClaudeAcpAgent;
  let dir: string;
  let updates: any[];
  let queries: ReturnType<typeof createQuery>[];
  /** Fails the initialization of the nth query that is created from now on. */
  let failInitialization: Error[];
  let initializationGate: Promise<void> | undefined;
  let turnGate: Promise<void> | undefined;
  /** Holds every `session/update` to the client while it is set. */
  let updateGate: Promise<void> | undefined;
  /** Resolved when a `session/update` starts to wait for `updateGate`. */
  let updateReached: ReturnType<typeof deferred>;

  function createQuery(request: { options: Options; prompt: AsyncIterable<any> }) {
    const state = { model: request.options.model ?? "sonnet" };
    const prompts: string[] = [];
    const failure = failInitialization.shift();
    const query = {
      ...makeMockQuery(),
      request,
      state,
      prompts,
      initializationResult: async () => {
        await initializationGate;
        if (failure) throw failure;
        return { models: MODELS };
      },
      setModel: vi.fn(async (value: string) => {
        state.model = value;
      }),
      close: vi.fn(),
      [Symbol.asyncIterator]: async function* () {
        for await (const message of request.prompt) {
          prompts.push(message.message.content);
          yield userEcho(message);
          await turnGate;
          yield successfulResultMessage();
          yield { type: "system", subtype: "status", status: "idle" };
        }
      },
    };
    const iterator = query[Symbol.asyncIterator]();
    return Object.assign(query, { next: iterator.next.bind(iterator) });
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "v1-session-rewind-"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
    updates = [];
    queries = [];
    failInitialization = [];
    initializationGate = turnGate = updateGate = undefined;
    updateReached = deferred();
    sdk.query.mockImplementation((request) => {
      const query = createQuery(request);
      queries.push(query);
      return query;
    });
    sdk.getSessionMessages.mockResolvedValue(HISTORY);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ data: MODELS.map((model) => ({ id: model.resolvedModel })) }),
      ),
    );
    agent = new ClaudeAcpAgent(
      {
        sessionUpdate: async (update: any) => {
          if (updateGate) updateReached.resolve();
          await updateGate;
          updates.push(update);
        },
      } as AcpClient,
      { log() {}, error() {}, warn() {} },
    );
  });

  afterEach(async () => {
    await agent.dispose();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function start(capabilities: ClientCapabilities = REWIND_CLIENT) {
    await initializeClient(agent, capabilities);
    await agent.unstable_setProvider({
      providerId: "main",
      apiType: "anthropic",
      baseUrl: "https://provider.example",
    });
    const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [] });
    // The transcript that the rewind point is recorded beside.
    await writeTranscript(path.join(dir, "projects", "project"), sessionId, [
      transcriptUser("u1", "one"),
      transcriptAssistant("a1", "one"),
    ]);
    return sessionId;
  }

  const rewind = (sessionId: string, cursorId = "before:u3") =>
    agent.rewindSession({ sessionId, cursorId });
  const prompt = (sessionId: string, text = "hi") =>
    agent.prompt({ sessionId, prompt: [{ type: "text", text }] });

  describe("capability", () => {
    it.each([
      ["a client that declares it", REWIND_CLIENT, true],
      ["an AIR client that does not", air(), false],
      ["a client that is not AIR", { session: { cursors: {} } }, false],
    ])("is advertised to %s: %s", async (_, capabilities, advertised) => {
      const response = (await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: capabilities,
      })) as InitializeResponse;
      const listed = (response._meta as any)?.jetbrains?.air?.capabilities ?? [];
      expect(listed.includes(AIR_SESSION_REWIND_CAPABILITY)).toBe(advertised);
    });

    it.each([
      ["a client that declares sessionRewind", REWIND_CLIENT, { fork: {}, rewind: {} }],
      ["an AIR client that does not", air(), { fork: {} }],
      ["a client that is not AIR", { session: { cursors: {} } }, { fork: {} }],
    ])("puts rewind on the cursors of %s", async (_, capabilities, expected) => {
      await start(capabilities);
      await (agent as any).replaySessionHistory("s");
      const cursors = updates
        .map((notification) => notification.update)
        .filter((update) => update.sessionUpdate === "cursor_update");
      expect(cursors.map((cursor) => cursor.cursorId)).toEqual(["before:u2", "before:u3"]);
      for (const cursor of cursors) expect(cursor.capabilities).toEqual(expected);
    });
  });

  describe("capability on a cursor that cannot be rewound to", () => {
    const cursorsOf = () =>
      updates
        .map((notification) => notification.update)
        .filter((update) => update.sessionUpdate === "cursor_update")
        .map((update) => [update.cursorId, Object.keys(update.capabilities).sort()]);

    it("is fork alone for a cursor before the newest compaction, in a replay", async () => {
      const sessionId = await start();
      await writeTranscript(path.join(dir, "projects", "project"), sessionId, [
        transcriptUser("u1", "one"),
        transcriptAssistant("a1", "one"),
        transcriptUser("ux", "earlier"),
        transcriptAssistant("ax", "earlier"),
        transcriptCompactBoundary("b1", "ax"),
        transcriptCompactSummary("s1"),
        transcriptUser("u2", "two"),
        transcriptAssistant("a2", "two"),
      ]);
      const current = [user("s1", "summary"), user("u2", "two"), assistant("a2")];
      const visible = [user("u1", "one"), assistant("a1"), user("ux", "earlier")].concat(
        [assistant("ax")],
        current,
      );
      (current[0] as any).isCompactSummary = true;
      (visible[4] as any).isCompactSummary = true;
      sdk.getSessionMessages.mockImplementation(async (_id: string, options?: any) =>
        options?.sessionStore ? visible : current,
      );
      updates.length = 0;

      await (agent as any).replaySessionHistory(sessionId);

      expect(cursorsOf()).toEqual([
        ["before:ux", ["fork"]],
        ["before:u2", ["fork", "rewind"]],
      ]);
    });

    it("is fork alone in a session whose context was cleared, in a replay and live", async () => {
      const sessionId = await start();
      agent.sessions[sessionId]!.claudeSessionId = "another-session";
      updates.length = 0;
      await (agent as any).replaySessionHistory(sessionId);
      await prompt(sessionId, "first");
      await prompt(sessionId, "second");

      // Two from the replay, two live prompts.
      expect(cursorsOf().map(([, capabilities]) => capabilities)).toEqual(Array(4).fill(["fork"]));
    });
  });

  describe("rewinding", () => {
    it("recreates the same session at the cut, with the user's choices", async () => {
      const sessionId = await start();
      await agent.setSessionConfigOption({ sessionId, configId: "model", value: "opus" });
      const before = queries[0]!;

      expect(await rewind(sessionId)).toEqual({ rewound: true });

      expect(before.close).toHaveBeenCalled();
      const resumed = queries.at(-1)!;
      expect(resumed.request.options).toMatchObject({
        resume: sessionId,
        resumeSessionAt: "a2",
        resumeDropsTurn: "u3",
      });
      expect(resumed.state.model).toBe("opus");
      expect(agent.sessions[sessionId]!.query).toBe(resumed);
      // The reader runs: a prompt reaches the resumed query and ends its turn.
      expect(await prompt(sessionId, "edited")).toMatchObject({ stopReason: "end_turn" });
      expect(resumed.prompts).toHaveLength(1);
    });

    it("closes the replacement query after an in-flight rewind", async () => {
      const sessionId = await start();
      const gate = deferred();
      initializationGate = gate.promise;
      const rewinding = rewind(sessionId);
      let closing: ReturnType<ClaudeAcpAgent["closeSession"]> | undefined;
      try {
        await vi.waitFor(() => expect(queries).toHaveLength(2));
        closing = agent.closeSession({ sessionId });
        gate.resolve();
        expect(await rewinding).toEqual({ rewound: true });
        await closing;
        expect(agent.sessions[sessionId]).toBeUndefined();
        expect(queries[0]!.close).toHaveBeenCalledTimes(1);
        expect(queries[1]!.close).toHaveBeenCalledTimes(1);
      } finally {
        gate.resolve();
        await Promise.allSettled([rewinding, closing]);
      }
    });

    it("gives the edited message a cursor after the entity that the client keeps, and rewinds again", async () => {
      const sessionId = await start();
      await (agent as any).replaySessionHistory(sessionId);
      await rewind(sessionId);
      updates.length = 0;

      await prompt(sessionId, "edited");

      const cursors = updates
        .map((notification) => notification.update)
        .filter((update) => update.sessionUpdate === "cursor_update");
      expect(cursors).toEqual([
        {
          sessionUpdate: "cursor_update",
          cursorId: expect.stringMatching(/^before:/),
          capabilities: { fork: {}, rewind: {} },
          anchor: { type: "agent_message", messageId: "msg_a2", position: "after" },
        },
      ]);

      // The stored history now holds the edited message after `a2`.
      const edited = cursors[0].cursorId.slice("before:".length);
      sdk.getSessionMessages.mockResolvedValue([
        ...HISTORY.slice(0, 4),
        user(edited, "edited"),
        assistant("a5"),
      ]);
      expect(await rewind(sessionId, cursors[0].cursorId)).toEqual({ rewound: true });
      expect(queries.at(-1)!.request.options).toMatchObject({
        resumeSessionAt: "a2",
        resumeDropsTurn: edited,
      });
    });

    describe("the anchor of the edited message", () => {
      const cursorsAfter = (from: number) =>
        updates
          .slice(from)
          .map((notification) => notification.update)
          .filter((update) => update.sessionUpdate === "cursor_update");
      /** Prompts `texts`, and returns the cursor of each. */
      async function promptAll(sessionId: string, texts: string[]) {
        const from = updates.length;
        for (const text of texts) await prompt(sessionId, text);
        return cursorsAfter(from);
      }
      /** The stored history once `cursors` were prompted after `a2`. */
      const storedAfter = (cursors: any[]) => {
        const stored = [
          ...HISTORY.slice(0, 4),
          ...cursors.map((cursor) => user(cursor.cursorId.slice("before:".length), "prompt")),
        ];
        sdk.getSessionMessages.mockResolvedValue(stored);
      };
      const A2 = { type: "agent_message", messageId: "msg_a2", position: "after" };

      beforeEach(() => sdk.getSessionMessages.mockResolvedValue(HISTORY.slice(0, 4)));

      it("is that of the dropped message when the retained tail is a prompt that had no output", async () => {
        const sessionId = await start();
        await (agent as any).replaySessionHistory(sessionId);
        const [first, second] = await promptAll(sessionId, ["first", "second"]);
        expect(second.anchor).toEqual(A2);
        storedAfter([first, second]);

        await rewind(sessionId, second.cursorId);
        const from = updates.length;
        await prompt(sessionId, "edited");

        expect(cursorsAfter(from)[0].anchor).toEqual(A2);
      });

      it("is the live compaction_update right after a compaction", async () => {
        const sessionId = await start();
        await (agent as any).replaySessionHistory(sessionId);
        const [first] = await promptAll(sessionId, ["first"]);
        await (agent as any).client.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "compaction_update", compactionId: "live-compaction" },
        });
        const [second] = await promptAll(sessionId, ["second"]);
        expect(second.anchor).toEqual({
          type: "compaction",
          compactionId: "live-compaction",
          position: "after",
        });
        storedAfter([first, second]);

        await rewind(sessionId, second.cursorId);
        const from = updates.length;
        await prompt(sessionId, "edited");

        expect(cursorsAfter(from)[0].anchor).toEqual({
          type: "compaction",
          compactionId: "live-compaction",
          position: "after",
        });
      });

      it("is the entity replayed before the message for a cursor that a replay announced", async () => {
        sdk.getSessionMessages.mockResolvedValue(HISTORY);
        const sessionId = await start();
        await (agent as any).replaySessionHistory(sessionId);

        await rewind(sessionId, "before:u2");
        const from = updates.length;
        await prompt(sessionId, "edited");

        expect(cursorsAfter(from)[0].anchor).toEqual({
          type: "agent_message",
          messageId: "msg_a1",
          position: "after",
        });
      });
    });

    it("does not guard an earlier turn with resumeDropsTurn", async () => {
      const sessionId = await start();
      await rewind(sessionId, "before:u2");
      const options = queries.at(-1)!.request.options;
      expect(options.resumeSessionAt).toBe("a1");
      expect(options.resumeDropsTurn).toBeUndefined();
    });

    it("holds a prompt that arrives meanwhile until the session is resumed", async () => {
      const sessionId = await start();
      const gate = deferred();
      initializationGate = gate.promise;

      const rewinding = rewind(sessionId);
      const prompting = prompt(sessionId, "edited");
      await vi.waitFor(() => expect(queries).toHaveLength(2));
      expect(queries.flatMap((query) => query.prompts)).toEqual([]);

      gate.resolve();
      expect(await rewinding).toEqual({ rewound: true });
      await prompting;
      expect(queries).toHaveLength(2);
      expect(queries[0]!.prompts).toEqual([]);
      expect(queries[1]!.request.options.resumeSessionAt).toBe("a2");
      expect(queries[1]!.prompts).toHaveLength(1);
    });
  });

  describe("a prompt that is past its first check when the rewind starts", () => {
    it("waits for the rewind and runs on the resumed session", async () => {
      const sessionId = await start();
      // A pending task plan makes the prompt send an update before it queues.
      agent.sessions[sessionId]!.taskState.set("task-1", {
        subject: "Run tests",
        status: "in_progress",
      } as any);
      const planGate = deferred();
      updateGate = planGate.promise;
      const prompting = prompt(sessionId, "edited");
      await updateReached.promise;

      const resumeGate = deferred();
      initializationGate = resumeGate.promise;
      const rewinding = rewind(sessionId);
      await vi.waitFor(() => expect(queries).toHaveLength(2));
      updateGate = undefined;
      planGate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(queries.flatMap((query) => query.prompts)).toEqual([]);

      resumeGate.resolve();
      expect(await rewinding).toEqual({ rewound: true });
      await prompting;
      expect(queries[0]!.prompts).toEqual([]);
      expect(queries[1]!.prompts).toHaveLength(1);
    });
  });

  describe("a rewind that starts and finishes during an await of the prompt", () => {
    const planned = (sessionId: string) =>
      agent.sessions[sessionId]!.taskState.set("task-1", {
        subject: "Run tests",
        status: "in_progress",
      } as any);

    /** Holds the prompt at `hold` until a whole rewind is done, then lets it go on. */
    async function rewindDuring(
      sessionId: string,
      hold: Promise<void>,
      release: () => void,
      expected: { rewound: boolean; reason?: string } = { rewound: true },
      meta?: Record<string, unknown>,
      text = "edited",
    ) {
      const prompting = agent.prompt({
        sessionId,
        prompt: [{ type: "text", text }],
        ...(meta ? { _meta: meta } : {}),
      });
      prompting.catch(() => {});
      await hold;
      expect(await rewind(sessionId)).toEqual(expected);
      release();
      return prompting;
    }

    /** Holds the prompt after its first rewind check, while it publishes the prompt suggestions it clears. */
    function holdAtPromptSuggestions(sessionId: string) {
      agent.sessions[sessionId]!.promptSuggestions = { clear: () => ["stale"] } as any;
      const gate = deferred();
      const reached = deferred();
      vi.spyOn(agent as any, "publishPromptSuggestions").mockImplementation(async () => {
        reached.resolve();
        await gate.promise;
      });
      return { gate, reached };
    }

    it("runs the prompt on the rewound session when the rewind ends before the rewind check", async () => {
      const sessionId = await start();
      planned(sessionId);
      const gate = deferred();
      const reached = deferred();
      vi.spyOn(agent as any, "publishTaskPlan").mockImplementation(async () => {
        reached.resolve();
        await gate.promise;
      });

      await rewindDuring(sessionId, reached.promise, gate.resolve);
      expect(queries).toHaveLength(2);
      expect(queries[0]!.prompts).toEqual([]);
      expect(queries[1]!.prompts).toHaveLength(1);
    });

    it("runs a /remote-control command on the rewound session's query", async () => {
      const sessionId = await start();
      const gate = deferred();
      const reached = deferred();
      const enableRemoteControl = () => vi.fn(async () => ({ session_url: "https://claude.ai/s" }));
      sdk.query.mockImplementation((request) => {
        const query = Object.assign(createQuery(request), {
          enableRemoteControl: enableRemoteControl(),
        });
        queries.push(query);
        return query;
      });
      Object.assign(queries[0]!, {
        enableRemoteControl: enableRemoteControl(),
        supportedCommands: async () => {
          reached.resolve();
          await gate.promise;
          return [];
        },
      });

      const prompting = rewindDuring(
        sessionId,
        reached.promise,
        gate.resolve,
        undefined,
        undefined,
        "/remote-control",
      );
      await prompting;
      expect(queries).toHaveLength(2);
      expect((queries[0] as any).enableRemoteControl).not.toHaveBeenCalled();
      expect((queries[1] as any).enableRemoteControl).toHaveBeenCalledWith(true, undefined);
    });

    describe("when the rewind ends after the first rewind check", () => {
      it("takes the file change report, the title context and the idle compaction's disarm again from the new session", async () => {
        const sessionId = await start();
        const { gate, reached } = holdAtPromptSuggestions(sessionId);
        const turn = deferred();
        turnGate = turn.promise;
        const meta = { jetbrains: { air: { agentFileChangeReportRequest: { requestId: "r-1" } } } };

        const reporter = {
          request: vi.fn(() => "report-1"),
          report: vi.fn(async () => undefined),
          finish: vi.fn(),
        };
        let onPrompt!: ReturnType<typeof vi.spyOn>;
        let disarm!: ReturnType<typeof vi.spyOn>;
        // The rewind is done when the prompt is released: the successor is in place.
        const prompting = rewindDuring(
          sessionId,
          reached.promise,
          () => {
            const successor = agent.sessions[sessionId]!;
            successor.fileChangeReporter = reporter as any;
            onPrompt = vi.spyOn(successor.titles, "onPrompt");
            disarm = vi.spyOn(successor.idleCompaction!, "disarm");
            gate.resolve();
          },
          { rewound: true },
          meta,
        );

        await vi.waitFor(() => expect(queries[1]!.prompts).toHaveLength(1));
        expect(reporter.request).toHaveBeenCalledWith(meta);
        expect(agent.sessions[sessionId]!.turnQueue![0]!.fileChangeReport).toBe("report-1");
        expect(onPrompt).toHaveBeenCalledWith([{ type: "text", text: "edited" }]);
        expect(disarm).toHaveBeenCalledWith("prompt");
        turn.resolve();
        await prompting;
      });

      it("waits for a /remote-control command that the successor holds, which the old session did not", async () => {
        const sessionId = await start();
        const { gate, reached } = holdAtPromptSuggestions(sessionId);
        // A command prompt that the same rewind held starts on the new session.
        const command = deferred();
        const held = vi.spyOn(command.promise, "catch");

        const prompting = rewindDuring(sessionId, reached.promise, () => {
          agent.sessions[sessionId]!.remoteControlCommand = command.promise;
          gate.resolve();
        });

        await vi.waitFor(() => expect(held).toHaveBeenCalled());
        expect(queries.flatMap((query) => query.prompts)).toEqual([]);
        agent.sessions[sessionId]!.remoteControlCommand = undefined;
        command.resolve();
        await prompting;
        expect(queries[1]!.prompts).toHaveLength(1);
      });

      it("follows into the session that a refused cut's recovery leaves", async () => {
        const sessionId = await start();
        const { gate, reached } = holdAtPromptSuggestions(sessionId);
        failInitialization = [new Error("Resume rejected by --resume-drops-turn: queued message")];

        await rewindDuring(sessionId, reached.promise, gate.resolve, {
          rewound: false,
          reason: "providerRefused",
        });
        expect(queries).toHaveLength(3);
        expect(queries.slice(0, 2).flatMap((query) => query.prompts)).toEqual([]);
        expect(queries[2]!.prompts).toHaveLength(1);
      });

      it("follows two rewinds that finish during one await to the current session", async () => {
        const sessionId = await start();
        const { gate, reached } = holdAtPromptSuggestions(sessionId);
        const prompting = agent.prompt({ sessionId, prompt: [{ type: "text", text: "edited" }] });
        prompting.catch(() => {});
        await reached.promise;
        expect(await rewind(sessionId)).toEqual({ rewound: true });
        const intermediate = agent.sessions[sessionId]!;
        expect(await rewind(sessionId, "before:u2")).toEqual({ rewound: true });
        expect(intermediate.queryClosed).toBe(true);
        gate.resolve();
        await prompting;
        expect(queries).toHaveLength(3);
        expect(queries.slice(0, 2).flatMap((query) => query.prompts)).toEqual([]);
        expect(queries[2]!.prompts).toHaveLength(1);
      });

      it("ends the prompt with the session-ended error when the session it follows into is closed", async () => {
        const sessionId = await start();
        const { gate, reached } = holdAtPromptSuggestions(sessionId);
        const prompting = agent.prompt({ sessionId, prompt: [{ type: "text", text: "edited" }] });
        prompting.catch(() => {});
        await reached.promise;
        (agent as any).rewoundSessions.set(agent.sessions[sessionId], { queryClosed: true });
        gate.resolve();
        await expect(prompting).rejects.toMatchObject({
          message: expect.stringContaining("session has ended"),
        });
      });
    });

    it.each([
      ["deleted", (session: any, id: string) => delete agent.sessions[id]],
      ["closed", (session: any) => (session.queryClosed = true)],
    ])(
      "still ends the prompt with the session-ended error when the session is %s",
      async (_, end) => {
        const sessionId = await start();
        const session = agent.sessions[sessionId]!;
        const command = deferred();
        session.remoteControlCommand = command.promise;
        const held = vi.spyOn(command.promise, "catch");

        const prompting = prompt(sessionId, "edited");
        prompting.catch(() => {});
        await vi.waitFor(() => expect(held).toHaveBeenCalled());
        end(session, sessionId);
        command.resolve();
        await expect(prompting).rejects.toMatchObject({
          message: expect.stringContaining("session has ended"),
        });
      },
    );
  });

  describe("refusals", () => {
    it("answers busy while a turn runs", async () => {
      const sessionId = await start();
      const gate = deferred();
      turnGate = gate.promise;
      const turn = prompt(sessionId);
      await vi.waitFor(() => expect(queries[0]!.prompts).toHaveLength(1));

      expect(await rewind(sessionId)).toEqual({ rewound: false, reason: "busy" });

      gate.resolve();
      await turn;
      expect(queries).toHaveLength(1);
    });

    it.each([
      [
        "backgroundWork",
        (session: any) => session.liveBackgroundTasks.set("task", { isSubagent: true }),
      ],
      ["clearedContext", (session: any) => (session.claudeSessionId = "another-session")],
    ])("answers %s without replacing the query", async (reason, arrange) => {
      const sessionId = await start();
      arrange(agent.sessions[sessionId]);
      expect(await rewind(sessionId)).toEqual({ rewound: false, reason });
      expect(queries).toHaveLength(1);
      expect(queries[0]!.close).not.toHaveBeenCalled();
    });

    it("answers busy while a /remote-control command is in flight", async () => {
      const sessionId = await start();
      const command = deferred();
      agent.sessions[sessionId]!.remoteControlCommand = command.promise;

      expect(await rewind(sessionId)).toEqual({ rewound: false, reason: "busy" });

      expect(queries).toHaveLength(1);
      expect(queries[0]!.close).not.toHaveBeenCalled();
      agent.sessions[sessionId]!.remoteControlCommand = undefined;
    });

    it("fails with -32002 for a session that the agent does not hold", async () => {
      await start();
      await expect(rewind("unknown-session")).rejects.toMatchObject({ code: -32002 });
    });

    it("fails with -32602 for a cursor the history does not hold", async () => {
      const sessionId = await start();
      await expect(rewind(sessionId, "before:u1")).rejects.toMatchObject({ code: -32602 });
      expect(queries).toHaveLength(1);
    });

    it.each([
      ["an AIR client that did not declare sessionRewind", air()],
      ["a client that is not AIR", { session: { cursors: {} } }],
    ])("answers method not found to %s", async (_, clientCapabilities) => {
      let created!: ClaudeAcpAgent;
      const connection = acpClient({ name: "rewind-test" }).connect(
        v1AgentApp({ log() {}, error() {} }, (made) => (created = made)),
      );
      try {
        await connection.agent.request("initialize", { protocolVersion: 1, clientCapabilities });
        await expect(
          connection.agent.request("_session/rewind", { sessionId: "s", cursorId: "before:u2" }),
        ).rejects.toMatchObject({ code: -32601 });
        expect((created as any).sessionRewinds.size).toBe(0);
      } finally {
        connection.close();
        await created.dispose();
      }
    });

    it("fails with -32602 for a subagent's session", async () => {
      let created!: ClaudeAcpAgent;
      const connection = acpClient({ name: "rewind-test" }).connect(
        v1AgentApp({ log() {}, error() {} }, (made) => (created = made)),
      );
      try {
        await connection.agent.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: REWIND_CLIENT,
        });
        (created as any).announcedChildren.sending({
          sessionId: "root",
          update: { sessionUpdate: "subagent_update", sessionId: "child" },
        });
        await expect(
          connection.agent.request("_session/rewind", {
            sessionId: "child",
            cursorId: "before:u2",
          }),
        ).rejects.toMatchObject({ code: -32602 });
      } finally {
        connection.close();
        await created.dispose();
      }
    });
  });

  describe("recovery", () => {
    it("resumes the conversation as it was, with the choices, when the cut is refused", async () => {
      const sessionId = await start();
      await agent.setSessionConfigOption({ sessionId, configId: "model", value: "opus" });
      failInitialization = [
        new Error("Resume rejected by --resume-drops-turn: the range holds a queued message"),
      ];

      expect(await rewind(sessionId)).toEqual({ rewound: false, reason: "providerRefused" });

      // One attempt at the cut, one recovery, and no retry.
      const attempts = queries.slice(1);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]!.request.options.resumeSessionAt).toBe("a2");
      expect(attempts[1]!.request.options.resume).toBe(sessionId);
      expect(attempts[1]!.request.options.resumeSessionAt).toBeUndefined();
      expect(attempts[1]!.state.model).toBe("opus");
      expect(agent.sessions[sessionId]!.query).toBe(attempts[1]);
      expect(await prompt(sessionId)).toMatchObject({ stopReason: "end_turn" });
    });
  });

  describe("a recovery that fails too", () => {
    const refused = new Error(
      "Resume rejected by --resume-drops-turn: the range holds a queued message",
    );

    it("ends the session and fails with an internal error", async () => {
      const sessionId = await start();
      failInitialization = [refused, new Error("cannot start")];

      await expect(rewind(sessionId)).rejects.toMatchObject({
        code: -32603,
      });

      expect(agent.sessions[sessionId]).toBeUndefined();
    });

    it("fails with authRequired and keeps the session when the account needs a sign-in", async () => {
      const sessionId = await start();
      failInitialization = [refused, RequestError.authRequired()];

      await expect(rewind(sessionId)).rejects.toMatchObject({
        code: RequestError.authRequired().code,
      });

      expect(agent.sessions[sessionId]).toBeDefined();
      expect(agent.sessions[sessionId]!.needsSignOutRespawn).toBe(true);
    });
  });

  describe("state that outlives the cut", () => {
    it.each([
      ["a rewind", []],
      [
        "a refused cut and its recovery",
        [new Error("Resume rejected by --resume-drops-turn: the range holds a queued message")],
      ],
    ])("keeps the task list and the failure state through %s", async (_, failures) => {
      const sessionId = await start();
      const before = agent.sessions[sessionId]!;
      before.taskState.set("task-1", { id: "task-1" } as any);
      before.subagentChecklists.add("checklist-1");
      failInitialization = [...failures];

      await rewind(sessionId);

      const after = agent.sessions[sessionId]!;
      expect(after).not.toBe(before);
      expect(after.taskState).toBe(before.taskState);
      expect(after.subagentChecklists).toBe(before.subagentChecklists);
      expect(after.sessionFailureState).toBe(before.sessionFailureState);
      expect(after.forwardSubagentText).toBe(before.forwardSubagentText);
    });
  });

  describe("a pending rewind point", () => {
    /** The transcript that a rewind of `u3` leaves: `u3` stays as the dropped branch. */
    async function rewound(sessionId: string) {
      const directory = path.join(dir, "projects", "project");
      await writeTranscript(directory, sessionId, [
        transcriptUser("u1", "one"),
        transcriptAssistant("a1", "one"),
        transcriptUser("u2", "two"),
        transcriptAssistant("a2", "two"),
        transcriptUser("u3", "three"),
      ]);
      await writeRewindPoint(sessionId, { resumeSessionAt: "a2", droppedPromptUuid: "u3" });
      return {
        transcript: path.join(directory, `${sessionId}.jsonl`),
        point: path.join(directory, sessionId, "rewind.json"),
      };
    }
    const cursors = () =>
      updates
        .map((notification) => notification.update)
        .filter((update) => update.sessionUpdate === "cursor_update")
        .map((update) => update.cursorId);

    it("is left out of the replay, with its cursor", async () => {
      const sessionId = await start();
      await rewound(sessionId);
      updates.length = 0;

      await (agent as any).replaySessionHistory(sessionId);

      expect(cursors()).toEqual(["before:u2"]);
      const userMessages = updates
        .map((notification) => notification.update)
        .filter((update) => update.sessionUpdate === "user_message_chunk");
      expect(userMessages.map((update) => update.messageId)).toEqual(["u1", "u2"]);
    });

    it("is where session/load resumes, and its replay stops", async () => {
      await start();
      const sessionId = randomUUID();
      await rewound(sessionId);
      updates.length = 0;

      await agent.loadSession({ sessionId, cwd: dir, mcpServers: [] });

      expect(queries.at(-1)!.request.options).toMatchObject({
        resume: sessionId,
        resumeSessionAt: "a2",
      });
      expect(queries.at(-1)!.request.options.resumeDropsTurn).toBeUndefined();
      expect(cursors()).toEqual(["before:u2"]);
    });

    it("is where a restart of the query resumes", async () => {
      const sessionId = await start();
      await rewound(sessionId);

      await agent.unstable_setProvider({
        providerId: "main",
        apiType: "anthropic",
        baseUrl: "https://other.example",
      });

      expect(queries.at(-1)!.request.options).toMatchObject({
        resume: sessionId,
        resumeSessionAt: "a2",
      });
    });

    it("is neither read nor changed by a session/options probe", async () => {
      await start();
      const sessionId = randomUUID();
      const files = await rewound(sessionId);
      const before = await Promise.all([readFile(files.transcript), readFile(files.point)]);

      await agent.sessionOptions({ sessionId, cwd: dir });

      const options = queries.at(-1)!.request.options;
      expect(options.resume).toBe(sessionId);
      expect(options.resumeSessionAt).toBeUndefined();
      expect(await Promise.all([readFile(files.transcript), readFile(files.point)])).toEqual(
        before,
      );
    });
  });
});
