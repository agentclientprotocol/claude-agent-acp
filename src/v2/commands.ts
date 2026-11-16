/**
 * The slash commands of a v2 session: the list that setup responses
 * and `available_commands_update` carry, and the adapter's own `/mcp`.
 *
 * The list is built by the v1 core's `getAvailableSlashCommands`, so both
 * cores advertise the same commands: Claude Code's commands without the
 * unsupported and terminal-bound ones, MCP prompts as `mcp:<server>:<name>`,
 * the adapter's `/mcp`, and the adapter's `/remote-control` when the query
 * serves Remote Control and Claude Code offers no command of that name (see
 * `remote-control.ts`).
 *
 * `/mcp` is served as on v1 (`runMcpCommand`): Claude Code runs the command,
 * and the adapter's server list replaces Claude Code's text in the turn's
 * output.
 */
import type { ContentBlock } from "@agentclientprotocol/sdk/unstable";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { Query, SDKSystemMessage, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { getAvailableSlashCommands } from "../slash-commands.js";
import { parseMcpCommand, runMcpCommand, type McpCommand } from "../mcp-command.js";
import { v2AvailableCommands } from "./session-requests.js";

export class SessionCommands {
  /** Claude Code's terminal-bound commands, from the turn's `system/init`. */
  private terminalCommands: string[] | undefined;

  constructor(private readonly query: Query) {}

  /** The session's commands, in v2 form. */
  async list(): Promise<v2.AvailableCommand[]> {
    return this.render(await this.query.supportedCommands());
  }

  /** The `available_commands_update` of Claude Code's `commands_changed` list. */
  changed(commands: SlashCommand[]): v2.SessionUpdate {
    return { sessionUpdate: "available_commands_update", availableCommands: this.render(commands) };
  }

  /**
   * Records the terminal-bound commands of a `system/init`. Returns whether
   * they changed, so the list must go out again.
   */
  init(message: SDKSystemMessage): boolean {
    const terminal = message.terminal_slash_commands;
    if (!terminal || JSON.stringify(terminal) === JSON.stringify(this.terminalCommands)) {
      return false;
    }
    this.terminalCommands = terminal;
    return true;
  }

  /** Claude Code's terminal-bound commands, which it does not offer. */
  terminal(): readonly string[] | undefined {
    return this.terminalCommands;
  }

  /** The `/mcp` command that a prompt is, if it is one. */
  localCommand(prompt: ContentBlock[]): McpCommand | undefined {
    const [first] = prompt;
    if (prompt.length !== 1 || first?.type !== "text") return undefined;
    return parseMcpCommand(first.text) ?? undefined;
  }

  /**
   * The text that replaces Claude Code's `output` of `command`, or `output`
   * when the adapter cannot build it (a status read failed, or `signal`
   * aborted).
   */
  async replace(
    query: Parameters<typeof runMcpCommand>[0],
    command: McpCommand,
    output: string,
    signal: AbortSignal,
    logError: (message: string) => void,
  ): Promise<string> {
    const { markdown } = await runMcpCommand(query, command, output, signal, logError);
    return markdown ?? output;
  }

  private render(commands: SlashCommand[]): v2.AvailableCommand[] {
    return v2AvailableCommands(
      getAvailableSlashCommands(commands, this.terminalCommands, undefined, undefined, this.query),
    );
  }
}
