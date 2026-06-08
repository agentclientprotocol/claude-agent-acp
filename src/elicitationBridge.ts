/**
 * Bridges between the Claude Agent SDK's user-input mechanisms and ACP's
 * `unstable_createElicitation` request. When the connected ACP client
 * advertises form-mode elicitation, these helpers let:
 *
 *   - MCP servers under the SDK forward elicitation requests to the user
 *     through ACP (`bridgeSdkElicitation` → SDK `onElicitation` callback),
 *   - and built-in CLI tools that need a blocking user prompt — most
 *     notably `AskUserQuestion` — round-trip through ACP form elicitation
 *     (`bridgeUserDialog` → SDK `onUserDialog` callback).
 */

import { AgentSideConnection } from "@agentclientprotocol/sdk";
import type {
  ElicitationRequest as SdkElicitationRequest,
  ElicitationResult as SdkElicitationResult,
  UserDialogRequest,
  UserDialogResult,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "./acp-agent.js";

/** Question payload the CLI sends for `dialogKind: "askUserQuestion"`. */
interface AskUserQuestionPayload {
  questions: Array<AskUserQuestion>;
}

interface AskUserQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{
    label: string;
    description?: string;
    preview?: string;
  }>;
}

interface AskUserQuestionAnswer {
  question: string;
  header?: string;
  options: AskUserQuestion["options"];
  multiSelect?: boolean;
  /** Label of the option(s) the user picked. */
  answer: string | string[];
}

/**
 * Forward an MCP-server-initiated elicitation through ACP. ACP and MCP
 * elicitation share a near-identical shape (form/url modes, JSON Schema
 * for form, action: accept|decline|cancel for the response), so this is
 * mostly a pass-through with a session-scope envelope added.
 */
export async function bridgeSdkElicitation(
  client: AgentSideConnection,
  sessionId: string,
  request: SdkElicitationRequest,
): Promise<SdkElicitationResult> {
  if (request.mode === "url") {
    const response = await client.unstable_createElicitation({
      mode: "url",
      sessionId,
      message: request.message,
      url: request.url ?? "",
      elicitationId: request.elicitationId ?? "",
    } as never);
    return mapAcpResponse(response);
  }
  const response = await client.unstable_createElicitation({
    mode: "form",
    sessionId,
    message: request.message,
    requestedSchema: (request.requestedSchema ?? {
      type: "object",
      properties: {},
    }) as never,
  } as never);
  return mapAcpResponse(response);
}

/**
 * Bridge a CLI-initiated user dialog (e.g. `AskUserQuestion`) through ACP.
 * Unrecognized `dialogKind`s answer `cancelled` per the SDK contract so
 * the CLI applies the dialog's default behavior.
 */
export async function bridgeUserDialog(
  client: AgentSideConnection,
  sessionId: string,
  request: UserDialogRequest,
  logger?: Logger,
): Promise<UserDialogResult> {
  if (request.dialogKind !== "askUserQuestion") {
    logger?.log?.(
      `bridgeUserDialog: unsupported dialogKind="${request.dialogKind}" — cancelling`,
    );
    return { behavior: "cancelled" };
  }
  const payload = request.payload as unknown as AskUserQuestionPayload;
  if (!payload?.questions?.length) {
    return { behavior: "cancelled" };
  }

  const answers: AskUserQuestionAnswer[] = [];
  for (const question of payload.questions) {
    const result = await askOne(client, sessionId, question);
    if (!result) {
      return { behavior: "cancelled" };
    }
    answers.push(result);
  }
  return { behavior: "completed", result: { questions: answers } };
}

async function askOne(
  client: AgentSideConnection,
  sessionId: string,
  question: AskUserQuestion,
): Promise<AskUserQuestionAnswer | null> {
  const optionEnum = question.options.map((opt) => ({
    const: opt.label,
    title: opt.label,
  }));
  const schemaProperty = question.multiSelect
    ? {
        type: "array",
        items: { type: "string", enum: question.options.map((o) => o.label) },
        uniqueItems: true,
      }
    : { type: "string", oneOf: optionEnum };
  const response = await client.unstable_createElicitation({
    mode: "form",
    sessionId,
    message: question.question,
    requestedSchema: {
      type: "object",
      title: question.header,
      properties: { answer: schemaProperty },
      required: ["answer"],
    } as never,
  } as never);
  if (response.action !== "accept" || !response.content) {
    return null;
  }
  const raw = response.content["answer"];
  if (raw == null) {
    return null;
  }
  return {
    question: question.question,
    header: question.header,
    options: question.options,
    multiSelect: question.multiSelect,
    answer: Array.isArray(raw) ? raw.map(String) : String(raw),
  };
}

function mapAcpResponse(response: {
  action: string;
  content?: Record<string, unknown> | null;
}): SdkElicitationResult {
  if (response.action === "accept") {
    return { action: "accept", content: response.content ?? undefined } as SdkElicitationResult;
  }
  if (response.action === "decline") {
    return { action: "decline" } as SdkElicitationResult;
  }
  return { action: "cancel" } as SdkElicitationResult;
}
