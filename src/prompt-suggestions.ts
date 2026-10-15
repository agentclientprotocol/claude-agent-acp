/**
 * The follow-up prompt the SDK predicts for the next turn.
 *
 * With `promptSuggestions` on, the CLI emits one `prompt_suggestion` message
 * after a turn's `result` holding the prompt it expects the user to send next.
 * ACP has no field for it, so it travels as
 * `session_info_update._meta.promptSuggestions`: a client that does not read
 * the key sees a session info update that says nothing and ignores it.
 *
 * AIR renders the first non-blank `suggestions[].text` as gray text in an empty
 * composer, where Tab fills the composer without sending.
 *
 * The CLI sends no suggestion on the first turn of a session, after an API
 * error, in plan mode, and at the account's usage limit, so most sessions have
 * turns that end with no prediction at all.
 */

/** The `_meta` key the suggestion travels under. It names no vendor. */
export const PROMPT_SUGGESTIONS_META_KEY = "promptSuggestions";

/** One predicted prompt, as the `_meta` value carries it. */
export type PromptSuggestionsMetaValue = {
  suggestions: { text: string }[];
};

/**
 * The suggestion as it goes on the wire, or `null` for a suggestion that says
 * nothing: the CLI can predict whitespace, and an empty text would otherwise
 * reach the composer as a hint with no content.
 */
export function promptSuggestionText(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  return text ? text : null;
}

/**
 * The `_meta` of the session info update that publishes `text`. `null` sends an
 * empty `suggestions` list, which clears the prompt the client holds — the turn
 * predicted nothing, so the composer must not keep the previous prediction.
 */
export function promptSuggestionsMeta(text: string | null): Record<string, unknown> {
  const value: PromptSuggestionsMetaValue = { suggestions: text === null ? [] : [{ text }] };
  return { [PROMPT_SUGGESTIONS_META_KEY]: value };
}
