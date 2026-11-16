import { describe, expect, it } from "vitest";
import { workflowSnapshot, workflowSnapshotText } from "../workflow-progress.js";

const phase = (index: number, title: string) => ({ type: "workflow_phase", index, title });
const agent = (label: string, fields: Record<string, unknown> = {}) => ({
  type: "workflow_agent",
  label,
  state: "start",
  phaseIndex: 1,
  ...fields,
});

describe("workflowSnapshot", () => {
  it.each([
    ["not an array", { agents: [] }],
    ["no phase or agent", [{ type: "workflow_note", text: "hi" }]],
    ["only malformed entries", [phase(1, " "), { type: "workflow_agent", label: "a" }, null]],
  ])("is undefined for %s", (_, value) => {
    expect(workflowSnapshot(value)).toBeUndefined();
  });

  it("skips malformed entries and fields of the wrong type", () => {
    expect(
      workflowSnapshot([
        phase(1, "Count"),
        { type: "workflow_phase", title: "No index" },
        agent("a", { tokens: "12" }),
      ]),
    ).toEqual({
      phases: [{ index: 1, title: "Count" }],
      agents: [{ label: "a", state: "start", phaseIndex: 1 }],
    });
  });
});

describe("workflowSnapshotText", () => {
  it.each([
    {
      name: "lists agents without a known phase before the phases",
      entries: [
        phase(1, "Count"),
        agent("loose", { phaseIndex: undefined }),
        agent("lost", { phaseIndex: 9 }),
      ],
      text: "- loose: running\n- lost: running\n\n**Count**\n- not started",
    },
    {
      name: "shows a retry's attempt and a state the adapter does not know as sent",
      entries: [phase(1, "Count"), agent("a", { attempt: 2, state: "error" })],
      text: "**Count**\n- a: error (attempt 2)",
    },
    {
      name: "shows the last tool of a running agent only",
      entries: [
        phase(1, "Count"),
        agent("run", { lastToolName: "Read" }),
        agent("done", { state: "done", lastToolName: "Bash", lastToolSummary: "echo 3" }),
      ],
      text: "**Count**\n- run: running · Read\n- done: done",
    },
  ])("$name", ({ entries, text }) => {
    expect(workflowSnapshotText(workflowSnapshot(entries)!)).toBe(text);
  });
});
