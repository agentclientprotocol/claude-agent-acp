import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
} from "@agentclientprotocol/sdk/unstable";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import type { AcpSessionNotification } from "../acp-subagents.js";
import { NativeSubagentRuntime, type NativeSubagent } from "../native-subagents.js";
import { serveAcp } from "../serve.js";
import * as utils from "../utils.js";
import { initializeClient, makeMockQuery } from "./helpers.js";
import { mockSessionState } from "./session-doubles.js";

const CHILD_TIMEOUT_RESULT = {
  behavior: "deny",
  message:
    "No answer was received for this question request. A question form timed out. " +
    "Report every question and its options from this tool call to the parent agent. " +
    "Ask it to present them to the user and wait for an answer. " +
    "Do not continue work that depends on these answers. " +
    "Do not infer an answer, treat the timeout as a user rejection, " +
    "or call AskUserQuestion again during this turn. Preserve answers from other question requests.",
};
const INPUT = {
  questions: [
    {
      question: "Which color?",
      header: "Color",
      options: [
        { label: "Blue", description: "Use blue" },
        { label: "Red", description: "Use red" },
      ],
      multiSelect: false,
    },
    {
      question: "Which checks?",
      header: "Checks",
      options: [
        { label: "Build", description: "Compile the project" },
        { label: "Test", description: "Run the tests" },
      ],
      multiSelect: true,
    },
  ],
};
const TIMEOUT_ENV = "CLAUDE_AGENT_ACP_ASK_USER_QUESTION_TIMEOUT_MS";
const TIMEOUT_RESULT = {
  behavior: "deny",
  message:
    "No answer was received for this question request. A question form timed out. " +
    "Restate every question and its options from this tool call in your next normal reply, " +
    "then wait for the user. Do not infer an answer, treat the timeout as a user rejection, " +
    "or call AskUserQuestion again during this turn. Preserve answers from other question requests.",
};

type Form = {
  request: Extract<CreateElicitationRequest, { mode: "form"; sessionId: string }>;
  signal: AbortSignal;
} & ReturnType<typeof Promise.withResolvers<CreateElicitationResponse>>;

beforeEach(() => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
});

function gate() {
  const deferred = Promise.withResolvers<void>();
  onTestFinished(() => {
    deferred.resolve();
  });
  return deferred;
}

