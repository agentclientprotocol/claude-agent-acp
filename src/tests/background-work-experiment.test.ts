import { describe, expect, it } from "vitest";
import { BackgroundWorkExperiment, backgroundWorkStream } from "../background-work-experiment.js";

const update = (value: Record<string, unknown>, sessionId = "s") => ({
  method: "session/update",
  params: { sessionId, update: value },
});
const level = (taskIds: unknown) =>
  update({
    sessionUpdate: "session_info_update",
    _meta: { backgroundWorkExperiment: { taskIds } },
  });
const expected = (background: unknown, state = "idle") => ({
  params: {
    sessionId: "s",
    update: { sessionUpdate: "state_update", state, background },
  },
});

describe.each([1, 2])("background work experiment v%s", (version) => {
  function fixture() {
    const bridge = new BackgroundWorkExperiment();
    bridge.inbound({
      id: 1,
      method: "initialize",
      params: { protocolVersion: version },
    });
    bridge.inbound({ id: 2, method: "session/new", params: {} });
    bridge.outbound({ id: 2, result: { sessionId: "s" } });
    return bridge;
  }
  function spawn(bridge: BackgroundWorkExperiment) {
    bridge.outbound(
      update({
        sessionUpdate: version === 1 ? "tool_call" : "tool_call_update",
        toolCallId: "tool",
        status: "in_progress",
      }),
    );
    bridge.outbound(level(["native"]));
    return bridge.outbound(
      update({
        sessionUpdate: version === 1 ? "async_task_spawned" : "_async_task_spawned",
        asyncTaskId: "native",
        taskType: "shell",
        toolCallId: "tool",
        canStop: true,
      }),
    );
  }
  it("does not infer empty from a silent backend or unmapped monitor", () => {
    const bridge = fixture();
    expect(bridge.snapshot("s")).toMatchObject(expected(null));
    expect(bridge.outbound(level(["monitor"]))).toMatchObject([expected(null)]);
    expect(bridge.outbound(level([]))).toMatchObject([expected([])]);
    expect(bridge.outbound(level([null]))).toMatchObject([expected(null)]);
    expect(bridge.outbound(level("damaged"))).toMatchObject([expected(null)]);
  });
  it("references announced tools and keeps them running after foreground completion", () => {
    const bridge = fixture();
    expect(spawn(bridge)).toMatchObject([
      {
        params: {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool",
            status: "in_progress",
            capabilities: { cancel: {} },
          },
        },
      },
      expected([{ type: "tool_call", toolCallId: "tool" }]),
    ]);
    expect(
      bridge.outbound(
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool",
          status: "completed",
        }),
      ),
    ).toMatchObject([{ params: { update: { status: "in_progress" } } }]);
    bridge.outbound(
      update({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      }),
    );
    expect(bridge.outbound(level(["native"]))).toMatchObject([
      expected([{ type: "tool_call", toolCallId: "tool" }]),
    ]);
    expect(bridge.outbound(level(["native"]))[0]).not.toHaveProperty("params.update.stopReason");
    bridge.inbound({
      method: "session/cancel",
      params: { sessionId: "s" },
    });
    expect(bridge.snapshot("s")).toMatchObject(
      expected([{ type: "tool_call", toolCallId: "tool" }]),
    );
  });
  it("acceptance does not finalize, and completion wins a cancellation race", () => {
    const bridge = fixture();
    spawn(bridge);
    expect(
      bridge.inbound({
        id: 3,
        method: "tool_call/cancel",
        params: { sessionId: "s", toolCallId: "tool" },
      }),
    ).toMatchObject({
      forward: {
        method: "_session/async_task/stop",
        params: { asyncTaskId: "native" },
      },
    });
    expect(bridge.outbound({ id: 3, result: { stopped: true } })).toMatchObject([{ result: {} }]);
    expect(bridge.snapshot("s")).toMatchObject(
      expected([{ type: "tool_call", toolCallId: "tool" }]),
    );
    expect(
      bridge.outbound(
        update({
          sessionUpdate: "async_task_state_update",
          asyncTaskId: "native",
          state: "completed",
        }),
      ),
    ).toMatchObject([
      { params: { update: { status: "completed", capabilities: null } } },
      expected([]),
    ]);
    expect(
      bridge.outbound(
        update({
          sessionUpdate: "async_task_state_update",
          asyncTaskId: "native",
          state: "stopped",
        }),
      ),
    ).toMatchObject([expected([])]);
    expect(
      bridge.inbound({
        id: 4,
        method: "tool_call/cancel",
        params: { sessionId: "s", toolCallId: "tool" },
      }),
    ).toMatchObject({ send: [{ error: { code: -32602 } }] });
  });
  it("does not revive a tool finalized before late native discovery", () => {
    const bridge = fixture();
    bridge.outbound(
      update({
        sessionUpdate: version === 1 ? "tool_call" : "tool_call_update",
        toolCallId: "late",
        status: "completed",
      }),
    );
    bridge.outbound(level(["native"]));
    const messages = bridge.outbound(
      update({
        sessionUpdate: "async_task_spawned",
        asyncTaskId: "native",
        taskType: "shell",
        toolCallId: "late",
        canStop: true,
      }),
    );
    expect(messages).toContainEqual(expect.objectContaining(expected(null)));
    expect(messages).not.toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          update: expect.objectContaining({ status: "in_progress" }),
        }),
      }),
    );
    expect(
      bridge.inbound({
        id: 30,
        method: "tool_call/cancel",
        params: { sessionId: "s", toolCallId: "late" },
      }),
    ).toMatchObject({ send: [{ error: { code: -32602 } }] });
  });
  it("does not claim scheduled workflows even when they name an announced tool", () => {
    const bridge = fixture();
    bridge.outbound(
      update({
        sessionUpdate: version === 1 ? "tool_call" : "tool_call_update",
        toolCallId: "scheduled",
        status: "pending",
      }),
    );
    bridge.outbound(level(["workflow"]));
    const messages = bridge.outbound(
      update({
        sessionUpdate: "async_task_spawned",
        asyncTaskId: "workflow",
        taskType: "workflow",
        toolCallId: "scheduled",
        canStop: true,
      }),
    );
    expect(messages.at(-1)).toMatchObject(expected(null));
    expect(
      bridge.inbound({
        id: 31,
        method: "tool_call/cancel",
        params: { sessionId: "s", toolCallId: "scheduled" },
      }),
    ).toMatchObject({ send: [{ error: { code: -32602 } }] });
    expect(
      bridge.outbound(
        update({ sessionUpdate: "tool_call_update", toolCallId: "scheduled", status: "pending" }),
      )[0],
    ).toMatchObject({ params: { update: { status: "pending" } } });
  });
  it("does not fabricate referenced tools during resume and starts forks empty", () => {
    const bridge = fixture();
    bridge.inbound({
      id: 8,
      method: "session/resume",
      params: { sessionId: "restored" },
    });
    expect(bridge.outbound({ id: 8, result: {} })[0]).toMatchObject({
      params: { sessionId: "restored", update: { background: null } },
    });
    bridge.inbound({
      id: 9,
      method: "session/fork",
      params: { sessionId: "s" },
    });
    expect(bridge.outbound({ id: 9, result: { sessionId: "fork" } })[1]).toMatchObject({
      params: { sessionId: "fork", update: { background: [] } },
    });
  });
  it("leaves the stream untouched when disabled", () => {
    const stream = {
      readable: new ReadableStream(),
      writable: new WritableStream(),
    };
    expect(backgroundWorkStream(stream)).toBe(stream);
  });
});
