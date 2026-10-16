/**
 * The `_meta` of the tool calls of one ACP v2 connection, as the client stores
 * it.
 *
 * The agent gives each v1 tool call report the `_meta` keys of that report.
 * An AIR client merges them by key (see `ToolCallFieldTracker`), and another
 * v1 client reads them per report. A v2 client patches its stored `_meta` by
 * top-level key: a key the report leaves out keeps its value, a key set to
 * `null` is removed, and any other value replaces the key whole, nested
 * objects included.
 *
 * {@link V2ToolCallMeta} therefore keeps the merged `_meta` of each tool call,
 * with the `claudeCode` keys merged one by one and every other key replaced
 * whole, as `ToolCallFieldTracker` models it. A report carries the top-level
 * keys that changed: all of `claudeCode` when one of its keys changed, since
 * the client does not merge it, and `null` for a key that is gone. A report
 * that changes nothing carries no `_meta`.
 *
 * `claudeCode.toolName` repeats the name of the tool, which v2 has a field
 * for. It becomes the `name` of a tool call that has none yet, and is left out
 * of the stored `_meta`. Subagent routing reads it before this, on the agent's
 * v1 reports.
 */
import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";

type Meta = Record<string, unknown>;

/** The number of tool calls whose `_meta` a connection remembers. */
const TOOL_CALL_LIMIT = 2048;

export class V2ToolCallMeta {
  /** The stored `_meta` of each tool call, by session and tool call, oldest first. */
  private readonly calls = new Map<string, { meta: Meta; named: boolean }>();

  /**
   * The v2 reports of `report`: the report with the `_meta` keys it changes,
   * without `_meta` when it changes none, and with `name` when it names the
   * tool call for the first time.
   *
   * `starts` says that the report starts the tool call (a v1 `tool_call`),
   * which forgets what an earlier one with the same id stored: the report sets
   * `null` for each of its keys. `replaying` says that the client may hold
   * `_meta` of the tool call from before this connection, for example from an
   * earlier live session. A replayed start of a tool call this connection has
   * not reported then clears it with `_meta: null`, and a second report sets
   * the current keys.
   */
  apply<Report extends ToolCall | ToolCallUpdate>(
    sessionId: string,
    report: Report,
    starts: boolean,
    replaying = false,
  ): [Report] | [Report, ToolCallUpdate] {
    const key = `${sessionId} ${report.toolCallId}`;
    const previous = this.calls.get(key);
    const held = previous?.meta ?? {};
    const call = (!starts && previous) || { meta: {}, named: false };
    this.remember(key, call);

    const { _meta, ...fields } = report;
    const result = fields as Report;
    const { toolName, ...claudeCode } = asRecord(_meta?.claudeCode) ?? {};
    if (report.name != null) {
      call.named = true;
    } else if (!call.named && typeof toolName === "string") {
      result.name = toolName;
      call.named = true;
    }

    const meta: Meta = { ...call.meta };
    for (const [name, value] of Object.entries(_meta ?? {})) {
      if (name === "claudeCode") continue;
      // `null` removes the key in v2, so it is not stored.
      if (value === null) delete meta[name];
      else meta[name] = value;
    }
    if (Object.keys(claudeCode).length > 0) {
      meta.claudeCode = { ...asRecord(call.meta.claudeCode), ...claudeCode };
    }
    call.meta = meta;

    if (starts && replaying && !previous) {
      result._meta = null;
      if (Object.keys(meta).length === 0) return [result];
      return [result, { toolCallId: report.toolCallId, _meta: meta }];
    }
    const patch: Meta = {};
    for (const name of Object.keys(held)) {
      if (!(name in meta)) patch[name] = null;
    }
    for (const [name, value] of Object.entries(meta)) {
      if (JSON.stringify(value) !== JSON.stringify(held[name])) patch[name] = value;
    }
    if (Object.keys(patch).length > 0) result._meta = patch;
    return [result];
  }

  /**
   * The tool call of a permission request's subject: like {@link apply}, but
   * with every stored `_meta` key even when the subject changes nothing, since
   * a client can show the request from the request alone.
   */
  subject<Report extends ToolCall | ToolCallUpdate>(sessionId: string, toolCall: Report): Report {
    const [result] = this.apply(sessionId, toolCall, false);
    const stored = this.calls.get(`${sessionId} ${toolCall.toolCallId}`)?.meta ?? {};
    if (Object.keys(stored).length > 0) result._meta = { ...result._meta, ...stored };
    return result;
  }

  /** Forgets the tool calls of a session, when it closes. */
  forget(sessionId: string): void {
    for (const key of this.calls.keys()) {
      if (key.startsWith(`${sessionId} `)) this.calls.delete(key);
    }
  }

  /** Stores the entry as the most recent one, and forgets the oldest one past the limit. */
  private remember(key: string, call: { meta: Meta; named: boolean }): void {
    this.calls.delete(key);
    this.calls.set(key, call);
    if (this.calls.size > TOOL_CALL_LIMIT) {
      const oldest = this.calls.keys().next().value;
      if (oldest !== undefined) this.calls.delete(oldest);
    }
  }
}

function asRecord(value: unknown): Meta | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Meta) : undefined;
}
