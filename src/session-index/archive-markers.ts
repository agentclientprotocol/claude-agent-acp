/**
 * Archive marker files, `<config>/acp/archived/<sessionId>`: an empty file
 * per session. The archive itself lives in the transcript title (see
 * archive-title.ts); markers are read for compatibility and never written. A
 * session with one is listed as archived, and unarchive, archive and delete
 * remove it, so it turns into the title format.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { claudeConfigDir } from "../paths.js";
import { errorCode, isSessionId } from "./project-dirs.js";

/** `<config>/acp/archived`. */
export function archiveMarkerDir(): string {
  return path.join(claudeConfigDir(), "acp", "archived");
}

function markerPath(sessionId: string): string {
  // The id becomes a file name: only a UUID may, so no id can leave the dir.
  if (!isSessionId(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
  return path.join(archiveMarkerDir(), sessionId.toLowerCase());
}

/** Removes the archive marker of `sessionId`. Returns whether it existed. */
export async function removeArchiveMarker(sessionId: string): Promise<boolean> {
  try {
    await fs.unlink(markerPath(sessionId));
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** The ids of all archived sessions, lower case. Empty when none was ever archived. */
export async function readArchivedSessionIds(): Promise<Set<string>> {
  try {
    const names = await fs.readdir(archiveMarkerDir());
    return new Set(names.filter((name) => isSessionId(name)).map((name) => name.toLowerCase()));
  } catch {
    return new Set();
  }
}
