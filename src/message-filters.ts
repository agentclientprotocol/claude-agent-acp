/**
 * The Claude Code messages and content that a client never sees as the user's
 * or the agent's text: local slash command markers, context the CLI injects,
 * the synthetic `/login` message and meta messages from other agents. The live
 * stream and the `session/load` replay both filter with these.
 */
import { isLoginRequiredText } from "./result-end.js";
import { isSyntheticUsageLimitMessage } from "./session-failure-extension.js";
import { markerTagText, TASK_NOTIFICATION_TAG } from "./task-notifications.js";

// Slash commands that the SDK handles locally without replaying the user
// message and without invoking the model.
export const LOCAL_ONLY_COMMANDS = new Set(["/context", "/heapdump", "/extra-usage"]);

// Commands whose marker-only transcript records are ACP/client-local UI noise,
// not model-visible user prompts. Marker-only custom slash skills are not in
// this list, so replay can reconstruct them from `<command-name>`/`<command-args>`.
const REPLAY_HIDDEN_COMMANDS = new Set([
  ...LOCAL_ONLY_COMMANDS,
  "/compact",
  "/model",
  "/mcp",
  "/status",
  "/usage",
]);

// The Claude SDK persists local slash command invocations (e.g. `/model`) and
// their output as user messages in the session transcript, wrapping the
// payload in these XML-like markers that the CLI uses for its own display.
// The live prompt loop drops them; replay must strip them too or they leak
// into the UI on session/load.
const LOCAL_COMMAND_MARKERS = [
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
].map((tag) => ({ open: `<${tag}>`, close: `</${tag}>` }));

// Context the CLI injects into a user turn to steer the model, appended to
// whatever the user typed. Nobody wrote it and no client sees it live — the
// prompt loop's user-message skip covers the whole message — but it is
// persisted alongside that prose, so replay would hand the client a prompt
// with instructions in it the user never gave. A `task-notification` tells the
// model that a background task stopped; live, the SDK `task_notification`
// frame reports the same stop, so replay restores the task state from it (see
// taskNotificationsOf) instead of showing it.
const INJECTED_CONTEXT_MARKERS = ["system-reminder", TASK_NOTIFICATION_TAG].map((tag) => ({
  open: `<${tag}>`,
  close: `</${tag}>`,
}));

// Everything a replayed user message may be wrapped in that is not speech.
const TRANSCRIPT_MARKERS = [...LOCAL_COMMAND_MARKERS, ...INJECTED_CONTEXT_MARKERS];

// Single-pass scanner that removes each `<tag>…</tag>` marker (matching the
// nearest closing tag of the same name, like a lazy regex would).
function stripMarkerTags(text: string): string {
  const dead = new Set<string>();
  let result = "";
  let copiedUpTo = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "<") {
      const marker = TRANSCRIPT_MARKERS.find(
        (m) => !dead.has(m.open) && text.startsWith(m.open, i),
      );
      if (marker) {
        const end = text.indexOf(marker.close, i + marker.open.length);
        if (end !== -1) {
          result += text.slice(copiedUpTo, i);
          i = copiedUpTo = end + marker.close.length;
          continue;
        }
        // No closing marker remains anywhere ahead, and `indexOf` only ever
        // searches forward from here on, so stop treating this tag as an
        // opener — that avoids rescanning the tail for it on every match.
        dead.add(marker.open);
      }
    }
    i++;
  }
  return result + text.slice(copiedUpTo);
}

function hasMarkerTag(text: string, tag: string): boolean {
  return markerTagText(text, tag) !== undefined;
}

function commandInvocationFromMarkerOnlyText(text: string): string | null {
  if (hasMarkerTag(text, "local-command-stdout") || hasMarkerTag(text, "local-command-stderr")) {
    return null;
  }
  const commandName = markerTagText(text, "command-name")?.trim();
  if (!commandName?.startsWith("/")) return null;
  if (REPLAY_HIDDEN_COMMANDS.has(commandName.split(" ", 1)[0])) return null;

  const commandArgs = markerTagText(text, "command-args")?.trim();
  return commandArgs ? `${commandName} ${commandArgs}` : commandName;
}

