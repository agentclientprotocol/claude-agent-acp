/**
 * The adapter's `/remote-control` on the v2 core, and the messages that
 * a person types in another client of the session over Remote Control.
 *
 * The command, its listing, and its reply are the v1 core's
 * (`remote-control.ts`). The command
 * runs as a local command of its own turn, as v2 asks of one ("Local handling
 * still uses the foreground lifecycle"): its prompt is inserted as a
 * live-only `user_message`, the turn reports `running`, the reply goes out,
 * and the turn ends `idle` with `end_turn`. It waits until no turn is open
 * and no prompt waits in Claude Code's queue, and the prompts after it wait
 * for it: v2 asks to hold a prompt rather than reject it while Claude works.
 */
import { randomUUID } from "node:crypto";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../acp-agent.js";
import {
  adapterRemoteControlCommand,
  isRemoteHumanMessage,
  parseRemoteControlCommand,
  runRemoteControlCommand,
} from "../remote-control.js";

/** What the command needs of its session. */
export interface RemoteControlHost {
  readonly logger: Logger;
  query(): Query | undefined;
  /** Claude Code's terminal-bound commands, which it does not offer. */
  terminalCommands(): readonly string[] | undefined;
  /** Resolves `true` once no turn is open and no prompt waits in Claude Code, `false` once the session closed. */
  idle(): Promise<boolean>;
  /** Inserts the prompt `uuid` and opens its turn. */
  begin(uuid: string): void;
  /** Sends the reply `text`, as agent text of the message `messageId`, and ends the turn. */
  end(text: string, messageId: string): void;
}

export class SessionRemoteControl {
  /** The uuids of the prompts that this session sent, until Claude Code echoes them. */
  private readonly sent = new Set<string>();

  constructor(private readonly host: RemoteControlHost) {}

  /** Whether `prompt` may be the adapter's command, which {@link run} then decides. */
  mayRun(prompt: Parameters<typeof parseRemoteControlCommand>[0]): boolean {
    return parseRemoteControlCommand(prompt) !== null;
  }

  /**
   * Runs `prompt` as the adapter's command, as its turn, once the session is
   * idle. Resolves `false` without running it when Claude Code serves the
   * command itself or the query has no Remote Control: the prompt then goes
   * to Claude Code. `stillPending` tells whether a cancel or close answered
   * the prompt meanwhile.
   */
  async run(
    prompt: Parameters<typeof parseRemoteControlCommand>[0],
    uuid: string,
    stillPending: () => boolean,
  ): Promise<boolean> {
    const query = this.host.query();
    if (!query) return false;
    const command = await adapterRemoteControlCommand(prompt, query, this.host.terminalCommands());
    if (!command) return false;
    if (!(await this.host.idle()) || !stillPending()) return true;
    this.host.begin(uuid);
    // The turn is open across the network call, so the session reads as busy.
    const text = await runRemoteControlCommand(command.query, command.command, (message) =>
      this.host.logger.error(message),
    );
    this.host.end(text, randomUUID());
    return true;
  }

  /** The session sent the prompt `uuid` to Claude Code. */
  pushed(uuid: string): void {
    this.sent.add(uuid);
  }

  /**
   * The content of a prompt echo to show as a user message: one that a
   * person typed in another client of the session. `undefined` for the
   * echo of a prompt that this session sent, and for any other echo.
   */
  remoteMessage(message: SDKUserMessage): SDKUserMessage["message"]["content"] | undefined {
    if (message.uuid && this.sent.delete(message.uuid)) return undefined;
    return isRemoteHumanMessage(message) ? message.message.content : undefined;
  }
}
