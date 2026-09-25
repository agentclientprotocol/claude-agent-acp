import { describe, expect, it } from "vitest";
import { compareWithBaseline } from "./acp-scenarios/compare.js";
import type { Recorded } from "./acp-scenarios/harness.js";

function update(fields: Record<string, unknown>): Recorded {
  return { kind: "sessionUpdate", payload: { sessionId: "s", update: fields } };
}

const toolCall = update({
  sessionUpdate: "tool_call",
  toolCallId: "t",
  title: "Read",
  status: "pending",
  _meta: { claudeCode: { toolName: "Read" } },
});

const result = {
  sessionUpdate: "tool_call_update",
  toolCallId: "t",
  title: "Read",
  status: "completed",
  rawOutput: "text",
  _meta: { claudeCode: { toolName: "Read" } },
};

const baseline = [toolCall, update(result)];

/** A copy of `value` without `key`. */
function omit(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

describe("compareWithBaseline", () => {
  it("accepts the baseline itself", () => {
    expect(compareWithBaseline(baseline, baseline)).toEqual([]);
  });

  it("accepts an update without a field that did not change", () => {
    expect(compareWithBaseline(baseline, [toolCall, update(omit(result, "title"))])).toEqual([]);
  });

  it("reports a dropped _meta key", () => {
    expect(compareWithBaseline(baseline, [toolCall, update(omit(result, "_meta"))])).toContainEqual(
      expect.stringMatching(/^origin\/main sent .*"toolName":"Read"/u),
    );
  });

  it("reports a changed rawOutput", () => {
    const changed = update({ ...result, rawOutput: "other" });
    expect(compareWithBaseline(baseline, [toolCall, changed])).toContainEqual(
      expect.stringMatching(/but the adapter sent .*"rawOutput":"other"/u),
    );
  });

  it("reports an extra update", () => {
    const extra = update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "failed" });
    expect(compareWithBaseline(baseline, [...baseline, extra])).toEqual([
      expect.stringMatching(/^origin\/main did not send /u),
    ]);
  });
});
