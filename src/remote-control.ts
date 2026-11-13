/**
 * `/remote-control`, which the adapter serves itself, Remote Control at the
 * start of a session when Claude Code asks for it, and the messages that a
 * person types in another client of the session (claude.ai or the Claude
 * mobile app, over Remote Control). Shared by the v1 core and the v2
 * core, which run the command each in their own turn model.
 */
/** The content blocks of a prompt, in v1 or v2 form: the command is one text block. */
type PromptContent = ReadonlyArray<{ type: string; text?: unknown }>;

import type {
  Query,
  SDKControlInitializeResponse,
  SDKUserMessage,
  SDKUserMessageReplay,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionNotice } from "./session-notices.js";

/** Runtime Remote Control control exposed by the pinned Agent SDK. Like
 *  `mcpAuthenticate`, it is not in the public `Query` declaration yet. The CLI's
 *  own `/remote-control` is terminal-bound and not offered to SDK hosts, so the
 *  adapter handles the command itself and answers with the session URL. */
export type RemoteControlQuery = Query & {
  enableRemoteControl(
    enabled: boolean,
    name?: string,
  ): Promise<{ session_url?: string; connect_url?: string }>;
};

export function supportsRemoteControl(query: Query): query is RemoteControlQuery {
  return typeof (query as Partial<RemoteControlQuery>).enableRemoteControl === "function";
}

export const REMOTE_CONTROL_COMMAND_NAME = "remote-control";

export type RemoteControlCommand = { action: "connect"; name?: string } | { action: "disconnect" };

/** Parses `/remote-control [name]` and `/remote-control off` from a single-text
 *  prompt. Connecting is idempotent, so the command never needs to know whether
 *  Remote Control is already on. */
export function parseRemoteControlCommand(prompt: PromptContent): RemoteControlCommand | null {
  const [first] = prompt;
  if (prompt.length !== 1 || first?.type !== "text" || typeof first.text !== "string") return null;
  const match = /^\/remote-control(?:\s+([\s\S]*))?$/.exec(first.text.trim());
  if (!match) return null;
  const argument = match[1]?.trim();
  if (argument?.toLowerCase() === "off") return { action: "disconnect" };
  return argument ? { action: "connect", name: argument } : { action: "connect" };
}

/** Whether Claude Code offers a slash command of this name to an ACP client.
 *  This is the rule `getAvailableSlashCommands` applies when it lists the
 *  commands, so the adapter stands in for the command exactly when the client
 *  sees the adapter's entry: Claude Code's terminal-bound commands are not
 *  offered, and a user's own command or skill of the name is never shadowed. */
export function claudeCodeOffersCommand(
  commands: readonly SlashCommand[],
  terminalCommands: readonly string[] | undefined,
  name: string,
): boolean {
  return commands.some(
    (command) => command.name === name && !terminalCommands?.includes(command.name),
  );
}

/**
 * The `/remote-control` command of `prompt` that the adapter runs: the query
 * serves Remote Control and Claude Code does not offer a command of that name.
 * `null` for any other prompt, which goes to Claude Code.
 */
export async function adapterRemoteControlCommand(
  prompt: PromptContent,
  query: Query,
  terminalCommands: readonly string[] | undefined,
): Promise<{ query: RemoteControlQuery; command: RemoteControlCommand } | null> {
  const command = parseRemoteControlCommand(prompt);
  if (!command || !supportsRemoteControl(query)) return null;
  if (
    claudeCodeOffersCommand(
      await query.supportedCommands(),
      terminalCommands,
      REMOTE_CONTROL_COMMAND_NAME,
    )
  ) {
    return null;
  }
  return { query, command };
}

/**
 * Connects Remote Control (again, if it is already on) or disconnects it, and
 * returns the text that tells the user how it went. A failure is in the text:
 * this never throws.
 */
export async function runRemoteControlCommand(
  query: RemoteControlQuery,
  command: RemoteControlCommand,
  logError: (message: string) => void,
): Promise<string> {
  if (command.action === "disconnect") {
    try {
      await query.enableRemoteControl(false);
      return "Remote Control is off. Run /remote-control to reconnect.";
    } catch (error) {
      logError(`Failed to disable Remote Control: ${error}`);
      return `Could not stop Remote Control: ${error instanceof Error ? error.message : error}`;
    }
  }
  try {
    const result = await query.enableRemoteControl(true, command.name);
    return result.session_url
      ? `Remote Control is active. Continue this session from claude.ai/code or the Claude mobile app:\n\n${result.session_url}\n\nRun /remote-control off to disconnect.`
      : "Remote Control is active, but Claude Code did not return a session URL.";
  } catch (error) {
    logError(`Failed to enable Remote Control: ${error}`);
    return `Could not start Remote Control: ${error instanceof Error ? error.message : error}`;
  }
}

/** The `initialize` result with `remote_control_auto_enable`, which Claude Code
 *  resolves from `remoteControlAtStartup` in the settings, else the policy
 *  default, so that an SDK host can start Remote Control with the session as
 *  the terminal does. Like `enableRemoteControl`, it is not in the public
 *  declaration yet. */
type RemoteControlInitializeResponse = SDKControlInitializeResponse & {
  remote_control_auto_enable?: boolean;
};

/** Whether Claude Code asks for Remote Control to start with the session.
 *  `false` when the field is missing, as from a CLI that predates it. */
export function startsWithRemoteControl(
  initializationResult: SDKControlInitializeResponse,
): boolean {
  return (
    (initializationResult as RemoteControlInitializeResponse).remote_control_auto_enable === true
  );
}

/** Starts Remote Control for a session that starts with it, and returns the
 *  notice that tells the user how it went. A notice cannot be withdrawn once
 *  sent, so its title reports the connection as an event rather than a state
 *  that `/remote-control off` would make untrue. A refusal, such as Remote
 *  Control being disabled by policy, comes back as a warning instead of a
 *  throw. */
export async function startRemoteControl(
  query: RemoteControlQuery,
  logger: { error: (...args: unknown[]) => void },
): Promise<SessionNotice> {
  try {
    const { session_url } = await query.enableRemoteControl(true);
    const link = session_url
      ? `Continue this session from claude.ai/code or the Claude mobile app: ${session_url}`
      : "Claude Code did not return a session URL.";
    return {
      severity: "info",
      title: "Remote Control connected",
      description: `${link}\nRun /remote-control off to disconnect.`,
    };
  } catch (error) {
    logger.error(`Failed to enable Remote Control: ${error}`);
    return {
      severity: "warning",
      title: "Could not start Remote Control",
      description: error instanceof Error ? error.message : String(error),
    };
  }
}

/** A top-level message a person typed in another client of the session, such
 *  as claude.ai or the Claude mobile app over Remote Control. Tool results and
 *  the CLI's own synthetic messages are user-role too, but carry no human
 *  origin. */
export function isRemoteHumanMessage(message: SDKUserMessage | SDKUserMessageReplay): boolean {
  return (
    message.type === "user" &&
    message.origin?.kind === "human" &&
    message.parent_tool_use_id === null &&
    !message.isSynthetic
  );
}
