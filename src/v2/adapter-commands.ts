/**
 * The commands the adapter serves itself on the v2 core (`/remote-control`
 * and `/plugin`, see `adapter-command.ts`), and the messages that a person
 * types in another client of the session over Remote Control.
 *
 * The commands, their listing, and their replies are shared with the v1 core.
 * A command runs as a local command of its own turn, as v2 asks of one
 * ("Local handling still uses the foreground lifecycle"): its prompt is
 * inserted as a live-only `user_message`, the turn reports `running`, the
 * reply goes out, and the turn ends `idle` with `end_turn`. It waits until no
 * turn is open and no prompt waits in Claude Code's queue, and the prompts
 * after it wait for it: v2 asks to hold a prompt rather than reject it while
 * Claude works. A cancel or close aborts the running command: no reply goes
 * out and the turn ends `cancelled`.
 *
 * Remote Control also starts with a query that Claude Code asked to start
 * with it (`remoteControlAtStartup` in the settings, else the policy default or
 * a rollout; see `startsWithRemoteControl`). That is no turn: it reports in a
 * notice, as v1 does.
 */
import { randomUUID } from "node:crypto";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  adapterCommand,
  mayBeAdapterCommand,
  type AdapterCommandContext,
} from "../adapter-command.js";
import type { Logger } from "../logger.js";
import { isRemoteHumanMessage, RemoteControlAtStartup } from "../remote-control.js";
import type { SessionNotice } from "../session-notices.js";

/** How {@link SessionAdapterCommands.run} handled a prompt. */
export type AdapterCommandOutcome =
  /** The adapter does not serve the prompt, which goes to Claude Code. */
  | "not-served"
  /** The command ran as its turn. */
  | "ran"
  /** A cancel or close answered the prompt before the command began. */
  | "answered";

/** What the commands need of their session. */
export interface AdapterCommandsHost extends Pick<
  AdapterCommandContext,
  "cwd" | "env" | "remoteSession"
> {
  readonly logger: Logger;
  readonly sessionId: string;
  query(): Query | undefined;
  /** Claude Code's terminal-bound commands, which it does not offer. */
  terminalCommands(): readonly string[] | undefined;
  /** Resolves `true` once no turn is open and no prompt waits in Claude Code, `false` once the session closed. */
  idle(): Promise<boolean>;
  /** Inserts the prompt `uuid` and opens its turn. */
  begin(uuid: string): void;
  /** Ends the turn, after the reply `text` as agent text of the message `messageId`, if any. */
  end(reply: { text: string; messageId: string } | undefined): void;
  /** Whether a turn is open or a prompt waits in Claude Code's queue. */
  working(): boolean;
  /** Sends `notice` to the client. */
  notice(notice: SessionNotice): void;
}

export class SessionAdapterCommands {
  /** The uuids of the prompts that this session sent, until Claude Code echoes them. */
  private readonly sent = new Set<string>();

  /**
   * Remote Control at the start of this query, which Claude Code can ask for
   * at `initialize` (see `V2Session.setRemoteControlAtStartup`).
   */
  atStartup = new RemoteControlAtStartup(false);

  constructor(private readonly host: AdapterCommandsHost) {}

  /**
   * Starts Remote Control after the setup response of a query that Claude
   * Code asked to start with it, and reports how it went in a notice (see
   * `RemoteControlAtStartup`). It runs once per query, so a later resume of
   * the live session starts nothing, while a restart of the query (see
   * `restarts.ts`), whose new query asks again, starts it again, unless the
   * user turned it off before (see {@link restartedFrom}). The session holds
   * its prompts back until the notice is sent.
   */
  async connectAtStartup(): Promise<void> {
    const notice = this.atStartup.connect(this.host);
    if (notice) this.host.notice(await notice);
  }

  /**
   * A restart replaced the query of `previous` with this one: Remote Control
   * that the user turned off there stays off (see
   * `RemoteControlAtStartup.restartedFrom`).
   */
  restartedFrom(previous: SessionAdapterCommands): void {
    this.atStartup.restartedFrom(previous.atStartup);
  }

  /** The running command's abort, while one runs. */
  private abortCommand: AbortController | undefined;

  /** Whether `prompt` may be an adapter command, which {@link run} then decides. */
  mayRun(prompt: Parameters<typeof mayBeAdapterCommand>[0]): boolean {
    return mayBeAdapterCommand(prompt);
  }

  /**
   * Runs `prompt` as an adapter command, as its turn, once the session is
   * idle. Resolves `"not-served"` without running it when the adapter does
   * not serve it (Claude Code offers the command itself, or the session
   * cannot run it): the prompt then goes to Claude Code. `stillPending`
   * tells whether a cancel or close answered the prompt meanwhile, which
   * resolves `"answered"` without running it.
   */
  async run(
    prompt: Parameters<typeof mayBeAdapterCommand>[0],
    uuid: string,
    stillPending: () => boolean,
  ): Promise<AdapterCommandOutcome> {
    const query = this.host.query();
    if (!query) return "not-served";
    const command = await adapterCommand(prompt, query, this.host.terminalCommands(), {
      cwd: this.host.cwd,
      env: this.host.env,
      remoteSession: this.host.remoteSession,
      query: () => this.host.query(),
      logError: (message) => this.host.logger.error(message),
    });
    if (!command) return "not-served";
    if (!(await this.host.idle()) || !stillPending()) return "answered";
    this.host.begin(uuid);
    // A restart of the query keeps what the user chose last.
    if (command.remoteControl) this.atStartup.commandRan(command.remoteControl);
    // The turn is open across the command, so the session reads as busy.
    const abort = new AbortController();
    this.abortCommand = abort;
    try {
      const text = await command.run(abort.signal);
      this.host.end(abort.signal.aborted ? undefined : { text, messageId: randomUUID() });
    } finally {
      this.abortCommand = undefined;
    }
    return "ran";
  }

  /** Aborts the running command, which then sends no reply. A cancel or close calls it. */
  abort(): void {
    this.abortCommand?.abort();
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
