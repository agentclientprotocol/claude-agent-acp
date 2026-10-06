/**
 * Validates recorded outbound messages against the ACP JSON schemas that
 * `@agentclientprotocol/sdk` ships: v1 ({@link validateRecorded}) and the
 * draft v2 ({@link validateV2Message}).
 *
 * The session updates of the AIR extensions (`async_task_*`, `subagent_*`)
 * are not in the ACP schema. {@link validateRecorded} accepts them only for a
 * client that negotiated them, and checks only their envelope.
 *
 * The validator checks every `format` of the schema. `ajv-formats` defines
 * the standard formats, such as `uri`, and `int32`, `int64`, and `double`.
 * This file defines the unsigned integer formats of the ACP schema.
 */
import { createRequire } from "node:module";
// The named exports load under the ESM build of TypeScript. The default
// exports of these CommonJS modules are not constructable or callable there.
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import type { Recorded, WireRecorded } from "./harness.js";

const require = createRequire(import.meta.url);
const schema = require("@agentclientprotocol/sdk/schema/schema.json") as Record<string, unknown>;
const v2Schema = require("@agentclientprotocol/sdk/schema/v2/schema.unstable.json") as {
  $defs: Record<string, { "x-method"?: string; "x-side"?: string }>;
};

/** The session update kinds of the AIR extensions. They are not in the ACP schema. */
export const EXTENSION_SESSION_UPDATES = new Set([
  "async_task_spawned",
  "async_task_progress",
  "async_task_state_update",
  // RFD #1992's rework merged subagent_spawned/subagent_state_update into
  // one upsert-style subagent_update, and added session_message /
  // session_message_chunk for directed messages (e.g. a subagent's prompt).
  "subagent_update",
  "session_message",
  "session_message_chunk",
]);

/** A validator of one ACP schema, which knows every format the schema uses. */
function schemaValidator(source: Record<string, unknown>, name: string): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const [format, definition] of Object.entries(fullFormats)) {
    ajv.addFormat(format, definition);
  }
  for (const [format, max] of [
    ["uint16", 2 ** 16 - 1],
    ["uint32", 2 ** 32 - 1],
    ["uint64", 2 ** 64 - 1],
  ] as const) {
    ajv.addFormat(format, {
      type: "number",
      validate: (value: number) => Number.isInteger(value) && value >= 0 && value <= max,
    });
  }
  // A format without a definition passes every value, so each one must be known.
  for (const format of schemaFormats(source)) {
    if (!ajv.formats[format]) throw new Error(`No definition of the ACP schema format ${format}`);
  }
  ajv.addSchema(source, name);
  return ajv;
}

const ajv = schemaValidator(schema, "acp");
const ajvV2 = schemaValidator(v2Schema, "acp-v2");

/** Every `format` value in a JSON schema. */
function schemaFormats(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) schemaFormats(item, found);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "format" && typeof value === "string") found.add(value);
      else schemaFormats(value, found);
    }
  }
  return found;
}

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

/**
 * The v2 definition of a message that the agent sends, found from the method
 * and side that each definition of the v2 schema names: a request or
 * notification that the client handles, or the response to a request that
 * the agent handles.
 */
function v2Definition(message: WireRecorded): string {
  const side = message.kind === "response" ? "agent" : "client";
  const suffix =
    message.kind === "response"
      ? "Response"
      : message.kind === "request"
        ? "Request"
        : "Notification";
  const names = Object.entries(v2Schema.$defs)
    .filter(
      ([name, definition]) =>
        definition["x-method"] === message.method &&
        definition["x-side"] === side &&
        name.endsWith(suffix),
    )
    .map(([name]) => name);
  if (names.length !== 1) {
    throw new Error(
      `The ACP v2 schema has ${names.length} definitions of ${message.kind} ${message.method}`,
    );
  }
  return names[0];
}

const v2Validators = new Map<string, ValidateFunction>();

/**
 * Returns a description of each way a message that the agent sent to a v2
 * client breaks the draft v2 schema, or an empty list. Extension methods only
 * need their `_` prefix, and an error response a code and a message.
 */
export function validateV2Message(message: WireRecorded): string[] {
  const label = `${message.kind} ${message.method}`;
  if (message.method.startsWith("_")) return [];
  if (message.kind === "error") {
    const { code, message: text } = message.payload as { code?: unknown; message?: unknown };
    return Number.isInteger(code) && typeof text === "string"
      ? []
      : [`${label} is not a JSON-RPC error`];
  }
  const definition = v2Definition(message);
  let validate = v2Validators.get(definition);
  if (!validate) {
    validate = ajvV2.getSchema(`acp-v2#/$defs/${definition}`);
    if (!validate) throw new Error(`The ACP v2 schema has no ${definition}`);
    v2Validators.set(definition, validate);
  }
  if (validate(message.payload)) return [];
  return (validate.errors ?? []).map(
    (error) => `${label} ${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
  );
}
