import { randomUUID } from "node:crypto";
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  ElicitationSchema,
  EnumOption,
} from "@agentclientprotocol/sdk";
import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import type {
  AskUserQuestionInput,
  AskUserQuestionOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";

/**
 * Bridges between the Claude Agent SDK's elicitation/dialog callbacks and ACP's
 * (unstable) elicitation protocol.
 *
 * Two distinct SDK surfaces flow through here:
 *
 *   1. `onElicitation` — fired when an MCP server requests user input. These map
 *      directly onto ACP `session/create_elicitation` (form or url mode).
 *   2. The built-in AskUserQuestion tool — when a `canUseTool` callback is
 *      registered the SDK routes its permission check through `canUseTool`
 *      (not the interactive `permission_ask_user_question` dialog). We render
 *      its questions as an ACP form elicitation and feed the user's selections
 *      back as the tool's `updatedInput`, which the tool's own `call()` reads.
 */

/** Modes the connected client advertised support for. */
export type ElicitationSupport = {
  form: boolean;
  url: boolean;
};

/**
 * Convert an MCP elicitation request (from the SDK's `onElicitation` callback)
 * into an ACP `CreateElicitationRequest`. Returns `null` when the request can't
 * be represented (e.g. a url-mode request with no url).
 */
export function mcpElicitationToCreateRequest(
  request: ElicitationRequest,
  sessionId: string,
): CreateElicitationRequest | null {
  if (request.mode === "url") {
    if (!request.url) {
      return null;
    }
    return {
      mode: "url",
      sessionId,
      message: request.message,
      url: request.url,
      // URL elicitations need a stable id so the client can correlate the
      // later `session/complete_elicitation` notification. MCP servers usually
      // provide one; fall back to a generated id if not.
      elicitationId: request.elicitationId ?? randomUUID(),
    };
  }

  // Form mode (the default). The MCP `requestedSchema` is already a JSON Schema
  // with primitive-typed properties, which is structurally what ACP expects.
  return {
    mode: "form",
    sessionId,
    message: request.message,
    requestedSchema: normalizeElicitationSchema(request.requestedSchema),
  };
}

/**
 * Map an ACP elicitation response back to the MCP `ElicitResult` the SDK expects
 * to hand back to the requesting server.
 */
export function createElicitationResponseToElicitResult(
  response: CreateElicitationResponse,
): ElicitationResult {
  switch (response.action) {
    case "accept":
      return { action: "accept", content: response.content ?? {} };
    case "decline":
      return { action: "decline" };
    case "cancel":
    default:
      return { action: "cancel" };
  }
}

/**
 * A single question as supplied by the AskUserQuestion tool. Derived from the
 * SDK's input type so the shape stays in sync; the SDK validates the model's
 * tool call against this schema before it reaches us.
 */
export type AskUserQuestion = AskUserQuestionInput["questions"][number];

/**
 * Pull the well-formed questions out of an AskUserQuestion tool input. Returns
 * `null` when there are no usable questions — including the case where every
 * entry is malformed and filtering leaves an empty list — so callers can treat
 * "nothing to ask" uniformly.
 */
export function extractAskUserQuestions(input: Record<string, unknown>): AskUserQuestion[] | null {
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const valid = questions.filter(
    (q): q is AskUserQuestion =>
      !!q && typeof q.question === "string" && Array.isArray(q.options) && q.options.length > 0,
  );
  return valid.length > 0 ? valid : null;
}

/** Stable form-field key for the question at the given index. */
function questionFieldKey(index: number): string {
  return `question_${index}`;
}

/**
 * Form-field key for the per-question free-text "custom answer" field that sits
 * alongside `question_<n>`. Mirrors the first-party clients, where every
 * question carries its own "Other" box rather than one form-level field.
 */
function questionCustomFieldKey(index: number): string {
  return `question_${index}_custom`;
}

/**
 * `_meta` key under which a bridged enum option carries its structured
 * `description`/`preview`, since ACP's `EnumOption` has no field for either.
 * Namespaced like the agent's other `_meta` extensions (`_claude/...`).
 */
const OPTION_META_KEY = "_claude/askUserQuestionOption";

/** A single option as supplied by the AskUserQuestion tool. */
type AskUserQuestionOption = AskUserQuestion["options"][number];

/**
 * Build the `_meta` payload that carries an option's structured `description`
 * and optional `preview` for clients that can render them as distinct fields.
 * Returns `undefined` when neither is present, so we don't emit an empty `_meta`.
 */
function askUserQuestionOptionMeta(
  option: AskUserQuestionOption,
): NonNullable<EnumOption["_meta"]> | undefined {
  const detail: { description?: string; preview?: string } = {};
  if (option.description) {
    detail.description = option.description;
  }
  if (option.preview) {
    detail.preview = option.preview;
  }
  return Object.keys(detail).length > 0 ? { [OPTION_META_KEY]: detail } : undefined;
}

/**
 * Render the AskUserQuestion tool's questions as an ACP form elicitation.
 *
 * Fields are keyed by a short stable id (`question_<n>`) rather than the full
 * question text, so the question text appears in exactly one place per field.
 * Single-select questions use a titled `oneOf` enum; multi-select questions use
 * an array with a titled `anyOf` item enum. The enum `const` is always the
 * option label, since that is what the tool records as the answer.
 *
 * Each question is followed by its own optional free-text "custom answer" field
 * (`question_<n>_custom`), mirroring the CLI's per-question "Other" box: the
 * user can type their own answer instead of picking an option, scoped to that
 * specific question. Nothing is marked required, so the user can also just skip
 * — matching the built-in tool, which always offers Skip + a free-text box.
 */
export function askUserQuestionsToCreateRequest(
  questions: AskUserQuestion[],
  sessionId: string,
  toolCallId: string | undefined,
): CreateElicitationRequest {
  const single = questions.length === 1;
  const properties: Record<string, ElicitationPropertySchema> = {};

  questions.forEach((question, index) => {
    const options: EnumOption[] = question.options.map((option) => {
      const enumOption: EnumOption = {
        const: option.label,
        // `title` stays a flattened "label — description" string so clients that
        // only read `const`/`title` still surface the description. Clients that
        // understand the `_meta` below should prefer its structured fields (and
        // treat `const` as the clean label) rather than parsing this title.
        title: option.description ? `${option.label} — ${option.description}` : option.label,
      };
      // The SDK option carries a `description` (secondary text) and an optional
      // `preview` (mockups, code snippets, comparisons shown on focus). Neither
      // has a structural slot in `EnumOption`, so forward them under ACP's
      // reserved `_meta` extension point for clients that can render them.
      const meta = askUserQuestionOptionMeta(option);
      if (meta) {
        enumOption._meta = meta;
      }
      return enumOption;
    });

    // For a single question the prompt is carried by `message`, so we don't
    // repeat it in the field description. With multiple questions each field
    // needs its own question text.
    const description = single ? undefined : question.question;
    const title = question.header || undefined;

    properties[questionFieldKey(index)] = question.multiSelect
      ? { type: "array", title, description, items: { anyOf: options } }
      : { type: "string", title, description, oneOf: options };

    properties[questionCustomFieldKey(index)] = {
      type: "string",
      title: "Other",
      description: "Type your own answer instead of choosing an option above (optional).",
    };
  });

  const requestedSchema: ElicitationSchema = {
    type: "object",
    properties,
  };

  const message = single ? questions[0].question : "Please answer the following questions.";

  return {
    mode: "form",
    sessionId,
    ...(toolCallId ? { toolCallId } : {}),
    message,
    requestedSchema,
  };
}

/** Outcome of an AskUserQuestion elicitation, decoupled from any transport. */
export type AskUserQuestionOutcome =
  { action: "answered"; updatedInput: Record<string, unknown> } | { action: "cancel" };

/**
 * Fold an ACP elicitation response into the AskUserQuestion tool's input.
 *
 * Selected labels are read back from the indexed form fields and written into
 * `answers` as a `{ [questionText]: label }` map (comma-joining multi-selects)
 * — the key shape the tool's own `call()` reads. A non-empty per-question
 * custom-answer field (`question_<n>_custom`) takes precedence over that
 * question's selection, since the user typed their own answer instead of
 * picking one. Decline yields empty answers (the model is told the user skipped
 * rather than the turn aborting); cancel aborts the tool call.
 */
export function applyAskElicitationResponse(
  response: CreateElicitationResponse,
  toolInput: Record<string, unknown>,
  questions: AskUserQuestion[],
): AskUserQuestionOutcome {
  if (response.action === "cancel") {
    return { action: "cancel" };
  }

  if (response.action === "decline") {
    return { action: "answered", updatedInput: { ...toolInput, answers: {} } };
  }

  const content = response.content ?? {};
  // Typed against the tool's own output schema so the answer/response shapes
  // stay in sync with what the built-in tool's call() expects to read back.
  const answers: AskUserQuestionOutput["answers"] = {};
  questions.forEach((question, index) => {
    // A typed custom answer wins over the selection: the user chose to write
    // their own answer for this question instead of picking an option.
    const custom = content[questionCustomFieldKey(index)];
    if (typeof custom === "string" && custom.trim() !== "") {
      answers[question.question] = custom.trim();
      return;
    }

    const value = content[questionFieldKey(index)];
    if (value === undefined || value === null) {
      return;
    }
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    if (text === "") {
      return;
    }
    answers[question.question] = text;
  });

  return { action: "answered", updatedInput: { ...toolInput, answers } };
}

/**
 * Coerce an arbitrary MCP `requestedSchema` into an ACP `ElicitationSchema`.
 * The two are structurally compatible JSON Schemas; we just guarantee the
 * `type: "object"` discriminator is present.
 */
function normalizeElicitationSchema(
  schema: Record<string, unknown> | undefined,
): ElicitationSchema {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  return { ...(schema as ElicitationSchema), type: "object" };
}

/**
 * The `request_user_dialog` kind the CLI emits when a model refusal has a
 * fallback available but needs user consent before retrying (e.g. Claude Fable
 * declining a request with Opus available as the fallback). Declaring this
 * kind in `supportedDialogKinds` is the opt-in: the CLI fails closed and never
 * emits an undeclared kind — the flow degrades to the classic refusal error
 * ending the turn.
 */
export const REFUSAL_FALLBACK_DIALOG_KIND = "refusal_fallback_prompt";

/**
 * Payload of the `refusal_fallback_prompt` dialog. The dialog protocol
 * transports payloads opaquely, so this shape is recovered from the CLI's own
 * schema (v2.1.177): `originalModel`/`fallbackModel` are required strings;
 * `apiRefusalCategory` (nullable), `guidanceText`, and
 * `retractedMessageUuids` are optional. We ignore `retractedMessageUuids` —
 * ACP has no way to retract already-streamed chunks.
 */
export type RefusalFallbackPrompt = {
  originalModel: string;
  fallbackModel: string;
  apiRefusalCategory: string | null;
  guidanceText?: string;
};

/**
 * Validate the opaque dialog payload into a {@link RefusalFallbackPrompt}.
 * Returns `null` when the required fields are missing or mistyped (a newer CLI
 * may reshape the payload), so the caller can cancel the dialog and let the
 * CLI apply its default behavior instead of rendering something misleading.
 */
export function extractRefusalFallbackPrompt(
  payload: Record<string, unknown>,
): RefusalFallbackPrompt | null {
  const { originalModel, fallbackModel, apiRefusalCategory, guidanceText } = payload;
  if (typeof originalModel !== "string" || typeof fallbackModel !== "string") {
    return null;
  }
  return {
    originalModel,
    fallbackModel,
    apiRefusalCategory: typeof apiRefusalCategory === "string" ? apiRefusalCategory : null,
    ...(typeof guidanceText === "string" && guidanceText ? { guidanceText } : {}),
  };
}

/** Form-field key carrying the user's choice in the refusal-fallback form. */
const REFUSAL_FALLBACK_CHOICE_KEY = "choice";

/** Wire values of the dialog's result enum (CLI schema). `edit_prompt` is
 *  deliberately not offered: in the CLI it prefills the composer with the
 *  refused prompt for edit-and-retry, and ACP has no composer-prefill surface
 *  — the user can simply edit and resend on their own. */
const RETRY_FALLBACK_RESULT = "retry_fallback";
const KEEP_REFUSAL_RESULT = "cancelled";

/**
 * Render the refusal-fallback consent prompt as an ACP form elicitation: a
 * single-select between retrying on the fallback model and keeping the
 * refusal. The enum `const`s are the dialog's wire result values, so the
 * response maps back without a translation table.
 */
export function refusalFallbackToCreateRequest(
  prompt: RefusalFallbackPrompt,
  sessionId: string,
): CreateElicitationRequest {
  const category = prompt.apiRefusalCategory ? ` (${prompt.apiRefusalCategory})` : "";
  const guidance = prompt.guidanceText ? `\n\n${prompt.guidanceText}` : "";
  return {
    mode: "form",
    sessionId,
    message:
      `${prompt.originalModel} declined this request${category}. ` +
      `Retry with ${prompt.fallbackModel}? The session would continue on ${prompt.fallbackModel}.` +
      guidance,
    requestedSchema: {
      type: "object",
      properties: {
        [REFUSAL_FALLBACK_CHOICE_KEY]: {
          type: "string",
          oneOf: [
            { const: RETRY_FALLBACK_RESULT, title: `Retry with ${prompt.fallbackModel}` },
            { const: KEEP_REFUSAL_RESULT, title: "Keep the refusal" },
          ],
        },
      },
    },
  };
}

/**
 * Map the elicitation response back to the dialog's result enum. Only an
 * explicit accept-with-retry resolves to `retry_fallback`; decline, cancel, a
 * skipped field, or an unrecognized value all keep the refusal — the dialog's
 * own default — so a dismissed or half-filled form can never trigger a model
 * switch the user didn't ask for.
 */
export function refusalFallbackResultFromResponse(response: CreateElicitationResponse): string {
  if (response.action !== "accept") {
    return KEEP_REFUSAL_RESULT;
  }
  const choice = response.content?.[REFUSAL_FALLBACK_CHOICE_KEY];
  return choice === RETRY_FALLBACK_RESULT ? RETRY_FALLBACK_RESULT : KEEP_REFUSAL_RESULT;
}
