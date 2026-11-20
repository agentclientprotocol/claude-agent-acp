import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { readWorkflowLaunches } from "../v2/workflow-history.js";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
it("restores only workers owned by the recorded Workflow call and uses their individual outcomes", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "workflow-history-"));
  const id = "parent",
    runId = "wf_a1",
    taskId = "group";
  const dir = path.join(root, id),
    file = dir + ".jsonl";
  const call = { type: "tool_use", name: "Workflow", id: "launch", input: {} };
  const result = { type: "tool_result", tool_use_id: "launch", content: "Run ID: wf_spoofed" };
  const messages: SessionMessage[] = [
    { type: "assistant", uuid: "a", message: { content: [call] } },
    { type: "user", uuid: "u", message: { content: [result] } },
  ].map((m) => ({
    ...m,
    type: m.type as "assistant" | "user",
    session_id: id,
    parent_tool_use_id: null,
    parent_agent_id: null,
  }));
  const launch = {
    type: "user",
    sessionId: id,
    uuid: "u",
    message: { content: [result] },
    toolUseResult: { taskType: "local_workflow", taskId, runId },
  };
  const storage = path.join(dir, "workflows");
  await mkdir(storage, { recursive: true });
  const storeRun = (task: string) =>
    writeFile(
      path.join(storage, runId + ".json"),
      JSON.stringify({
        runId,
        taskId: task,
        workflowProgress: [
          {
            type: "workflow_agent",
            label: "Valid error",
            agentId: "a01",
            state: "error",
            error: "worker failed",
          },
          { type: "workflow_agent", label: "Unsafe id", agentId: "../outside", state: "done" },
        ],
      }),
    );
  await storeRun(taskId);
  const read = () => readWorkflowLaunches(id, id, dir, file, messages);
  for (const rejected of [
    { ...launch, uuid: "wrong" },
    { ...launch, isSidechain: true },
    { ...launch, sessionId: "other" },
    { ...launch, toolUseResult: { ...launch.toolUseResult, runId: "../outside" } },
  ]) {
    await writeFile(file, JSON.stringify(rejected));
    expect((await read()).size).toBe(0);
  }
  await writeFile(file, JSON.stringify(launch));
  expect((await read()).get("launch")?.map((x) => x.agent)).toEqual([
    { label: "Valid error", agentId: "a01", state: "error", error: "worker failed" },
  ]);
  await storeRun("other-task");
  expect((await read()).get("launch")).toEqual([]);
});
