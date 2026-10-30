import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo, Options } from "@anthropic-ai/claude-agent-sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { ClaudeAcpAgent, FAST_MODE_CONFIG_ID, type AcpClient } from "../acp-agent.js";
import { AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY } from "../air-extension.js";
import { acpProtocolRouter } from "../serve.js";
import { initializeClient, makeMockQuery } from "./helpers.js";
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

const MODELS: ModelInfo[] = ["sonnet", "opus"].map((value) => ({
  value,
  displayName: value,
  description: "",
  resolvedModel: `claude-${value}-4-6`,
  supportsAutoMode: true,
  supportsFastMode: true,
  supportsEffort: true,
  supportedEffortLevels: ["low", "medium", "high", "xhigh"] as const,
}));
const PROVIDER = {
  providerId: "main",
  apiType: "anthropic",
  baseUrl: "https://provider.example",
};
const AIR_CAPABILITIES = {
  _meta: {
    jetbrains: { air: { version: 1, capabilities: [AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY] } },
  },
};

describe("provider updates preserve session configuration", { timeout: 10_000 }, () => {
  let agent: ClaudeAcpAgent;
  let cwd: string;
  let updates: any[];
  let queries: ReturnType<typeof createQuery>[];
  let initializationGate: Promise<void> | undefined;
  let modelGate: Promise<void> | undefined;
  let turnGate: Promise<void> | undefined;
  let missingResume: boolean;
  let rejectModel: boolean;
  let agentsAvailable: boolean;
  let rejectConfigUpdate: boolean;
  let models: typeof MODELS;
  let mcpServers: Array<{ name: string; status: string }>;

  function createQuery(request: { options: Options; prompt: AsyncIterable<any> }) {
    const state = {
      model: request.options.model ?? "sonnet",
      effort: request.options.effort ?? null,
      fastMode: false,
      ultracode:
        typeof request.options.settings === "object" &&
        request.options.settings?.ultracode === true,
      agent: request.options.agent ?? "default",
    };
    const calls: any[] = [];
    const query = {
      ...makeMockQuery(),
      request,
      state,
      calls,
      initializationResult: async () => {
        await initializationGate;
        if (request.options.resume && missingResume) {
          throw new Error("No conversation found with session ID");
        }
        return { models, fast_mode_state: "off", fast_mode_disabled_reason: "sdk_opt_in_required" };
      },
      setModel: vi.fn(async (value: string) => {
        await modelGate;
        if (rejectModel) throw new Error("Model switch blocked by a PreModelSwitch hook");
        state.model = value;
      }),
      setPermissionMode: vi.fn(async () => {}),
      applyFlagSettings: async (flags: any) => {
        calls.push(flags);
        if ("effortLevel" in flags) state.effort = flags.effortLevel;
        if ("fastMode" in flags) state.fastMode = flags.fastMode;
        if ("ultracode" in flags) state.ultracode = flags.ultracode;
        if ("agent" in flags) state.agent = flags.agent ?? "default";
      },
      supportedAgents: async () =>
        agentsAvailable ? [{ name: "reviewer", description: "Review" }] : [],
      getSettings: async () => ({
        applied: { ultracodeAvailable: true, ultracodeRequested: state.ultracode },
      }),
      close: vi.fn(),
      [Symbol.asyncIterator]: async function* () {
        for await (const message of request.prompt) {
          calls.push({ prompt: message.message.content, state: { ...state } });
          yield userEcho(message);
          // The CLI reports MCP server statuses in the `system`/init of every turn.
          if (mcpServers.length > 0) {
            yield { type: "system", subtype: "init", mcp_servers: mcpServers };
          }
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
    cwd = await mkdtemp(path.join(tmpdir(), "provider-session-configuration-"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", cwd);
    vi.stubEnv("ANTHROPIC_MODEL", undefined);
    updates = [];
    queries = [];
    initializationGate = modelGate = turnGate = undefined;
    missingResume = rejectModel = false;
    agentsAvailable = true;
    rejectConfigUpdate = false;
    models = MODELS;
    mcpServers = [];
    sdk.query.mockImplementation((request) => {
      const query = createQuery(request);
      queries.push(query);
      return query;
    });
    sdk.getSessionMessages.mockResolvedValue([]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ data: MODELS.map((model) => ({ id: model.resolvedModel })) }),
      ),
    );
    agent = new ClaudeAcpAgent(
      {
        sessionUpdate: async (update: any) => {
          if (rejectConfigUpdate && update.update.sessionUpdate === "config_option_update") {
            throw new Error("Connection closed");
          }
          updates.push(update);
        },
      } as AcpClient,
      { log() {}, error() {}, warn() {} },
    );
    await initializeClient(agent, AIR_CAPABILITIES);
    await refresh();
  });

  afterEach(async () => {
    await agent.dispose();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await rm(cwd, { recursive: true, force: true });
  });

  function refresh() {
    return agent.unstable_setProvider(PROVIDER);
  }

  function newSession(meta?: any) {
    return agent.newSession({ cwd, mcpServers: [], _meta: meta });
  }

  function select(sessionId: string, configId: string, value: string) {
    return agent.setSessionConfigOption({ sessionId, configId, value });
  }

  function setMode(sessionId: string, modeId: string) {
    return agent.setSessionMode({ sessionId, modeId });
  }

  function prompt(sessionId: string, text = "hi") {
    return agent.prompt({ sessionId, prompt: [{ type: "text", text }] });
  }

  function current(sessionId: string, id: string) {
    return agent.sessions[sessionId].configOptions.find((option) => option.id === id)?.currentValue;
  }

  function lastQuery() {
    return queries.at(-1)!;
  }

  it("keeps the model and each explicit effort before the first prompt", async () => {
    const sessions = [];
    for (const effort of ["high", "low"]) {
      const { sessionId } = await newSession();
      await select(sessionId, "model", "opus");
      await select(sessionId, "effort", effort);
      sessions.push(sessionId);
    }
    updates.length = 0;
    await refresh();

    expect(queries.slice(0, 2).every((query) => query.close.mock.calls.length === 1)).toBe(true);
    expect(queries.slice(2).map((query) => query.request.options.resume)).toEqual(sessions);
    expect(queries.slice(2).map((query) => [query.state.model, query.state.effort])).toEqual([
      ["opus", "high"],
      ["opus", "low"],
    ]);
    for (const id of sessions) {
      expect(updates).toContainEqual({
        sessionId: id,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: agent.sessions[id].configOptions,
        },
      });
    }
  });

  it("keeps a later model choice instead of the model in the transcript", async () => {
    const { sessionId } = await newSession();
    await prompt(sessionId);
    sdk.getSessionMessages.mockResolvedValue([
      { type: "assistant", message: { model: "claude-sonnet-4-6" } },
    ]);
    await select(sessionId, "model", "opus");
    await select(sessionId, "effort", "high");

    await refresh();

    expect(lastQuery().state).toMatchObject({ model: "opus", effort: "high" });
    expect(current(sessionId, "model")).toBe("opus");
  });

  it("keeps every choice through the missing-history fallback", async () => {
    const { sessionId } = await newSession();
    await select(sessionId, "model", "opus");
    await select(sessionId, "effort", "low");
    await select(sessionId, "ultracode", "on");
    await select(sessionId, FAST_MODE_CONFIG_ID, "on");
    await select(sessionId, "agent", "reviewer");
    missingResume = true;

    await refresh();

    expect(lastQuery().request.options.sessionId).toBe(sessionId);
    expect(lastQuery().request.options.resume).toBeUndefined();
    expect(lastQuery().state).toEqual({
      model: "opus",
      effort: "low",
      ultracode: true,
      fastMode: true,
      agent: "reviewer",
    });
  });

  it("keeps automatic effort unpinned across a later model switch", async () => {
    const { sessionId } = await newSession({
      claudeCode: {
        options: {
          settings: { modelSettings: { "claude-opus-4-6": { effortLevel: "high" } } },
        },
      },
    });
    await refresh();
    expect(lastQuery().state.effort).toBe("medium");

    await select(sessionId, "model", "opus");

    expect(lastQuery().state.effort).toBe("high");
  });

  it("keeps legacy pins and does not restore an explicit effort cleared by Default", async () => {
    agent.clientCapabilities = {};
    const { sessionId } = await newSession({ claudeCode: { options: { effort: "high" } } });
    await select(sessionId, "effort", "low");
    await refresh();
    expect(lastQuery().state.effort).toBe("low");
    await select(sessionId, "effort", "default");

    await refresh();

    expect(lastQuery().state.effort).toBeNull();
    expect(lastQuery().request.options.effort).toBeUndefined();
    expect(current(sessionId, "effort")).toBe("default");
  });

  it("drops a creation-time pin that a model switch removed", async () => {
    models = MODELS.map((model) =>
      model.value === "opus" ? { ...model, supportedEffortLevels: ["low", "medium"] } : model,
    );
    const { sessionId } = await newSession({ claudeCode: { options: { effort: "high" } } });
    await select(sessionId, "model", "opus");
    await select(sessionId, "model", "sonnet");

    await refresh();

    expect(current(sessionId, "effort")).toBe("medium");
    expect(lastQuery().state.effort).toBe("medium");
  });

  it("reports a supported effort after the catalog removes a pin", async () => {
    const { sessionId } = await newSession();
    await select(sessionId, "model", "opus");
    await select(sessionId, "effort", "high");
    models = MODELS.map((model) => ({ ...model, supportedEffortLevels: ["low", "medium"] }));

    await refresh();

    expect(current(sessionId, "effort")).toBe("medium");
    expect(lastQuery().state.effort).toBe("medium");
  });

  it("reports the actual fallback when a model disappears or its switch is refused", async () => {
    const { sessionId } = await newSession();
    await select(sessionId, "model", "opus");
    models = [MODELS[0]];
    await refresh();
    expect(current(sessionId, "model")).toBe("sonnet");
    models = MODELS;
    await refresh();
    await select(sessionId, "model", "opus");
    rejectModel = true;

    await refresh();

    expect(current(sessionId, "model")).toBe("sonnet");
    expect(lastQuery().state.model).toBe("sonnet");
    expect(updates.at(-1).update.configOptions).toEqual(agent.sessions[sessionId].configOptions);
  });

  it("restores Auto once the restored model supports it", async () => {
    models = MODELS.map((model) =>
      model.value === "sonnet" ? { ...model, supportsAutoMode: false } : model,
    );
    const { sessionId } = await newSession();
    await select(sessionId, "model", "opus");
    await setMode(sessionId, "auto");

    await refresh();
    await prompt(sessionId);

    expect(agent.sessions[sessionId].modes.currentModeId).toBe("auto");
    expect(lastQuery().setPermissionMode).toHaveBeenLastCalledWith("auto");
    expect(JSON.stringify(updates)).not.toContain("Auto mode unavailable");
  });

  it("keeps the plan return mode and the creation options", async () => {
    const { sessionId } = await newSession({
      claudeCode: { options: { maxTurns: 3, promptSuggestions: false } },
    });
    await setMode(sessionId, "acceptEdits");
    await setMode(sessionId, "plan");

    await refresh();

    expect(lastQuery().request.options).toMatchObject({
      maxTurns: 3,
      promptSuggestions: false,
      permissionMode: "plan",
    });
    expect(agent.sessions[sessionId].prePlanMode).toBe("acceptEdits");
  });

  it.each(["resumeSession", "loadSession"] as const)(
    "%s reuses a refreshed session when its creation parameters are unchanged",
    async (method) => {
      const meta = { claudeCode: { options: { effort: "high" } } };
      const { sessionId } = await newSession(meta);
      await select(sessionId, "model", "opus");
      await select(sessionId, "effort", "low");
      await refresh();
      const recreated = agent.sessions[sessionId];
      const queryCount = queries.length;

      await agent[method]({ sessionId, cwd, mcpServers: [], _meta: meta });

      expect(queries).toHaveLength(queryCount);
      expect(agent.sessions[sessionId]).toBe(recreated);
      expect(lastQuery().state).toMatchObject({ model: "opus", effort: "low" });
    },
  );

  it("keeps Fast mode on while the current model hides the toggle", async () => {
    models = [MODELS[0], { ...MODELS[1], supportsFastMode: false }];
    const { sessionId } = await newSession();
    await select(sessionId, FAST_MODE_CONFIG_ID, "on");
    await select(sessionId, "model", "opus");

    await refresh();

    expect(lastQuery().state).toMatchObject({ model: "opus", fastMode: true });
    await select(sessionId, "model", "sonnet");
    expect(current(sessionId, FAST_MODE_CONFIG_ID)).toBe("on");
  });

  it.each([true, false])(
    "keeps live ultracode %s over opposite initial settings",
    async (enabled) => {
      const { sessionId } = await newSession({
        claudeCode: { options: { settings: { ultracode: !enabled } } },
      });
      await select(sessionId, "model", "opus");
      await select(sessionId, "ultracode", enabled ? "on" : "off");
      await select(sessionId, "effort", "high");

      await refresh();

      expect(lastQuery().state).toMatchObject({
        model: "opus",
        effort: "high",
        ultracode: enabled,
      });
      expect(current(sessionId, "ultracode")).toBe(enabled ? "on" : "off");
      // An effort change without `ultracode: true` turns ultracode off since CLI 2.1.284.
      expect(lastQuery().calls.findLast((flags) => "effortLevel" in flags)).toEqual(
        enabled ? { effortLevel: "high", ultracode: true } : { effortLevel: "high" },
      );
    },
  );

  it("keeps a creation-time agent that is absent from the picker", async () => {
    const { sessionId } = await newSession({ claudeCode: { options: { agent: "Explore" } } });

    await refresh();

    expect(lastQuery().state.agent).toBe("Explore");
    expect(current(sessionId, "agent")).toBe("default");
  });

  it.each([
    { created: "reviewer", picked: [], pickerAvailable: true },
    { created: "Explore", picked: [], pickerAvailable: true },
    { created: "Explore", picked: ["reviewer"], pickerAvailable: true },
    { created: "Explore", picked: [], pickerAvailable: false },
  ])(
    "keeps Default after clearing $created, picked first: $picked, picker available: $pickerAvailable",
    async (agents) => {
      const { sessionId } = await newSession({
        claudeCode: { options: { agent: agents.created } },
      });
      for (const picked of [...agents.picked, "default"]) await select(sessionId, "agent", picked);
      agentsAvailable = agents.pickerAvailable;
      // The second refresh starts from the session the first one restored.
      for (let refreshes = 0; refreshes < 2; refreshes++) {
        await refresh();
        expect(lastQuery().state.agent).toBe("default");
        expect(current(sessionId, "agent")).toBe(agents.pickerAvailable ? "default" : undefined);
      }
    },
  );

  it("applies a choice sent during the restart after the old choices", async () => {
    const { sessionId } = await newSession();
    const held = deferred();
    initializationGate = held.promise;
    const update = refresh();
    await vi.waitFor(() => expect(queries).toHaveLength(2));
    const choices = [
      select(sessionId, "model", "opus"),
      select(sessionId, "effort", "high"),
      select(sessionId, "ultracode", "on"),
    ];
    held.resolve();
    await Promise.all([update, ...choices]);

    expect(queries[1].state).toMatchObject({ model: "opus", effort: "high", ultracode: true });
  });

  it.each([
    { action: "close", phase: "initialization", missingHistory: false },
    { action: "dispose", phase: "initialization", missingHistory: false },
    { action: "close", phase: "initialization", missingHistory: true },
    { action: "close", phase: "restoration", missingHistory: false },
    { action: "dispose", phase: "restoration", missingHistory: false },
  ])(
    "honors $action during provider $phase (missing history: $missingHistory)",
    async ({ action, phase, missingHistory }) => {
      const { sessionId } = await newSession();
      await select(sessionId, "model", "opus");
      await select(sessionId, "effort", "low");
      const held = deferred();
      missingResume = missingHistory;
      if (phase === "initialization") initializationGate = held.promise;
      else modelGate = held.promise;
      const update = refresh();
      try {
        await vi.waitFor(() => {
          if (phase === "initialization") expect(queries).toHaveLength(2);
          else expect(queries[1]?.setModel).toHaveBeenCalledWith("opus");
        });
        const closing = action === "close" ? agent.closeSession({ sessionId }) : agent.dispose();
        held.resolve();
        await closing;
        const updateCount = updates.length;
        await update;

        expect(Object.hasOwn(agent.sessions, sessionId)).toBe(false);
        expect(queries.every((query) => query.close.mock.calls.length === 1)).toBe(true);
        expect(updates).toHaveLength(updateCount);
      } finally {
        held.resolve();
        await update;
      }
    },
  );

  it("removes the old session when provider recreation fails", async () => {
    const { sessionId } = await newSession();
    const held = deferred();
    initializationGate = held.promise.then(() => {
      throw new Error("Initialization failed");
    });
    const update = refresh();
    try {
      await vi.waitFor(() => expect(queries).toHaveLength(2));
    } finally {
      held.resolve();
      await update;
    }

    expect(Object.hasOwn(agent.sessions, sessionId)).toBe(false);
    expect(queries.every((query) => query.close.mock.calls.length === 1)).toBe(true);
  });

  it("keeps a recreated session when the client misses its restored configuration", async () => {
    await initializeClient(agent, {
      _meta: {
        jetbrains: {
          air: {
            version: 1,
            capabilities: [AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY, "sessionFailure"],
          },
        },
      },
    });
    const { sessionId } = await newSession();
    await select(sessionId, "model", "opus");
    rejectConfigUpdate = true;

    await refresh();
    // The session failure is published without being awaited.
    await new Promise((resolve) => setImmediate(resolve));

    expect(agent.sessions[sessionId].queryClosed).toBeFalsy();
    expect(lastQuery().state.model).toBe("opus");
    expect(updates.filter((update) => update.update._meta?.jetbrains?.air?.sessionFailure)).toEqual(
      [],
    );
  });

  it("restarts a session only after a choice still running on its old query", async () => {
    const { sessionId } = await newSession();
    const heldModel = deferred();
    modelGate = heldModel.promise;
    const firstChoice = select(sessionId, "model", "opus");
    await vi.waitFor(() => expect(queries[0].setModel).toHaveBeenCalledWith("opus"));
    const update = refresh();
    const lastChoice = select(sessionId, "effort", "low");
    expect(queries[0].close).not.toHaveBeenCalled();
    heldModel.resolve();
    await Promise.all([firstChoice, update, lastChoice]);

    expect(queries[1].state).toMatchObject({ model: "opus", effort: "low" });
  });

  it("does not hold another session behind a model switch", async () => {
    const first = await newSession();
    const second = await newSession();
    const held = deferred();
    modelGate = held.promise;
    const choice = select(first.sessionId, "model", "opus");
    await vi.waitFor(() => expect(queries[0].setModel).toHaveBeenCalledWith("opus"));
    try {
      await setMode(second.sessionId, "acceptEdits");
      await prompt(second.sessionId);
    } finally {
      held.resolve();
      await choice;
    }
  });

  it("allows mode changes while a provider update waits for another session's turn", async () => {
    const first = await newSession();
    const second = await newSession();
    const held = deferred();
    turnGate = held.promise;
    const turn = prompt(first.sessionId);
    await vi.waitFor(() => expect(queries[0].calls.some((call) => call.prompt)).toBe(true));
    const update = refresh();
    try {
      await Promise.all([
        setMode(second.sessionId, "acceptEdits"),
        setMode(first.sessionId, "acceptEdits"),
      ]);
      expect(queries).toHaveLength(2);
    } finally {
      held.resolve();
      await Promise.all([turn, update]);
    }
    expect(queries.slice(2).map((query) => query.request.options.permissionMode)).toEqual([
      "acceptEdits",
      "acceptEdits",
    ]);
  });

  it("finishes active and queued turns before the update and holds a later prompt", async () => {
    const { sessionId } = await newSession();
    await select(sessionId, "model", "opus");
    await select(sessionId, "effort", "high");
    const held = deferred();
    turnGate = held.promise;
    const first = prompt(sessionId, "first");
    const second = prompt(sessionId, "queued");
    await vi.waitFor(() => expect(agent.sessions[sessionId].turnQueue).toHaveLength(2));
    const update = refresh();
    const next = prompt(sessionId, "after update");
    await Promise.resolve();
    expect(queries[0].close).not.toHaveBeenCalled();
    held.resolve();
    await Promise.all([first, second, update, next]);

    expect(queries[0].calls.filter((call) => call.prompt)).toHaveLength(2);
    expect(queries[1].calls.filter((call) => call.prompt)).toEqual([
      expect.objectContaining({
        state: expect.objectContaining({ model: "opus", effort: "high" }),
      }),
    ]);
  });

  it("reports a failed client MCP server once across a provider refresh", async () => {
    mcpServers = [{ name: "client-fs", status: "failed" }];
    const { sessionId } = await agent.newSession({
      cwd,
      mcpServers: [{ name: "client-fs", command: "fs-server", args: [], env: [] }],
    });
    await prompt(sessionId);
    await refresh();

    await prompt(sessionId);

    const notices = updates.filter((update) =>
      JSON.stringify(update.update).includes('MCP server \\"client-fs\\" failed to start'),
    );
    expect(notices).toHaveLength(1);
  });

  it("forgets the queue of a session once its changes settle", async () => {
    const { sessionId } = await newSession();
    await select(sessionId, "model", "opus");
    await expect(select("unknown", "model", "opus")).rejects.toThrow();
    await refresh();

    await vi.waitFor(() => expect((agent as any).configurationChanges.size).toBe(0));
  });

  it("reroutes a sign-out replacement already initializing when the provider changes", async () => {
    const { sessionId } = await newSession();
    await select(sessionId, "model", "opus");
    await select(sessionId, "effort", "high");
    agent.sessions[sessionId].needsSignOutRespawn = true;
    const held = deferred();
    initializationGate = held.promise;
    const turn = prompt(sessionId);
    let update: ReturnType<ClaudeAcpAgent["unstable_setProvider"]> | undefined;
    try {
      await vi.waitFor(() => expect(queries).toHaveLength(2));
      const baseUrl = "https://recovered.example";
      update = agent.unstable_setProvider({ ...PROVIDER, baseUrl });
      await vi.waitFor(() => expect(agent.providerConfig?.baseUrl).toBe(baseUrl));
      held.resolve();
      await Promise.all([turn, update]);

      expect(lastQuery().request.options.env?.ANTHROPIC_BASE_URL).toBe(baseUrl);
      expect(lastQuery().state).toMatchObject({ model: "opus", effort: "high" });
    } finally {
      held.resolve();
      await Promise.allSettled([turn, ...(update ? [update] : [])]);
    }
  });

  it("holds prompts waiting for sign-out recovery until the provider replacement is ready", async () => {
    const { sessionId } = await newSession();
    await select(sessionId, "model", "opus");
    await select(sessionId, "effort", "high");
    agent.sessions[sessionId].needsSignOutRespawn = true;
    const signOutHeld = deferred();
    const providerHeld = deferred();
    initializationGate = signOutHeld.promise;
    const first = prompt(sessionId, "first");
    const second = prompt(sessionId, "queued");
    let update: ReturnType<ClaudeAcpAgent["unstable_setProvider"]> | undefined;
    try {
      await vi.waitFor(() => expect(queries).toHaveLength(2));
      initializationGate = providerHeld.promise;
      const baseUrl = "https://recovered.example";
      update = agent.unstable_setProvider({ ...PROVIDER, baseUrl });
      await vi.waitFor(() => expect(agent.providerConfig?.baseUrl).toBe(baseUrl));
      signOutHeld.resolve();
      await vi.waitFor(() => expect(queries).toHaveLength(3));
      expect(queries[1].calls.filter((call) => call.prompt)).toEqual([]);
      expect(queries[2].calls.filter((call) => call.prompt)).toEqual([]);
      providerHeld.resolve();
      await Promise.all([first, second, update]);

      expect(agent.sessions[sessionId].query).toBe(lastQuery());
      expect(lastQuery().request.options.env?.ANTHROPIC_BASE_URL).toBe(baseUrl);
      expect(lastQuery().calls.filter((call) => call.prompt)).toEqual([
        {
          prompt: [{ type: "text", text: "first" }],
          state: expect.objectContaining({ model: "opus", effort: "high" }),
        },
        {
          prompt: [{ type: "text", text: "queued" }],
          state: expect.objectContaining({ model: "opus", effort: "high" }),
        },
      ]);
    } finally {
      signOutHeld.resolve();
      providerHeld.resolve();
      await Promise.allSettled([first, second, ...(update ? [update] : [])]);
    }
  });

  it("keeps choices after a failed listing and a later proxy recovery", async () => {
    const { sessionId } = await newSession();
    await select(sessionId, "model", "opus");
    await select(sessionId, "effort", "high");
    const recovered = { ...PROVIDER, baseUrl: "https://recovered.example" };
    vi.mocked(fetch).mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(agent.unstable_setProvider(recovered)).rejects.toThrow();
    expect(queries[0].close).not.toHaveBeenCalled();

    await agent.unstable_setProvider(recovered);

    expect(lastQuery().state).toMatchObject({ model: "opus", effort: "high" });
    expect(lastQuery().request.options.env?.ANTHROPIC_BASE_URL).toBe("https://recovered.example");
  });

  it("publishes the restored configuration through the v2 protocol router", async () => {
    await agent.dispose();
    const toAgent = new TransformStream<v2.AnyWireMessage, v2.AnyWireMessage>();
    const toClient = new TransformStream<v2.AnyWireMessage, v2.AnyWireMessage>();
    acpProtocolRouter({ log() {}, error() {} }, (created) => (agent = created)).connect({
      readable: toAgent.readable,
      writable: toClient.writable,
    });
    const received: v2.UpdateSessionNotification[] = [];
    await v2
      .client({ name: "provider-test" })
      .onNotification(v2.methods.client.session.update, ({ params }) => void received.push(params))
      .connectWith({ readable: toClient.readable, writable: toAgent.writable }, async (client) => {
        await client.request(v2.methods.agent.initialize, {
          protocolVersion: v2.PROTOCOL_VERSION,
          info: { name: "provider-test", version: "1" },
          capabilities: AIR_CAPABILITIES,
        });
        await client.request(v2.methods.agent.providers.set, PROVIDER);
        const { sessionId } = await client.request(v2.methods.agent.session.new, { cwd });
        for (const [configId, value] of [
          ["model", "opus"],
          ["effort", "high"],
        ]) {
          await client.request(v2.methods.agent.session.setConfigOption, {
            sessionId,
            configId,
            value,
            type: "id",
          });
        }

        await client.request(v2.methods.agent.providers.set, PROVIDER);

        const config = received.findLast(
          ({ update }) => update.sessionUpdate === "config_option_update",
        );
        expect(config?.update).toMatchObject({
          configOptions: expect.arrayContaining([
            expect.objectContaining({ configId: "model", currentValue: "opus" }),
            expect.objectContaining({ configId: "effort", currentValue: "high" }),
          ]),
        });
      });
  });
});
