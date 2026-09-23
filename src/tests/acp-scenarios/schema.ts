/**
 * Validates recorded outbound messages against the ACP JSON schema that
 * `@agentclientprotocol/sdk` ships.
 *
 * The session updates of the AIR extensions (`async_task_*`, `subagent_*`)
 * are not in the ACP schema. {@link validateRecorded} accepts them only for a
 * client that negotiated them, and checks only their envelope.
 */
import { createRequire } from "node:module";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { Recorded } from "./harness.js";

const require = createRequire(import.meta.url);
const schema = require("@agentclientprotocol/sdk/schema/schema.json") as Record<string, unknown>;

/** The session update kinds of the AIR extensions. They are not in the ACP schema. */
export const EXTENSION_SESSION_UPDATES = new Set([
  "async_task_spawned",
  "async_task_progress",
  "async_task_state_update",
  "subagent_spawned",
  "subagent_state_update",
]);

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(schema, "acp");

const validators = new Map<string, ValidateFunction>();

function validator(definition: string): ValidateFunction {
  let validate = validators.get(definition);
  if (!validate) {
    validate = ajv.getSchema(`acp#/$defs/${definition}`);
    if (!validate) throw new Error(`The ACP schema has no ${definition}`);
    validators.set(definition, validate);
  }
  return validate;
}

/** The schema definition of each recorded message kind. */
const DEFINITIONS: Record<Recorded["kind"], string> = {
  initialize: "InitializeResponse",
  newSession: "NewSessionResponse",
  loadSession: "LoadSessionResponse",
  sessionUpdate: "SessionNotification",
  requestPermission: "RequestPermissionRequest",
  createElicitation: "CreateElicitationRequest",
  completeElicitation: "CompleteElicitationNotification",
  extNotification: "",
  promptResponse: "PromptResponse",
};

/**
 * Returns a description of each schema violation of a recorded message, or
 * an empty list. `extensions` names the extension session updates that the
 * client negotiated.
 */
export function validateRecorded(record: Recorded, extensions: ReadonlySet<string>): string[] {
  if (record.kind === "extNotification") {
    const { method } = record.payload as { method?: unknown };
    return typeof method === "string" && method.startsWith("_")
      ? []
      : [`an extension notification needs a method that starts with "_": ${String(method)}`];
  }
  if (record.kind === "sessionUpdate") {
    const update = (record.payload as { update?: { sessionUpdate?: unknown } }).update;
    const kind = update?.sessionUpdate;
    if (typeof kind === "string" && EXTENSION_SESSION_UPDATES.has(kind)) {
      if (!extensions.has(kind)) return [`the client did not negotiate ${kind}`];
      const sessionId = (record.payload as { sessionId?: unknown }).sessionId;
      return typeof sessionId === "string" ? [] : [`${kind} has no sessionId`];
    }
  }
  const validate = validator(DEFINITIONS[record.kind]);
  if (validate(record.payload)) return [];
  return (validate.errors ?? []).map(
    (error) => `${record.kind} ${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
  );
}
