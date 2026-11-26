/**
 * The commands the adapter serves itself on the v1 core (`/remote-control` and
 * `/plugin`, see `../adapter-command.ts`), and the session's slot that they
 * share with Remote Control starting with the query.
 *
 * Their reply goes straight to the client, not through the turn queue, so it
 * would land inside the output of a turn that is running. v1 therefore refuses
 * a command while Claude works or another command runs, and holds the prompts
 * that follow back until the reply is sent, as they would start a turn that the
 * reply lands in. (v2 holds the command instead: `src/v2/adapter-commands.ts`.)
 */
import { randomUUID } from "node:crypto";
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import {
  type AdapterCommand,
  type AdapterCommandContext,
  adapterCommand,
} from "../adapter-command.js";
import type { RemoteControlCommand } from "../remote-control.js";
import type { TurnEvents } from "./turn-events.js";

/** What the commands need of their session and its agent. */
export interface AdapterCommandsHost {
  /** The `RequestError` text for a session that has ended. */
  readonly sessionEndedMessage: string;
  /** This session's query. A rewind leaves a successor session with its own. */
  query(): Query;
  /** Claude Code's terminal-bound commands, which it does not offer. */
  terminalCommands(): readonly string[] | undefined;
  /** Whether Claude is working in the session (see `ClaudeAcpAgent.claudeIsWorking`). */
  claudeIsWorking(): boolean;
  /** Starts the reader of the session's query stream, if none runs yet. */
  ensureConsumer(): void;
  /** Sends `text` to the client as an agent message. */
  reply(text: string): Promise<void>;
  /** Whether the session is still the agent's current one and its query is open. */
  alive(): boolean;
  /** Why the prompt received as number `received` must not start: its session
   *  was closed, or a `session/cancel` came after the prompt. */
  endedBeforeStart(received: number): "closed" | "cancelled" | undefined;
  /** Records the `/remote-control` that was asked, so that a restart of the
   *  query keeps what the user chose last (see `RemoteControlAtStartup.commandRan`). */
  commandRan(command: RemoteControlCommand): void;
  context(): AdapterCommandContext;
}

export class AdapterCommands {
  /**
   * What runs, from its request to its answer: an adapter command, or Remote
   * Control starting with the query (see `connectAtStartup`). `abort` stops a
   * command on `session/cancel` and teardown; the start of Remote Control has
   * none, as it can't be stopped.
   */
  private running: { done: Promise<void>; abort?: AbortController } | undefined;

  constructor(private readonly host: AdapterCommandsHost) {}

  /** Whether something runs, so that the session is busy for idle compaction
   *  and rewind, and a command is refused. */
  get busy(): boolean {
    return this.running !== undefined;
  }

  /** Settles when what runs has ended, failed or not. The prompts wait for it. */
  get done(): Promise<void> | undefined {
    return this.running?.done;
  }

  /** Stops the command that runs, which then sends no reply. */
  abort(): void {
    this.running?.abort?.abort();
  }

  /**
   * Settles when the command that `abort` stops has ended, for a close to wait
   * for. Not for the start of Remote Control: a cancel does not stop it, and a
   * request that never answers would hold the close for the whole timeout.
   */
  abortedEnd(): Promise<void> | undefined {
    return this.running?.abort && this.running.done.catch(() => {});
  }

  /** The adapter command of `prompt`, or `null` for a prompt that goes to Claude Code. */
  lookup(prompt: Parameters<typeof adapterCommand>[0]): Promise<AdapterCommand | null> {
    return adapterCommand(
      prompt,
      this.host.query(),
      this.host.terminalCommands(),
      this.host.context(),
    );
  }

  /** Refuses a command that cannot start now: the session ended, a turn runs,
   *  or another command does. */
  assertCanStart(command: AdapterCommand): void {
    if (!this.host.alive())
      throw RequestError.internalError(undefined, this.host.sessionEndedMessage);
    // `claudeIsWorking` also covers a cycle that Claude Code started on its own,
    // such as its follow-up after a background subagent finished.
    if (this.host.claudeIsWorking()) {
      throw RequestError.invalidRequest(undefined, command.busyMessage);
    }
    if (this.running) throw RequestError.invalidRequest(undefined, command.inFlightMessage);
  }

  /**
   * Starts the command, which the adapter answers without a model turn. The
   * refusals of {@link assertCanStart} throw synchronously. A close or cancel
   * that came before the command started ends the prompt `cancelled` when
   * `events` is passed (a prompt), and throws when it is not (`steer`, which
   * has no prompt to end). The promise settles once the command and its reply
   * are done.
   */
  begin(
    command: AdapterCommand,
    received: number,
    events?: Pick<TurnEvents, "inserted" | "ended">,
  ): Promise<void> {
    const ended = this.host.endedBeforeStart(received);
    if (ended) {
      if (!events) {
        throw ended === "closed"
          ? RequestError.internalError(undefined, this.host.sessionEndedMessage)
          : RequestError.requestCancelled(
              undefined,
              "The command was cancelled before it started.",
            );
      }
      events.ended({ stopReason: "cancelled" });
      return Promise.resolve();
    }
    this.assertCanStart(command);
    if (command.remoteControl) this.host.commandRan(command.remoteControl);
    // Once Remote Control is on, other clients can start turns on their own.
    // The reader starts after the session's setup response, so a command that
    // comes before it answers without a turn and leaves the stream unread.
    this.host.ensureConsumer();
    events?.inserted(randomUUID());
    // A command can take a network call or a minute-long `git clone`.
    const abort = new AbortController();
    const done = this.run(command, abort.signal);
    return this.occupy({ done, abort }).then(() =>
      events?.ended({ stopReason: abort.signal.aborted ? "cancelled" : "end_turn" }),
    );
  }

  /**
   * Runs `change`, Remote Control starting with the query, which answers into
   * the session's output, with the session's prompts held back until it is
   * done. Nothing awaits before the hold is set, so no prompt can start between
   * the caller's checks and the hold. The query stream's reader starts first,
   * as in {@link begin}. The hold has no `abort`: a `session/cancel` does not
   * stop `change`, as Remote Control cannot be un-started.
   */
  hold(change: () => Promise<void>): Promise<void> {
    this.host.ensureConsumer();
    return this.occupy({ done: change() });
  }

  private async run(command: AdapterCommand, signal: AbortSignal): Promise<void> {
    const text = await command.run(signal);
    if (!signal.aborted) await this.host.reply(text);
  }

  private async occupy(held: NonNullable<typeof this.running>): Promise<void> {
    this.running = held;
    try {
      await held.done;
    } finally {
      if (this.running === held) this.running = undefined;
    }
  }
}
