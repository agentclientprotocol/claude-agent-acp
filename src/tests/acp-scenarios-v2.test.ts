/**
 * Every scenario of `acp-scenarios/scenarios.ts` on the experimental ACP v2
 * surface: through the protocol router, with the SDK's v2 client.
 *
 * - Status: each scenario either passes, every prompt turn ending with a stop
 *   reason, or stops for the reason in {@link V2_STATUS}. A step of the v2
 *   support that translates more of the agent's messages turns scenarios from
 *   stopped into passing, and updates the table.
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
  runScenarioV2,
  type ScenarioRunV2,
  type WireRecorded,
} from "./acp-scenarios/harness.js";
import { SCENARIOS } from "./acp-scenarios/scenarios.js";
import { canonical } from "./acp-scenarios/compare.js";
import { validateV2Message } from "./acp-scenarios/schema.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  const harness = await import("./acp-scenarios/harness.js");
  return {
    ...actual,
    query: harness.mockedQuery,
    getSessionMessages: harness.mockedSessionMessages,
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
/** Step 4 of `docs/acp-v2.md`. */
const REPLAY = "Invalid params: The ACP v2 surface does not replay session history yet";
/** Step 5 of `docs/acp-v2.md`. */
const PLANS = "The ACP v2 surface does not translate plan session updates yet";

/**
 * How each scenario runs on the v2 surface: it passes, or stops for a reason
 * that names the step of `docs/acp-v2.md` that removes it.
 */
const V2_STATUS: Record<string, string> = {
  "session-setup": PASSES,
  "text-and-thinking": PASSES,
  "bash-foreground": PASSES,
  "bash-error": PASSES,
  "bash-background": PASSES,
  "async-task-held-until-tool-id": PASSES,
  "async-task-ends-before-tool-id": PASSES,
  "async-task-released-at-turn-end": PASSES,
  read: PASSES,
  "write-new": PASSES,
  "write-existing": PASSES,
  "edit-with-permission": PASSES,
  "edit-rejected": PASSES,
  "notebook-edit": PASSES,
  "grep-and-glob": PASSES,
  "web-fetch-and-search": PASSES,
  "subagent-task-legacy": PASSES,
  "subagent-agent-async": PASSES,
  "subagent-native-sessions": PASSES,
  "subagent-nested": PASSES,
  "subagent-late-child-update": PASSES,
  "subagent-transcript-extension": PASSES,
  "todo-write": PLANS,
  "task-create-update": PLANS,
  goal: PASSES,
  "network-permission": PASSES,
  "exit-plan-approve": PASSES,
  "exit-plan-reject": PASSES,
  "ask-user-question": PASSES,
  skill: PASSES,
  "mcp-tool": PASSES,
  "task-output-and-stop": PASSES,
  "memory-recall": PASSES,
  "permission-denied": PASSES,
  "tool-progress": PASSES,
  "rate-limit-and-origin": PASSES,
  "compaction-legacy": PASSES,
  "compaction-update": PASSES,
  "compaction-failed-legacy": PASSES,
  "session-load-replay": REPLAY,
};

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
  const { acpProtocolRouter } = await import("../serve.js");
  for (const scenario of SCENARIOS) {
    resetIds();
    const agents: ClaudeAcpAgent[] = [];
    const quiet = { log: () => {}, error: () => {} };
    runs.set(
      scenario.name,
      await runScenarioV2(
        (stream) => acpProtocolRouter(quiet, (agent) => agents.push(agent)).connect(stream),
        scenario,
      ),
    );
    await Promise.all(agents.map((agent) => agent.dispose()));
  }
}, 120_000);

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(configDir, { recursive: true, force: true });
});

function run(scenario: string): ScenarioRunV2 {
  const recorded = runs.get(scenario);
  if (!recorded) throw new Error(`no v2 run of ${scenario}`);
  return recorded;
}

function toJsonLines(recorded: WireRecorded[]): string {
  return recorded.map((record) => `${canonical(record)}\n`).join("");
}

describe("ACP v2 scenarios", () => {
  it("run as the status table says", () => {
    expect(
      Object.fromEntries(SCENARIOS.map((scenario) => [scenario.name, run(scenario.name).status])),
    ).toEqual(V2_STATUS);
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
      (scenario) => V2_STATUS[scenario] === PASSES,
    );
    it.each(passing)("%s", async (scenario) => {
      await expect(toJsonLines(run(scenario).normalized)).toMatchFileSnapshot(
        path.join(here, "acp-scenarios", "__snapshots__", "v2", `${scenario}.jsonl`),
      );
    });
  });
});
