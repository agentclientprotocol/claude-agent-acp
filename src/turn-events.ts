/**
 * A prompt turn as the adapter understands it, independent of the ACP version.
 *
 * The agent reports each turn through {@link TurnEvents}, and each ACP version
 * maps the events to its own messages. ACP v1 answers `session/prompt` when the
 * turn ends or fails. ACP v2 answers it when the prompt is inserted, and
 * reports the rest as session state.
 */
export interface TurnEvents {
  /**
   * The prompt is now the user message `messageId` of the conversation, and
   * the agent works on it. Reported at most once per turn, and never after
   * {@link ended} or {@link failed}.
   */
  inserted(messageId: string): void;
  /** The turn waits for the user to answer a permission request or a question. */
  awaitingUser(): void;
  /** The turn works again: the user answered every open request. */
  resumed(): void;
  /**
   * The turn ended. A queued turn that is cancelled before it is inserted
   * ends too, without {@link inserted}.
   */
  ended(outcome: TurnOutcome): void;
  /**
   * The turn failed. Without {@link inserted} before, the prompt never
   * reached the conversation.
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
