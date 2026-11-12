/**
 * Client renames of a session: `session/set_title` (v1 and v2) and AIR's
 * `_session/rename` (v1). Both cores call {@link renameSession}, which stores
 * the title in every transcript of the session (see
 * {@link SessionIndexService.retitle}) and, for a session loaded on the
 * connection, makes it the client title that no generated title replaces.
 */

import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { SessionTitles, TitledSession } from "../session-titles.js";
import { storedTitle } from "./archive-title.js";
import {
  renameTo,
  type RenameSessionRequest,
  type RetitleOptions,
  type SessionIndexService,
  type TitleChange,
} from "./service.js";

/** A session loaded on the connection, and its title state. */
export interface RetitledSession {
  readonly session: TitledSession;
  readonly titles: Pick<
    SessionTitles,
    "setExplicitTitle" | "storedTitle" | "rememberStoredTitle" | "shownTitle"
  >;
}

type RenamingQuery = Query & {
  renameSession?: (title: string, sessionId?: string) => Promise<void>;
};

/**
 * Names a session; no generated title replaces it. An archived session stays
 * archived. `loaded` is the session loaded on this connection, if any;
 * `clientTitle` turns a stored title into the one the client shows (an AIR
 * client's drops the archive prefix). Returns that title, which the loaded
 * session also publishes as a `session_info_update`.
 *
 * A session that is not loaded and has no transcript is unknown (`-32002`).
 */
export async function renameSession(
  index: SessionIndexService,
  request: RenameSessionRequest,
  loaded: RetitledSession | undefined,
  clientTitle: (stored: string) => string = (stored) => stored,
): Promise<string> {
  const { sessionId } = request;
  // As the CLI keeps it, and never with the archive prefix: a rename does
  // not change the archive state.
  const title = storedTitle(request.title, false, sessionId);
  // The title as stored: an archived one is cut with its prefix.
  const shown = (stored: string | undefined) => clientTitle(stored ?? title);
  const stored = await retitleSession(index, sessionId, renameTo(title), shown, loaded, {
    mayBeUnwritten: true,
    sidecar: "always",
  });
  return shown(stored);
}

/**
 * Retitles a session (see {@link SessionIndexService.retitle}) and returns
 * the title stored. A session that runs here is titled through its CLI
 * (`rename_session`). A loaded session's title state takes the change as a
 * client title, so no generated title replaces it; `publish` is the title it
 * then publishes.
 */
export async function retitleSession(
  index: SessionIndexService,
  sessionId: string,
  change: TitleChange,
  publish: Parameters<SessionTitles["setExplicitTitle"]>[0],
  loaded: RetitledSession | undefined,
  options: Pick<RetitleOptions, "mayBeUnwritten" | "sidecar">,
): Promise<string | undefined> {
  let stored: string | undefined;
  // Decided once a title generation in flight has ended: the query may
  // have closed meanwhile.
  const persist = async () => {
    const session = loaded?.session;
    const query = session?.query as RenamingQuery | undefined;
    // A closed session's CLI is gone here: only a running query titles it.
    const running = session !== undefined && !session.queryClosed;
    if (running && typeof query?.renameSession !== "function") {
      // Its CLI holds the title and would write it back over ours.
      throw RequestError.invalidRequest(
        { sessionId },
        "The Claude Code CLI of this session cannot change its title while it runs.",
      );
    }
    const live = running
      ? {
          cwd: session.cwd,
          rename: (title: string) => query!.renameSession!(title, sessionId),
          stored: () => loaded!.titles.storedTitle,
          remember: (title: string) => loaded!.titles.rememberStoredTitle(title),
          shown: loaded!.titles.shownTitle,
        }
      : undefined;
    stored = await index.retitle(sessionId, change, {
      ...options,
      // Without its CLI, a session needs its transcript.
      mayBeUnwritten: live !== undefined && options.mayBeUnwritten,
      live,
    });
    return stored;
  };
  if (loaded) {
    await loaded.titles.setExplicitTitle(publish, persist);
  } else {
    await persist();
  }
  return stored;
}
