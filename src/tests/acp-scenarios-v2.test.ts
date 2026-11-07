/**
 * Every scenario of `acp-scenarios/scenarios.ts` on the experimental ACP v2
 * surface: through the protocol router, with the SDK's v2 client.
 *
 * - Status: each scenario passes, every prompt turn ending with a stop reason,
 *   unless {@link V2_STOPS} names why it stops. Every scenario passes today;
 *   a scenario that the v2 surface cannot run yet goes in the table.
 * - Schema: every message the agent sends, also in a scenario that stops, is
 *   valid against the draft v2 schema of the SDK.
 * - Tool calls: the first report of each tool call has a title. v2 has no
 *   `tool_call`, so a report of a tool call that the client has not seen
 *   creates it, where v1 drops it.
 * - Golden files: `acp-scenarios/__snapshots__/v2/<scenario>.jsonl` for each
 *   passing scenario. Run `npx vitest run src/tests/acp-scenarios-v2.test.ts -u`
 *   to update them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeAcpAgent } from "../acp-agent.js";
import {
  resetIds,
  PROFILES,
  assistantTurn,
  result,
  type Scenario,
  runScenarioV2,
  type ScenarioRunV2,
  type WireRecorded,
} from "./acp-scenarios/harness.js";
import { SCENARIOS } from "./acp-scenarios/scenarios.js";
import { canonical } from "./acp-scenarios/compare.js";
import { validateV2Message } from "./acp-scenarios/schema.js";
import { airExtensionMeta } from "../air-extension.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  const harness = await import("./acp-scenarios/harness.js");
  return {
    ...actual,
    query: harness.mockedQuery,
    getSessionMessages: harness.mockedSessionMessages,
    getSessionInfo: harness.mockedSessionInfo,
  };
});

// The recordings replace only the ids that the run generated, so the harness
// learns each id that `randomUUID` returns.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const harness = await import("./acp-scenarios/harness.js");
  return {
    ...actual,
    randomUUID: (...args: Parameters<typeof actual.randomUUID>) => {
      const id = actual.randomUUID(...args);
      harness.noteGeneratedId(id);
      return id;
    },
  };
});

const here = path.dirname(fileURLToPath(import.meta.url));

const PASSES = "passes";

/**
 * The scenarios that stop on the v2 surface, each with the reason, which names
 * the step of `docs/acp-v2.md` that removes it. Every other scenario passes.
 */
const V2_STOPS: Record<string, string> = {};

const statusOf = (scenario: string) => V2_STOPS[scenario] ?? PASSES;

const runs = new Map<string, ScenarioRunV2>();
let configDir: string;

beforeAll(async () => {
  // A run must not depend on the machine: no remote login, no Claude CLI, no
  // user settings, and the bypass mode also for root.
  for (const name of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "NO_BROWSER"]) {
    vi.stubEnv(name, "");
  }
  vi.stubEnv("CLAUDE_CODE_REMOTE", "");
  vi.stubEnv("ANTHROPIC_MODEL", "");
  vi.stubEnv("IS_SANDBOX", "1");
  vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "/usr/bin/false");
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-scenario-config-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  for (const scenario of SCENARIOS) runs.set(scenario.name, await runV2(scenario));
}, 120_000);

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(configDir, { recursive: true, force: true });
});

async function runV2(scenario: Scenario): Promise<ScenarioRunV2> {
  resetIds();
  const agents: ClaudeAcpAgent[] = [];
  const { acpProtocolRouter } = await import("../serve.js");
  const quiet = { log: () => {}, error: () => {} };
  try {
    return await runScenarioV2(
      (stream) => acpProtocolRouter(quiet, (agent) => agents.push(agent)).connect(stream),
      scenario,
    );
  } finally {
    await Promise.all(agents.map((agent) => agent.dispose()));
  }
}

function run(scenario: string): ScenarioRunV2 {
  const recorded = runs.get(scenario);
  if (!recorded) throw new Error(`no v2 run of ${scenario}`);
  return recorded;
}

function toJsonLines(recorded: WireRecorded[]): string {
  return recorded.map((record) => `${canonical(record)}\n`).join("");
}

