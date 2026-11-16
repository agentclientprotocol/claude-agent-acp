/**
 * What a `session/resume` with `replayFrom` holds back. Between the request
 * and the session's `replay_complete`, v2 allows only the session's replayed
 * history. Every other update of the session and of its subagent sessions,
 * such as a chunk of a message that streams, a notice or a state, waits and
 * goes out after `replay_complete`, in the order it was sent. So does a
 * permission request or an elicitation.
 *
 * The replay itself runs in one synchronous step ({@link ReplayHolds.replay}),
 * so what a session sends during that step is its replayed history. Nothing
 * else tells the two apart.
 */
export class ReplayHolds {
  /** What each session with a replay in flight holds, in send order, with the count of its replays. */
  private readonly sessions = new Map<string, { resumes: number; sends: Array<() => void> }>();
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
    const hold = this.sessions.get(sessionId) ?? { resumes: 0, sends: [] };
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

  /** Runs `send` once the session `sessionId` no longer holds its sends (see {@link holds}). */
  defer(sessionId: string, send: () => void): void {
    this.sessions.get(sessionId)!.sends.push(send);
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
