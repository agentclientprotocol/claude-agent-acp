/**
 * A prompt turn and the foreground work of a session, as the adapter
 * understands them, independent of the ACP version.
 *
 * The agent reports how each prompt is answered through {@link TurnEvents}:
 * ACP v1 answers `session/prompt` when the turn ends or fails, and ACP v2 when
 * the prompt is inserted. ACP v2 also reports the session's work as state,
 * which the agent reports through {@link ForegroundEvents}.
 *
 * The agent calls these synchronously while it updates its own state, so a
 * handler must not throw, nor call back into the agent before it returns.
 */
export interface TurnEvents {
  /**
   * Claude Code took the prompt in as the user message `messageId` of the
   * conversation. Reported at most once per turn, and never after
   * {@link ended} or {@link failed}.
   *
   * When Claude Code reports command lifecycles (`msg_lifecycle_v1`), that is
   * when the prompt starts a turn, before the turn's output. Otherwise, and
   * while another turn is still active (held for its background work,
   * steered, or cancelled but not yet ended), it is the prompt's echo, after
   * that turn ended; for a command Claude Code does not echo (such as
   * `/compact`), it is the command's result, after any output it streamed.
   */
  inserted(messageId: string): void;
  /**
   * The turn ended. A queued turn that is cancelled before it is inserted
   * ends too, without {@link inserted}; Claude Code may still run its prompt.
   */
  ended(outcome: TurnOutcome): void;
  /**
   * The turn failed with `error`, the JSON-RPC error that v1 answers the
   * prompt with. Without {@link inserted} before, Claude Code was not seen
   * taking the prompt in.
   */
  failed(error: unknown): void;
}

/**
 * The foreground work of a session: what a client would wait for before it
 * sends the next prompt. One piece of work runs at a time, and the next starts
 * with {@link running}. The work is either:
 *
 * - A prompt's turn, from {@link TurnEvents.inserted} until its result, or
 *   until it fails or is cancelled. A turn that v1 holds open for the
 *   background subagents it spawned (`Turn.deferredSettle`) ends its work at
 *   its result all the same: the hold only delays v1's answer.
 * - A model cycle that Claude Code starts on its own while no work runs: for
 *   example, its follow-up after a background command or subagent finished,
 *   or its answer to a message from another session. It runs until its result.
 *
 * A prompt that Claude Code takes in while a cycle runs takes the cycle over:
 * the cycle reports nothing more, and the turn reports from there.
 */
export interface ForegroundEvents {
  /** The work started, or works again after it waited for the user. */
  running(): void;
  /**
   * The work waits for the user: a permission request or a question is open in
   * the session. Requests do not say which work they are for, so this includes
   * one opened before the work started.
   */
  awaitingUser(): void;
  /** The work ended. */
  ended(outcome: TurnOutcome): void;
  /**
   * The work failed with `error`, the JSON-RPC error that v1 answers the
   * prompt with.
   */
  failed(error: unknown): void;
}

/** Why a turn ended. Every ACP version has these reasons. */
export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/** How a turn ended. */
export type TurnOutcome = {
  stopReason: StopReason;
  /** The tokens that the main agent loop of the turn used. */
  usage?: TurnUsage;
  /**
   * Extension data for the client, such as the quota breakdown of the turn
   * and a terminal session failure.
   */
  _meta?: Record<string, unknown>;
};

export type TurnUsage = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
};