async function setup(options: { timeout: string | undefined } = { timeout: "100" }) {
  vi.stubEnv(TIMEOUT_ENV, options.timeout);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const forms: Form[] = [];
  const pending: ReturnType<CanUseTool>[] = [];
  const client = {
    createElicitation: vi.fn((request: CreateElicitationRequest, signal?: AbortSignal) => {
      if (!signal) {
        throw new TypeError("Expected an elicitation cancellation signal");
      }
      if (request.mode !== "form" || !("sessionId" in request) || !("requestedSchema" in request)) {
        throw new TypeError("Expected a session-scoped form elicitation");
      }
      const deferred = Promise.withResolvers<CreateElicitationResponse>();
      forms.push({ request: request as Form["request"], signal, ...deferred });
      return deferred.promise;
    }),
    requestPermission: vi.fn<AcpClient["requestPermission"]>(),
    sessionUpdate: vi
      .fn<(notification: AcpSessionNotification) => Promise<void>>()
      .mockResolvedValue(undefined),
  };
  const foreground = {
    awaitingUser: vi.fn(),
    ended: vi.fn(),
    failed: vi.fn(),
    running: vi.fn(),
  };
  const logger = { error: vi.fn(), log: vi.fn() };
  const agent = new ClaudeAcpAgent(client as unknown as AcpClient, logger, {
    foreground: () => foreground,
  });
  onTestFinished(async () => {
    await Promise.allSettled(pending);
    // The injected session owns no SDK process or filesystem resources.
    delete agent.sessions.foo;
    await agent.dispose();
  });

  const probe = vi.spyOn(agent as any, "probeCliAuthStatus").mockResolvedValue(undefined);
  onTestFinished(() => {
    probe.mockRestore();
  });
  await initializeClient(agent, { elicitation: { form: {} }, subagents: {} });

  const interrupt = vi.fn().mockResolvedValue(undefined);
  const session = mockSessionState({ query: makeMockQuery({ interrupt }) });
  agent.sessions.foo = session;
  const runtime = new NativeSubagentRuntime("rfd", "foo", session, client.sessionUpdate, logger);
  session.nativeSubagentRuntime = runtime;

  function turn() {
    const owner = { settled: false };
    session.activeTurn = owner;
    (agent as any).startForeground("foo", owner);
    return owner;
  }

  function autonomous() {
    session.activeTurn = undefined;
    (agent as any).endForeground("foo", (agent as any).foregroundWork.get("foo")?.owner, {
      outcome: "end_turn",
    });
    (agent as any).startAutonomousCycle("foo", session, {
      type: "assistant",
      parent_tool_use_id: null,
    });
  }

  function child(id: string) {
    session.liveBackgroundTasks.set(id, {
      backgrounded: true,
      isSubagent: true,
      parentToolUseId: `launch-${id}`,
    });
    const value: NativeSubagent = {
      announced: true,
      name: id,
      parentSessionId: "foo",
      parentToolUseId: `launch-${id}`,
      sessionId: id,
      task: "Choose the checks",
      workState: "running",
    };
    session.nativeSubagentsByTaskId.set(id, value);
    return value;
  }

  function ask(toolUseID: string, agentID?: string) {
    const controller = new AbortController();
    onTestFinished(() => {
      controller.abort();
    });
    const promise = agent.canUseTool("foo")("AskUserQuestion", INPUT, {
      agentID,
      requestId: toolUseID,
      signal: controller.signal,
      suggestions: [],
      toolUseID,
    });
    pending.push(promise);
    const settled = vi.fn();
    void promise.then(settled, settled);
    return { controller, promise, settled };
  }

  turn();
  return {
    agent,
    ask,
    autonomous,
    child,
    client,
    foreground,
    forms,
    interrupt,
    logger,
    session,
    turn,
  };
}

it("waits without a timer when the timeout is zero", async () => {
  const { ask, client, forms, logger, session } = await setup({ timeout: "0" });
  const request = ask("foo");
  await vi.advanceTimersByTimeAsync(0);

  expect(client.createElicitation).toHaveBeenCalledOnce();
  expect(forms[0].signal).toBe(request.controller.signal);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(2_147_483_648);
  expect(request.settled).not.toHaveBeenCalled();
  expect(session.openUserInputs.size).toBe(1);
  expect(logger.error).not.toHaveBeenCalled();

  forms[0].resolve({ action: "accept", content: { question_0: "Blue" } });
  await expect(request.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: { "Which color?": "Blue" } },
  });
  expect(session.openUserInputs.size).toBe(0);
});

