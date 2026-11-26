/**
 * Remote Control at the start of a query on the v1 core, besides what both
 * cores share (`../remote-control.ts`): holding a session's prompts back while
 * it connects. It answers in a notice, which does not go through the turn
 * queue, so the prompts that follow wait for it: a prompt that started a turn
 * meanwhile would have the notice land in that turn. It occupies the session's
 * `adapterCommand` slot, as the adapter's `/remote-control` does.
 */
import type { RemoteControlAtStartup, RemoteControlAtStartupSession } from "../remote-control.js";
import type { SessionNotice } from "../session-notices.js";

/** What holding prompts back needs of a v1 session. */
export type PromptHoldingSession = {
  /**
   * The adapter command that is running (see `Session.adapterCommand`), or
   * Remote Control starting with the query, from its request to its answer.
   * Prompts wait for `done`, and a command is refused meanwhile: v1 refuses a
   * command rather than hold it, as it does while Claude works.
   */
  adapterCommand?: { done: Promise<void>; abort?: AbortController };
};

/**
 * Runs `change`, Remote Control starting with the query, which answers into
 * the session's output, and holds the session's prompts back until it is done.
 * Nothing awaits before the hold is set, so no prompt can start between the
 * caller's checks and the hold. `readStream` starts the reader of the query
 * stream first: once Remote Control is on, other clients can start turns or
 * send messages on their own, and something has to read the stream for those
 * to reach this client. The hold has no `abort`: a `session/cancel` does not
 * stop `change`, as Remote Control cannot be un-started, so its notice still
 * goes out. `session/close` does not wait for it either, as a pending request
 * would hold the close for the whole teardown timeout.
 */
async function holdingPrompts(
  session: PromptHoldingSession,
  readStream: () => void,
  change: () => Promise<void>,
): Promise<void> {
  readStream();
  const done = change();
  const held = { done };
  session.adapterCommand = held;
  try {
    await done;
  } finally {
    if (session.adapterCommand === held) session.adapterCommand = undefined;
  }
}

/** What starting Remote Control with a query needs of a v1 session and its agent. */
export type StartupConnection = RemoteControlAtStartupSession & {
  /** Starts the reader of the session's query stream, if none runs yet. */
  readStream(): void;
  /** Sends `notice` to the client, as a transcript line to one without notices. */
  notice(notice: SessionNotice): Promise<void>;
};

/**
 * Starts Remote Control with the session's query when Claude Code asked for it
 * (see `RemoteControlAtStartup`), and holds the session's prompts back until
 * its notice is sent. An adapter command (`/remote-control`, `/plugin`) that
 * runs meanwhile makes the session busy too, so this does not start then. One
 * that comes while this runs is refused, as during another command. A query
 * that closed before the answer, as by a restart or a close, gets no notice:
 * it would report on Remote Control that ended with that query.
 */
export async function connectAtStartup(
  session: PromptHoldingSession & { remoteControlAtStartup?: RemoteControlAtStartup },
  connection: StartupConnection,
): Promise<void> {
  const notice = session.remoteControlAtStartup?.connect({
    ...connection,
    working: () => connection.working() || session.adapterCommand !== undefined,
  });
  if (!notice) return;
  try {
    await holdingPrompts(
      session,
      () => connection.readStream(),
      async () => {
        const answer = await notice;
        if (connection.query()) await connection.notice(answer);
      },
    );
  } catch (error) {
    connection.logger.error(
      `Session ${connection.sessionId}: failed to send the Remote Control notice:`,
      error,
    );
  }
}
