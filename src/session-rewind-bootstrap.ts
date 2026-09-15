import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export const RESUME_DROPS_TURN_REJECTION_PREFIX = "Resume rejected by --resume-drops-turn:";

export type RewindBootstrapObservation = "pending" | "acknowledged" | "rejected";

export class SessionRewindBootstrapCoordinator<TSession, TQuery> {
  constructor(
    private readonly dependencies: {
      currentSession(sessionId: string): TSession | undefined;
      queryOf(session: TSession): TQuery;
      discard(sessionId: string, session: TSession): void;
    },
  ) {}

  create(sessionId: string, query: TQuery): SessionRewindBootstrap {
    return new SessionRewindBootstrap(() => {
      const session = this.dependencies.currentSession(sessionId);
      if (!session || this.dependencies.queryOf(session) !== query) return;
      this.dependencies.discard(sessionId, session);
    });
  }
}

/** Tracks the startup handshake for a guarded truncating resume. */
export class SessionRewindBootstrap {
  private readonly completion: Promise<void>;
  private resolveCompletion!: () => void;
  private rejectCompletion!: (error: unknown) => void;
  private settled = false;

  constructor(private readonly cleanupFailedSession: () => void) {
    this.completion = new Promise<void>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
  }

  wait(): Promise<void> {
    return this.completion;
  }

  observe(message: SDKMessage): RewindBootstrapObservation {
    if (this.settled) return "pending";
    if (
      message.type === "result" &&
      message.subtype === "error_during_execution" &&
      message.errors.some((error) => error.startsWith(RESUME_DROPS_TURN_REJECTION_PREFIX))
    ) {
      const reason =
        message.errors.find((error) => error.startsWith(RESUME_DROPS_TURN_REJECTION_PREFIX)) ??
        RESUME_DROPS_TURN_REJECTION_PREFIX;
      this.fail(new Error(reason));
      return "rejected";
    }
    if (message.type === "system" && message.subtype === "init") {
      this.settled = true;
      this.resolveCompletion();
      return "acknowledged";
    }
    return "pending";
  }

  rejectStreamEnd(): void {
    this.fail(new Error("Claude query ended before truncating resume was acknowledged"));
  }

  rejectTransport(error: unknown): void {
    this.fail(error);
  }

  private fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    try {
      this.cleanupFailedSession();
    } catch (cleanupError) {
      this.rejectCompletion(
        new AggregateError([error, cleanupError], "Failed to clean up rejected rewind bootstrap", {
          cause: cleanupError,
        }),
      );
      return;
    }
    this.rejectCompletion(error);
  }
}