function stripLocalCommandMetadataText(text: string): string | null {
  const stripped = stripMarkerTags(text);
  if (stripped.trim() !== "") return stripped;
  return commandInvocationFromMarkerOnlyText(text);
}

/**
 * Return user-message content with local-command and injected-context marker
 * tags removed, or `null` if nothing meaningful remains (caller should skip
 * the message). Preserves real prose that's mixed in alongside the markers —
 * e.g. a message like `<command-name>…</command-name>hi` becomes `hi`, and
 * `hi<system-reminder>…</system-reminder>` becomes `hi`.
 */
export function stripLocalCommandMetadata(content: unknown): unknown | null {
  if (typeof content === "string") {
    return stripLocalCommandMetadataText(content);
  }
  if (!Array.isArray(content)) return content;

  const kept: unknown[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type: unknown }).type === "text" &&
      "text" in block &&
      typeof (block as { text: unknown }).text === "string"
    ) {
      const stripped = stripLocalCommandMetadataText((block as { text: string }).text);
      if (stripped === null) continue;
      kept.push({ ...(block as object), text: stripped });
    } else {
      kept.push(block);
    }
  }
  if (kept.length === 0) return null;
  return kept;
}

/**
 * True for the synthetic assistant message the CLI injects into the transcript
 * when a turn fails authentication (e.g. "Not logged in · Please run /login",
 * "Session expired. Please run /login to sign in again."). The `/login`
 * instruction is Claude Code TUI-specific and meaningless to ACP clients
 * (issue #863). The live prompt loop suppresses the text and fails the turn
 * with `authRequired` so the client can run its own auth flow; replay must
 * skip it too — both for parity with what the client saw live and because the
 * message stays in the transcript forever, so it would resurface on every
 * session/load even after the user has logged back in.
 *
 * Takes the API message (`message.message`), which replay only knows as
 * `unknown`. The persisted record's structured `error` marker is stripped by
 * `getSessionMessages`, and the CLI does not always set it to
 * `authentication_failed` anyway: an expired login with no refresh token
 * ("Login expired · Run /login to sign in again, …") arrives as
 * `invalid_request`. So the synthetic model + text is what both paths match on.
 * Usage-limit banners are excluded because some of them also mention `/login`
 * (to switch accounts) and have their own handling.
 */
export function isSyntheticLoginMessage(apiMessage: unknown): boolean {
  if (!apiMessage || typeof apiMessage !== "object") {
    return false;
  }
  const { model, content } = apiMessage as { model?: unknown; content?: unknown };
  if (model !== "<synthetic>" || !Array.isArray(content) || content.length !== 1) {
    return false;
  }
  const block = content[0] as { type?: unknown; text?: unknown } | null;
  return (
    !!block &&
    block.type === "text" &&
    typeof block.text === "string" &&
    isLoginRequiredText(block.text) &&
    !isSyntheticUsageLimitMessage(apiMessage)
  );
}

/** Origin kinds of the meta user messages `getSessionMessages` returns since
 *  SDK 0.3.284 (messages from other agents, sessions and channels). */
const REPLAY_HIDDEN_META_ORIGIN_KINDS = new Set([
  "peer",
  "channel",
  "observer",
  "observer-activity",
  "slack-ping",
]);

/**
 * True for a transcript message delivered to the model from another agent,
 * session or channel. Since SDK 0.3.284 `getSessionMessages` returns these as
 * `is_meta` user messages whose content is the full harness framing (envelope
 * XML plus the "not typed by your user" preamble). The live prompt loop never
 * renders them, so replay skips them too rather than presenting them as text
 * the user typed. Other `is_meta` messages (compact summaries) are kept.
 *
 * `is_meta` and `origin` are runtime fields not declared on `SessionMessage`.
 */
export function isReplayHiddenMetaMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const { type, is_meta, origin } = message as {
    type?: unknown;
    is_meta?: unknown;
    origin?: { kind?: unknown } | null;
  };
  return (
    type === "user" &&
    is_meta === true &&
    typeof origin?.kind === "string" &&
    REPLAY_HIDDEN_META_ORIGIN_KINDS.has(origin.kind)
  );
}
