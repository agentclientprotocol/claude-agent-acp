/**
 * Agent-owned display terminals for the commands that the agent runs.
 *
 * The agent reports a command through the terminal extension of ACP v1
 * clients, as codex-acp does: `_meta.terminal_info` names the terminal of a
 * tool call, whose content references it; `terminal_output` (a snapshot) or
 * `terminal_output_delta` (a chunk) carries the output, and `terminal_exit` the
 * exit. ACP v2 standardizes this as display-only terminals: the same content
 * reference, and `terminal_update` and `terminal_output_chunk` for the
 * terminal's state. The agent reports to a v2 client as to a client of the
 * extension (`ToolCallClientCapabilities.from`), and {@link V2Terminals} turns
 * the extension's keys into those updates.
 */
import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2";

type V1ToolCallReport =
  | (ToolCall & { sessionUpdate: "tool_call" })
  | (ToolCallUpdate & { sessionUpdate: "tool_call_update" });

/** The `_meta` keys of the terminal extension. */
interface TerminalMeta {
  terminal_info?: { terminal_id: string };
  terminal_output?: { terminal_id: string; data: string };
  terminal_output_delta?: { terminal_id: string; data: string };
  terminal_exit?: { terminal_id: string; exit_code: number | null; signal: string | null };
}

const TERMINAL_KEYS = [
  "terminal_info",
  "terminal_output",
  "terminal_output_delta",
  "terminal_exit",
] as const;

/** The terminal updates of the tool call reports of one v2 connection. */
export class V2Terminals {
  /** The terminal and the last reported command of each running command, by session and tool call. */
  private readonly running = new Map<string, { terminalId: string; command?: string }>();

  /**
   * The terminal updates that a tool call report carries in the extension's
   * keys, and the report without them, or undefined when nothing else is left
   * in it.
   *
   * The extension names no command, so the terminal gets the command of the
   * tool call's `rawInput` once a report carries it: the first report of a
   * streamed tool use has no input yet.
   */
  split(
    sessionId: string,
    report: V1ToolCallReport,
  ): { terminal: v2.SessionUpdate[]; report: V1ToolCallReport | undefined } {
    const meta = (report._meta ?? {}) as TerminalMeta;
    const key = `${sessionId} ${report.toolCallId}`;
    if (meta.terminal_info) this.running.set(key, { terminalId: meta.terminal_info.terminal_id });
    const terminal: v2.SessionUpdate[] = [];
    const running = this.running.get(key);
    if (running) {
      const command = commandOf(report.rawInput);
      const newCommand = command !== undefined && command !== running.command;
      if (newCommand) running.command = command;
      const { terminal_output: output, terminal_output_delta: delta, terminal_exit: exit } = meta;
      if (meta.terminal_info || newCommand || output || exit) {
        terminal.push({
          sessionUpdate: "terminal_update",
          terminalId: running.terminalId,
          ...(newCommand ? { command } : {}),
          ...(output ? { output: { data: base64(output.data) } } : {}),
          ...(exit
            ? {
                exitStatus: {
                  ...(exit.exit_code != null ? { exitCode: exit.exit_code } : {}),
                  ...(exit.signal != null ? { signal: exit.signal } : {}),
                },
              }
            : {}),
        });
      }
      if (delta) {
        terminal.push({
          sessionUpdate: "terminal_output_chunk",
          terminalId: running.terminalId,
          data: base64(delta.data),
        });
      }
      if (exit) this.running.delete(key);
    }
    return { terminal, report: withoutTerminalKeys(report) };
  }

  /** Forgets the terminals of a session. */
  forget(sessionId: string): void {
    for (const key of this.running.keys()) {
      if (key.startsWith(`${sessionId} `)) this.running.delete(key);
    }
  }
}

/**
 * The report without the extension's keys, or undefined when it carried
 * nothing else but `_meta`: the output report of a command carries the output
 * alone, and only the stamps that every report of the tool call repeats. In v2
 * a concrete `_meta` replaces the stored one, so sending them would drop the
 * other keys that the tool call holds.
 */
function withoutTerminalKeys(report: V1ToolCallReport): V1ToolCallReport | undefined {
  if (!report._meta || !TERMINAL_KEYS.some((key) => key in report._meta!)) return report;
  const meta = Object.fromEntries(
    Object.entries(report._meta).filter(
      ([key]) => !(TERMINAL_KEYS as readonly string[]).includes(key),
    ),
  );
  const stripped = { ...report };
  if (Object.keys(meta).length > 0) stripped._meta = meta;
  else delete stripped._meta;
  const fields = Object.keys(stripped).filter(
    (key) => key !== "sessionUpdate" && key !== "toolCallId" && key !== "_meta",
  );
  return fields.length > 0 || report.sessionUpdate === "tool_call" ? stripped : undefined;
}

function commandOf(rawInput: unknown): string | undefined {
  const command = (rawInput as { command?: unknown } | null | undefined)?.command;
  return typeof command === "string" && command.length > 0 ? command : undefined;
}

/** The output bytes, base64-encoded as a v2 terminal carries them. */
function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}
