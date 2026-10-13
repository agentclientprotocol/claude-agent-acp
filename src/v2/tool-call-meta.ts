/**
 * The `_meta` of the tool calls of one ACP v2 connection, as the client stores
 * it.
 *
 * The agent gives each v1 tool call report the `_meta` keys of that report.
 * An AIR client merges them by key (see `ToolCallFieldTracker`), and another
 * v1 client reads them per report. A v2 client stores a tool call's `_meta`,
 * and a report that carries `_meta` replaces it. So the earlier keys must
 * travel again, or the `{ toolName }` of a tool's result would replace, for
 * example, the reason of the denial before it.
 *
 * {@link V2ToolCallMeta} therefore keeps the merged `_meta` of each tool call,
 * with the `claudeCode` keys merged one by one and every other key replaced
 * whole, as `ToolCallFieldTracker` models it. A report that changes it carries
 * all of it; a report that changes nothing carries no `_meta`.
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
   * `report` with the tool call's whole `_meta` when the report changes it,
   * without `_meta` when it does not, and with `name` when it names the tool
   * call for the first time. `starts` says that the report starts the tool
   * call (a v1 `tool_call`), which forgets what an earlier one stored.
   */
  apply<Report extends ToolCall | ToolCallUpdate>(
    sessionId: string,
    report: Report,
    starts: boolean,
  ): Report {
    const key = `${sessionId} ${report.toolCallId}`;
    const call = (!starts && this.calls.get(key)) || { meta: {}, named: false };
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
      if (name !== "claudeCode") meta[name] = value;
    }
    if (Object.keys(claudeCode).length > 0) {
      meta.claudeCode = { ...asRecord(call.meta.claudeCode), ...claudeCode };
    }
    if (JSON.stringify(meta) !== JSON.stringify(call.meta)) {
      call.meta = meta;
      result._meta = meta;
    }
    return result;
  }

  /**
   * The tool call of a permission request's subject: like {@link apply}, but
   * with the tool call's whole `_meta` even when the subject changes nothing,
   * since a client can show the request from the request alone.
   */
  subject<Report extends ToolCall | ToolCallUpdate>(sessionId: string, toolCall: Report): Report {
    const result = this.apply(sessionId, toolCall, false);
    const stored = this.calls.get(`${sessionId} ${toolCall.toolCallId}`)?.meta ?? {};
    if (result._meta === undefined && Object.keys(stored).length > 0) result._meta = stored;
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
