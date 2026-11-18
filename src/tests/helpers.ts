/**
 * Shared test doubles. Deliberately vitest-free so `vi.mock` async factories
 * can `await import("./helpers.js")` without ordering hazards; tests supply
 * their own vi.fn spies via `overrides`.
 */

import {
  RequestError,
  type ClientCapabilities,
  type InitializeRequest,
} from "@agentclientprotocol/sdk/unstable";
import { mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";

/** The context-usage report the base mock query returns: a 200K window, as
 *  Claude Code reports for `claude-sonnet-4-5`. It differs from the agent's
 *  DEFAULT_CONTEXT_WINDOW, so a test can tell a window that was read from the
 *  default. */
export const DEFAULT_CONTEXT_USAGE = {
  model: "claude-sonnet-4-5",
  totalTokens: 0,
  rawMaxTokens: 200000,
};

/**
 * Base stub for the SDK `query()` return object, covering the surface
 * ClaudeAcpAgent touches unconditionally at session creation. Tests pass
 * `overrides` for the parts they assert on (spies, custom models, rejecting
 * getContextUsage, …).
 *
 * When the agent starts calling a new SDK method on every session, add it
 * here once — the getContextUsage adoption required hand-editing ~10 inline
 * mocks across five files, and any missed copy didn't fail: it silently
 * rerouted that test through the error-fallback branch and re-polluted test
 * output.
 */
export function makeMockQuery(overrides: Record<string, unknown> = {}) {
  return {
    initializationResult: async () => ({ models: [] }),
    setModel: async () => {},
    setPermissionMode: async () => {},
    supportedCommands: async () => [],
    mcpServerStatus: async () => [],
    setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    getContextUsage: async () => DEFAULT_CONTEXT_USAGE,
    // No ultracode fields: session creation falls back to settings and the
    // model's effort levels, as with a CLI that does not report them.
    getSettings: async () => ({ applied: {} }),
    close: () => {},
    interrupt: async () => undefined,
    [Symbol.asyncIterator]: async function* () {},
    ...overrides,
  };
}

/**
 * The error `initializationResult()` rejects with when Claude Code refuses to
 * start with `CLAUDE_CODE_STARTUP_FAILURE_RESULTS` set, as SDK 0.3.316 builds
 * it from the CLI's error result (same message prefix and fields).
 */
export function startupFailure(reason: string, cliMessage: string): Error {
  return Object.assign(new Error(`Claude Code returned an error result: ${cliMessage}`), {
    telemetryMessage: "Claude Code returned an error result",
    errorClass: "error_result",
    startupFailureReason: reason,
  });
}

/**
 * The error `setModel()` rejects with when Claude Code refuses the switch, as
 * SDK 0.3.325 builds it from the CLI's answer: `errorCode` is the answer's
 * `error_code`, such as `not_found` for "Model 'gpt-4' not found".
 */
export function setModelRefusal(message: string, errorCode: string): Error {
  return Object.assign(new Error(message), {
    telemetryMessage: "Claude Code control request failed (set_model)",
    errorClass: "control_request_failed",
    errorCode,
  });
}

/**
 * Declares the client capabilities through `initialize`, as a real client
 * does. The agent reads its capability choices only there.
 */
export async function initializeClient(
  agent: { initialize(request: InitializeRequest): Promise<unknown> },
  clientCapabilities: ClientCapabilities,
): Promise<void> {
  await agent.initialize({ protocolVersion: 1, clientCapabilities });
}

/**
 * A request to a client that never answers it, as the SDK connection returns
 * it with `stopWaitingOnCancel`: it rejects with `-32800` once `signal`
 * aborts. The real connection also sends `$/cancel_request` then.
 */
export function heldRequest<T>(_params?: unknown, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    const cancel = () => reject(RequestError.requestCancelled(signal?.reason));
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
  });
}

