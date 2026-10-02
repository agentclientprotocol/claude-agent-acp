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
const TOOL_CALLS = "The ACP v2 surface does not translate tool_call session updates yet";
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
  "bash-foreground": TOOL_CALLS,
  "bash-error": TOOL_CALLS,
  "bash-background": TOOL_CALLS,
  "async-task-held-until-tool-id": PASSES,
  "async-task-ends-before-tool-id": PASSES,
  "async-task-released-at-turn-end": PASSES,
  read: TOOL_CALLS,
  "write-new": TOOL_CALLS,
  "write-existing": TOOL_CALLS,
  "edit-with-permission": TOOL_CALLS,
  "edit-rejected": TOOL_CALLS,
  "notebook-edit": TOOL_CALLS,
  "grep-and-glob": TOOL_CALLS,
  "web-fetch-and-search": TOOL_CALLS,
  "subagent-task-legacy": TOOL_CALLS,
  "subagent-agent-async": TOOL_CALLS,
  "subagent-native-sessions": TOOL_CALLS,
  "subagent-nested": TOOL_CALLS,
  "subagent-late-child-update": TOOL_CALLS,
  "subagent-transcript-extension": TOOL_CALLS,
  "todo-write": PLANS,
  "task-create-update": PLANS,
  goal: PASSES,
  "network-permission": TOOL_CALLS,
  "exit-plan-approve": TOOL_CALLS,
  "exit-plan-reject": TOOL_CALLS,
  "ask-user-question": TOOL_CALLS,
  skill: TOOL_CALLS,
  "mcp-tool": TOOL_CALLS,
  "task-output-and-stop": TOOL_CALLS,
  "memory-recall": TOOL_CALLS,
  "permission-denied": TOOL_CALLS,
  "tool-progress": TOOL_CALLS,
  "rate-limit-and-origin": PASSES,
  "compaction-legacy": TOOL_CALLS,
  "compaction-update": TOOL_CALLS,
  "compaction-failed-legacy": TOOL_CALLS,
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
