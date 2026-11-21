/**
 * What a `session/resume` with `replayFrom` holds back. Between the request
 * and the session's `replay_complete`, v2 allows only the session's replayed
 * history. Every other update of the session and of its subagent sessions,
 * such as a chunk of a message that streams, a notice or a state, waits and
 * goes out after `replay_complete`, in the order it was sent. So does a
 * permission request or an elicitation.
 *
 * The replay itself runs in one synchronous step ({@link ReplayHolds.replay}),
 * so what a session sends during that step is not held: its replayed history
 * and the `replay_complete` updates that end it. Nothing else tells that from
 * what waits.
 */
export class ReplayHolds {
  /**
   * What each session with a replay in flight holds, in send order, with the
   * count of its replays and the sessions that sent what it holds: itself and
   * its subagent sessions.
   */
  private readonly sessions = new Map<
    string,
    { resumes: number; sends: Array<() => void>; senders: Set<string> }
  >();
  /** Whether {@link replay} runs. */
  private replaying = false;

  /** Whether any session holds its sends. */
  get any(): boolean {
    return this.sessions.size > 0;
  }

  /** Whether the session `sessionId` holds what it sends now: a replay of it is in flight, and is not the sender. */
  holds(sessionId: string): boolean {
    return !this.replaying && this.sessions.has(sessionId);
  }

  /**
   * A resume of `sessionId` that replays came: the session holds its sends
   * from now on. Returns the release, to call once the session's
   * `replay_complete` went out, or the resume failed. It sends what the
   * session held, unless another replay of the session is still in flight.
   * Calling it again does nothing.
   */
  begin(sessionId: string): () => void {
    const hold = this.sessions.get(sessionId) ?? { resumes: 0, sends: [], senders: new Set() };
    hold.resumes++;
    this.sessions.set(sessionId, hold);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--hold.resumes > 0) return;
      this.sessions.delete(sessionId);
      for (const send of hold.sends) send();
    };
  }

  /**
   * Runs `send`, an update or a request of the session `sender`, once the
   * session `sessionId` no longer holds its sends (see {@link holds}).
   */
  defer(sessionId: string, send: () => void, sender: string): void {
    const hold = this.sessions.get(sessionId)!;
    hold.sends.push(send);
    hold.senders.add(sender);
  }

  /** The sessions whose updates or requests the session `sessionId` holds now. */
  senders(sessionId: string): ReadonlySet<string> {
    return this.sessions.get(sessionId)?.senders ?? new Set();
  }

  /** Runs `replay`, which must send the history and its `replay_complete` before it returns. */
  replay(replay: () => void): void {
    this.replaying = true;
    try {
      replay();
    } finally {
      this.replaying = false;
    }
  }
}
