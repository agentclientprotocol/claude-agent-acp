/**
 * Every scenario of `acp-scenarios/scenarios.ts` on the native ACP v2 core
 * (`CLAUDE_AGENT_ACP_V2_CORE=native`), as `acp-scenarios-v2.test.ts` runs them
 * on the bridge.
 *
 * - Status: each scenario passes, or stops as {@link NATIVE_STOPS} says.
 * - Schema: every message the native core sends is valid against the draft
 *   v2 schema, also in a scenario that stops.
 * - Parity: the scenarios whose session updates equal the bridge's golden
 *   file are listed in {@link SAME_AS_BRIDGE}, so a change in parity, either
 *   way, shows up as a diff of that list. `docs/v2-native-core.md` says why
 *   the others differ.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentHandle } from "../v2-native/agent.js";
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
    getSessionInfo: harness.mockedSessionInfo,
  };
});

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
 * The scenarios that stop on the native core, each with the reason, as the
 * native core reports it.
 */
const NATIVE_STOPS: Record<string, string> = {
  // AskUserQuestion needs a form elicitation, which the native core does not
  // send: it disallows the tool, and the scenario's script, which calls it
  // anyway, then ends the stream.
  "ask-user-question": "Internal error: Claude Code stopped. Resume the session to continue.",
};

/**
 * The scenarios whose session updates equal the bridge's v2 golden file.
 * The others differ in what the native core does not serve yet (subagent
 * details, ...; see `docs/v2-native-core.md`).
 */
const SAME_AS_BRIDGE: string[] = [
  "session-setup",
  "text-and-thinking",
  "bash-foreground",
  "bash-error",
  "bash-background",
  "async-task-held-until-tool-id",
  "async-task-ends-before-tool-id",
  "async-task-released-at-turn-end",
  "read",
  "write-new",
  "write-existing",
  "edit-with-permission",
  "edit-rejected",
  "notebook-edit",
  "grep-and-glob",
  "web-fetch-and-search",
  "todo-write",
  "task-create-update",
  "goal",
  "exit-plan-approve",
  "exit-plan-reject",
  "skill",
  "mcp-tool",
  "task-output-and-stop",
  "memory-recall",
  "tool-progress",
  "rate-limit-and-origin",
  "compaction-legacy",
  "compaction-update",
  "compaction-failed-legacy",
];

const runs = new Map<string, ScenarioRunV2>();
let configDir: string;

beforeAll(async () => {
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
    const agents: AgentHandle[] = [];
    const quiet = { log: () => {}, error: () => {} };
    runs.set(
      scenario.name,
      await runScenarioV2(
        (stream) =>
          acpProtocolRouter(quiet, () => {}, "auto", {
            v2Core: "native",
            onNativeAgent: (agent) => agents.push(agent),
          }).connect(stream),
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
  if (!recorded) throw new Error(`no native run of ${scenario}`);
  return recorded;
}

/** The session updates of a run, as lines of its golden file. */
function sessionUpdateLines(recorded: WireRecorded[]): string[] {
  return recorded
    .filter((record) => record.kind === "notification" && record.method === "session/update")
    .map((record) => canonical(record));
}

function bridgeSessionUpdateLines(scenario: string): string[] | undefined {
  const file = path.join(here, "acp-scenarios", "__snapshots__", "v2", `${scenario}.jsonl`);
  if (!fs.existsSync(file)) return undefined;
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(
      (line) => line.includes('"method":"session/update"') && line.includes('"notification"'),
    );
}

/**
 * With `DUMP_NATIVE_SCENARIOS=<dir>`, writes each scenario's session updates
 * to `<dir>/<scenario>.jsonl`, in the lines of the bridge's golden file, to
 * diff the two cores: `diff <dir>/read.jsonl <(grep session/update ...v2/read.jsonl)`.
 */
afterAll(() => {
  const dir = process.env.DUMP_NATIVE_SCENARIOS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const [scenario, recorded] of runs) {
    fs.writeFileSync(
      path.join(dir, `${scenario}.jsonl`),
      sessionUpdateLines(recorded.normalized).join("\n") + "\n",
    );
    const bridge = bridgeSessionUpdateLines(scenario);
    if (bridge) {
      fs.writeFileSync(path.join(dir, `${scenario}.bridge.jsonl`), bridge.join("\n") + "\n");
    }
  }
});

describe("ACP v2 scenarios on the native core", () => {
  it("pass, or stop as the table says", () => {
    const table = (status: (scenario: string) => string) =>
      Object.fromEntries(SCENARIOS.map((scenario) => [scenario.name, status(scenario.name)]));
    expect(table((scenario) => run(scenario).status)).toEqual(
      table((scenario) => NATIVE_STOPS[scenario] ?? PASSES),
    );
  });

  describe("schema check", () => {
    it.each(SCENARIOS.map((scenario) => scenario.name))("%s", (scenario) => {
      expect(run(scenario).raw.flatMap((message) => validateV2Message(message))).toEqual([]);
    });
  });

  it("send the bridge's session updates in the scenarios the parity list names", () => {
    const same = SCENARIOS.map((scenario) => scenario.name).filter((scenario) => {
      const bridge = bridgeSessionUpdateLines(scenario);
      return (
        bridge !== undefined &&
        JSON.stringify(sessionUpdateLines(run(scenario).normalized)) === JSON.stringify(bridge)
      );
    });
    expect(same).toEqual(SAME_AS_BRIDGE);
  });
});
