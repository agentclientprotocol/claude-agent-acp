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
 * Diffs need what a v1 diff does not say, so the agent builds them in v2 form
 * for a v2 client (`v2DiffContent`), and they pass as they are. Terminal
 * content throws until the v2 surface translates it (step 4 of
 * `docs/acp-v2.md`).
 */
export function v2ToolCallUpdate(report: V1ToolCallReport): V2ToolCallUpdate {
  const patch = Object.fromEntries(
    Object.entries(report).filter(
      ([key, value]) => value !== null && key !== "sessionUpdate" && key !== "content",
    ),
  ) as Omit<V2ToolCallUpdate, "sessionUpdate" | "content">;
  return {
    ...patch,
    sessionUpdate: "tool_call_update",
    ...(report.content != null ? { content: report.content.map(v2ToolCallContent) } : {}),
  };
}

function v2ToolCallContent(item: ToolCallContent): v2.ToolCallContent {
  switch (item.type) {
    case "content":
      // v2 content blocks are a superset of the v1 blocks.
      return item;
    case "diff":
      if (isV2Diff(item)) return item;
      // A v1 diff names one path, with old and new texts that can be a
      // snippet: v2 cannot say which operation it is, nor give its patch.
      throw new Error("An ACP v2 client cannot take a v1 diff");
    default:
      throw new Error(`The ACP v2 surface does not translate ${item.type} tool call content yet`);
  }
}

/** A diff that the agent built in v2 form, which travels as v1 content. */
function isV2Diff(item: ToolCallContent): item is ToolCallContent & v2.ToolCallContent {
  return "changes" in item;
}
