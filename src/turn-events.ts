/**
 * A prompt turn as the adapter understands it, independent of the ACP version.
 *
 * The agent reports each turn through {@link TurnEvents}, and each ACP version
 * maps the events to its own messages. ACP v1 answers `session/prompt` when the
 * turn ends or fails. ACP v2 answers it when the prompt is inserted, and
 * reports the rest as session state.
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
   * The turn waits for the user: a permission request or a question is open in
   * the session. Requests do not say which prompt they are for, so this
   * includes one opened before the turn was inserted. Only reported after
   * {@link inserted}.
   */
  awaitingUser(): void;
  /**
   * The turn works again: no request is open any more. A turn that ends or
   * fails while it waits reports that instead.
   */
  resumed(): void;
  /**
   * The turn ended. A queued turn that is cancelled before it is inserted
   * ends too, without {@link inserted}; Claude Code may still run its prompt.
   */
  ended(outcome: TurnOutcome): void;
  /**
   * The turn failed. Without {@link inserted} before, Claude Code was not seen
   * taking the prompt in. `title`, when the agent has one, describes the
   * failure for the user in plain text, such as "API Error: 529 Overloaded".
   */
  failed(error: unknown, title?: string): void;
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
