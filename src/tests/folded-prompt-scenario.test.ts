/**
 * Replays the stream of a session whose prompt was folded into a cycle that
 * Claude Code started on its own (a `task-notification` cycle) and was never
 * answered: the cycle's result kept its autonomous origin but named the prompt.
 * It lives outside `acp-scenarios/scenarios.ts` because every scenario there
 * needs an origin/main baseline, and this one hangs on origin/main.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assistantTurn,
  PROFILES,
  type Profile,
  type Recorded,
  resetIds,
  result,
  runScenario,
  type Scenario,
  system,
  toolCall,
} from "./acp-scenarios/harness.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  const harness = await import("./acp-scenarios/harness.js");
  return {
    ...actual,
    query: harness.mockedQuery,
    getSessionMessages: harness.mockedSessionMessages,
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

const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

const backgroundBash = (id: string) =>
  ({
    id,
    name: "Bash",
    input: { command: "npm test", description: "Run the tests", run_in_background: true },
  }) as const;

const backgroundOutcome = (taskId: string) => ({
  content: `Command running in background with ID: ${taskId}. Output is being written to: /tmp/tasks/${taskId}.output. You will be notified when it completes.`,
  structured: {
    stdout: "",
    stderr: "",
    interrupted: false,
    isImage: false,
    backgroundTaskId: taskId,
  },
});

const taskStarted = (taskId: string, toolUseId: string) =>
  system("task_started", {
    task_id: taskId,
    task_type: "local_bash",
    description: "Run the tests",
    tool_use_id: toolUseId,
    is_backgrounded: true,
  });

const taskNotification = (taskId: string, toolUseId: string) =>
  system("task_notification", {
    task_id: taskId,
    status: "completed",
    summary: "done",
    output_file: `/tmp/tasks/${taskId}.output`,
    tool_use_id: toolUseId,
  });

const idle = () => system("session_state_changed", { state: "idle" });
const running = () => system("session_state_changed", { state: "running" });

const scenario: Scenario = {
  name: "folded-prompt-answered-by-autonomous-result",
  prompts: ["Run the tests", "When you finish, explain the changes", "Thanks"],
  turns: [
    async function* (ctx) {
      yield* toolCall(ctx, backgroundBash("toolu_lane_1"), backgroundOutcome("bash_1"));
      yield taskStarted("bash_1", "toolu_lane_1");
      yield* assistantTurn("msg_started", [
        { type: "text", text: "The tests run in the background." },
      ]);
      yield result({ usage: usage(10, 5) });
      yield idle();
      // The background shell finished: Claude Code starts a cycle on its own
      // and is still working when the second prompt arrives.
      yield taskNotification("bash_1", "toolu_lane_1");
      yield running();
      yield* assistantTurn("msg_reading", [{ type: "text", text: "Reading the test results." }]);
      yield* toolCall(
        ctx,
        {
          id: "toolu_read_results",
          name: "Bash",
          input: { command: "cat results.txt", description: "Read the results" },
        },
        { content: "42 passed" },
      );
    },
    async function* (ctx) {
      // The harness yielded the echo of the folded prompt already.
      yield* assistantTurn("msg_promise", [
        { type: "text", text: "I will answer after the next test run." },
      ]);
      yield* toolCall(ctx, backgroundBash("toolu_lane_2"), backgroundOutcome("bash_2"));
      yield taskStarted("bash_2", "toolu_lane_2");
      yield result({
        origin: { kind: "task-notification" },
        user_message_uuid: ctx.promptUuid,
        user_message_uuids: [ctx.promptUuid],
        usage: usage(20, 7),
      });
      yield idle();
      yield taskNotification("bash_2", "toolu_lane_2");
      yield running();
      yield* assistantTurn("msg_answer", [{ type: "text", text: "Here is the explanation." }]);
      // This cycle folded no prompt, so its result is unstamped.
      yield result({ origin: { kind: "task-notification" }, usage: usage(30, 9) });
      yield idle();
    },
    async function* () {
      yield* assistantTurn("msg_thanks", [{ type: "text", text: "You're welcome." }]);
      yield result({ usage: usage(40, 11) });
      yield idle();
    },
  ],
};

const runProfiles = [PROFILES.air, PROFILES.plain];
const runs = new Map<Profile["name"], Recorded[]>();
let configDir: string;

/** Fails a hang with a clear message instead of the vitest timeout. */
function unlessHung<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("a session/prompt was never answered")), 3000);
  });
  return Promise.race([promise, hung]).finally(() => clearTimeout(timer));
}

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
  const { ClaudeAcpAgent } = await import("../acp-agent.js");
  for (const profile of runProfiles) {
    resetIds();
    const run = await unlessHung(runScenario(ClaudeAcpAgent, profile, scenario));
    runs.set(profile.name, run.raw);
  }
}, 30_000);

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(configDir, { recursive: true, force: true });
});

const update = (record: Recorded) =>
  (record.payload as { update?: Record<string, unknown> }).update ?? {};

/** The index of the first agent text chunk of the message, or -1. */
function chunkIndex(recorded: Recorded[], messageId: string): number {
  return recorded.findIndex(
    (record) =>
      record.kind === "sessionUpdate" &&
      update(record).sessionUpdate === "agent_message_chunk" &&
      update(record).messageId === messageId,
  );
}

describe.each(runProfiles.map((profile) => profile.name))("folded prompt (%s)", (name) => {
  const recorded = () => runs.get(name)!;
  const responses = () =>
    recorded().flatMap((record, index) =>
      record.kind === "promptResponse" ? [{ index, response: record.payload as any }] : [],
    );

  it("answers every prompt", () => {
    const all = responses();
    expect(all).toHaveLength(3);
    for (const { response } of all) expect(response.stopReason).toBe("end_turn");
  });

  it("answers the folded prompt with the background cycle's result", () => {
    const { response } = responses()[1];
    expect(response.usage).toMatchObject({ inputTokens: 20, outputTokens: 7 });
  });

  it("streams the folded prompt's output before its response", () => {
    const chunk = chunkIndex(recorded(), "msg_promise");
    expect(chunk).toBeGreaterThanOrEqual(0);
    expect(chunk).toBeLessThan(responses()[1].index);
  });

  it("still delivers the background answer before the next prompt's response", () => {
    const folded = chunkIndex(recorded(), "msg_promise");
    const answer = chunkIndex(recorded(), "msg_answer");
    expect(answer).toBeGreaterThan(folded);
    expect(answer).toBeLessThan(responses()[2].index);
  });

  it("keeps the background answer's tokens out of the next prompt", () => {
    const { response } = responses()[2];
    expect(response.usage).toMatchObject({ inputTokens: 40, outputTokens: 11 });
  });
});
