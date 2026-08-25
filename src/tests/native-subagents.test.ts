import { describe, expect, it, vi } from "vitest";
import type { AcpSessionNotification } from "../acp-subagents.js";
import {
  announceNativeSubagent,
  finishNativeSubagent,
  NativeSubagent,
  NativeSubagentRuntime,
  NativeSubagentSession,
} from "../native-subagents.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function child(overrides: Partial<NativeSubagent> = {}): NativeSubagent {
  return {
    sessionId: "child-1",
    parentSessionId: "root",
    parentToolUseId: "agent-tool",
    name: "Explore",
    task: "Inspect the project",
    ...overrides,
  };
}

function sessionWith(value: NativeSubagent): NativeSubagentSession {
  return {
    nativeSubagentsByTaskId: new Map([[value.sessionId, value]]),
    nativeSubagentTaskIdByToolUseId: new Map([[value.parentToolUseId!, value.sessionId]]),
    nativeSubagentParentByToolUseId: new Map(),
  };
}

function control(
  sessionUpdate: "tool_call" | "tool_call_update",
  status?: "pending" | "failed",
  parentToolUseId?: string,
): AcpSessionNotification {
  return {
    sessionId: "root",
    update: {
      sessionUpdate,
      toolCallId: "agent-tool",
      title: "Investigate failure",
      status,
      rawInput: { description: "Investigate failure", prompt: "Find the cause" },
      _meta: {
        claudeCode: { toolName: "Agent", subagent: true, parentToolUseId },
      },
    },
  } as AcpSessionNotification;
}

