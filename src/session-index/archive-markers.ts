/**
 * The adapter's own session archive: one empty marker file per archived
 * session in `<config>/acp/archived/<sessionId>`.
 *
 * A marker is created with `O_EXCL` and removed with `unlink`, so archive and
 * unarchive are idempotent and never touch the transcript (its mtime, and so
 * the order of the list, stays as it was). The list reads the directory once
 * into a set.
 *
 * The CLI has no archive of its own. The adapter never writes the
 * `.desktop-released.json` of Claude Desktop: the CLI cleanup deletes a
 * transcript that has one.
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

/** Marks `sessionId` archived. Returns false when it already was. */
export async function writeArchiveMarker(sessionId: string): Promise<boolean> {
  const file = markerPath(sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const handle = await fs.open(file, "wx", 0o600);
    await handle.close();
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
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

/** Whether `sessionId` has an archive marker. */
export async function hasArchiveMarker(sessionId: string): Promise<boolean> {
  try {
    await fs.access(markerPath(sessionId));
    return true;
  } catch {
    return false;
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
