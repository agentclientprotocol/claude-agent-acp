/**
 * The `state` of a session list row while a background task of the session
 * is open, against a real projects directory and live registry in a
 * temporary `CLAUDE_CONFIG_DIR`. The record orders are those of AIR's native
 * Claude provider tests (`ClaudeThreadsStoreTest`), from Claude Code 2.1.299.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionInfo } from "@agentclientprotocol/sdk/unstable";
import type { ActivityState } from "../session-index/activity.js";
import { endedTaskId, searchBackgroundTasks } from "../session-index/background-tasks.js";
import { encodeProjectPath } from "../session-index/project-dirs.js";
import { SessionIndex } from "../session-index/session-index.js";
import { SessionIndexService } from "../session-index/service.js";

let configDir: string;
let workspace: string;
let previousConfigDir: string | undefined;
let sessionId: string;
let transcript: string;

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  configDir = fsSync.realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "bg-tasks-cfg-")));
  workspace = fsSync.realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "bg-tasks-ws-")));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  sessionId = randomUUID();
  const dir = path.join(configDir, "projects", encodeProjectPath(workspace));
  await fs.mkdir(dir, { recursive: true });
  transcript = path.join(dir, `${sessionId}.jsonl`);
});

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  await fs.rm(configDir, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
/** The fields of a transcript record. */
type RecordFields = { [key: string]: JsonValue };

/** The fields that `sessionInfoOf` writes in the `_meta` of a row. The SDK
 *  types `_meta` as a map of any values. */
type RowMeta = { jetbrains?: { air?: { state?: ActivityState } } };

const record = (timestamp: string, fields: RecordFields) =>
  JSON.stringify({ sessionId, cwd: workspace, isSidechain: false, timestamp, ...fields });

const user = (timestamp: string, text = "Run it") =>
  record(timestamp, { type: "user", message: { role: "user", content: text } });

const assistant = (timestamp: string, text = "Done") =>
  record(timestamp, {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" },
  });

const toolUse = (timestamp: string, id = "tu_1", name = "Bash") =>
  record(timestamp, {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input: {} }],
      stop_reason: "tool_use",
    },
  });

const backgroundShellResult = (timestamp: string, taskId: string, extra: RecordFields = {}) =>
  record(timestamp, {
    ...extra,
    type: "user",
    message: {
      role: "user",
      content: [
        {
          tool_use_id: "tu_1",
          type: "tool_result",
          content: `Command running in background with ID: ${taskId}`,
          is_error: false,
        },
      ],
    },
    toolUseResult: { backgroundTaskId: taskId, stdout: "", stderr: "", interrupted: false },
  });

const asyncAgentResult = (timestamp: string, agentId: string, toolUseId: string) =>
  record(timestamp, {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          tool_use_id: toolUseId,
          type: "tool_result",
          content: [{ type: "text", text: "Async agent launched successfully." }],
        },
      ],
    },
    toolUseResult: {
      isAsync: true,
      status: "async_launched",
      agentId,
      description: "Background work",
      prompt: "Work",
      outputFile: `/tmp/${agentId}.output`,
      canReadOutputFile: true,
    },
  });

const notificationText = (taskId: string, status = "completed") =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n</task-notification>`;

const notification = (timestamp: string, taskId: string, status = "completed") =>
  record(timestamp, {
    type: "user",
    message: { role: "user", content: notificationText(taskId, status) },
  });

const queueOperation = (
  timestamp: string,
  taskId: string,
  operation = "enqueue",
  content = notificationText(taskId),
) => record(timestamp, { type: "queue-operation", operation, content });

/** The notification that Claude Code 2.1.303 sends for a quiet background
 *  shell that still runs. It has no `<status>`. */
const checkInText = (taskId: string) =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>tu_1</tool-use-id>\n` +
  `<output-file>/tmp/${taskId}.output</output-file>\n` +
  `<summary>Background command "npm run dev" is still running after 10m, with no new output for 10m</summary>\n` +
  `</task-notification>\nThis is a check-in, not a completion.`;

const checkIn = (timestamp: string, taskId: string) =>
  record(timestamp, { type: "user", message: { role: "user", content: checkInText(taskId) } });