describe("NativeSubagentRuntime lifecycle", () => {
  it("publishes a raced spawn exactly once", async () => {
    const release = deferred();
    const published: AcpSessionNotification[] = [];
    const value = child();
    const publish = vi.fn(async (notification: AcpSessionNotification) => {
      published.push(notification);
      await release.promise;
    });

    const first = announceNativeSubagent(value, publish);
    const second = announceNativeSubagent(value, publish);

    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(1);
    release.resolve();
    await Promise.all([first, second]);
    expect(published.map(({ update }) => update.sessionUpdate)).toEqual(["subagent_spawned"]);
  });

  it("publishes a raced terminal exactly once after the spawn", async () => {
    const releaseSpawn = deferred();
    const published: AcpSessionNotification[] = [];
    const value = child();
    const session = sessionWith(value);
    const publish = vi.fn(async (notification: AcpSessionNotification) => {
      published.push(notification);
      if (notification.update.sessionUpdate === "subagent_spawned") await releaseSpawn.promise;
    });

    const first = finishNativeSubagent(session, value.sessionId, "completed", publish);
    const second = finishNativeSubagent(session, value.sessionId, "cancelled", publish);
    releaseSpawn.resolve();
    await Promise.all([first, second]);

    expect(published.map(({ update }) => update.sessionUpdate)).toEqual([
      "subagent_spawned",
      "subagent_state_update",
    ]);
    expect(published[1]?.update).toMatchObject({ state: "completed" });
  });

  it("falls back to one ordinary failed tool call when no child ever starts", async () => {
    const runtime = new NativeSubagentRuntime(true, "root", {}, async () => {}, { log: () => {} });

    await expect(
      runtime.route(control("tool_call", "pending"), async () => {}),
    ).resolves.toBeNull();
    const fallback = await runtime.route(control("tool_call_update", "failed"), async () => {});

    expect(fallback).toMatchObject({
      sessionId: "root",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "agent-tool",
        title: "Investigate failure",
        status: "failed",
        _meta: { claudeCode: { toolName: "Agent" } },
      },
    });
    expect(
      (fallback?.update._meta?.claudeCode as Record<string, unknown>).subagent,
    ).toBeUndefined();
  });

  it("creates a schema-valid non-native failed tool call without a cached initial call", async () => {
    const runtime = new NativeSubagentRuntime(true, "root", {}, async () => {}, { log: () => {} });

    const fallback = await runtime.route(
      {
        sessionId: "root",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "agent-tool",
          status: "failed",
          _meta: { claudeCode: { toolName: "Agent", subagent: true } },
        },
      } as AcpSessionNotification,
      async () => {},
    );

    expect(fallback).toMatchObject({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "agent-tool",
        title: "Agent",
        status: "failed",
        _meta: { claudeCode: { toolName: "Agent" } },
      },
    });
    expect(
      (fallback?.update._meta?.claudeCode as Record<string, unknown>).subagent,
    ).toBeUndefined();
  });

  it("clears failed-control identity and parent affinity before an id is reused", async () => {
    const outer = child({
      sessionId: "outer-child",
      parentToolUseId: "outer-tool",
      announced: true,
    });
    const session = sessionWith(outer);
    const published: AcpSessionNotification[] = [];
    const runtime = new NativeSubagentRuntime(
      true,
      "root",
      session,
      async (notification) => {
        published.push(notification);
      },
      { log: () => {} },
    );

    await runtime.route(control("tool_call", "pending", "outer-tool"), async () => {});
    await runtime.route(control("tool_call_update", "failed", "outer-tool"), async () => {});
    await runtime.taskStarted(
      {
        taskId: "reused-child",
        toolUseId: "agent-tool",
        subagentType: "Review",
        description: "Fresh identity",
      },
      async () => {},
    );
    await runtime.route(
      {
        ...control("tool_call", "pending"),
        update: {
          ...control("tool_call", "pending").update,
          rawInput: { description: "Fresh identity", prompt: "Review again" },
        },
      } as AcpSessionNotification,
      async () => {},
    );

    expect(published.at(-1)).toMatchObject({
      sessionId: "root",
      update: {
        sessionUpdate: "subagent_spawned",
        subagentSessionId: "reused-child",
        name: "Fresh identity",
      },
    });
  });

  it("discards unknown pending child updates during finishAll", async () => {
    const published: AcpSessionNotification[] = [];
    const delivered: AcpSessionNotification[] = [];
    const runtime = new NativeSubagentRuntime(
      true,
      "root",
      {},
      async (notification) => {
        published.push(notification);
      },
      { log: () => {} },
    );
    const pending = {
      sessionId: "root",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "stale" },
        _meta: { claudeCode: { parentToolUseId: "agent-tool" } },
      },
    } as AcpSessionNotification;

    await expect(
      runtime.route(pending, async (value) => {
        delivered.push(value);
      }),
    ).resolves.toBeNull();
    await runtime.finishAll("cancelled", async (value) => {
      delivered.push(value);
    });
    await runtime.taskStarted(
      {
        taskId: "child-1",
        toolUseId: "agent-tool",
        subagentType: "Explore",
        description: "New child",
      },
      async (value) => {
        delivered.push(value);
      },
    );
    await runtime.route(control("tool_call", "pending"), async (value) => {
      delivered.push(value);
    });

    expect(delivered).toEqual([]);
    expect(published).toHaveLength(1);
  });

  it("creates a distinct ACP lifecycle when the SDK restarts the same task id", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new NativeSubagentRuntime(
      true,
      "root",
      {},
      async (notification) => {
        published.push(notification);
      },
      { log: () => {} },
    );
    const launch = (toolCallId: string) =>
      ({
        ...control("tool_call", "pending"),
        update: { ...control("tool_call", "pending").update, toolCallId },
      }) as AcpSessionNotification;
    const output = (parentToolUseId: string, text: string) =>
      ({
        sessionId: "root",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
          _meta: { claudeCode: { parentToolUseId } },
        },
      }) as AcpSessionNotification;

    await runtime.route(launch("launch-1"), async () => {});
    await runtime.taskStarted(
      {
        taskId: "worker-1",
        toolUseId: "launch-1",
        subagentType: "Explore",
        description: "First run",
      },
      async () => {},
    );
    await expect(runtime.route(output("launch-1", "first"), async () => {})).resolves.toMatchObject(
      { sessionId: "worker-1" },
    );
    await runtime.finishTask("worker-1", "completed", async () => {});

    await runtime.route(launch("launch-2"), async () => {});
    await runtime.taskStarted(
      {
        taskId: "worker-1",
        toolUseId: "launch-2",
        subagentType: "Explore",
        description: "Second run",
      },
      async () => {},
    );
    await expect(
      runtime.route(output("launch-2", "second"), async () => {}),
    ).resolves.toMatchObject({ sessionId: "worker-1:generation:2" });
    await runtime.finishTask("worker-1", "failed", async () => {}, "launch-1");
    expect(
      published.filter(({ update }) => update.sessionUpdate === "subagent_state_update"),
    ).toHaveLength(1);
    await expect(
      runtime.route(output("launch-2", "still running"), async () => {}),
    ).resolves.toMatchObject({ sessionId: "worker-1:generation:2" });
    await expect(runtime.route(output("launch-1", "late"), async () => {})).resolves.toBeNull();
    await runtime.finishTask("worker-1", "completed", async () => {}, "launch-2");

    const spawnedIds = published.flatMap(({ update }) =>
      update.sessionUpdate === "subagent_spawned" ? [update.subagentSessionId] : [],
    );
    const terminalIds = published.flatMap(({ update }) =>
      update.sessionUpdate === "subagent_state_update" ? [update.subagentSessionId] : [],
    );
    expect(spawnedIds).toEqual(["worker-1", "worker-1:generation:2"]);
    expect(terminalIds).toEqual(spawnedIds);
  });
});
