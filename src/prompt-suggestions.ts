/**
 * The follow-up prompt the SDK predicts for the next turn.
 *
 * With `promptSuggestions` on, the CLI emits one `prompt_suggestion` message
 * after a turn's `result` holding the prompt it expects the user to send next.
 * The adapter turns it on only for a client that takes the prediction
 * ({@link promptSuggestionOptions}).
 * It reaches the client in up to two forms:
 *
 * - `prompt_suggestions_update`, ACP's unstable session update, for a client
 *   that advertised `session.promptSuggestions`, on v1 and v2. The CLI
 *   predicts one prompt, so the list holds one suggestion, whose prompt is
 *   one text block.
 * - `session_info_update._meta.promptSuggestions`, for JetBrains AIR, which
 *   read the prediction there before ACP had an update for it. A client that
 *   does not read the key sees a session info update that says nothing.
 *
 * AIR renders the first non-blank `suggestions[].text` as gray text in an empty
 * composer, where Tab fills the composer without sending.
 *
 * The CLI sends no suggestion on the first turn of a session, after an API
 * error, in plan mode, and at the account's usage limit, so most sessions have
 * turns that end with no prediction at all.
 */
import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

type SuggestionUpdate = SessionNotification["update"];

/** The forms of the prediction that a client takes. */
export type PromptSuggestionForms = {
  /** `session_info_update._meta.promptSuggestions`: the client is JetBrains AIR. */
  meta: boolean;
  /** `prompt_suggestions_update`: the client advertised `session.promptSuggestions`. */
  update: boolean;
};

/**
 * Whether a client advertised `session.promptSuggestions`. `session` is the
 * session capabilities of its `initialize` request: `clientCapabilities.session`
 * on v1, `capabilities.session` on v2. ACP forbids the update without it.
 */
export function clientTakesPromptSuggestions(
  session: { promptSuggestions?: unknown } | null | undefined,
): boolean {
  return session?.promptSuggestions != null;
}

/** Whether a client takes the prediction in any form. */
function takesPrediction(forms: PromptSuggestionForms): boolean {
  return forms.meta || forms.update;
}

/**
 * The SDK option that makes Claude Code predict the next prompt, for a
 * session whose client takes the prediction in a form. Empty for any other
 * client: a prediction costs a request per turn, and none of it would reach
 * that client. Both cores spread it before the client's own options, so
 * `_meta.claudeCode.options.promptSuggestions: false` turns the prediction off.
 */
export function promptSuggestionOptions(
  forms: PromptSuggestionForms,
): Pick<Options, "promptSuggestions"> {
  return takesPrediction(forms) ? { promptSuggestions: true } : {};
}

/** The `_meta` key the suggestion travels under. It names no vendor. */
export const PROMPT_SUGGESTIONS_META_KEY = "promptSuggestions";

/** One predicted prompt, as the `_meta` value carries it. */
export type PromptSuggestionsMetaValue = {
  suggestions: { text: string }[];
};

/**
 * The suggestion as it goes on the wire, or `null` for a suggestion that says
 * nothing: the CLI can predict whitespace, and an empty text would otherwise
 * reach the composer as a hint with no content. ACP forbids a suggestion whose
 * only content is empty or whitespace-only text.
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

/**
 * The `prompt_suggestions_update` that makes `text` the session's list of
 * suggestions. `null` sends an empty list, which withdraws the list that the
 * client is offering.
 */
export function promptSuggestionsUpdate(text: string | null): SuggestionUpdate {
  return {
    sessionUpdate: "prompt_suggestions_update",
    suggestions: text === null ? [] : [{ prompt: [{ type: "text", text }] }],
  };
}

/** The prediction that a client holds in one form, and what is still to come of the last result. */
class Lane {
  /** The last text sent (`null` after a clear). Undefined until the first send. */
  private published: string | null | undefined;
  /**
   * Set at a turn's result, cleared when the next prompt arrives. A
   * prediction that the next prompt outran (sent before the prediction was
   * read off the stream) follows a turn that is answered already, so it is
   * dropped instead of published mid-turn.
   */
  private expected = false;

