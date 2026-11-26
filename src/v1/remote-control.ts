/**
 * Remote Control at the start of a query on the v1 core, besides what both
 * cores share (`../remote-control.ts`). It answers in a notice, which does not
 * go through the turn queue, so it holds the session's prompts back in the
 * `AdapterCommands` slot, as the adapter's `/remote-control` does.
 */
import type { RemoteControlAtStartup, RemoteControlAtStartupSession } from "../remote-control.js";
import type { SessionNotice } from "../session-notices.js";
import type { AdapterCommands } from "./adapter-commands.js";

/** What starting Remote Control with a query needs of a v1 session and its agent. */
export type StartupConnection = RemoteControlAtStartupSession & {
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
  session: { remoteControlAtStartup?: RemoteControlAtStartup },
  commands: AdapterCommands,
  connection: StartupConnection,
): Promise<void> {
  const notice = session.remoteControlAtStartup?.connect({
    ...connection,
    working: () => connection.working() || commands.busy,
  });
  if (!notice) return;
  try {
    await commands.hold(async () => {
      const answer = await notice;
      if (connection.query()) await connection.notice(answer);
    });
  } catch (error) {
    connection.logger.error(
      `Session ${connection.sessionId}: failed to send the Remote Control notice:`,
      error,
    );
  }
}
