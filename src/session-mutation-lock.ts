export type ReleaseSessionMutation = () => void;

/**
 * A keyed shared/exclusive lock for session lifecycle changes.
 *
 * Prompt preparation takes a shared reservation until its turn is queued.
 * Rewind, close, delete, load, resume, dispose, and provider recreation take
 * the exclusive side so they cannot replace a query while a prompt is being
 * accepted or another lifecycle operation is in flight.
 */
export class SessionMutationLock {
  private readonly exclusiveTails = new Map<string, Promise<void>>();
  private readonly promptReservations = new Map<string, number>();
  private readonly promptWaiters = new Map<string, Array<() => void>>();

  async runExclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const mutation = this.acquireExclusive(sessionId);
    const release = typeof mutation === "function" ? mutation : await mutation;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  acquireExclusive(sessionId: string): ReleaseSessionMutation | Promise<ReleaseSessionMutation> {
    const previous = this.exclusiveTails.get(sessionId);
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    this.exclusiveTails.set(sessionId, current);

    const release = this.once(() => {
      releaseCurrent();
      if (this.exclusiveTails.get(sessionId) === current) {
        this.exclusiveTails.delete(sessionId);
      }
    });
    const waitForPrompts = (): ReleaseSessionMutation | Promise<ReleaseSessionMutation> => {
      if (!this.promptReservations.get(sessionId)) return release;
      return new Promise<ReleaseSessionMutation>((resolve) => {
        const waiters = this.promptWaiters.get(sessionId) ?? [];
        waiters.push(() => resolve(release));
        this.promptWaiters.set(sessionId, waiters);
      });
    };
    return previous ? previous.then(waitForPrompts) : waitForPrompts();
  }

  reservePrompt(sessionId: string): ReleaseSessionMutation | Promise<ReleaseSessionMutation> {
    const pendingExclusive = this.exclusiveTails.get(sessionId);
    if (pendingExclusive) {
      return pendingExclusive.then(() => this.reservePrompt(sessionId));
    }
    this.promptReservations.set(sessionId, (this.promptReservations.get(sessionId) ?? 0) + 1);
    return this.once(() => {
      const remaining = (this.promptReservations.get(sessionId) ?? 1) - 1;
      if (remaining > 0) {
        this.promptReservations.set(sessionId, remaining);
        return;
      }
      this.promptReservations.delete(sessionId);
      const waiters = this.promptWaiters.get(sessionId) ?? [];
      this.promptWaiters.delete(sessionId);
      for (const waiter of waiters) waiter();
    });
  }

  private once(release: () => void): ReleaseSessionMutation {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }
}
