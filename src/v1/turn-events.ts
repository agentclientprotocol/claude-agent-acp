/**
 * A prompt turn of `ClaudeAcpAgent`. The agent reports how each prompt is
 * answered through {@link TurnEvents}: its `session/prompt` answers when the
 * turn ends or fails.
 *
 * The agent calls these synchronously while it updates its own state, so a
 * handler must not throw, nor call back into the agent before it returns.
 */
export interface TurnEvents {
  /**
   * Claude Code took the prompt in as the user message `messageId` of the
   * conversation, and the turn is the session's foreground work from then on.
   * Reported at most once per turn, and never after {@link ended} or
   * {@link failed}.
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