  constructor(
    private readonly form: (text: string | null) => SuggestionUpdate,
    /** `prompt_suggestions_update`, whose rules ACP sets. */
    readonly standard: boolean,
  ) {}

  resultArrived(): void {
    this.expected = true;
  }

  suggested(text: string | null, working: boolean): SuggestionUpdate | undefined {
    if (!this.expected) return undefined;
    this.expected = false;
    // ACP: a prediction is discarded when the conversation changed before it
    // was sent. AIR's draft has no such rule.
    if (working && this.standard) return undefined;
    return this.publish(text);
  }

  clear(): SuggestionUpdate | undefined {
    this.expected = false;
    return this.publish(null);
  }

  private publish(text: string | null): SuggestionUpdate | undefined {
    // An unchanged prediction is not sent again.
    if ((this.published ?? null) === text) return undefined;
    this.published = text;
    return this.form(text);
  }
}

/**
 * The predictions that a session holds on the client, and whether an arriving
 * `prompt_suggestion` still answers the turn the user waits on. Both cores
 * keep one per session and send the updates that its methods return, in
 * order. An empty list: nothing to send.
 *
 * Each form has its own state. The `_meta` form keeps the rules it had before
 * ACP had the update. The `prompt_suggestions_update` form follows ACP's, so
 * it also drops a prediction that arrives while Claude works
 * ({@link suggested}) and withdraws its list when work starts
 * ({@link workStarted}).
 */
export class PromptSuggestions {
  private readonly lanes: Lane[];

  /**
   * The predictions of a session whose client takes `forms`. Undefined for a
   * client that takes neither: nothing of a prediction goes to it.
   */
  static forClient(forms: PromptSuggestionForms): PromptSuggestions | undefined {
    return takesPrediction(forms) ? new PromptSuggestions(forms) : undefined;
  }

  private constructor(forms: PromptSuggestionForms) {
    this.lanes = [
      ...(forms.update ? [new Lane(promptSuggestionsUpdate, true)] : []),
      ...(forms.meta
        ? [
            new Lane(
              (text) => ({
                sessionUpdate: "session_info_update",
                _meta: promptSuggestionsMeta(text),
              }),
              false,
            ),
          ]
        : []),
    ];
  }

  /** A result came: the CLI predicts the next prompt right after it. */
  resultArrived(): void {
    for (const lane of this.lanes) lane.resultArrived();
  }

  /**
   * The updates for the CLI's `prompt_suggestion`, in each form where it
   * answers the last result and changes what the client holds.
   *
   * `working`: Claude works in the session now, such as on a prompt that was
   * queued before the result, or in a cycle that Claude Code started on its
   * own. The prediction does not account for that work, so the
   * `prompt_suggestions_update` form drops it.
   */
  suggested(raw: string | null | undefined, working: boolean): SuggestionUpdate[] {
    const text = promptSuggestionText(raw);
    return this.updates((lane) => lane.suggested(text, working));
  }

  /**
   * The updates that clear the prediction: a client prompt spent it, or a
   * `conversation_reset` dropped the transcript it came from. It also drops
   * a prediction still in flight for the last result. Empty when the client
   * holds none.
   */
  clear(): SuggestionUpdate[] {
    return this.updates((lane) => lane.clear());
  }

  /**
   * Foreground work started. The `prompt_suggestions_update` form withdraws
   * its list, as {@link clear} does: ACP asks for it when work starts without
   * a prompt, and a prompt's own work finds the list withdrawn already. The
   * `_meta` form keeps its prediction until the next prompt, as before.
   */
  workStarted(): SuggestionUpdate[] {
    return this.updates((lane) => (lane.standard ? lane.clear() : undefined));
  }

  private updates(of: (lane: Lane) => SuggestionUpdate | undefined): SuggestionUpdate[] {
    return this.lanes.flatMap((lane) => of(lane) ?? []);
  }
}
