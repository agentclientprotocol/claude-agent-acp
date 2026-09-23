type TimingLogger = {
  log: (...args: unknown[]) => void;
};

/** Small phase timer for session lifecycle diagnostics. */
export class SessionTiming {
  private readonly startedAt: number;
  private phaseStartedAt: number;

  constructor(
    private readonly logger: TimingLogger | undefined,
    private readonly operation: string,
    private readonly sessionId: string,
    startedAt = performance.now(),
  ) {
    this.startedAt = startedAt;
    this.phaseStartedAt = startedAt;
  }

  phase(name: string, detail = ""): void {
    const finishedAt = performance.now();
    this.logger?.log(
      `[session/${this.operation}] sessionId=${this.sessionId} phase=${name} durationMs=${Math.round(finishedAt - this.phaseStartedAt)} totalMs=${Math.round(finishedAt - this.startedAt)}${detail}`,
    );
    this.phaseStartedAt = finishedAt;
  }
}
