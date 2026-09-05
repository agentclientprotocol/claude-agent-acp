type TimingLogger = {
  log: (...args: unknown[]) => void;
};

/** Small phase timer for session lifecycle diagnostics. */
export class SessionTiming {
  private readonly startedAt = performance.now();
  private phaseStartedAt = this.startedAt;

  constructor(
    private readonly logger: TimingLogger | undefined,
    private readonly operation: string,
    private readonly sessionId: string,
  ) {}

  phase(name: string, detail = ""): void {
    const finishedAt = performance.now();
    this.logger?.log(
      `[session/${this.operation}] sessionId=${this.sessionId} phase=${name} durationMs=${Math.round(finishedAt - this.phaseStartedAt)} totalMs=${Math.round(finishedAt - this.startedAt)}${detail}`,
    );
    this.phaseStartedAt = finishedAt;
  }
}
