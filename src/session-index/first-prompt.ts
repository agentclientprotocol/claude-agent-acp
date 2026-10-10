/**
 * The first prompt of a transcript, extracted the way the SDK does for a
 * session title (its `rf`, `ti` and `jP` in `@anthropic-ai/claude-agent-sdk`).
 * Used when the SDK `getSessionInfo` read another copy of the session.
 *
 * - Only main-chain user records count: no tool result, meta or compact
 *   summary record.
 * - Each text (the string content, or every text block) is expanded from its
 *   `<pasted_content>` blocks and flattened to one line.
 * - A slash command (`<command-name>/init</command-name>`) is only a fallback
 *   while a real prompt may follow; `<bash-input>x</bash-input>` is `! x`;
 *   a text that starts with another tag or with an interrupt marker is
 *   skipped.
 * - A prompt longer than 200 characters is cut and gets an ellipsis.
 * - Without any text, an image or a document prompt is `Image` or `Document`.
 */

const MAX_PROMPT_LENGTH = 200;
const COMMAND_NAME = /<command-name>(.*?)<\/command-name>/;
const BASH_INPUT = /<bash-input>([\s\S]*?)<\/bash-input>/;
const SKIPPED_TEXT = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/;
const PASTED_OPEN = '<pasted_content id="';

type Entry = Record<string, unknown>;

function isPastedId(value: string): boolean {
  return /^[0-9a-f]{4}$/.test(value);
}

/** `text` with each `<pasted_content id="xxxx">` block replaced by its body. */
function expandPastedContent(text: string): string {
  const parts: string[] = [];
  let done = 0;
  let from = 0;
  let expanded = false;
  for (;;) {
    const open = text.indexOf(PASTED_OPEN, from);
    if (open === -1) break;
    const idStart = open + PASTED_OPEN.length;
    const id = text.slice(idStart, idStart + 4);
    if (!isPastedId(id) || !text.startsWith('">\n', idStart + 4)) {
      from = idStart;
      continue;
    }
    const bodyStart = idStart + 4 + 3;
    const close = `</pasted_content id="${id}">`;
    const closeAt = text.indexOf(`\n${close}`, bodyStart - 1) + 1;
    if (closeAt === 0) break;
    let start = open;
    for (let i = 0; i < 2 && start > done && text[start - 1] === "\n"; i++) start--;
    if (start > done) parts.push(text.slice(done, start));
    done = closeAt + close.length;
    for (let i = 0; i < 2 && text[done] === "\n"; i++) done++;
    parts.push(text.slice(bodyStart, closeAt - 1));
    expanded = true;
    from = done;
  }
  if (!expanded) return text;
  if (done < text.length) parts.push(text.slice(done));
  return parts.join("");
}

/** At most `length` UTF-16 units, without a split surrogate pair. */
function cut(text: string, length: number): string {
  if (text.length <= length) return text;
  const head = text.slice(0, length);
  const last = head.charCodeAt(length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

/**
 * The prompt of one user record, or undefined when it has none. A slash
 * command is recorded in `state.commandFallback` instead.
 */
export function promptOf(entry: Entry, state: { commandFallback: string }): string | undefined {
  if (entry.type !== "user") return undefined;
  if (entry.isMeta === true || entry.isCompactSummary === true) return undefined;
  const message = entry.message as { content?: unknown } | undefined;
  if (!message) return undefined;
  const content = message.content;
  const texts: string[] = [];
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const { type, text } = block as { type?: unknown; text?: unknown };
      if (type === "tool_result") return undefined;
      if (type === "text" && typeof text === "string") texts.push(text);
    }
  }
  for (const raw of texts) {
    let text = expandPastedContent(raw).replaceAll("\n", " ").trim();
    if (!text) continue;
    const command = COMMAND_NAME.exec(text);
    if (command) {
      if (!state.commandFallback) state.commandFallback = command[1]!;
      continue;
    }
    const bash = BASH_INPUT.exec(text);
    if (bash) return `! ${bash[1]!.trim()}`;
    if (SKIPPED_TEXT.test(text)) continue;
    if (text.length > MAX_PROMPT_LENGTH) text = `${cut(text, MAX_PROMPT_LENGTH).trim()}…`;
    return text;
  }
  return undefined;
}

/**
 * Whether a user record is a prompt the user sent: one with prompt text
 * ({@link promptOf}), or one with an image or a document, which the SDK
 * titles `Image` or `Document` when it has no prompt text. A tool result, a meta or compact summary
 * record, an interrupt and a slash command are none.
 */
export function isUserPrompt(entry: Entry): boolean {
  if (promptOf(entry, { commandFallback: "" }) !== undefined) return true;
  if (entry.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true) {
    return false;
  }
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return false;
  let media = false;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const { type } = block as { type?: unknown };
    if (type === "tool_result") return false;
    if (type === "image" || type === "document") media = true;
  }
  return media;
}

function isUserLine(line: string): boolean {
  return line.includes('"type":"user"') || line.includes('"type": "user"');
}

/** The first prompt of the head, else the first slash command, else "". */
export function firstPrompt(head: string): string {
  const state = { commandFallback: "" };
  for (const line of head.split("\n")) {
    if (!isUserLine(line)) continue;
    if (line.includes('"tool_result"')) continue;
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true')) continue;
    if (line.includes('"isCompactSummary":true') || line.includes('"isCompactSummary": true')) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const prompt = promptOf(entry as Entry, state);
    if (prompt !== undefined) return prompt;
  }
  return state.commandFallback;
}

/** `Image` or `Document` for a first user record that holds one, else "". */
export function mediaPrompt(head: string): string {
  for (const line of head.split("\n")) {
    if (!isUserLine(line)) continue;
    if (line.includes('"tool_result"')) continue;
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true')) continue;
    if (line.includes('"type":"image"') || line.includes('"type": "image"')) return "Image";
    if (line.includes('"type":"document"') || line.includes('"type": "document"')) {
      return "Document";
    }
  }
  return "";
}
