/**
 * Remote Control on the v1 core, besides what both cores share
 * (`../remote-control.ts`): holding a session's prompts back while Remote
 * Control changes. The adapter's `/remote-control` answers without a model
 * turn, and Remote Control that starts with a query answers in a notice.
 * Neither answer goes through the turn queue, so the prompts that follow wait
 * for it: a prompt that started a turn meanwhile would have the answer land in
 * that turn.
 */
import type { RemoteControlAtStartup, RemoteControlAtStartupSession } from "../remote-control.js";
import type { SessionNotice } from "../session-notices.js";

/** What holding prompts back needs of a v1 session. */
export type PromptHoldingSession = {
  /**
   * The Remote Control change that is running, from its request to its
   * answer: a `/remote-control` command, or Remote Control starting with the
   * query. Prompts wait for it, and a `/remote-control` is refused meanwhile:
   * v1 refuses a command rather than hold it, as it does while Claude works.
   */
  remoteControlCommand?: Promise<void>;
};

/**
 * Runs `change`, a change of Remote Control that answers into the session's
 * output, and holds the session's prompts back until it is done. Nothing
 * awaits before the hold is set, so no prompt can start between the caller's
 * checks and the hold. `readStream` starts the reader of the query stream
 * first: once Remote Control is on, other clients can start turns or send
 * messages on their own, and something has to read the stream for those to
 * reach this client.
 */
export async function holdingPrompts(
  session: PromptHoldingSession,
  readStream: () => void,
  change: () => Promise<void>,
): Promise<void> {
  readStream();
  const running = change();
  session.remoteControlCommand = running;
  try {
    await running;
  } finally {
    session.remoteControlCommand = undefined;
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
 * its notice is sent. A `/remote-control` command that runs meanwhile makes
 * the session busy too: Remote Control is that command's to decide. One that
 * comes while this runs is refused, as during another command. A query
 * that closed before the answer, as by a restart or a close, gets no notice:
 * it would report on Remote Control that ended with that query.
 */
export async function connectAtStartup(
  session: PromptHoldingSession & { remoteControlAtStartup?: RemoteControlAtStartup },
  connection: StartupConnection,
): Promise<void> {
  const notice = session.remoteControlAtStartup?.connect({
    ...connection,
    working: () => connection.working() || session.remoteControlCommand !== undefined,
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
