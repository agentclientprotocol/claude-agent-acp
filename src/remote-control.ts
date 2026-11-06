import type { PromptRequest } from "@agentclientprotocol/sdk/unstable";
import type { Query, SDKControlInitializeResponse } from "@anthropic-ai/claude-agent-sdk";
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
export function parseRemoteControlCommand(
  prompt: PromptRequest["prompt"],
): RemoteControlCommand | null {
  const [first] = prompt;
  if (prompt.length !== 1 || first?.type !== "text") return null;
  const match = /^\/remote-control(?:\s+([\s\S]*))?$/.exec(first.text.trim());
  if (!match) return null;
  const argument = match[1]?.trim();
  if (argument?.toLowerCase() === "off") return { action: "disconnect" };
  return argument ? { action: "connect", name: argument } : { action: "connect" };
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
