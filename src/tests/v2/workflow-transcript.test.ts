import { afterEach, expect, it, vi } from "vitest";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { WorkflowTranscripts } from "../../v2/workflow-transcript.js";

function message(uuid: string): SessionMessage {
  return {
    type: "user",
    uuid,
    session_id: "root",
    parent_agent_id: null,
    parent_tool_use_id: null,
    message: { content: "prompt" },
  };
}

afterEach(() => vi.useRealTimers());

it("samples workers beyond the first four and drops a read from a closed session", async () => {
  vi.useFakeTimers();
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<SessionMessage[]>>>();
  const send = vi.fn();
  const reader = new WorkflowTranscripts(async (id) => {
    const gate = Promise.withResolvers<SessionMessage[]>();
    gates.set(id, gate);
    return gate.promise;
  }, vi.fn());
  for (const id of ["a", "b", "c", "d", "e", "f"]) reader.follow(id, send, true);
  expect([...gates.keys()]).toEqual(["a", "b", "c", "d"]);
  for (const [id, gate] of gates) gate.resolve([message(id)]);
  await vi.advanceTimersByTimeAsync(2000);
  expect([...gates.keys()]).toEqual(["a", "b", "c", "d", "e", "f"]);
  reader.clear();
  for (const gate of gates.values()) gate.resolve([message("late")]);
  await vi.advanceTimersByTimeAsync(10000);
  expect(send.mock.calls.map(([m]) => m.uuid)).toEqual(["a", "b", "c", "d"]);
});

it("retries a missing terminal file and bounds a stuck read without late updates", async () => {
  vi.useFakeTimers();
  const gate = Promise.withResolvers<SessionMessage[]>();
  let reads = 0;
  const send = vi.fn(),
    error = vi.fn();
  const reader = new WorkflowTranscripts(async (id) => {
    if (id === "stuck") return gate.promise;
    if (reads++ === 0) throw new Error("not available yet");
    return [message(id)];
  }, error);
  reader.follow("stuck", send, true);
  const final = reader.final(new Set(["finished", "stuck"]));
  await vi.advanceTimersByTimeAsync(2000);
  await final;
  reader.follow("finished", send, false);
  gate.resolve([message("stale")]);
  await vi.advanceTimersByTimeAsync(1);
  expect(error).toHaveBeenCalledOnce();
  expect(send.mock.calls.map(([m]) => m.uuid)).toEqual(["finished"]);
  reader.clear();
});
