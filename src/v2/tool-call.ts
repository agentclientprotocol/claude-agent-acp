/**
 * The v2 form of the tool call reports that `ClaudeAcpAgent` sends as v1
 * `tool_call` and `tool_call_update` updates, and in permission requests.
 */
import type { ToolCall, ToolCallContent, ToolCallUpdate } from "@agentclientprotocol/sdk/unstable";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";

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
 * content references a display terminal, as in v2: a v2 client has no client
 * terminals, so the agent's only terminals are those of its terminal extension
 * (see `terminal.ts`).
 */
export function v2ToolCallUpdate(report: V1ToolCallReport): V2ToolCallUpdate {
  return { ...v2ToolCallPatch(report), sessionUpdate: "tool_call_update" };
}

/** The fields of a v2 tool call besides `toolCallId` and `_meta`. */
const TOOL_CALL_FIELDS = [
  "name",
  "title",
  "kind",
  "status",
  "content",
  "locations",
  "rawInput",
  "rawOutput",
] as const;

/**
 * The v2 form of a v1 `tool_call`, for a client that may already hold a tool
 * call with the same id. Each field that the `tool_call` leaves out is `null`,
 * so the client resets it to its default instead of keeping the old value. For
 * example, a replayed Bash call that the client holds with the `rawOutput` of
 * the live run gets `rawOutput: null`, which removes it.
 *
 * `V2ToolCallMeta` decides what `_meta` clears. Its `_meta: null` is a v2
 * clear, so it stays, where {@link v2ToolCallUpdate} drops a v1 `null`.
 */
export function v2RestartedToolCall(report: V1ToolCallReport): V2ToolCallUpdate {
  const update = v2ToolCallUpdate(report);
  const reset = Object.fromEntries(
    TOOL_CALL_FIELDS.filter((field) => !(field in update)).map((field) => [field, null]),
  );
  return { ...reset, ...update, ...(report._meta === null ? { _meta: null } : {}) };
}

/**
 * The v2 form of the fields of a v1 tool call report, which a session update
 * and the subject of a permission request carry. See {@link v2ToolCallUpdate}.
 */
export function v2ToolCallPatch(toolCall: ToolCall | ToolCallUpdate): v2.ToolCallUpdate {
  const patch = Object.fromEntries(
    Object.entries(toolCall).filter(
      ([key, value]) => value !== null && key !== "sessionUpdate" && key !== "content",
    ),
  ) as Omit<v2.ToolCallUpdate, "content">;
  return {
    ...patch,
    ...(toolCall.content != null ? { content: toolCall.content.map(v2ToolCallContent) } : {}),
  };
}

function v2ToolCallContent(item: ToolCallContent): v2.ToolCallContent {
  switch (item.type) {
    case "content":
      // v2 content blocks are a superset of the v1 blocks.
      return item;
    case "terminal":
      return item;
    default:
      if (isV2Diff(item)) return item;
      // A v1 diff names one path, with old and new texts that can be a
      // snippet: v2 cannot say which operation it is, nor give its patch.
      throw new Error("An ACP v2 client cannot take a v1 diff");
  }
}

/** A diff that the agent built in v2 form, which travels as v1 content. */
function isV2Diff(item: ToolCallContent): item is ToolCallContent & v2.ToolCallContent {
  return "changes" in item;
}