describe("ACP v2 scenarios", () => {
  it("pass, or stop as the table says", () => {
    const table = (status: (scenario: string) => string) =>
      Object.fromEntries(SCENARIOS.map((scenario) => [scenario.name, status(scenario.name)]));
    expect(table((scenario) => run(scenario).status)).toEqual(table(statusOf));
  });

  describe("schema check", () => {
    const chunk = (update: Record<string, unknown>): WireRecorded => ({
      kind: "notification",
      method: "session/update",
      payload: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", ...update } },
    });

    it("rejects a message that breaks the v2 schema", () => {
      const content = { type: "text", text: "hi" };
      expect(validateV2Message(chunk({ messageId: "m", content }))).toEqual([]);
      // v2 requires the id of the message a chunk belongs to.
      expect(validateV2Message(chunk({ content }))).not.toEqual([]);
    });

    it.each(SCENARIOS.map((scenario) => scenario.name))("%s", (scenario) => {
      expect(run(scenario).raw.flatMap((message) => validateV2Message(message))).toEqual([]);
    });
  });

  describe("tool calls are reported with a title first", () => {
    it.each(SCENARIOS.map((scenario) => scenario.name))("%s", (scenario) => {
      const reported = new Set<string>();
      const untitled: string[] = [];
      for (const message of run(scenario).raw) {
        if (message.kind !== "notification" || message.method !== "session/update") continue;
        const { sessionId, update } = message.payload as {
          sessionId: string;
          update: { sessionUpdate: string; toolCallId?: string; title?: unknown };
        };
        if (update.sessionUpdate !== "tool_call_update") continue;
        const key = `${sessionId} ${update.toolCallId}`;
        if (!reported.has(key) && typeof update.title !== "string") untitled.push(key);
        reported.add(key);
      }
      expect(untitled).toEqual([]);
    });
  });

  describe("v2 golden files", () => {
    const passing = SCENARIOS.map((scenario) => scenario.name).filter(
      (scenario) => statusOf(scenario) === PASSES,
    );
    it.each(passing)("%s", async (scenario) => {
      await expect(toJsonLines(run(scenario).normalized)).toMatchFileSnapshot(
        path.join(here, "acp-scenarios", "__snapshots__", "v2", `${scenario}.jsonl`),
      );
    });
  });
});

describe("AIR task scenarios on ACP v2", () => {
  it.each([
    "subagent-native-sessions",
    "subagent-agent-async",
    "subagent-nested",
    "subagent-late-child-update",
    "bash-background",
    "async-task-held-until-tool-id",
    "async-task-ends-before-tool-id",
    "async-task-released-at-turn-end",
  ])("%s keeps the session usable", async (name) => {
    const scenario = SCENARIOS.find((scenario) => scenario.name === name)!;
    const recorded = await runV2({
      ...scenario,
      capabilities: {
        ...scenario.capabilities,
        _meta: {
          ...scenario.capabilities?._meta,
          ...PROFILES.air.capabilities._meta,
        },
      },
      turns: [
        ...scenario.turns,
        async function* () {
          yield* assistantTurn("msg_followup", [{ type: "text", text: "Follow-up worked." }]);
          yield result();
        },
      ],
    });
    const updates = recorded.raw.flatMap((message) =>
      message.kind === "notification" && message.method === "session/update"
        ? [(message.payload as { update: Record<string, unknown> }).update]
        : [],
    );
    expect(recorded.status).toBe(PASSES);
    expect(
      updates.flatMap((update) => airExtensionMeta(update._meta)?.sessionFailure ?? []),
    ).toEqual([]);
    expect(updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: name.startsWith("subagent") ? "subagent_spawned" : "async_task_spawned",
      }),
    );
    const followup = updates
      .filter(
        (update) =>
          update.sessionUpdate === "agent_message_chunk" && update.messageId === "msg_followup",
      )
      .map((update) => (update.content as { text: string }).text)
      .join("");
    expect(followup).toBe("Follow-up worked.");
    expect(recorded.raw.flatMap(validateV2Message)).toEqual([]);
  });
});