it.each([" 100 ", "-1", "1.5", "1e3", "2147483648", "Infinity", "NaN"])(
  "rejects construction before any client request when the timeout is %j",
  (timeout) => {
    vi.stubEnv(TIMEOUT_ENV, timeout);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const client = {
      createElicitation: vi.fn(),
      requestPermission: vi.fn(),
      sessionUpdate: vi.fn(),
    };
    const logger = { error: vi.fn(), log: vi.fn() };

    expect(
      () => new ClaudeAcpAgent(client as unknown as AcpClient, logger),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: CLAUDE_AGENT_ACP_ASK_USER_QUESTION_TIMEOUT_MS must be an integer from 0 to 2147483647 milliseconds]`,
    );
    expect(client.createElicitation).not.toHaveBeenCalled();
    expect(client.requestPermission).not.toHaveBeenCalled();
    expect(client.sessionUpdate).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("rejects an invalid timeout synchronously before opening stdio", () => {
  vi.stubEnv(TIMEOUT_ENV, "-1");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const input = vi.spyOn(utils, "nodeToWebReadable").mockImplementation(() => {
    throw new Error("Unexpected stdin access");
  });
  onTestFinished(() => {
    input.mockRestore();
  });
  const output = vi.spyOn(utils, "nodeToWebWritable").mockImplementation(() => {
    throw new Error("Unexpected stdout access");
  });
  onTestFinished(() => {
    output.mockRestore();
  });
  const logger = { error: vi.fn(), log: vi.fn() };

  expect(() => serveAcp(logger, { protocols: "auto" })).toThrowErrorMatchingInlineSnapshot(
    `[Error: CLAUDE_AGENT_ACP_ASK_USER_QUESTION_TIMEOUT_MS must be an integer from 0 to 2147483647 milliseconds]`,
  );
  expect(input).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  { name: "configured 1 ms", timeout: "1", milliseconds: 1 },
  { name: "configured 2147483647 ms", timeout: "2147483647", milliseconds: 2_147_483_647 },
  { name: "default five-minute (empty value)", timeout: "", milliseconds: 300_000 },
  { name: "default five-minute (unset value)", timeout: undefined, milliseconds: 300_000 },
])(
  "expires a form at the $name deadline without interrupting the SDK",
  async ({ timeout, milliseconds }) => {
    const { agent, ask, client, forms, interrupt, logger, session } = await setup({ timeout });
    const request = ask("foo");
    await vi.advanceTimersByTimeAsync(0);

    expect(forms).toHaveLength(1);
    expect(forms[0].signal).not.toBe(request.controller.signal);
    expect(forms[0].signal.aborted).toBe(false);
    expect(forms[0].request).toMatchObject({ mode: "form", sessionId: "foo", toolCallId: "foo" });
    expect(agent.foregroundState("foo")).toBe("requires_action");
    await vi.advanceTimersByTimeAsync(milliseconds - 1);
    expect(request.settled).not.toHaveBeenCalled();
    expect(forms[0].signal.aborted).toBe(false);
    expect(session.openUserInputs.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(request.promise).resolves.toEqual(TIMEOUT_RESULT);
    expect(forms[0].signal.aborted).toBe(true);
    expect(request.controller.signal.aborted).toBe(false);
    expect(session.abortController.signal.aborted).toBe(false);
    expect(session.cancelled).toBe(false);
    expect(session.openUserInputs.size).toBe(0);
    expect(agent.foregroundState("foo")).toBe("running");
    expect(interrupt).not.toHaveBeenCalled();
    expect(client.requestPermission).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("keeps permission, MCP, and refusal dialog waits open after an AskUserQuestion expires", async () => {
  const { agent, ask, client, forms, interrupt, logger, session } = await setup({ timeout: "100" });
  const pending: Promise<unknown>[] = [];
  const controller = new AbortController();
  onTestFinished(async () => {
    controller.abort();
    await Promise.allSettled(pending);
  });
  client.requestPermission.mockImplementation(() => new Promise(() => {}));

  const permission = agent.canUseTool("foo")(
    "Bash",
    { command: "ls" },
    {
      requestId: "foo",
      signal: controller.signal,
      suggestions: [],
      toolUseID: "foo",
    },
  );
  pending.push(permission);
  const mcp: Promise<unknown> = (agent as any).handleMcpElicitation("foo", {
    form: true,
    url: false,
  })(
    {
      mode: "form",
      message: "Choose the checks",
      requestedSchema: { type: "object", properties: {} },
    },
    { signal: controller.signal },
  );
  pending.push(mcp);
  const refusal: Promise<unknown> = (agent as any).handleUserDialog("foo")(
    {
      dialogKind: "refusal_fallback_prompt",
      payload: {
        originalModel: "claude-fable-5",
        fallbackModel: "claude-opus-4-8",
      },
    },
    { signal: controller.signal },
  );
  pending.push(refusal);
  const settled = vi.fn();
  for (const promise of pending) {
    void promise.then(settled, settled);
  }
  await vi.advanceTimersByTimeAsync(0);

  expect(client.requestPermission).toHaveBeenCalledOnce();
  expect(client.requestPermission.mock.calls[0][1]).toBe(controller.signal);
  expect(forms).toHaveLength(2);
  expect(forms[0].signal).toBe(controller.signal);
  expect(forms[1].signal).toBe(controller.signal);
  expect(session.openUserInputs.size).toBe(3);
  expect(vi.getTimerCount()).toBe(0);

  const question = ask("bar");
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(question.promise).resolves.toEqual(TIMEOUT_RESULT);
  expect(forms).toHaveLength(3);
  expect(settled).not.toHaveBeenCalled();
  expect(controller.signal.aborted).toBe(false);
  expect(session.openUserInputs.size).toBe(3);
  expect(agent.foregroundState("foo")).toBe("requires_action");
  expect(vi.getTimerCount()).toBe(0);
  expect(interrupt).not.toHaveBeenCalled();
  expect(logger.error).not.toHaveBeenCalled();

  controller.abort();
  await expect(permission).rejects.toThrowErrorMatchingInlineSnapshot(`[Error: Tool use aborted]`);
  await expect(mcp).resolves.toEqual({ action: "cancel" });
  await expect(refusal).resolves.toEqual({ behavior: "cancelled" });
  expect(settled).toHaveBeenCalledTimes(3);
  expect(session.openUserInputs.size).toBe(0);
});

it("returns every answer and note from a multi-question form and clears its timer", async () => {
  const { ask, forms } = await setup();
  const request = ask("foo");
  await vi.advanceTimersByTimeAsync(99);

  expect(forms[0].request.requestedSchema.properties).toMatchObject({
    question_0: { description: "Which color?", oneOf: [{ const: "Blue" }, { const: "Red" }] },
    question_1: {
      description: "Which checks?",
      items: { anyOf: [{ const: "Build" }, { const: "Test" }] },
    },
  });
  forms[0].resolve({
    action: "accept",
    content: {
      question_0: "Blue",
      question_0_custom: "Use the darker shade",
      question_1: ["Build", "Test"],
      question_1_custom: "Lint",
    },
  });
  await expect(request.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: {
      ...INPUT,
      answers: { "Which color?": "Blue", "Which checks?": "Build, Test, Lint" },
      annotations: { "Which color?": { notes: "Use the darker shade" } },
    },
  });
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(100);
  expect(forms[0].signal.aborted).toBe(false);

  const retry = ask("bar");
  await vi.advanceTimersByTimeAsync(0);
  expect(forms).toHaveLength(2);
  forms[1].resolve({ action: "decline" });
  await expect(retry.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: {} },
  });
});

it.each([
  { elapsed: 99, timing: "before expiry" },
  { elapsed: 100, timing: "after expiry but before the timeout settles" },
])("preserves SDK cancellation $timing", async ({ elapsed }) => {
  const { ask, forms, logger, session } = await setup();
  const request = ask("foo");
  await vi.advanceTimersByTimeAsync(0);

  vi.advanceTimersByTime(elapsed);
  request.controller.abort();

  await expect(request.promise).rejects.toThrowErrorMatchingInlineSnapshot(
    `[Error: Tool use aborted]`,
  );
  expect(forms[0].signal.aborted).toBe(true);
  expect(session.openUserInputs.size).toBe(0);
  expect(logger.error).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not latch a turn when the SDK aborts before expiry", async () => {
  const { ask, forms } = await setup();
  const request = ask("foo");
  await vi.advanceTimersByTimeAsync(99);
  request.controller.abort();
  await expect(request.promise).rejects.toThrowErrorMatchingInlineSnapshot(
    `[Error: Tool use aborted]`,
  );
  await vi.advanceTimersByTimeAsync(100);

  const retry = ask("bar");
  await vi.advanceTimersByTimeAsync(0);
  expect(forms).toHaveLength(2);
  forms[1].resolve({ action: "decline" });
  await expect(retry.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: {} },
  });
});

it("preserves explicit cancellation without latching the turn", async () => {
  const { ask, forms, logger, session } = await setup();
  const request = ask("foo");
  await vi.advanceTimersByTimeAsync(50);
  forms[0].resolve({ action: "cancel" });

  await expect(request.promise).rejects.toThrowErrorMatchingInlineSnapshot(
    `[Error: Tool use aborted]`,
  );
  expect(session.openUserInputs.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(logger.error).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);

  const retry = ask("bar");
  await vi.advanceTimersByTimeAsync(0);
  expect(forms).toHaveLength(2);
  forms[1].resolve({ action: "decline" });
  await expect(retry.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: {} },
  });
});

it("preserves a declined form as skipped answers without latching the turn", async () => {
  const { ask, forms, logger, session } = await setup();
  const request = ask("foo");
  await vi.advanceTimersByTimeAsync(50);
  forms[0].resolve({ action: "decline" });

  await expect(request.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: {} },
  });
  expect(session.openUserInputs.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(logger.error).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);

  const retry = ask("bar");
  await vi.advanceTimersByTimeAsync(0);
  expect(forms).toHaveLength(2);
  forms[1].resolve({ action: "decline" });
  await expect(retry.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: {} },
  });
});

it("reports a client rejection without treating it as a timeout", async () => {
  const { ask, forms, logger, session } = await setup();
  const request = ask("foo");
  await vi.advanceTimersByTimeAsync(50);
  forms[0].reject(new Error("Client unavailable"));

  await expect(request.promise).resolves.toEqual({
    behavior: "deny",
    message: "Could not present the question to the user.",
  });
  expect(logger.error.mock.calls).toEqual([
    ["Failed to present AskUserQuestion elicitation: Error: Client unavailable"],
  ]);
  expect(session.openUserInputs.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(100);

  const retry = ask("bar");
  await vi.advanceTimersByTimeAsync(0);
  expect(forms).toHaveLength(2);
  forms[1].resolve({ action: "decline" });
  await expect(retry.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: {} },
  });
});

it("suppresses retries while an already open sibling can still answer", async () => {
  const { agent, ask, forms, session } = await setup();
  const first = ask("foo");
  await vi.advanceTimersByTimeAsync(50);
  const sibling = ask("bar");
  await vi.advanceTimersByTimeAsync(50);

  await expect(first.promise).resolves.toEqual(TIMEOUT_RESULT);
  await expect(ask("baz").promise).resolves.toEqual(TIMEOUT_RESULT);
  expect(forms).toHaveLength(2);
  expect(forms[1].signal.aborted).toBe(false);
  expect(sibling.settled).not.toHaveBeenCalled();
  expect(session.openUserInputs.size).toBe(1);
  expect(agent.foregroundState("foo")).toBe("requires_action");
  expect(vi.getTimerCount()).toBe(1);

  await vi.advanceTimersByTimeAsync(25);
  forms[1].resolve({ action: "accept", content: { question_0: "Red" } });
  await expect(sibling.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: { "Which color?": "Red" } },
  });
  expect(session.openUserInputs.size).toBe(0);
  expect(agent.foregroundState("foo")).toBe("running");
  expect(vi.getTimerCount()).toBe(0);
  await expect(ask("qux").promise).resolves.toEqual(TIMEOUT_RESULT);
  expect(forms).toHaveLength(2);
});

it("keeps retry suppression after a late client answer", async () => {
  const { ask, forms, logger, session } = await setup();
  const request = ask("foo");
  await vi.advanceTimersByTimeAsync(100);
  await expect(request.promise).resolves.toEqual(TIMEOUT_RESULT);
  expect(forms[0].signal.aborted).toBe(true);
  await expect(ask("bar").promise).resolves.toEqual(TIMEOUT_RESULT);

  forms[0].resolve({
    action: "accept",
    content: { question_0: "Blue", question_1: ["Build", "Test"] },
  });
  await vi.advanceTimersByTimeAsync(0);

  await expect(ask("baz").promise).resolves.toEqual(TIMEOUT_RESULT);
  expect(forms).toHaveLength(1);
  expect(session.openUserInputs.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(logger.error).not.toHaveBeenCalled();
});

it("does not report awaiting input for an already suppressed root retry", async () => {
  const { agent, ask, foreground, forms, session } = await setup();
  const first = ask("foo");
  await vi.advanceTimersByTimeAsync(100);
  await expect(first.promise).resolves.toEqual(TIMEOUT_RESULT);
  expect(foreground.awaitingUser).toHaveBeenCalledOnce();
  foreground.awaitingUser.mockClear();
  foreground.running.mockClear();

  await expect(ask("bar").promise).resolves.toEqual(TIMEOUT_RESULT);

  expect(foreground.awaitingUser).not.toHaveBeenCalled();
  expect(foreground.running).not.toHaveBeenCalled();
  expect(agent.foregroundState("foo")).toBe("running");
  expect(forms).toHaveLength(1);
  expect(session.openUserInputs.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not publish awaiting-input state for an already suppressed child retry", async () => {
  const { ask, child, client, forms, session } = await setup();
  const value = child("bar");
  const first = ask("foo", "bar");
  await vi.advanceTimersByTimeAsync(100);
  await expect(first.promise).resolves.toEqual(CHILD_TIMEOUT_RESULT);
  expect(client.sessionUpdate).toHaveBeenCalledWith({
    sessionId: "foo",
    update: {
      sessionUpdate: "subagent_update",
      sessionId: "bar",
      state: { state: "requires_action" },
    },
  });
  client.sessionUpdate.mockClear();

  await expect(ask("bar", "bar").promise).resolves.toEqual(CHILD_TIMEOUT_RESULT);

  expect(
    client.sessionUpdate.mock.calls.filter(
      ([{ update }]) => update.sessionUpdate === "subagent_update",
    ),
  ).toEqual([]);
  expect(forms).toHaveLength(1);
  expect(value.openRequests).toBe(0);
  expect(value.workState).toBe("running");
  expect(session.openUserInputs.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("expires staggered sibling forms at their own deadlines", async () => {
  const { ask, forms, session } = await setup();
  const first = ask("foo");
  await vi.advanceTimersByTimeAsync(50);
  const sibling = ask("bar");
  await vi.advanceTimersByTimeAsync(50);

  await expect(first.promise).resolves.toEqual(TIMEOUT_RESULT);
  expect(forms[0].signal.aborted).toBe(true);
  expect(forms[1].signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(49);
  expect(sibling.settled).not.toHaveBeenCalled();
  expect(session.openUserInputs.size).toBe(1);
  await vi.advanceTimersByTimeAsync(1);

  await expect(sibling.promise).resolves.toEqual(TIMEOUT_RESULT);
  expect(forms[1].signal.aborted).toBe(true);
  expect(first.controller.signal.aborted).toBe(false);
  expect(sibling.controller.signal.aborted).toBe(false);
  expect(session.openUserInputs.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("allows a later turn to open forms after the previous turn timed out", async () => {
  const { ask, forms, turn } = await setup();
  const first = ask("foo");
  await vi.advanceTimersByTimeAsync(100);
  await expect(first.promise).resolves.toEqual(TIMEOUT_RESULT);
  await expect(ask("bar").promise).resolves.toEqual(TIMEOUT_RESULT);

  turn();
  const later = ask("baz");
  await vi.advanceTimersByTimeAsync(0);
  expect(forms).toHaveLength(2);
  expect(later.settled).not.toHaveBeenCalled();
  forms[1].resolve({ action: "decline" });
  await expect(later.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: {} },
  });
});

it("isolates a child timeout from its parent, sibling, and resumed task", async () => {
  const { ask, child, forms, session } = await setup();
  const firstChild = child("bar");
  const siblingChild = child("baz");
  const first = ask("foo", "bar");
  await vi.advanceTimersByTimeAsync(100);
  await expect(first.promise).resolves.toEqual(CHILD_TIMEOUT_RESULT);
  await expect(ask("bar", "bar").promise).resolves.toEqual(CHILD_TIMEOUT_RESULT);
  expect(firstChild.openRequests).toBe(0);
  expect(firstChild.workState).toBe("running");

  const root = ask("baz");
  const sibling = ask("qux", "baz");
  // A resumed task has a fresh live record, even though its agent ID is unchanged.
  session.liveBackgroundTasks.delete("bar");
  session.liveBackgroundTasks.set("bar", {
    backgrounded: true,
    isSubagent: true,
    parentToolUseId: "launch-bar",
  });
  const resumed = ask("quux", "bar");
  await vi.advanceTimersByTimeAsync(0);

  expect(forms.map(({ request }) => request.sessionId)).toEqual(["bar", "foo", "baz", "bar"]);
  expect(firstChild.openRequests).toBe(1);
  expect(siblingChild.openRequests).toBe(1);
  forms[1].resolve({ action: "decline" });
  forms[2].resolve({ action: "decline" });
  forms[3].resolve({ action: "accept", content: { question_0: "Blue" } });
  await expect(root.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: {} },
  });
  await expect(sibling.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: {} },
  });
  await expect(resumed.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: { "Which color?": "Blue" } },
  });
  expect(session.openUserInputs.size).toBe(0);
  expect(firstChild.openRequests).toBe(0);
  expect(siblingChild.openRequests).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  { elapsed: 50, timing: "before expiry" },
  { elapsed: 100, timing: "after expiry" },
])("carries the autonomous latch into a turn that takes over $timing", async ({ elapsed }) => {
  const { ask, autonomous, forms, turn } = await setup();
  autonomous();
  const first = ask("foo");
  await vi.advanceTimersByTimeAsync(elapsed);

  turn();
  await vi.advanceTimersByTimeAsync(100 - elapsed);
  await expect(first.promise).resolves.toEqual(TIMEOUT_RESULT);
  await expect(ask("bar").promise).resolves.toEqual(TIMEOUT_RESULT);
  expect(forms).toHaveLength(1);

  turn();
  const later = ask("baz");
  await vi.advanceTimersByTimeAsync(0);
  expect(forms).toHaveLength(2);
  forms[1].resolve({ action: "decline" });
  await expect(later.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: {} },
  });
});

it("suppresses a delayed autonomous form after the adopting turn times out", async () => {
  const { ask, autonomous, client, forms, turn } = await setup();
  autonomous();
  const publication = gate();
  client.sessionUpdate.mockReturnValueOnce(publication.promise);
  const delayed = ask("foo");
  await vi.advanceTimersByTimeAsync(0);
  expect(client.sessionUpdate).toHaveBeenCalledOnce();
  expect(forms).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);

  turn();
  const adopter = ask("bar");
  await vi.advanceTimersByTimeAsync(100);
  await expect(adopter.promise).resolves.toEqual(TIMEOUT_RESULT);
  expect(forms).toHaveLength(1);
  expect(forms[0].request.toolCallId).toBe("bar");
  expect(delayed.settled).not.toHaveBeenCalled();
  publication.resolve();
  await vi.advanceTimersByTimeAsync(0);

  expect(forms).toHaveLength(1);
  await expect(delayed.promise).resolves.toEqual(TIMEOUT_RESULT);
  expect(vi.getTimerCount()).toBe(0);
});

it("expires unowned root requests without inventing a latch or poisoning a later turn", async () => {
  const { agent, ask, forms, session, turn } = await setup();
  (agent as any).endForeground("foo", session.activeTurn, { outcome: "end_turn" });
  session.activeTurn = undefined;
  const first = ask("foo");
  await vi.advanceTimersByTimeAsync(100);
  await expect(first.promise).resolves.toEqual(TIMEOUT_RESULT);

  const unowned = ask("bar");
  await vi.advanceTimersByTimeAsync(50);
  expect(forms).toHaveLength(2);
  turn();
  await vi.advanceTimersByTimeAsync(50);
  await expect(unowned.promise).resolves.toEqual(TIMEOUT_RESULT);

  const owned = ask("baz");
  await vi.advanceTimersByTimeAsync(0);
  expect(forms).toHaveLength(3);
  forms[2].resolve({ action: "decline" });
  await expect(owned.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: {} },
  });
});

it("does not borrow the root owner for a child whose task has not been recorded", async () => {
  const { ask, child, forms } = await setup();
  const first = ask("foo", "bar");
  await vi.advanceTimersByTimeAsync(100);
  await expect(first.promise).resolves.toEqual(CHILD_TIMEOUT_RESULT);

  const unowned = ask("bar", "bar");
  await vi.advanceTimersByTimeAsync(50);
  expect(forms).toHaveLength(2);
  child("bar");
  await vi.advanceTimersByTimeAsync(50);
  await expect(unowned.promise).resolves.toEqual(CHILD_TIMEOUT_RESULT);

  const root = ask("baz");
  const owned = ask("qux", "bar");
  await vi.advanceTimersByTimeAsync(0);
  expect(forms.map(({ request }) => request.sessionId)).toEqual(["foo", "foo", "foo", "bar"]);
  forms[2].resolve({ action: "decline" });
  forms[3].resolve({ action: "decline" });
  await expect(root.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: {} },
  });
  await expect(owned.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: {} },
  });
});

it("captures the owner before tool publication and starts the timer only when the form opens", async () => {
  const { ask, client, forms, session, turn } = await setup();
  const publication = gate();
  client.sessionUpdate.mockReturnValueOnce(publication.promise);
  const owner = session.activeTurn;
  const first = ask("foo");
  turn();
  await vi.advanceTimersByTimeAsync(500);

  expect(client.sessionUpdate).toHaveBeenCalledOnce();
  expect(forms).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(first.settled).not.toHaveBeenCalled();
  publication.resolve();
  await vi.advanceTimersByTimeAsync(99);
  expect(forms).toHaveLength(1);
  expect(first.settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(first.promise).resolves.toEqual(TIMEOUT_RESULT);

  const later = ask("bar");
  await vi.advanceTimersByTimeAsync(0);
  expect(forms).toHaveLength(2);
  forms[1].resolve({ action: "decline" });
  await expect(later.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: {} },
  });
  session.activeTurn = owner;
  await expect(ask("baz").promise).resolves.toEqual(TIMEOUT_RESULT);
  expect(forms).toHaveLength(2);
});

it("rechecks the child latch after delayed awaiting-user publication", async () => {
  const { ask, child, client, forms, session } = await setup();
  const value = child("bar");
  const publication = gate();
  client.sessionUpdate.mockImplementation((notification) => {
    const update = notification.update;
    return update.sessionUpdate === "subagent_update" && update.state?.state === "requires_action"
      ? publication.promise
      : Promise.resolve();
  });
  const delayed = ask("foo", "bar");
  await vi.advanceTimersByTimeAsync(0);
  expect(value.openRequests).toBe(1);
  expect(forms).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);

  const sibling = ask("bar", "bar");
  await vi.advanceTimersByTimeAsync(100);
  await expect(sibling.promise).resolves.toEqual(CHILD_TIMEOUT_RESULT);
  expect(delayed.settled).not.toHaveBeenCalled();
  expect(forms).toHaveLength(1);
  expect(forms[0].request.toolCallId).toBe("bar");
  publication.resolve();

  await expect(delayed.promise).resolves.toEqual(CHILD_TIMEOUT_RESULT);
  expect(forms).toHaveLength(1);
  expect(value.openRequests).toBe(0);
  expect(value.workState).toBe("running");
  expect(session.openUserInputs.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("clears the form timer before waiting for child cleanup publication", async () => {
  const { ask, child, client, forms, session } = await setup();
  const value = child("bar");
  const publication = gate();
  client.sessionUpdate.mockImplementation((notification) => {
    const update = notification.update;
    return update.sessionUpdate === "subagent_update" && update.state?.state === "running"
      ? publication.promise
      : Promise.resolve();
  });
  const request = ask("foo", "bar");
  await vi.advanceTimersByTimeAsync(50);
  forms[0].resolve({ action: "accept", content: { question_0: "Blue" } });
  await vi.advanceTimersByTimeAsync(0);

  expect(client.sessionUpdate).toHaveBeenCalledWith({
    sessionId: "foo",
    update: { sessionUpdate: "subagent_update", sessionId: "bar", state: { state: "running" } },
  });
  expect(request.settled).not.toHaveBeenCalled();
  expect(value.openRequests).toBe(0);
  expect(session.openUserInputs.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(100);
  expect(forms[0].signal.aborted).toBe(false);
  publication.resolve();
  await expect(request.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: { "Which color?": "Blue" } },
  });

  const retry = ask("bar", "bar");
  await vi.advanceTimersByTimeAsync(0);
  expect(forms).toHaveLength(2);
  forms[1].resolve({ action: "decline" });
  await expect(retry.promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: {} },
  });
});
