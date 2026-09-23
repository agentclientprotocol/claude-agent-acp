import type { ClientCapabilities, SessionNotification } from "@agentclientprotocol/sdk";

/** Fire-and-forget advisory text for the user: live events rather than
 *  conversation history. See the ACP Session Notices RFD
 *  (https://agentclientprotocol.com/rfds/session-notices). */
export type SessionNotice = {
  severity: "info" | "warning" | "error";
  /** Plain text that stands alone. */
  title: string;
  /** Plain-text detail or guidance. */
  description?: string;
};

/** Longest free-form line that may serve as a notice title on its own. Past
 *  this the text moves to `description` under a generic title. */
export const MAX_NOTICE_TITLE_LENGTH = 256;

/** Whether the Client advertised `clientCapabilities.session.notices`. Agents
 *  MUST NOT send `notice` updates otherwise; the alternative is a bold-label
 *  transcript line, which was the only way to flag these before. */
export function clientSupportsNotices(capabilities?: ClientCapabilities | null): boolean {
  const notices = capabilities?.session?.notices;
  return typeof notices === "object" && notices !== null && !Array.isArray(notices);
}

export function noticeUpdate(notice: SessionNotice): SessionNotification["update"] {
  return {
    sessionUpdate: "notice",
    severity: notice.severity,
    title: notice.title,
    ...(notice.description ? { description: notice.description } : {}),
  };
}

/** The transcript rendering of a notice for clients without the capability. */
export function noticeTranscriptText(notice: SessionNotice): string {
  return notice.description ? `**${notice.title}:** ${notice.description}` : `**${notice.title}**`;
}

/** The update to send for `notice`: a `notice` when the client can present
 *  one, else an agent message carrying `transcriptText` (by default the
 *  bold-label rendering of the notice) and `transcriptMeta`, so clients
 *  without the capability can still tell the line apart from Claude's reply. */
export function noticeOrTranscriptUpdate(
  notice: SessionNotice,
  supportsNotices: boolean,
  transcriptText: string = noticeTranscriptText(notice),
  transcriptMeta?: Record<string, unknown>,
): SessionNotification["update"] {
  if (supportsNotices) return noticeUpdate(notice);
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: transcriptText },
    ...(transcriptMeta ? { _meta: transcriptMeta } : {}),
  };
}

/** Fragments that read on after a bold label stand alone as a notice
 *  description, so start them with a capital. */
export function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Collapses whitespace so a text shown as a notice can be recognized when
 *  the SDK repeats it elsewhere (a hook-blocked turn's result, for one). */
export function normalizeNoticeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** Notice fields are plain text. Free-form SDK/hook output may carry light
 *  markdown that a transcript would render; drop the inline markers rather
 *  than show literal asterisks and backticks in a toast. */
export function noticePlainText(text: string): string {
  return text
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(?<![\w`])`([^`\n]+)`(?![\w`])/g, "$1");
}

/** Shapes free-form text into a notice title plus optional description: the
 *  first line stands as the title when it is short enough, otherwise the whole
 *  text becomes the description under `fallbackTitle`. */
export function splitNoticeText(
  text: string,
  fallbackTitle: string,
): Pick<SessionNotice, "title" | "description"> {
  const trimmed = noticePlainText(text).trim();
  if (!trimmed) return { title: fallbackTitle };
  const lineBreak = trimmed.search(/\r?\n/);
  const firstLine = lineBreak === -1 ? trimmed : trimmed.slice(0, lineBreak).trimEnd();
  const rest = lineBreak === -1 ? "" : trimmed.slice(lineBreak).trim();
  if (firstLine.length > MAX_NOTICE_TITLE_LENGTH) {
    return { title: fallbackTitle, description: trimmed };
  }
  return rest ? { title: firstLine, description: rest } : { title: firstLine };
}
