/**
 * `session/status` (the unstable "Session status" RFD) of a session that the
 * connection does not hold: `saved` or unknown. Each core answers `open`
 * itself for the sessions it holds.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { isSessionId, projectsRoot } from "./paths.js";

/** What a core advertises as `status` in its session capabilities. */
export const SESSION_STATUS_CAPABILITY = {};

/**
 * `saved` when a project directory holds a transcript file of `sessionId`
 * that is not empty. Its content is not read, so a transcript without a
 * conversation is `saved` too, and its resume fails with `-32002`. Fails with
 * `-32002` and `data.sessionId` otherwise:
 *
 * - an id that is not a UUID, such as a subagent's session id;
 * - an id without a transcript: one never used, a session never prompted
 *   (Claude Code writes the transcript at the first prompt), and a session
 *   whose transcripts were removed.
 *
 * The request names no `cwd`, so a transcript of any project counts: a
 * resume with another `cwd` can still fail with `-32002`.
 *
 * It lists the project directories and stats the one file name in each. No
 * query starts and no session is loaded. A directory or file that cannot be
 * read for another reason than being absent fails the request: it does not
 * make the session unknown.
 */
export async function savedSessionStatus(sessionId: string): Promise<{ status: "saved" }> {
  if (!isSessionId(sessionId) || !(await hasTranscript(sessionId))) {
    throw RequestError.sessionNotFound(sessionId);
  }
  return { status: "saved" };
}

async function hasTranscript(sessionId: string): Promise<boolean> {
  const root = projectsRoot();
  let projects: string[];
  try {
    projects = await fs.readdir(root);
  } catch (error) {
    // No session was ever stored.
    if (isAbsent(error)) return false;
    throw error;
  }
  const found = await Promise.all(
    projects.map((project) =>
      fs.stat(path.join(root, project, `${sessionId}.jsonl`)).then(
        (stats) => stats.isFile() && stats.size > 0,
        (error: unknown) => {
          // No such transcript, or `project` is a file.
          if (isAbsent(error)) return false;
          throw error;
        },
      ),
    ),
  );
  return found.includes(true);
}

function isAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