/** A transcript record of a user message. */
export function transcriptUser(uuid: string, content: string, extra: object = {}) {
  return { type: "user", uuid, message: { role: "user", content }, ...extra };
}

/** A transcript record of an assistant text response. */
export function transcriptAssistant(uuid: string, text: string) {
  return {
    type: "assistant",
    uuid,
    message: {
      id: `msg_${uuid}`,
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text }],
    },
  };
}

/** A `compact_boundary` as Claude Code writes it: no parent, and the last
 *  message before it in `logicalParentUuid`. */
export function transcriptCompactBoundary(
  uuid: string,
  logicalParentUuid: string,
  compactMetadata: object = {},
) {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid,
    parentUuid: null,
    logicalParentUuid,
    compactMetadata: { trigger: "manual", preTokens: 1000, ...compactMetadata },
  };
}

/** The summary message that follows a `compact_boundary`. */
export function transcriptCompactSummary(
  uuid: string,
  content = "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n" +
    "Summary:\n1. Primary Request and Intent:\n   Say hi.\n\n" +
    "Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary.",
) {
  return transcriptUser(uuid, content, { isCompactSummary: true });
}

/** Writes `<directory>/<sessionId>.jsonl` as Claude Code does: each record
 *  links to the record before it, except a record that sets its own
 *  `parentUuid`. */
export async function writeTranscript(
  directory: string,
  sessionId: string,
  records: Record<string, unknown>[],
): Promise<void> {
  await mkdir(directory, { recursive: true });
  let parentUuid: unknown = null;
  const lines = records.map((record) => {
    const line = {
      parentUuid,
      sessionId,
      isSidechain: false,
      timestamp: "2026-10-11T00:00:00.000Z",
      ...record,
    };
    parentUuid = record.uuid;
    return JSON.stringify(line);
  });
  await writeFile(path.join(directory, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

/** The `_meta` of every MCP 2026-07-28 request of Claude Code 2.1.325, as its HTTP client sends it. */
const CLAUDE_CODE_MCP_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": {
    name: "claude-code",
    title: "Claude Code",
    version: "2.1.325",
    description: "Anthropic's agentic coding tool",
    websiteUrl: "https://claude.com/claude-code",
  },
  "io.modelcontextprotocol/clientCapabilities": {
    roots: { listChanged: true },
    elicitation: { form: {}, url: {} },
  },
};

/**
 * Sends the MCP request `method` to the HTTP server of an SDK config, as
 * Claude Code 2.1.325 sends it: one JSON-RPC request in a POST, with the
 * headers that mirror its version, method and tool name. A `tools/call` has
 * the tool use id and a progress token in `_meta`. `headers` replace the
 * config's own, which carry the server's bearer token.
 *
 * Resolves with the HTTP status and the JSON-RPC messages of the response:
 * the one message of a JSON body, or every message of an event stream. It
 * uses `node:http`: the test setup stubs the global `fetch`.
 */
export function claudeCodeMcpRequest(
  config: { url: string; headers?: Record<string, string> },
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> | undefined = config.headers,
): Promise<{ status: number; messages: Array<Record<string, any>> }> {
  const meta =
    method === "tools/call"
      ? { ...CLAUDE_CODE_MCP_META, "claudecode/toolUseId": "toolu_01", progressToken: 1 }
      : CLAUDE_CODE_MCP_META;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params: { ...params, _meta: meta },
  });
  return new Promise((resolve, reject) => {
    const post = request(
      config.url,
      {
        method: "POST",
        headers: {
          ...headers,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const messages = response.headers["content-type"]?.startsWith("text/event-stream")
            ? text
                .split("\n\n")
                .flatMap((event) => event.split("\n").filter((line) => line.startsWith("data: ")))
                .map((line) => JSON.parse(line.slice("data: ".length)))
            : [JSON.parse(text)];
          resolve({ status: response.statusCode ?? 0, messages });
        });
      },
    );
    post.on("error", reject);
    post.end(body);
  });
}