const taskStopResult = (timestamp: string, taskId: string, toolUseId = "tu_stop") =>
  record(timestamp, {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          tool_use_id: toolUseId,
          type: "tool_result",
          content: `Successfully stopped task: ${taskId}`,
        },
      ],
    },
    toolUseResult: {
      message: `Successfully stopped task: ${taskId} (sleep 300)`,
      task_id: taskId,
      task_type: "local_bash",
      command: "sleep 300",
    },
  });

/** A finished turn with a long answer: the records after it fit in the tail
 *  window, the records before it do not. */
const padding = (timestamp: string) => [
  user(timestamp, "Explain it"),
  assistant(timestamp, "x".repeat(70 * 1024)),
];

/** Registers this process as a live interactive CLI that holds the session.
 *  Its status is older than the transcript, so the transcript decides. */
async function registerHolder(status = "busy") {
  await fs.mkdir(path.join(configDir, "sessions"), { recursive: true });
  await fs.writeFile(
    path.join(configDir, "sessions", `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId,
      kind: "interactive",
      entrypoint: "cli",
      status,
      statusUpdatedAt: 1,
      updatedAt: Date.now(),
    }),
  );
}

const toJsonl = (lines: string[]) => lines.map((line) => `${line}\n`).join("");

const newService = () => new SessionIndexService({ logError: () => {} });

function rowState(row: SessionInfo | undefined): ActivityState | undefined {
  const meta = row?._meta as RowMeta | null | undefined;
  return meta?.jetbrains?.air?.state;
}

async function stateOf(service: SessionIndexService): Promise<ActivityState | undefined> {
  const { sessions } = await service.list({ cwd: workspace }, () => undefined);
  const row = sessions.find((session) => session.sessionId === sessionId);
  return rowState(row);
}

async function stateWithNewService(): Promise<ActivityState | undefined> {
  const service = newService();
  try {
    return await stateOf(service);
  } finally {
    service.dispose();
  }
}

/** The background tasks in the facts of the only row, by an index that
 *  takes the session as live or not. */
async function listedBackgroundTasks(isLive: boolean) {
  const index = new SessionIndex({ isLive: async () => isLive });
  const { rows } = await index.list({ cwd: workspace, limit: 10, archived: "unarchived" });
  return rows[0]?.facts.backgroundTasks;
}

type Step = [lines: string[], state: ActivityState];

/**
 * Appends the lines of each step to the transcript and checks the state of
 * the row after the step. One service lists the session after each step,
 * so its scan takes over what the scan of the step before found. A new
 * service gives the same state from a first scan.
 */
async function expectStateAfterEachStep(...steps: Step[]) {
  await registerHolder();
  const service = newService();
  try {
    for (const [index, [lines, expected]] of steps.entries()) {
      await fs.appendFile(transcript, toJsonl(lines));
      const takenOver = await stateOf(service);
      expect(takenOver, `taken over after step ${index}`).toBe(expected);
      const firstScan = await stateWithNewService();
      expect(firstScan, `first scan after step ${index}`).toBe(expected);
    }
  } finally {
    service.dispose();
  }
}

/** The record orders of AIR's native Claude provider: each runs in a small
 *  transcript, and behind a padding that pushes the transcript past the tail
 *  window. */
describe.each([
  ["a small transcript", [] as string[]],
  ["a transcript longer than the tail window", padding("2026-02-08T00:59:00.000Z")],
])("background tasks in %s", (_, before) => {
  // IJAI-3744
  it("keeps two background sub-agents running until the last notification reaches the session", async () => {
    await expectStateAfterEachStep(
      [
        [
          ...before,
          user("2026-02-08T01:00:00.000Z", "Run two agents in the background"),
          toolUse("2026-02-08T01:00:01.000Z", "tu_a", "Agent"),
          asyncAgentResult("2026-02-08T01:00:01.100Z", "agent-a", "tu_a"),
          toolUse("2026-02-08T01:00:01.200Z", "tu_b", "Agent"),
          asyncAgentResult("2026-02-08T01:00:01.300Z", "agent-b", "tu_b"),
          assistant("2026-02-08T01:00:02.000Z", "launched"),
        ],
        "running",
      ],
      // The notification of agent B waits in the queue until the session takes it.
      [[queueOperation("2026-02-08T01:00:05.000Z", "agent-b")], "running"],
      [
        [
          notification("2026-02-08T01:00:05.100Z", "agent-b"),
          assistant("2026-02-08T01:00:06.000Z", "B finished, A still runs"),
        ],
        "running",
      ],
      [
        [
          queueOperation("2026-02-08T01:00:20.000Z", "agent-a"),
          notification("2026-02-08T01:00:20.100Z", "agent-a"),
          assistant("2026-02-08T01:00:21.000Z", "All done"),
        ],
        "idle",
      ],
    );
  });

  // IJAI-3744
  it("closes a task whose notification a running turn takes in", async () => {
    await expectStateAfterEachStep([
      [
        ...before,
        user("2026-02-08T01:00:00.000Z"),
        toolUse("2026-02-08T01:00:01.000Z"),
        backgroundShellResult("2026-02-08T01:00:02.000Z", "task-1"),
        queueOperation("2026-02-08T01:00:03.000Z", "task-1"),
        queueOperation("2026-02-08T01:00:04.000Z", "task-1", "remove"),
        assistant("2026-02-08T01:00:05.000Z"),
      ],
      "idle",
    ]);
  });

  // IJAI-3744
  it("keeps a quiet shell open at its check-ins", async () => {
    await expectStateAfterEachStep(
      [
        [
          ...before,
          user("2026-02-08T01:00:00.000Z", "Start the dev server"),
          toolUse("2026-02-08T01:00:01.000Z"),
          backgroundShellResult("2026-02-08T01:00:02.000Z", "task-1"),
          assistant("2026-02-08T01:00:03.000Z", "Started"),
        ],
        "running",
      ],
      // The check-in wakes the session for a short turn.
      [
        [
          queueOperation("2026-02-08T01:10:00.000Z", "task-1", "enqueue", checkInText("task-1")),
          queueOperation("2026-02-08T01:10:00.000Z", "task-1", "dequeue", ""),
          checkIn("2026-02-08T01:10:00.000Z", "task-1"),
          assistant("2026-02-08T01:10:01.000Z", "The server still runs"),
        ],
        "running",
      ],
      // A running turn takes the next check-in in.
      [
        [
          user("2026-02-08T01:20:00.000Z", "Next"),
          queueOperation("2026-02-08T01:20:01.000Z", "task-1", "enqueue", checkInText("task-1")),
          queueOperation("2026-02-08T01:20:02.000Z", "task-1", "remove", checkInText("task-1")),
          assistant("2026-02-08T01:20:03.000Z"),
        ],
        "running",
      ],
      [
        [
          notification("2026-02-08T01:30:00.000Z", "task-1"),
          assistant("2026-02-08T01:30:01.000Z", "The server stopped"),
        ],
        "idle",
      ],
    );
  });

  // IJAI-3744
  it("closes a task at its TaskStop result", async () => {
    await expectStateAfterEachStep(
      [
        [
          ...before,
          user("2026-02-08T01:00:00.000Z"),
          toolUse("2026-02-08T01:00:01.000Z"),
          backgroundShellResult("2026-02-08T01:00:02.000Z", "task-1"),
          assistant("2026-02-08T01:00:03.000Z", "Started"),
        ],
        "running",
      ],
      [
        [
          user("2026-02-08T01:00:10.000Z", "Stop it"),
          toolUse("2026-02-08T01:00:11.000Z", "tu_stop", "TaskStop"),
        ],
        "running",
      ],
      // The scan matches the result to the TaskStop call of an earlier step.
      [
        [
          taskStopResult("2026-02-08T01:00:12.000Z", "task-1"),
          assistant("2026-02-08T01:00:13.000Z", "Stopped"),
        ],
        "idle",
      ],
    );
  });

  // IJAI-3744
  it("keeps a task open at a task_id in the result of another tool", async () => {
    await expectStateAfterEachStep([
      [
        ...before,
        user("2026-02-08T01:00:00.000Z"),
        toolUse("2026-02-08T01:00:01.000Z"),
        backgroundShellResult("2026-02-08T01:00:02.000Z", "task-1"),
        toolUse("2026-02-08T01:00:03.000Z", "tu_output", "TaskOutput"),
        taskStopResult("2026-02-08T01:00:04.000Z", "task-1", "tu_output"),
        assistant("2026-02-08T01:00:05.000Z", "Still running"),
      ],
      "running",
    ]);
  });

  // IJAI-3744
  it("closes the tasks of the previous process in a resumed session", async () => {
    await expectStateAfterEachStep(
      [
        [
          ...before,
          user("2026-02-08T01:00:00.000Z"),
          toolUse("2026-02-08T01:00:01.000Z"),
          backgroundShellResult("2026-02-08T01:00:02.000Z", "task-1"),
          assistant("2026-02-08T01:00:03.000Z", "Started"),
        ],
        "running",
      ],
      // The resumed CLI reports the task of the gone process as stopped, and
      // delivers that with the next prompt.
      [
        [
          queueOperation("2026-02-08T02:00:00.000Z", "task-1"),
          notification("2026-02-08T02:00:00.100Z", "task-1", "stopped"),
          user("2026-02-08T02:00:00.200Z", "Say hi"),
          assistant("2026-02-08T02:00:01.000Z", "Hi"),
        ],
        "idle",
      ],
    );
  });

  // IJAI-3744
  it("keeps no turn open for a background task of a sub-agent", async () => {
    await expectStateAfterEachStep([
      [
        ...before,
        user("2026-02-08T01:00:00.000Z"),
        backgroundShellResult("2026-02-08T01:00:01.000Z", "task-of-sub-agent", {
          isSidechain: true,
        }),
        assistant("2026-02-08T01:00:02.000Z"),
      ],
      "idle",
    ]);
  });
});

describe("a background task before the tail window", () => {
  // IJAI-3744
  it("keeps the session running over later turns", async () => {
    await expectStateAfterEachStep(
      [
        [
          user("2026-02-08T01:00:00.000Z"),
          toolUse("2026-02-08T01:00:01.000Z"),
          backgroundShellResult("2026-02-08T01:00:02.000Z", "task-1"),
          assistant("2026-02-08T01:00:03.000Z", "Started"),
          ...padding("2026-02-08T01:00:04.000Z"),
        ],
        "running",
      ],
      // Within the tail window of the scan before: the scan takes over its tasks.
      [
        [user("2026-02-08T01:00:10.000Z", "Next"), assistant("2026-02-08T01:00:11.000Z")],
        "running",
      ],
      // Past the tail window of the scan before: the whole file is searched again.
      [padding("2026-02-08T01:00:12.000Z"), "running"],
      [
        [
          notification("2026-02-08T01:00:20.000Z", "task-1"),
          assistant("2026-02-08T01:00:21.000Z", "All done"),
        ],
        "idle",
      ],
    );
  });

  // IJAI-3744
  it("is taken over from the scan before without a whole-file search", async () => {
    let wholeFileSearches = 0;
    // The index asks for the live state only before it searches the whole file.
    const index = new SessionIndex({
      isLive: async () => {
        wholeFileSearches++;
        return true;
      },
    });
    const tasksAfter = async (lines: string[]) => {
      await fs.appendFile(transcript, toJsonl(lines));
      const { rows } = await index.list({ cwd: workspace, limit: 10, archived: "unarchived" });
      return rows[0]?.facts.backgroundTasks?.open;
    };
    const started = await tasksAfter([
      user("2026-02-08T01:00:00.000Z"),
      toolUse("2026-02-08T01:00:01.000Z"),
      backgroundShellResult("2026-02-08T01:00:02.000Z", "task-1"),
      assistant("2026-02-08T01:00:03.000Z", "Started"),
      ...padding("2026-02-08T01:00:04.000Z"),
    ]);
    expect(started).toEqual(["task-1"]);
    expect(wholeFileSearches).toBe(1);
    // Within the tail window of the scan before.
    const takenOver = await tasksAfter([
      user("2026-02-08T01:00:10.000Z", "Next"),
      assistant("2026-02-08T01:00:11.000Z"),
    ]);
    expect(takenOver).toEqual(["task-1"]);
    expect(wholeFileSearches).toBe(1);
    // Past the tail window of the scan before.
    const searchedAgain = await tasksAfter(padding("2026-02-08T01:00:12.000Z"));
    expect(searchedAgain).toEqual(["task-1"]);
    expect(wholeFileSearches).toBe(2);
    const ended = await tasksAfter([
      notification("2026-02-08T01:00:20.000Z", "task-1"),
      assistant("2026-02-08T01:00:21.000Z", "All done"),
    ]);
    expect(ended).toEqual([]);
    expect(wholeFileSearches).toBe(2);
  });

  it("is not searched for a session that no live process holds", async () => {
    const lines = [
      user("2026-02-08T01:00:00.000Z"),
      toolUse("2026-02-08T01:00:01.000Z"),
      backgroundShellResult("2026-02-08T01:00:02.000Z", "task-1"),
      ...padding("2026-02-08T01:00:04.000Z"),
    ];
    await fs.writeFile(transcript, toJsonl(lines));
    const fromTail = await listedBackgroundTasks(false);
    expect(fromTail).toEqual({ open: [], stopCalls: [], complete: false });
    const fromWholeFile = await listedBackgroundTasks(true);
    expect(fromWholeFile).toEqual({ open: ["task-1"], stopCalls: [], complete: true });
  });
});

describe("the end of the wait for a background task", () => {
  const lines = () => [
    user("2026-02-08T01:00:00.000Z"),
    toolUse("2026-02-08T01:00:01.000Z"),
    backgroundShellResult("2026-02-08T01:00:02.000Z", "task-1"),
    assistant("2026-02-08T01:00:03.000Z", "Started"),
  ];

  beforeEach(async () => {
    await fs.writeFile(transcript, toJsonl(lines()));
  });

  // IJAI-3744
  it("does not come after 10 minutes", async () => {
    await registerHolder();
    const old = new Date(Date.now() - 11 * 60_000);
    await fs.utimes(transcript, old, old);
    expect(await stateWithNewService()).toBe("running");
  });

  // IJAI-3744
  it("comes when the registry status is idle", async () => {
    await registerHolder("idle");
    expect(await stateWithNewService()).toBe("idle");
  });

  // IJAI-3744
  it("comes when no live process holds the session", async () => {
    expect(await stateWithNewService()).toBe("idle");
  });
});

describe("the task notification", () => {
  it("is read only at the start of the input", () => {
    expect(endedTaskId(notificationText("task-1"))).toBe("task-1");
    expect(endedTaskId(`\n  ${notificationText("task-1")}`)).toBe("task-1");
    expect(endedTaskId(`Look: ${notificationText("task-1")}`)).toBeUndefined();
    const status = "<status>completed</status></task-notification>";
    expect(endedTaskId(`<task-notification><task-id> </task-id>${status}`)).toBeUndefined();
    expect(endedTaskId(`<task-notification><task-id>task-1${status}`)).toBeUndefined();
    expect(endedTaskId(undefined)).toBeUndefined();
  });

  it("ends no task without a status", () => {
    expect(endedTaskId(checkInText("task-1"))).toBeUndefined();
    const monitorEvent =
      "<task-notification>\n<task-id>task-1</task-id>\n" +
      '<summary>Monitor event: "test log"</summary>\n<event>FAILED</event>\n</task-notification>';
    expect(endedTaskId(monitorEvent)).toBeUndefined();
  });

  it("is read as a text block of a user record", async () => {
    const content = [{ type: "text", text: notificationText("task-1") }];
    const lines = [
      backgroundShellResult("2026-02-08T01:00:00.000Z", "task-1"),
      record("2026-02-08T01:00:01.000Z", { type: "user", message: { role: "user", content } }),
    ];
    await fs.writeFile(transcript, toJsonl(lines));
    const { size } = await fs.stat(transcript);
    const tasks = await searchBackgroundTasks(transcript, size);
    expect(tasks.open).toEqual([]);
  });
});
