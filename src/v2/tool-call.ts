/**
 * The v2 form of the tool call reports that `ClaudeAcpAgent` sends as v1
 * `tool_call` and `tool_call_update` updates.
 */
import type { ToolCall, ToolCallContent, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2";

type V1ToolCallReport =
  | (ToolCall & { sessionUpdate: "tool_call" })
  | (ToolCallUpdate & { sessionUpdate: "tool_call_update" });

type V2ToolCallUpdate = v2.ToolCallUpdate & { sessionUpdate: "tool_call_update" };

/**
 * The v2 form of a v1 tool call report.
 *
 * v1 reports a new tool call with `tool_call` and changes it with
 * `tool_call_update`; v2 has one `tool_call_update` that upserts by
 * `toolCallId`. Both leave a field that a report omits unchanged, and both
 * replace `content` and `locations` as whole arrays. They differ on `null`:
 * in v1 it leaves the field unchanged too, in v2 it clears the field, so `null`
 * fields are left out.
 *
 * Diff and terminal content throw until the v2 surface translates them
 * (step 4 of `docs/acp-v2.md`).
 */
export function v2ToolCallUpdate(report: V1ToolCallReport): V2ToolCallUpdate {
  const { sessionUpdate: _, content, ...fields } = report;
  const patch = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null),
  ) as Omit<V2ToolCallUpdate, "sessionUpdate" | "content">;
  return {
    ...patch,
    sessionUpdate: "tool_call_update",
    ...(content != null ? { content: content.map(v2ToolCallContent) } : {}),
  };
}

function v2ToolCallContent(item: ToolCallContent): v2.ToolCallContent {
  switch (item.type) {
    case "content":
      // v2 content blocks are a superset of the v1 blocks.
      return item;
    case "diff":
    case "terminal":
      throw new Error(`The ACP v2 surface does not translate ${item.type} tool call content yet`);
  }
}
