/**
 * The session archive, in the on-disk format of JetBrains AIR's own Claude
 * integration: a session is archived when its title carries the
 * `[archived] ` prefix, and archive, unarchive and rename append the title as
 * a pair of records to the transcript:
 *
 * ```
 * {"type":"custom-title","customTitle":"[archived] Title","sessionId":"…"}
 * {"type":"agent-name","agentName":"[archived] Title","sessionId":"…"}
 * ```
 *
 * The effective title of a transcript is the last `agentName`, else the last
 * custom title, else the generated or prompt title. Archive writes the prefix
 * and the current title without it; unarchive writes the title without the
 * prefix. Both are cut to the CLI's 200-character title limit. The records
 * are metadata: they move neither `updatedAt` nor the list order. The
 * `claude --resume` picker shows the prefix.
 */

/** The title prefix of an archived session. */
export const ARCHIVED_TITLE_PREFIX = "[archived] ";

/** What the CLI keeps of a stored title: `title.slice(0, 200).trim()`. */
const CLI_TITLE_LIMIT = 200;

/** A title once normalized starts with the prefix: leading space, the
 *  marker, a run of white space, then a title character. */
const ARCHIVED_PATTERN = /^\s*\[archived\]\s+(?=\S)/;

/** How much of a long title the normalization reads: the stored title is
 *  cut to {@link CLI_TITLE_LIMIT} characters after it. */
const TITLE_SCAN_LENGTH = 4096;

/** Whitespace collapsed to single spaces and trimmed, as AIR stores a title. */
export function normalizeStoredTitle(title: string): string {
  const text = title.length > TITLE_SCAN_LENGTH ? title.slice(0, TITLE_SCAN_LENGTH) : title;
  return text.replace(/\s+/g, " ").trim();
}

/** Cut to what the CLI keeps of a title. */
function capTitle(title: string): string {
  return title.length <= CLI_TITLE_LIMIT ? title : title.slice(0, CLI_TITLE_LIMIT).trim();
}

/** Whether an effective title marks its session archived. */
export function isArchivedTitle(title: string | undefined): boolean {
  return title !== undefined && ARCHIVED_PATTERN.test(title);
}

/** The title shown for an effective title: without the archive prefix. */
export function visibleTitle(title: string): string {
  return title.replace(ARCHIVED_PATTERN, "");
}

/** The title of a session that has none at all, as AIR names it. */
export function defaultSessionTitle(sessionId: string): string {
  return `Session ${sessionId.slice(0, 8)}`;
}

/** The title that `title` is stored as in the given archive state: the
 *  visible title, with the prefix when archived, normalized and cut to the
 *  CLI limit. */
export function storedTitle(title: string, archived: boolean, sessionId: string): string {
  const visible = normalizeStoredTitle(visibleTitle(title)) || defaultSessionTitle(sessionId);
  return capTitle(archived ? ARCHIVED_TITLE_PREFIX + visible : visible);
}

/** The `custom-title` and `agent-name` records of `title`, one per line. */
export function titleRecords(sessionId: string, title: string): string {
  return (
    JSON.stringify({ type: "custom-title", customTitle: title, sessionId }) +
    "\n" +
    JSON.stringify({ type: "agent-name", agentName: title, sessionId }) +
    "\n"
  );
}
