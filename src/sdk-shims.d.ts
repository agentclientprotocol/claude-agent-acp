/**
 * Shims for types the `@anthropic-ai/claude-agent-sdk` 0.3.198 `sdk.d.ts`
 * references in its `SDKMessage` union but never declares
 * (`SDKControlRequestProgressMessage`, `SDKConversationResetMessage`). With
 * `skipLibCheck` the dangling references silently become error-`any`, which
 * poisons narrowing on the whole union — every exhaustive switch over
 * `SDKMessage` stops compiling.
 *
 * These must stay GLOBAL declarations (no top-level import/export in this
 * file): unqualified names inside the SDK's module declaration fall back to
 * the global scope, which is the only way a consumer can supply them. Shapes
 * are transcribed from the zod schemas embedded in the bundled CLI binary.
 * Delete this file once the SDK ships the declarations itself — a proper
 * module-scoped declaration will shadow these.
 */

/** Progress for a long-running client-originated control request (currently
 *  only `side_question`), correlated by `request_id`. */
declare type SDKControlRequestProgressMessage = {
  type: "control_request_progress";
  request_id: string;
  status: "started" | "api_retry";
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number | null;
  uuid: import("crypto").UUID;
  session_id: string;
};

/** Emitted by `/clear`, plan-mode exit, and fresh-session flows; the surface
 *  should mount a fresh transcript under `new_conversation_id`. */
declare type SDKConversationResetMessage = {
  type: "conversation_reset";
  new_conversation_id: import("crypto").UUID;
  uuid: import("crypto").UUID;
  session_id: string;
};
