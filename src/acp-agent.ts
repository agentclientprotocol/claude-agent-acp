import {
  agent as acpAgent,
  AgentContext,
  AuthenticateRequest,
  AuthMethod,
  AvailableCommand,
  CancelNotification,
  ClientCapabilities,
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  LogoutRequest,
  methods,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PermissionOption,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestError,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  StopReason,
} from "@agentclientprotocol/sdk";
import {
  AgentInfo,
  CanUseTool,
  deleteSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  McpServerConfig,
  ModelInfo,
  ModelUsage,
  OnElicitation,
  Options,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  query,
  Settings,
  SDKAssistantMessageError,
  SDKMessage,
  SDKMessageOrigin,
  SDKPartialAssistantMessage,
  SDKUserMessage,
  SlashCommand,
  ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { BetaContentBlock, BetaRawContentBlockDelta } from "@anthropic-ai/sdk/resources/beta.mjs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import packageJson from "../package.json" with { type: "json" };
import {
  applyAskElicitationResponse,
  askUserQuestionsToCreateRequest,
  createElicitationResponseToElicitResult,
  ElicitationSupport,
  extractAskUserQuestions,
  mcpElicitationToCreateRequest,
} from "./elicitation.js";
import { SettingsManager } from "./settings.js";
import {
  applyTaskCreate,
  applyTaskUpdate,
  ClaudePlanEntry,
  createPostToolUseHook,
  createTaskHook,
  parseTaskCreateOutput,
  planEntries,
  registerHookCallback,
  TaskState,
  taskStateToPlanEntries,
  toolInfoFromToolUse,
  toolUpdateFromDiffToolResponse,
  toolUpdateFromToolResult,
} from "./tools.js";
import { nodeToWebReadable, nodeToWebWritable, Pushable, unreachable } from "./utils.js";

export const CLAUDE_CONFIG_DIR =
  process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");

const execFileAsync = promisify(execFile);

const MAX_TITLE_LENGTH = 256;

function sanitizeTitle(text: string): string {
  // Replace newlines and collapse whitespace
  const sanitized = text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length <= MAX_TITLE_LENGTH) {
    return sanitized;
  }
  return sanitized.slice(0, MAX_TITLE_LENGTH - 1) + "…";
}

/**
 * Logger interface for customizing logging output
 */
export interface Logger {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

type AccumulatedUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
};

type UsageSnapshot = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

const ZERO_USAGE = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

const DEFAULT_CONTEXT_WINDOW = 200000;

/** Floor after `session/cancel` before the adapter forces the active prompt
 *  loop to return "cancelled". `query.interrupt()` normally makes the SDK
 *  yield a trailing idle within milliseconds, and the loop returns through its
 *  usual path — so this timer is armed and cleared, never fired, on healthy
 *  cancels. It only trips when the SDK is genuinely wedged (e.g. a
 *  `TaskOutput { block: true }` poll against a hung background task — issue
 *  #680) and never yields. The value is deliberately loose: it's an
 *  "obviously stuck" ceiling, not a guess at interrupt latency, so it can't
 *  pre-empt a slow-but-healthy interrupt. */
const DEFAULT_FORCE_CANCEL_GRACE_MS = 30_000;

/** Internal model-selection state. Mirrors the shape the ACP SDK exposed as
 *  `SessionModelState` before model selection moved entirely into
 *  `SessionConfigOption` (category "model"). Retained internally to track the
 *  current model and build the "model" config option. */
type SessionModelState = {
  availableModels: Array<{ modelId: string; name: string; description?: string }>;
  currentModelId: string;
};

/** One in-flight `prompt()` call. A persistent per-session consumer (see
 *  `runConsumer`) drains the SDK query stream for the whole session and settles
 *  each Turn's deferred when that turn's outcome is known, so `prompt()` itself
 *  holds no loop. Turns are processed FIFO: the SDK echoes queued user messages
 *  back in submission order, so `turnQueue[0]` is the turn currently running. */
type Turn = {
  /** uuid stamped on the pushed `SDKUserMessage`; the SDK echoes it back so the
   *  consumer can match the replayed user message to this turn. */
  promptUuid: string;
  /** Local-only slash commands (e.g. `/clear`) return a result without an echo,
   *  so the consumer can't promote them via the replay; it falls back to
   *  promoting the queue head when the result arrives. */
  isLocalOnlyCommand: boolean;
  /** Set once the deferred has been resolved/rejected, so the consumer never
   *  settles a turn twice (idle + handoff + stream-end can all race). */
  settled: boolean;
  resolve: (response: PromptResponse) => void;
  reject: (error: unknown) => void;
};

type Session = {
  query: Query;
  input: Pushable<SDKUserMessage>;
  cancelled: boolean;
  /** FIFO of in-flight prompts. The head is the turn the SDK is currently
   *  processing; later entries are queued and will be echoed in order. */
  turnQueue?: Turn[];
  /** The turn whose messages the consumer is currently attributing output to
   *  (the head of `turnQueue` once its user message has been echoed). */
  activeTurn?: Turn | null;
  /** Count of result messages the consumer should treat as orphans and skip
   *  (not promote/attribute to the current head). When cancel() settles+removes
   *  a queued turn, that turn's user message was already pushed to the SDK, so
   *  the SDK still runs it and emits a result with no uuid we can match. Because
   *  the SDK processes input FIFO, those orphan results arrive (in submission
   *  order) before the next live turn's, so skipping exactly this many leaves
   *  the genuine head untouched. Reset to 0 on every activation as a backstop
   *  against an SDK that drops queued input on interrupt (no orphan emitted). */
  pendingOrphanResults?: number;
  /** The long-lived consumer task. Lazily started on the first `prompt()` and
   *  kept alive for the session so between-turn/background messages are still
   *  drained and forwarded. */
  consumer?: Promise<void>;
  /** Set once the SDK query stream has terminated (it ran to `done` or threw a
   *  non-process error). The query iterator is not reusable afterward, so a
   *  later `prompt()` rejects instead of enqueueing onto a dead stream and
   *  hanging (or silently restarting a consumer that resolves `end_turn`
   *  without ever reaching the model). */
  queryClosed?: boolean;
  cwd: string;
  /** Serialized snapshot of session-defining params (cwd, mcpServers) used to
   *  detect when loadSession/resumeSession is called with changed values. */
  sessionFingerprint: string;
  settingsManager: SettingsManager;
  accumulatedUsage: AccumulatedUsage;
  modes: SessionModeState;
  models: SessionModelState;
  modelInfos: ModelInfo[];
  configOptions: SessionConfigOption[];
  /** Custom main-thread agent personas the user (or a plugin/project) has
   *  configured, discovered via `supportedAgents()` with Claude Code's built-in
   *  subagents filtered out. Empty when none are configured, in which case the
   *  "agent" config option is omitted entirely. */
  agents: AgentInfo[];
  /** The currently selected main-thread agent name, or "default" for the
   *  standard Claude Code agent (no `agent` flag applied). */
  currentAgent: string;
  abortController: AbortController;
  /** Signal the consumer races `query.next()` against. Aborted by cancel()
   *  (after a grace period) to force the active turn to settle "cancelled" when
   *  the SDK is wedged and `query.next()` never yields again (issue #680).
   *  Distinct from `abortController`: this only wakes the consumer; it does NOT
   *  touch the SDK query/subprocess. The consumer re-arms it after each fire.
   *  Undefined until the consumer is started by the first prompt. */
  cancelController?: AbortController;
  /** Pending grace-period timer that aborts `cancelController`. Cleared when the
   *  active turn settles normally so the backstop never fires after a clean
   *  cancel. */
  forceCancelTimer?: ReturnType<typeof setTimeout>;
  emitRawSDKMessages: boolean | SDKMessageFilter[];
  /** Context window size of the last top-level assistant model, carried across
   *  prompts so mid-stream usage_update notifications report a correct `size`
   *  before the turn's first result message arrives. Defaults to
   *  DEFAULT_CONTEXT_WINDOW, refreshed from each result's modelUsage, and
   *  invalidated when the user switches the session's model. */
  contextWindowSize: number;
  /** Accumulated task list for the session, keyed by task ID. Task IDs are
   *  per-session, so this state must not be shared across sessions. */
  taskState: TaskState;
  /** Last session title we pushed to the client via `session_info_update`.
   *  The SDK auto-generates a title in a background task and persists it to the
   *  session file; we poll it on each turn-end (`session_state_changed: idle`)
   *  and only notify the client when it actually changes. Undefined until the
   *  first title is observed. */
  lastTitle?: string;
  /** Caches `tool_use` blocks by id so the matching `tool_result` can recover
   *  the tool name/input when mapping it to a `tool_call_update`. Per-session
   *  (tool_use ids are only unique within a session) and pruned at
   *  `tool_result` time so a long-running session doesn't accumulate every
   *  tool call for its whole lifetime. */
  toolUseCache: ToolUseCache;
  /** Tracks which tool_use ids we've already emitted a `tool_call` for, so the
   *  second source to encounter a tool call sends a `tool_call_update` instead
   *  of a duplicate `tool_call`. The SDK can invoke `canUseTool` (→ a permission
   *  request, which emits the tool_call eagerly so the client has it before
   *  being asked to approve it) either before or after the assistant message's
   *  tool_use block streams; this set makes the two paths converge regardless of
   *  order. Pruned at `tool_result` time alongside `toolUseCache`. */
  emittedToolCalls: Set<string>;
  /** Maps the ACP `messageId` we expose to clients (see `messageIdForGrouping`)
   *  to the SDK message uuid that the Agent SDK's rewind/resume APIs key on
   *  (`Query.rewindFiles` takes a user-message uuid; `resumeSessionAt` takes an
   *  `SDKAssistantMessage.uuid`). For assistant turns the two differ — the ACP
   *  id is the Anthropic API message id (`msg_…`), available at `message_start`
   *  so streamed chunks can carry it, while the uuid only arrives on the
   *  consolidated message — so a client can only ask to rewind/fork by the id it
   *  was given, and we need this table to translate it back.
   *
   *  Populated as a byproduct of the message loop (the consolidated message
   *  carries both ids) and of `replaySessionHistory` on load, so no extra
   *  `getSessionMessages` read is needed at rewind time. Last-write-wins
   *  naturally yields the turn-boundary uuid when one `msg_…` spans several
   *  content-block messages.
   *
   *  NOT READ YET — recorded now so the mapping exists if/when we wire up
   *  fork/rewind. */
  messageIdToUuid: Map<string, string>;
};

/** Compute a stable fingerprint of the session-defining params so we can
 *  detect when a loadSession/resumeSession call requires tearing down and
 *  recreating the underlying Query process.  MCP servers are sorted by name
 *  so that ordering differences don't trigger unnecessary recreations. */
function computeSessionFingerprint(params: {
  cwd: string;
  mcpServers?: NewSessionRequest["mcpServers"];
}): string {
  const servers = [...(params.mcpServers ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify({ cwd: params.cwd, mcpServers: servers });
}

export type SDKMessageFilter = {
  type: string;
  subtype?: string;
  origin?: SDKMessageOrigin["kind"];
};

/**
 * Extra metadata that can be given when creating a new session.
 */
export type NewSessionMeta = {
  claudeCode?: {
    /**
     * Options forwarded to Claude Code when starting a new session.
     * Those parameters will be ignored and managed by ACP:
     *   - cwd
     *   - includePartialMessages
     *   - allowDangerouslySkipPermissions
     *   - permissionMode
     *   - canUseTool
     *   - executable
     * Those parameters will be used and updated to work with ACP:
     *   - hooks (merged with ACP's hooks)
     *   - mcpServers (merged with ACP's mcpServers)
     *   - disallowedTools (merged with ACP's disallowedTools)
     *   - tools (passed through; defaults to claude_code preset if not provided)
     */
    options?: Options;
    /**
     * When set, raw SDK messages are emitted as extNotification("_claude/sdkMessage", message)
     * in addition to normal processing.
     * - true: emit all messages
     * - false/undefined: emit nothing (default)
     * - SDKMessageFilter[]: emit only messages matching at least one filter
     */
    emitRawSDKMessages?: boolean | SDKMessageFilter[];
  };
  additionalRoots?: string[];
};

/**
 * Extra metadata for 'gateway' authentication requests.
 */
type GatewayAuthMeta = {
  /**
   * These parameters are mapped to environment variables to:
   * - Redirect API calls via baseUrl
   * - Inject custom headers
   * - Bypass the default Claude login requirement
   */
  gateway: {
    baseUrl: string;
    headers: Record<string, string>;
  };
};

type GatewayAuthRequest = AuthenticateRequest & { _meta?: GatewayAuthMeta };

/**
 * Extra metadata that the agent provides for each tool_call / tool_update update.
 */
export type ToolUpdateMeta = {
  claudeCode?: {
    /* The name of the tool that was used in Claude Code. */
    toolName: string;
    /* The structured output provided by Claude Code. */
    toolResponse?: unknown;
  };
  /* Terminal metadata for Bash tool execution, matching codex-acp's _meta protocol. */
  terminal_info?: {
    terminal_id: string;
  };
  terminal_output?: {
    terminal_id: string;
    data: string;
  };
  terminal_exit?: {
    terminal_id: string;
    exit_code: number;
    signal: string | null;
  };
};

export type ToolUseCache = {
  [key: string]: {
    type: "tool_use" | "server_tool_use" | "mcp_tool_use";
    id: string;
    name: string;
    input: unknown;
  };
};

export async function claudeCliPath(): Promise<string> {
  if (process.env.CLAUDE_CODE_EXECUTABLE) {
    return process.env.CLAUDE_CODE_EXECUTABLE;
  }
  // The SDK's CLI is a native binary shipped as a platform-specific optional
  // dependency of @anthropic-ai/claude-agent-sdk. Resolve via a require bound
  // to the SDK so nested installs are found even when npm doesn't hoist.
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  const ext = process.platform === "win32" ? ".exe" : "";
  // On linux, both glibc and musl variants may be installed side-by-side
  // (e.g. bunx hydrates every optional dep), so picking one by trial is
  // unreliable: the wrong binary segfaults at runtime instead of failing to
  // spawn. Detect the runtime libc and prefer the matching variant, falling
  // back to the other only if the preferred one isn't installed.
  const candidates =
    process.platform === "linux"
      ? isMuslLibc()
        ? [
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/claude${ext}`,
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude${ext}`,
          ]
        : [
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude${ext}`,
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/claude${ext}`,
          ]
      : [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${ext}`];
  for (const candidate of candidates) {
    try {
      return req.resolve(candidate);
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `Claude native binary not found for ${process.platform}-${process.arch}. ` +
      `Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set CLAUDE_CODE_EXECUTABLE.`,
  );
}

function isMuslLibc(): boolean {
  // process.report.getReport().header.glibcVersionRuntime is populated when
  // Node is dynamically linked against glibc, and absent on musl.
  const report = process.report?.getReport() as
    { header?: { glibcVersionRuntime?: string } } | undefined;
  return !report?.header?.glibcVersionRuntime;
}

function shouldHideClaudeAuth(): boolean {
  return process.argv.includes("--hide-claude-auth");
}

/** Returned to clients when a prompt or cancel targets a session whose SDK
 *  query stream has already ended (ran to `done` or died). The stream is not
 *  revivable, so the only recovery is a fresh session. */
const SESSION_ENDED_MESSAGE = "The Claude Agent session has ended. Please start a new session.";

// Bypass Permissions doesn't work if we are a root/sudo user
const IS_ROOT = (process.geteuid?.() ?? process.getuid?.()) === 0;
const ALLOW_BYPASS = !IS_ROOT || !!process.env.IS_SANDBOX;

// Slash commands that the SDK handles locally without replaying the user
// message and without invoking the model.
const LOCAL_ONLY_COMMANDS = new Set(["/context", "/heapdump", "/extra-usage"]);

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

// Single-pass scanner that removes each `<tag>…</tag>` marker (matching the
// nearest closing tag of the same name, like a lazy regex would).
function stripMarkerTags(text: string): string {
  const dead = new Set<string>();
  let result = "";
  let copiedUpTo = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "<") {
      const marker = LOCAL_COMMAND_MARKERS.find(
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

/**
 * Return user-message content with local-command marker tags removed, or
 * `null` if nothing meaningful remains (caller should skip the message).
 * Preserves real prose that's mixed in alongside the markers — e.g. a
 * message like `<command-name>…</command-name>hi` becomes `hi`.
 */
export function stripLocalCommandMetadata(content: unknown): unknown | null {
  if (typeof content === "string") {
    const stripped = stripMarkerTags(content);
    return stripped.trim() === "" ? null : stripped;
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
      const stripped = stripMarkerTags((block as { text: string }).text);
      if (stripped.trim() === "") continue;
      kept.push({ ...(block as object), text: stripped });
    } else {
      kept.push(block);
    }
  }
  if (kept.length === 0) return null;
  return kept;
}

export function isLocalCommandMetadata(content: unknown): boolean {
  return stripLocalCommandMetadata(content) === null;
}

const PERMISSION_MODE_ALIASES: Record<string, PermissionMode> = {
  auto: "auto",
  default: "default",
  acceptedits: "acceptEdits",
  dontask: "dontAsk",
  plan: "plan",
  bypasspermissions: "bypassPermissions",
  bypass: "bypassPermissions",
};

export function resolvePermissionMode(
  defaultMode?: unknown,
  logger: Logger = console,
): PermissionMode {
  if (defaultMode === undefined) {
    return "default";
  }

  if (typeof defaultMode !== "string") {
    logger.error("Ignoring permissions.defaultMode from settings: expected a string.");
    return "default";
  }

  const normalized = defaultMode.trim().toLowerCase();
  if (normalized === "") {
    logger.error("Ignoring permissions.defaultMode from settings: expected a non-empty string.");
    return "default";
  }

  const mapped = PERMISSION_MODE_ALIASES[normalized];
  if (!mapped) {
    logger.error(`Ignoring permissions.defaultMode from settings: unknown value '${defaultMode}'.`);
    return "default";
  }

  if (mapped === "bypassPermissions" && !ALLOW_BYPASS) {
    logger.error(
      "Ignoring permissions.defaultMode from settings: bypassPermissions is not available when running as root.",
    );
    return "default";
  }

  return mapped;
}

/**
 * Builds the label for the "Always Allow" permission option so the user can see
 * the exact scope they are committing to. Uses the SDK-provided suggestions
 * when available (e.g. `Bash(npm test:*)`) and falls back to naming the whole
 * tool so "Always Allow" is never a blank check without disclosure.
 */
export function describeAlwaysAllow(
  suggestions: PermissionUpdate[] | undefined,
  toolName: string,
): string {
  if (!suggestions || suggestions.length === 0) {
    return `Always Allow all ${toolName}`;
  }

  const ruleLabels: string[] = [];
  const directories: string[] = [];

  for (const update of suggestions) {
    if (update.type === "addRules" && update.behavior === "allow") {
      for (const rule of update.rules) {
        ruleLabels.push(
          rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : `all ${rule.toolName}`,
        );
      }
    } else if (update.type === "addDirectories") {
      directories.push(...update.directories);
    }
  }

  const parts: string[] = [];
  if (ruleLabels.length > 0) {
    parts.push(ruleLabels.join(", "));
  }
  if (directories.length > 0) {
    parts.push(`access to ${directories.join(", ")}`);
  }

  if (parts.length === 0) {
    return `Always Allow all ${toolName}`;
  }

  return `Always Allow ${parts.join(" and ")}`;
}

/**
 * Client-facing surface the agent calls back into. This is the subset of ACP
 * client methods the agent actually uses, expressed as a narrow interface so
 * tests can supply lightweight mocks. In production it is backed by
 * {@link ClientConnection} over the SDK's typed `AgentContext`.
 */
export interface AcpClient {
  sessionUpdate(params: SessionNotification): Promise<void>;
  /** `signal`, when aborted, sends `$/cancel_request` for the in-flight
   *  permission request so the client can dismiss its prompt (and settle our
   *  await) instead of leaving the dialog open after the turn was cancelled. */
  requestPermission(
    params: RequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse>;
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
  /** `signal`, when aborted, sends `$/cancel_request` for the in-flight
   *  elicitation so the client can dismiss its prompt and settle our await. */
  unstable_createElicitation(
    params: CreateElicitationRequest,
    signal?: AbortSignal,
  ): Promise<CreateElicitationResponse>;
  unstable_completeElicitation(params: CompleteElicitationNotification): Promise<void>;
  /** Send a custom (extension) notification, e.g. `_claude/sdkMessage`. */
  extNotification(method: string, params: Record<string, unknown>): Promise<void>;
}

/**
 * Bridges {@link AcpClient} to the connection-scoped {@link AgentContext}
 * exposed by `AgentApp.connect(...)` as `connection.client`. The peer handle is
 * valid for the entire connection lifetime, so it is captured once at
 * construction.
 */
class ClientConnection implements AcpClient {
  constructor(private readonly ctx: AgentContext) {}

  sessionUpdate(params: SessionNotification): Promise<void> {
    return this.ctx.notify(methods.client.session.update, params);
  }

  requestPermission(
    params: RequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    return this.ctx.request(methods.client.session.requestPermission, params, {
      cancellationSignal: signal,
    });
  }

  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return this.ctx.request(methods.client.fs.readTextFile, params);
  }

  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return this.ctx.request(methods.client.fs.writeTextFile, params);
  }

  unstable_createElicitation(
    params: CreateElicitationRequest,
    signal?: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    return this.ctx.request(methods.client.elicitation.create, params, {
      cancellationSignal: signal,
    });
  }

  unstable_completeElicitation(params: CompleteElicitationNotification): Promise<void> {
    return this.ctx.notify(methods.client.elicitation.complete, params);
  }

  extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    return this.ctx.notify(method, params);
  }
}

export class ClaudeAcpAgent {
  sessions: {
    [key: string]: Session;
  };
  client: AcpClient;
  clientCapabilities?: ClientCapabilities;
  logger: Logger;
  gatewayAuthRequest?: GatewayAuthRequest;
  /** Grace period before a `session/cancel` forces a wedged prompt loop to
   *  return "cancelled". See {@link DEFAULT_FORCE_CANCEL_GRACE_MS}. Mutable so
   *  tests can shrink it. */
  forceCancelGraceMs: number = DEFAULT_FORCE_CANCEL_GRACE_MS;

  constructor(client: AcpClient, logger?: Logger) {
    this.sessions = {};
    this.client = client;
    this.logger = logger ?? console;
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = request.clientCapabilities;

    // Bypasses standard auth by routing requests through a custom Anthropic-protocol gateway.
    // Only offered when the client advertises `auth._meta.gateway` capability.
    const supportsGatewayAuth = request.clientCapabilities?.auth?._meta?.gateway === true;

    const gatewayAuthMethod: AuthMethod = {
      id: "gateway",
      name: "Custom model gateway",
      description: "Use a custom gateway to authenticate and access models",
      _meta: {
        gateway: {
          protocol: "anthropic",
        },
      },
    };

    const gatewayBedrockAuthMethod: AuthMethod = {
      id: "gateway-bedrock",
      name: "Custom model gateway",
      description: "Use a custom gateway to authenticate and access models",
      _meta: {
        gateway: {
          protocol: "bedrock",
        },
      },
    };

    const supportsTerminalAuth = request.clientCapabilities?.auth?.terminal === true;
    const supportsMetaTerminalAuth = request.clientCapabilities?._meta?.["terminal-auth"] === true;

    // Detect remote environments where the OAuth browser redirect to localhost
    // won't work. This matches the SDK's internal isRemote check. In these cases,
    // the `auth login` subcommand would fall back to a device-code-like manual
    // flow, which doesn't work well over ACP, so we offer the TUI login instead.
    const isRemote = !!(
      process.env.NO_BROWSER ||
      process.env.SSH_CONNECTION ||
      process.env.SSH_CLIENT ||
      process.env.SSH_TTY ||
      process.env.CLAUDE_CODE_REMOTE
    );
    const terminalAuthMethods: AuthMethod[] = [];

    if (isRemote) {
      const remoteLoginMethod: AuthMethod = {
        description: "Run `claude /login` in the terminal",
        name: "Log in with Claude",
        id: "claude-login",
        type: "terminal",
        args: ["--cli"],
      };

      if (supportsMetaTerminalAuth) {
        remoteLoginMethod._meta = {
          "terminal-auth": {
            command: process.execPath,
            args: [...process.argv.slice(1), "--cli"],
            label: "Claude Login",
          },
        };
      }

      if (!shouldHideClaudeAuth() && (supportsTerminalAuth || supportsMetaTerminalAuth)) {
        terminalAuthMethods.push(remoteLoginMethod);
      }
    } else {
      const claudeLoginMethod: AuthMethod = {
        description: "Use Claude subscription ",
        name: "Claude Subscription",
        id: "claude-ai-login",
        type: "terminal",
        args: ["--cli", "auth", "login", "--claudeai"],
      };

      const consoleLoginMethod: AuthMethod = {
        description: "Use Anthropic Console (API usage billing)",
        name: "Anthropic Console",
        id: "console-login",
        type: "terminal",
        args: ["--cli", "auth", "login", "--console"],
      };

      if (supportsMetaTerminalAuth) {
        const baseArgs = process.argv.slice(1);
        claudeLoginMethod._meta = {
          "terminal-auth": {
            command: process.execPath,
            args: [...baseArgs, "--cli", "auth", "login", "--claudeai"],
            label: "Claude Login",
          },
        };
        consoleLoginMethod._meta = {
          "terminal-auth": {
            command: process.execPath,
            args: [...baseArgs, "--cli", "auth", "login", "--console"],
            label: "Anthropic Console Login",
          },
        };
      }

      if (!shouldHideClaudeAuth() && (supportsTerminalAuth || supportsMetaTerminalAuth)) {
        terminalAuthMethods.push(claudeLoginMethod);
      }
      if (supportsTerminalAuth || supportsMetaTerminalAuth) {
        terminalAuthMethods.push(consoleLoginMethod);
      }
    }

    return {
      protocolVersion: 1,
      agentCapabilities: {
        _meta: {
          claudeCode: {
            promptQueueing: true,
          },
        },
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        auth: {
          logout: {},
        },
        loadSession: true,
        sessionCapabilities: {
          additionalDirectories: {},
          close: {},
          delete: {},
          fork: {},
          list: {},
          resume: {},
        },
      },
      agentInfo: {
        name: packageJson.name,
        title: "Claude Agent",
        version: packageJson.version,
      },
      authMethods: [
        ...terminalAuthMethods,
        ...(supportsGatewayAuth ? [gatewayAuthMethod, gatewayBedrockAuthMethod] : []),
      ],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const response = await this.createSession(params, {
      // Revisit these meta values once we support resume
      resume: (params._meta as NewSessionMeta | undefined)?.claudeCode?.options?.resume,
    });
    // Needs to happen after we return the session
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(response.sessionId);
    }, 0);
    return response;
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    const response = await this.createSession(
      {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        additionalDirectories: params.additionalDirectories,
        _meta: params._meta,
      },
      {
        resume: params.sessionId,
        forkSession: true,
      },
    );
    // Needs to happen after we return the session
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(response.sessionId);
    }, 0);
    return response;
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const result = await this.getOrCreateSession(params);

    // Needs to happen after we return the session
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(params.sessionId);
    }, 0);
    return result;
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const result = await this.getOrCreateSession(params);

    await this.replaySessionHistory(params.sessionId);

    // Send available commands after replay so it doesn't interleave with history
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(params.sessionId);
    }, 0);

    return result;
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const sdk_sessions = await listSessions({ dir: params.cwd ?? undefined });
    const sessions = [];

    for (const session of sdk_sessions) {
      if (!session.cwd) continue;
      sessions.push({
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: sanitizeTitle(session.summary),
        updatedAt: new Date(session.lastModified).toISOString(),
      });
    }
    return {
      sessions,
    };
  }

  /** Read the SDK-maintained title for a session and, if it changed since the
   *  last time we looked, notify the client with a `session_info_update`. The
   *  SDK has no push event for the title it auto-generates in the background, so
   *  we pull it at turn-end. A missing session file or read error is non-fatal:
   *  the title is best-effort and another turn will retry. */
  private async maybeUpdateSessionTitle(sessionId: string, session: Session): Promise<void> {
    let info;
    try {
      info = await getSessionInfo(sessionId, { dir: session.cwd });
    } catch (error) {
      this.logger.error(`Session ${sessionId}: failed to read session info: ${error}`);
      return;
    }
    // `customTitle` is a user-set `/rename`; `summary` is the auto-generated
    // title (or first prompt). Prefer the explicit title when present.
    const rawTitle = info?.customTitle ?? info?.summary;
    if (!rawTitle) {
      return;
    }
    const title = sanitizeTitle(rawTitle);
    if (title === session.lastTitle) {
      return;
    }
    session.lastTitle = title;
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title,
        updatedAt: new Date(info!.lastModified).toISOString(),
      },
    });
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    if (_params.methodId === "gateway" || _params.methodId === "gateway-bedrock") {
      this.gatewayAuthRequest = _params as GatewayAuthRequest;
      return;
    }
    throw new Error("Method not implemented.");
  }

  async logout(_params: LogoutRequest): Promise<void> {
    // Clear in-memory gateway credentials supplied via `authenticate`. The
    // gateway method never touches the on-disk credential store, so dropping
    // this reference is the whole logout for that path.
    this.gatewayAuthRequest = undefined;

    // For the Claude/Console login methods the credentials live in the native
    // CLI's store (keychain or config dir), which only the binary can clear.
    // `claude auth logout` is non-interactive and idempotent.
    const cliPath = await claudeCliPath();
    try {
      await execFileAsync(cliPath, ["auth", "logout"]);
    } catch (error) {
      const stderr =
        typeof error === "object" && error && "stderr" in error
          ? String((error as { stderr: unknown }).stderr).trim()
          : undefined;
      throw RequestError.internalError(
        { stderr: stderr || undefined },
        `claude auth logout failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    // The SDK query stream already terminated (see `queryClosed`); its iterator
    // can't be revived, so enqueueing here would hang on a deferred that never
    // settles. Fail clearly and let the client start a fresh session.
    if (session.queryClosed) {
      throw RequestError.internalError(undefined, SESSION_ENDED_MESSAGE);
    }

    const userMessage = promptToClaude(params);
    const promptUuid = randomUUID();
    userMessage.uuid = promptUuid;

    // Local-only commands (e.g. `/clear`) return a result without replaying the
    // user message, so the consumer can't promote the turn from the echo.
    const firstText = params.prompt[0]?.type === "text" ? params.prompt[0].text : "";
    const isLocalOnlyCommand =
      firstText.startsWith("/") && LOCAL_ONLY_COMMANDS.has(firstText.split(" ", 1)[0]);

    // Each prompt is a Turn whose deferred the persistent consumer settles once
    // the turn's outcome is known. `prompt()` owns no loop: it enqueues the
    // turn, pushes the user message onto the streaming input, makes sure the
    // consumer is running, and awaits the deferred.
    const turn: Turn = {
      promptUuid,
      isLocalOnlyCommand,
      settled: false,
      resolve: () => {},
      reject: () => {},
    };
    const response = new Promise<PromptResponse>((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    });

    session.turnQueue ??= [];
    session.turnQueue.push(turn);
    session.input.push(userMessage);
    this.ensureConsumer(session, params.sessionId);
    return response;
  }

  /** Lazily start the per-session consumer that drains the SDK query stream for
   *  the session's whole life. Idempotent: only the first `prompt()` starts it. */
  private ensureConsumer(session: Session, sessionId: string): void {
    if (session.consumer) {
      return;
    }
    // Wake-up channel so cancel() can force the consumer to settle the active
    // turn "cancelled" even when query.next() is wedged and never yields again
    // (issue #680). The consumer re-arms it after each fire.
    session.cancelController = new AbortController();
    session.consumer = this.runConsumer(session, { sessionId });
    session.consumer.catch((error) => {
      this.logger.error(`Session ${sessionId}: consumer terminated unexpectedly: ${error}`);
    });
  }

  /** The single, long-lived consumer of the SDK query stream for a session. It
   *  forwards every message as ACP `sessionUpdate`s (so background/between-turn
   *  output streams live, not just while a prompt is awaiting) and settles each
   *  Turn's deferred when that turn ends. Replaces the per-prompt message loop;
   *  `params` only carries the (session-invariant) `sessionId`. */
  private async runConsumer(session: Session, params: { sessionId: string }): Promise<void> {
    // Per-turn scratch, reset whenever a turn becomes active. Kept as consumer
    // locals (rather than per-Turn fields) because they describe the message
    // currently being processed, which is sequential — exactly one turn is
    // active at a time. Mirrors the locals the old per-prompt loop held.
    let lastAssistantTotalUsage: number | null = null;
    let lastAssistantUsage: UsageSnapshot | null = null;
    let lastAssistantModel: string | null = null;
    // When the Claude SDK classifies a turn as failed (e.g. rate limit, auth
    // problem, billing), it sets a categorical `error` field on the
    // `SDKAssistantMessage` that precedes the final `result` message. We capture
    // it here so the subsequent `RequestError.internalError` can forward it to
    // clients as structured `data`, sparing them from pattern-matching on text.
    let lastAssistantError: SDKAssistantMessageError | undefined;
    // When a streaming classifier refuses a turn, the assistant message carries
    // stop_reason "refusal" and structured stop_details. We capture the
    // human-readable explanation so the terminal `result` can surface it.
    let lastRefusalExplanation: string | null = null;
    // Tracks whether we're inside a compaction. The SDK emits the terminal
    // `status` (compact_result success/failed) twice for a single failed
    // compaction, and the two messages are indistinguishable — so we report the
    // outcome only while a compaction is in progress, then clear this.
    let compactionInProgress = false;
    // Anthropic API message id of the assistant message currently being
    // streamed, captured from `message_start` so the streamed chunks that follow
    // (whose delta events don't carry it) can all be tagged with the same,
    // replay-stable id.
    let currentStreamMessageId: string | undefined;
    // The text/thinking blocks that have actually streamed live as
    // `stream_event` deltas for the message the next consolidated `assistant`
    // will repeat, in stream order, each accumulated to its full streamed text.
    // The consolidated handler diffs each assembled block against these and
    // forwards only the un-streamed remainder — nothing if it streamed in full
    // (the common case), the whole block if it never streamed (a non-streaming
    // gateway), or just the tail if the stream was cut short mid-block. Matching
    // on content rather than the Anthropic message id makes dedupe robust to
    // gateways that don't carry a stable/matching id across the stream and the
    // consolidated message. Reset after each consolidated message consumes it.
    const streamedBlocks: { index: number; type: "text" | "thinking"; text: string }[] = [];
    // Stop reason accumulated for the active turn (result subtype, refusal,
    // max_tokens, …). Reset per turn; read when the turn settles at idle.
    let stopReason: StopReason = "end_turn";

    const resetTurnScratch = () => {
      lastAssistantTotalUsage = null;
      lastAssistantUsage = null;
      lastAssistantModel = null;
      lastAssistantError = undefined;
      lastRefusalExplanation = null;
      compactionInProgress = false;
      // Do NOT reset currentStreamMessageId or streamedBlocks here. Turn
      // activation can fire mid-message (the replayed user echo with
      // --replay-user-messages lands between a message's blocks); clearing the
      // streamed-content record on activation would drop the blocks that
      // streamed before the echo, so the consolidated assistant message would
      // re-emit them as duplicates. streamedBlocks is bounded instead by being
      // cleared when each consolidated message consumes it. #785 stopped
      // resetting the streamed-content tracking here but left this line.
      stopReason = "end_turn";
      session.accumulatedUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      };
    };

    /** Promote a queued turn to active: it becomes the one output is attributed
     *  to, and its scratch starts fresh. Clears the cancelled flag so a turn
     *  enqueued after a prior cancel isn't treated as cancelled. Also clears any
     *  leftover orphan-skip count: since the SDK echoes/runs input FIFO, every
     *  orphan from a prior cancel has already arrived by the time a live turn
     *  activates, so a non-zero remainder means the SDK dropped a queued turn on
     *  interrupt (no orphan emitted) — drop the stale count so a later echo-less
     *  result isn't wrongly skipped. */
    const activateTurn = (turn: Turn) => {
      session.activeTurn = turn;
      session.cancelled = false;
      session.pendingOrphanResults = 0;
      resetTurnScratch();
    };

    /** Ensure there is an active turn before a user-turn result that carries no
     *  echo to activate it, by promoting the queue head. Most turns are
     *  activated by their replayed user message before their result, but some
     *  legitimately produce a result with no matching echo: local-only commands
     *  (e.g. `/context`) and compaction (`/compact`, whose only user messages
     *  are the generated summary and a `<local-command-stdout>` replay — neither
     *  carries the prompt's uuid). Promoting the head settles those.
     *
     *  But an echo-less result can also be an ORPHAN: cancel() settles+removes a
     *  queued turn whose user message was already pushed, so the SDK still runs
     *  it and emits a result with no uuid to match. Promoting the head for an
     *  orphan would misattribute its stop reason/usage to an unrelated later
     *  prompt. `session.pendingOrphanResults` counts exactly how many such
     *  orphans are still expected (FIFO, they arrive before any live turn's
     *  result), so we skip those and only promote once the count is drained. */
    const ensureActiveTurn = () => {
      if (session.activeTurn) {
        return;
      }
      const head = (session.turnQueue ?? []).find((t) => !t.settled);
      if (!head) {
        return;
      }
      if ((session.pendingOrphanResults ?? 0) > 0) {
        session.pendingOrphanResults!--;
        return;
      }
      activateTurn(head);
    };

    /** Settle the active turn's deferred exactly once, disarm the force-cancel
     *  backstop (the turn is over), and drop it from the queue. */
    const settleActive = (result: PromptResponse) => {
      const turn = session.activeTurn;
      if (!turn || turn.settled) {
        return;
      }
      turn.settled = true;
      if (session.forceCancelTimer) {
        clearTimeout(session.forceCancelTimer);
        session.forceCancelTimer = undefined;
      }
      session.turnQueue = (session.turnQueue ?? []).filter((t) => t !== turn);
      session.activeTurn = null;
      turn.resolve(result);
    };

    /** Reject the active turn (auth required, error result, …) without tearing
     *  down the consumer: the stream continues to idle and later turns proceed. */
    const failActive = (error: unknown) => {
      if (session.forceCancelTimer) {
        clearTimeout(session.forceCancelTimer);
        session.forceCancelTimer = undefined;
      }
      const turn = session.activeTurn;
      if (!turn || turn.settled) {
        return;
      }
      turn.settled = true;
      session.turnQueue = (session.turnQueue ?? []).filter((t) => t !== turn);
      session.activeTurn = null;
      turn.reject(error);
    };

    /** Reject every in-flight turn — used when the stream dies. */
    const failAllTurns = (error: unknown) => {
      if (session.forceCancelTimer) {
        clearTimeout(session.forceCancelTimer);
        session.forceCancelTimer = undefined;
      }
      const turns = session.activeTurn
        ? [session.activeTurn, ...(session.turnQueue ?? []).filter((t) => t !== session.activeTurn)]
        : [...(session.turnQueue ?? [])];
      session.activeTurn = null;
      session.turnQueue = [];
      for (const turn of turns) {
        if (!turn.settled) {
          turn.settled = true;
          turn.reject(error);
        }
      }
    };

    // The wake-up channel cancel()/teardown aborts to force the active turn to
    // settle "cancelled" even when query.next() is wedged (issue #680). Re-armed
    // after each fire so the consumer keeps serving later turns.
    let cancelController = session.cancelController!;

    try {
      while (true) {
        const nextMessage = session.query.next();
        // Fresh abort listener per iteration, removed when next() wins, so a
        // long-lived session doesn't accumulate listeners on one signal.
        let onAbort!: () => void;
        const abortRace = new Promise<"abort">((resolve) => {
          onAbort = () => resolve("abort");
          cancelController.signal.addEventListener("abort", onAbort, { once: true });
        });
        const raced = await Promise.race([
          nextMessage.then((result) => ({ kind: "message" as const, result })),
          abortRace,
        ]);
        cancelController.signal.removeEventListener("abort", onAbort);

        if (raced === "abort") {
          // cancel()/teardown woke us. Abandon the in-flight next() (swallowing
          // any later rejection so it can't surface as unhandled) and settle the
          // active turn "cancelled" per the ACP contract. If the session is
          // being torn down, stop; otherwise re-arm and keep consuming.
          void nextMessage.catch(() => {});
          settleActive({ stopReason: "cancelled" });
          if (!this.sessions[params.sessionId]) {
            return;
          }
          cancelController = new AbortController();
          session.cancelController = cancelController;
          continue;
        }

        const { value: message, done } = raced.result as IteratorResult<SDKMessage, void>;

        if (done || !message) {
          // The stream ended. Settle the in-flight turns FIRST, then release the
          // stream resources — same order as the error paths (failAllTurns before
          // closeQueryStream). Settling is the user-facing contract; resource
          // release is best-effort cleanup, so a throw there must not pre-empt a
          // turn's real outcome.
          //
          // Settle the turn that was in flight so its prompt() doesn't hang:
          // cancelled if a cancel is pending, otherwise the accumulated outcome.
          settleActive(
            session.cancelled
              ? { stopReason: "cancelled" }
              : { stopReason, usage: sessionUsage(session) },
          );
          // Queued turns the SDK never started never ran, so reject them rather
          // than reporting a success (end_turn) — or a misleading "cancelled" —
          // for a prompt that produced no output. (A cancel already settled the
          // turns that were queued at cancel time and removed them, so anything
          // still here was enqueued afterward and was not part of the cancel.)
          for (const queued of [...(session.turnQueue ?? [])]) {
            if (!queued.settled) {
              queued.settled = true;
              queued.reject(RequestError.internalError(undefined, SESSION_ENDED_MESSAGE));
            }
          }
          session.turnQueue = [];
          // The query iterator can't be revived, so close the session's stream
          // (marks queryClosed, drops the consumer handle, releases the dead
          // subprocess/settings resources) — a later prompt() then rejects up
          // front rather than restarting a consumer on the exhausted stream.
          this.closeQueryStream(session);
          return;
        }

        if (
          session.emitRawSDKMessages &&
          shouldEmitRawMessage(session.emitRawSDKMessages, message)
        ) {
          await this.client.extNotification("_claude/sdkMessage", {
            sessionId: params.sessionId,
            message: message as Record<string, unknown>,
          });
        }

        switch (message.type) {
          case "system":
            switch (message.subtype) {
              case "init":
                break;
              case "status": {
                if (message.status === "compacting") {
                  compactionInProgress = true;
                  await this.client.sessionUpdate({
                    sessionId: message.session_id,
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "Compacting..." },
                    },
                  });
                } else if (message.compact_result === "success" && compactionInProgress) {
                  // The SDK signals manual `/compact` completion with a status
                  // message carrying `compact_result`, not the `compact_boundary`
                  // message (which only fires when there's content to compact).
                  compactionInProgress = false;
                  await this.client.sessionUpdate({
                    sessionId: message.session_id,
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "\n\nCompacting completed." },
                    },
                  });
                } else if (message.compact_result === "failed" && compactionInProgress) {
                  compactionInProgress = false;
                  const reason = message.compact_error ? `: ${message.compact_error}` : ".";
                  await this.client.sessionUpdate({
                    sessionId: message.session_id,
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: `\n\nCompacting failed${reason}` },
                    },
                  });
                }
                break;
              }
              case "compact_boundary": {
                // Refresh the displayed usage immediately so the client doesn't
                // keep showing the stale pre-compaction size (e.g. "944k/1m")
                // right after the user sees "Compacting completed", which is
                // confusing and wrong.
                //
                // Prefer the SDK's authoritative post-compaction `used` via
                // getContextUsage — it reflects the real retained context
                // (system prompt + tools + surviving messages), which the
                // per-message API usage numbers can't give us until the next
                // turn's result. If the control request fails, fall back to the
                // used:0 approximation: directionally correct (context just
                // dropped dramatically) and replaced within seconds by the next
                // result message.
                //
                // `size` keeps coming from session.contextWindowSize (learned
                // from modelUsage / the model heuristic) — getContextUsage's
                // window field under-reports extended 1M windows.
                //
                // The "Compacting completed." text is emitted from the `status`
                // handler (keyed on `compact_result`), not here, so the failure
                // path gets a message too.
                const usedTokens = await fetchContextUsedTokens(session.query, this.logger);
                lastAssistantUsage = null;
                lastAssistantTotalUsage = usedTokens ?? 0;
                await this.client.sessionUpdate({
                  sessionId: message.session_id,
                  update: {
                    sessionUpdate: "usage_update",
                    used: lastAssistantTotalUsage,
                    size: session.contextWindowSize,
                  },
                });
                break;
              }
              case "local_command_output": {
                await this.client.sessionUpdate({
                  sessionId: message.session_id,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: message.content },
                  },
                });
                break;
              }
              case "session_state_changed": {
                if (message.state === "idle") {
                  // A non-cancelled turn already settled at its terminal
                  // `result` (issue #773), so this trailing `idle` is just
                  // absorbed. We must NOT settle `activeTurn` here in that case:
                  // `idle` carries no turn identity, and it can lag (the SDK
                  // flushes held-back results / drains background agents first),
                  // so by the time it arrives the SDK may have echoed the NEXT
                  // turn and activated it — settling now would resolve that new
                  // turn prematurely with end_turn and ~zero usage, dropping its
                  // real result. Only a cancelled turn relies on `idle`: its
                  // `result` is dropped at the `session.cancelled` guard, so it
                  // never settles at a result and must settle here.
                  if (session.cancelled) {
                    settleActive({ stopReason: "cancelled" });
                  }
                  // The SDK generates the session title in a background task and
                  // persists it to the session file; `idle` is the turn-over
                  // signal, so it's the point at which a new title may have
                  // landed. Push it to the client if it changed.
                  await this.maybeUpdateSessionTitle(params.sessionId, session);
                }
                break;
              }
              case "memory_recall": {
                const isSynthesis = message.mode === "synthesize";
                const locations = isSynthesis
                  ? []
                  : message.memories.map((m) => ({ path: m.path }));
                const content = isSynthesis
                  ? message.memories
                      .filter(
                        (m): m is (typeof message.memories)[number] & { content: string } =>
                          typeof m.content === "string",
                      )
                      .map((m) => ({
                        type: "content" as const,
                        content: { type: "text" as const, text: m.content },
                      }))
                  : [];
                const count = message.memories.length;
                const title = isSynthesis
                  ? "Recalled synthesized memory"
                  : `Recalled ${count} ${count === 1 ? "memory" : "memories"}`;
                await this.client.sessionUpdate({
                  sessionId: message.session_id,
                  update: {
                    sessionUpdate: "tool_call",
                    toolCallId: message.uuid,
                    title,
                    kind: "read",
                    status: "completed",
                    ...(locations.length > 0 && { locations }),
                    ...(content.length > 0 && { content }),
                    _meta: {
                      claudeCode: {
                        toolName: "memory_recall",
                        toolResponse: { mode: message.mode },
                      },
                    } satisfies ToolUpdateMeta,
                  },
                });
                break;
              }
              case "commands_changed": {
                // Push the full slash-command list after a mid-session change
                // (e.g. skills discovered dynamically as the agent works in a
                // subdirectory). The client should REPLACE its cached command
                // list with this payload: supportedCommands() is captured once
                // at initialize and never reflects mid-session changes, so we
                // forward message.commands directly rather than re-querying.
                await this.client.sessionUpdate({
                  sessionId: message.session_id,
                  update: {
                    sessionUpdate: "available_commands_update",
                    availableCommands: getAvailableSlashCommands(message.commands),
                  },
                });
                break;
              }
              case "mirror_error": {
                // The SDK failed to persist session history (SessionStore
                // append rejected/timed out after retry) — potential data loss
                // the user should know about rather than a silent gap on
                // resume. Log it and surface a warning in the conversation.
                this.logger.error(
                  `Session ${message.session_id}: failed to persist history: ${message.error}`,
                );
                break;
              }
              case "permission_denied": {
                // A tool call was auto-denied (by a rule, the classifier,
                // dontAsk mode, etc.) before running. The tool_use block was
                // already emitted as a `tool_call`, so mark it failed with the
                // rejection reason — otherwise the client shows a tool call
                // that silently never resolves.
                const reason = message.decision_reason ?? message.message;
                await this.client.sessionUpdate({
                  sessionId: message.session_id,
                  update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: message.tool_use_id,
                    status: "failed",
                    content: [
                      {
                        type: "content",
                        content: { type: "text", text: `Permission denied: ${reason}` },
                      },
                    ],
                    _meta: {
                      claudeCode: {
                        toolName: message.tool_name,
                        toolResponse: {
                          decisionReasonType: message.decision_reason_type,
                          decisionReason: message.decision_reason,
                          message: message.message,
                        },
                      },
                    } satisfies ToolUpdateMeta,
                  },
                });
                break;
              }
              case "informational": {
                // Free-form notice from the SDK (e.g. why a UserPromptSubmit/Stop
                // hook blocked continuation). Surface the text so the user sees it
                // instead of a silent stop. ACP's agent_message_chunk has no
                // severity field, so fold the level into the text for the more
                // prominent levels ('info' is transcript-only noise — leave plain).
                const text =
                  message.level === "info"
                    ? message.content
                    : `**${message.level[0].toUpperCase()}${message.level.slice(1)}:** ${message.content}`;
                await this.client.sessionUpdate({
                  sessionId: message.session_id,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text },
                  },
                });
                break;
              }
              case "hook_started":
              case "hook_progress":
              case "hook_response":
              case "files_persisted":
              case "task_started":
              case "task_notification":
              case "task_progress":
              case "task_updated":
                break;
              case "worker_shutting_down":
                // A Remote Control worker announced a graceful teardown. This is a
                // live-tail signal for remote clients to explain why a session went
                // away; it's not meaningful for a local stdio ACP session.
                break;
              case "elicitation_complete": {
                // A url-mode MCP elicitation finished server-side. Let the client
                // dismiss any UI it opened for it. Only meaningful when the
                // client supports url elicitation; ignore failures otherwise.
                if (this.clientCapabilities?.elicitation?.url) {
                  try {
                    await this.client.unstable_completeElicitation({
                      elicitationId: message.elicitation_id,
                    });
                  } catch (error) {
                    this.logger.error(`Failed to complete elicitation: ${error}`);
                  }
                }
                break;
              }
              case "plugin_install":
              case "notification":
              case "api_retry":
              case "thinking_tokens":
              case "model_refusal_fallback":
              case "model_refusal_no_fallback":
                // Todo: process via status api: https://docs.claude.com/en/docs/claude-code/hooks#hook-output
                break;
              default:
                unreachable(message, this.logger);
                break;
            }
            break;
          case "result": {
            // Task-notification followups are autonomous work triggered by a
            // task-notification system message, not by the user's prompt.
            // They should not influence the user-turn lifecycle (stop reason,
            // slash-command output forwarding) but their cost is real.
            const isTaskNotification = message.origin?.kind === "task-notification";

            // A user-turn result needs an active turn so its stop reason is
            // attributed and the turn settles at idle. Local-only commands carry
            // no user-message echo to promote them, so do it here from the head.
            // Promote BEFORE accumulating usage, since activation resets the
            // accumulator — promoting after would discard this result's tokens.
            if (!isTaskNotification) {
              ensureActiveTurn();
            }

            // Accumulate usage into the user turn's tally. Skip task-notification
            // followups: their cost is real but is reported separately via the
            // usage_update below, and `session.accumulatedUsage` is only reset on
            // turn activation — so folding a task-notification result that lands
            // after the next turn is active (but before it settles) would leak
            // those tokens into that turn's PromptResponse.usage.
            if (!isTaskNotification) {
              session.accumulatedUsage.inputTokens += message.usage.input_tokens;
              session.accumulatedUsage.outputTokens += message.usage.output_tokens;
              session.accumulatedUsage.cachedReadTokens += message.usage.cache_read_input_tokens;
              session.accumulatedUsage.cachedWriteTokens +=
                message.usage.cache_creation_input_tokens;
            }

            const matchingModelUsage = lastAssistantModel
              ? getMatchingModelUsage(message.modelUsage, lastAssistantModel)
              : null;
            // Only overwrite when we have an authoritative value — a miss
            // (e.g. a turn with no top-level assistant message) would
            // otherwise discard the window learned on a prior turn and
            // leave the next prompt's mid-stream updates reporting 200k.
            if (matchingModelUsage) {
              session.contextWindowSize = matchingModelUsage.contextWindow;
            }

            // Send usage_update notification
            if (lastAssistantTotalUsage !== null) {
              await this.client.sessionUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "usage_update",
                  used: lastAssistantTotalUsage,
                  size: session.contextWindowSize,
                  cost: {
                    amount: message.total_cost_usd,
                    currency: "USD",
                  },
                  ...(message.origin && {
                    _meta: { "_claude/origin": message.origin },
                  }),
                },
              });
            }

            if (session.cancelled) {
              if (!isTaskNotification) {
                stopReason = "cancelled";
              }
              break;
            }

            // A refusal can arrive on any result subtype (and may even set
            // is_error), so handle it before the subtype switch — otherwise the
            // is_error throw below would surface it as an internal error. The
            // refused assistant message carries no visible content, so surface
            // the classifier's explanation (when available) and report ACP's
            // dedicated `refusal` stop reason.
            if (message.stop_reason === "refusal" && !isTaskNotification) {
              if (lastRefusalExplanation) {
                await this.client.sessionUpdate({
                  sessionId: params.sessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: lastRefusalExplanation },
                  },
                });
              }
              stopReason = "refusal";
              settleActive({ stopReason: "refusal", usage: sessionUsage(session) });
              break;
            }

            switch (message.subtype) {
              case "success": {
                if (message.result.includes("Please run /login")) {
                  failActive(RequestError.authRequired());
                  break;
                }
                if (message.stop_reason === "max_tokens") {
                  if (!isTaskNotification) {
                    stopReason = "max_tokens";
                  }
                  break;
                }
                if (message.is_error) {
                  failActive(
                    RequestError.internalError(errorKindData(lastAssistantError), message.result),
                  );
                  break;
                }
                // For local-only commands (no model invocation), the result
                // text is the command output — forward it to the client.
                // Task-notification followups never originate from a user
                // slash command, so skip the forwarding for them.
                if (session.activeTurn?.isLocalOnlyCommand && !isTaskNotification) {
                  for (const notification of toAcpNotifications(
                    message.result,
                    "assistant",
                    params.sessionId,
                    session.toolUseCache,
                    this.client,
                    this.logger,
                  )) {
                    await this.client.sessionUpdate(notification);
                  }
                }
                break;
              }
              case "error_during_execution": {
                if (message.stop_reason === "max_tokens") {
                  if (!isTaskNotification) {
                    stopReason = "max_tokens";
                  }
                  break;
                }
                if (message.is_error) {
                  failActive(
                    RequestError.internalError(
                      errorKindData(lastAssistantError),
                      message.errors.join(", ") || message.subtype,
                    ),
                  );
                  break;
                }
                if (!isTaskNotification) {
                  stopReason = "end_turn";
                }
                break;
              }
              case "error_max_budget_usd":
              case "error_max_turns":
              case "error_max_structured_output_retries":
                if (message.is_error) {
                  failActive(
                    RequestError.internalError(
                      errorKindData(lastAssistantError),
                      message.errors.join(", ") || message.subtype,
                    ),
                  );
                  break;
                }
                if (!isTaskNotification) {
                  stopReason = "max_turn_requests";
                }
                break;
              default:
                unreachable(message, this.logger);
                break;
            }
            // Settle the user turn at its terminal result so the client unlocks
            // as soon as the answer is done, rather than waiting for the SDK's
            // trailing `idle` (which can lag while background work runs — issue
            // #773). The consumer keeps draining afterward (absorbing idle and
            // forwarding any background output). is_error/auth already settled
            // via failActive; cancellation is left to the idle/abort path.
            // settleActive is idempotent, so a duplicate idle is a no-op.
            if (!isTaskNotification && !session.cancelled) {
              settleActive({ stopReason, usage: sessionUsage(session) });
            }
            break;
          }
          case "stream_event": {
            // `message_start` carries the Anthropic API message id; capture it
            // so the streamed chunks that follow (whose delta events don't carry
            // it) can all be tagged with the same, replay-stable id.
            if (message.event.type === "message_start") {
              currentStreamMessageId = message.event.message.id || undefined;
              // A new top-level message starts: clear any streamed-content
              // residue from a prior message that never reached its
              // consolidated reset — a cancelled turn breaks out before the
              // reset, and the synthetic-auth/system/local-command paths
              // `break` early too. Block indices restart at 0 each message, so
              // leftover entries would otherwise collide with this message's
              // blocks and re-emit (or truncate) already-streamed text. Gated on
              // `parent_tool_use_id === null` so a subagent stream can't clear
              // the top-level record. Fires once, before any of this message's
              // blocks, so it doesn't disturb the mid-message turn-activation
              // path the way resetting on turn activation would.
              if (message.parent_tool_use_id === null) {
                streamedBlocks.length = 0;
              }
            }
            // Accumulate the text/thinking actually streamed live, so the
            // `assistant` case below can diff its assembled blocks against what
            // already reached the client as chunks and forward only the
            // remainder. Gated on `parent_tool_use_id === null` so a subagent
            // stream can't attribute its content to the top-level message.
            // Contiguous deltas of the same block (same index and type) extend
            // the current entry; anything else opens a new one.
            if (
              message.parent_tool_use_id === null &&
              message.event.type === "content_block_delta"
            ) {
              const delta = message.event.delta;
              const chunk =
                delta.type === "text_delta"
                  ? { type: "text" as const, text: delta.text }
                  : delta.type === "thinking_delta"
                    ? { type: "thinking" as const, text: delta.thinking }
                    : undefined;
              // Skip empty deltas (some gateways emit empty thinking chunks —
              // #793): appending "" is a no-op, but pushing a "" entry would
              // create a block the consolidated handler's `text.length > 0`
              // guard can never consume, stalling the diff cursor and
              // re-emitting the next block as a duplicate.
              if (chunk && chunk.text.length > 0) {
                const index = message.event.index;
                const last = streamedBlocks[streamedBlocks.length - 1];
                if (last && last.index === index && last.type === chunk.type) {
                  last.text += chunk.text;
                } else {
                  streamedBlocks.push({ index, type: chunk.type, text: chunk.text });
                }
              }
            }
            if (
              message.parent_tool_use_id === null &&
              (message.event.type === "message_start" || message.event.type === "message_delta")
            ) {
              if (message.event.type === "message_start") {
                lastAssistantUsage = snapshotFromUsage(message.event.message.usage);
                const model = message.event.message.model;
                if (model && model !== "<synthetic>") {
                  lastAssistantModel = model;
                  // Only upgrade from the default — once a `result` has given
                  // us an authoritative window, trust it over the heuristic.
                  // Model switches invalidate the cached window via
                  // `syncSessionConfigState`, which resets us back to the
                  // default so this branch runs again for the new model.
                  if (session.contextWindowSize === DEFAULT_CONTEXT_WINDOW) {
                    const inferred = inferContextWindowFromModel(model);
                    if (inferred !== null) {
                      session.contextWindowSize = inferred;
                    }
                  }
                }
              } else {
                const usage = message.event.usage;
                const prev: Readonly<UsageSnapshot> = lastAssistantUsage ?? ZERO_USAGE;
                // Per Anthropic API, message_delta usage fields are *cumulative*;
                // nullable fields (input_tokens and the cache fields) fall back
                // to the prior snapshot when the server omits them from this
                // delta. Only output_tokens is guaranteed non-null.
                lastAssistantUsage = {
                  input_tokens: usage.input_tokens ?? prev.input_tokens,
                  output_tokens: usage.output_tokens,
                  cache_read_input_tokens:
                    usage.cache_read_input_tokens ?? prev.cache_read_input_tokens,
                  cache_creation_input_tokens:
                    usage.cache_creation_input_tokens ?? prev.cache_creation_input_tokens,
                };
              }

              const nextUsage = totalTokens(lastAssistantUsage);
              if (nextUsage !== lastAssistantTotalUsage) {
                lastAssistantTotalUsage = nextUsage;
                await this.client.sessionUpdate({
                  sessionId: params.sessionId,
                  update: {
                    sessionUpdate: "usage_update",
                    used: nextUsage,
                    size: session.contextWindowSize,
                  },
                });
              }
            }
            for (const notification of streamEventToAcpNotifications(
              message,
              params.sessionId,
              session.toolUseCache,
              this.client,
              this.logger,
              {
                clientCapabilities: this.clientCapabilities,
                cwd: session.cwd,
                taskState: session.taskState,
                emittedToolCalls: session.emittedToolCalls,
                messageId: currentStreamMessageId,
              },
            )) {
              await this.client.sessionUpdate(notification);
            }
            break;
          }
          case "user":
          case "assistant": {
            // Record the ACP messageId -> SDK uuid mapping for this message
            // (including replays). The consolidated message carries both ids, so
            // this is where we learn the uuid the SDK's rewind/resume APIs key on
            // for the id we hand clients. Not read yet (see messageIdToUuid).
            const mappedMessageId = messageIdForGrouping(message);
            if (mappedMessageId && typeof message.uuid === "string" && message.uuid.length > 0) {
              session.messageIdToUuid.set(mappedMessageId, message.uuid);
            }

            // A replayed user message echoes a queued turn back in submission
            // order. The first echo promotes that turn to active; if a different
            // turn is still active, it is handed off (settled end_turn) first.
            // Done before the `cancelled` guard so a turn enqueued after a cancel
            // is still promoted — activateTurn() clears the flag. The turn's own
            // echo is then dropped from the feed (the client already shows it).
            if (message.type === "user" && "uuid" in message && message.uuid) {
              const queued = (session.turnQueue ?? []).find(
                (t) => t.promptUuid === message.uuid && !t.settled,
              );
              if (queued) {
                // Only (re)activate if this isn't already the active turn — a
                // turn promoted early (e.g. by a result that preceded its echo)
                // must not have its accumulated usage reset by its own echo.
                if (session.activeTurn !== queued) {
                  if (session.activeTurn) {
                    // Hand off the previous turn. If a cancel is pending for it
                    // (its trailing idle hasn't arrived yet), settle it
                    // "cancelled" per the ACP contract rather than "end_turn" —
                    // otherwise a cancel followed quickly by the next prompt
                    // would report the cancelled turn as a normal completion.
                    settleActive(
                      session.cancelled
                        ? { stopReason: "cancelled" }
                        : { stopReason: "end_turn", usage: sessionUsage(session) },
                    );
                  }
                  activateTurn(queued);
                }
                break;
              }
              if ("isReplay" in message && message.isReplay) {
                // Unrelated replay (e.g. the echo of an already-settled turn).
                break;
              }
            }

            if (session.cancelled) {
              break;
            }

            // Snapshot the latest top-level assistant usage and model so the
            // next `result` can emit a usage_update tied to the right context
            // window. Subagent messages are excluded to keep the snapshot
            // aligned with what the user's current selection is producing.
            if (message.type === "assistant" && message.parent_tool_use_id === null) {
              lastAssistantUsage = snapshotFromUsage(message.message.usage);
              lastAssistantTotalUsage = totalTokens(lastAssistantUsage);
              if (message.message.model && message.message.model !== "<synthetic>") {
                lastAssistantModel = message.message.model;
              }
              if (message.error) {
                lastAssistantError = message.error;
              }
              if (message.message.stop_reason === "refusal") {
                lastRefusalExplanation = message.message.stop_details?.explanation ?? null;
              }
            }

            // Strip <command-*>/<local-command-stdout> markers and render any
            // remaining prose. Skill bodies and built-in slash commands (e.g.
            // /usage, /status, /model) arrive wrapped in these tags; pure-marker
            // payloads (e.g. /compact's malformed output) strip to null and are
            // skipped. Mirrors the replay path at replaySessionHistory.
            if (
              message.message.role !== "system" &&
              typeof message.message.content === "string" &&
              message.message.content.includes("<local-command-stdout>")
            ) {
              const stripped = stripLocalCommandMetadata(message.message.content);
              if (typeof stripped === "string") {
                for (const notification of toAcpNotifications(
                  stripped,
                  message.message.role,
                  params.sessionId,
                  session.toolUseCache,
                  this.client,
                  this.logger,
                  {
                    clientCapabilities: this.clientCapabilities,
                    parentToolUseId: message.parent_tool_use_id,
                    cwd: session.cwd,
                    taskState: session.taskState,
                    messageId: messageIdForGrouping(message),
                  },
                )) {
                  await this.client.sessionUpdate(notification);
                }
              } else {
                this.logger.log(message.message.content);
              }
              break;
            }

            if (
              typeof message.message.content === "string" &&
              message.message.content.includes("<local-command-stderr>")
            ) {
              this.logger.error(message.message.content);
              break;
            }
            // Skip these user messages for now, since they seem to just be messages we don't want in the feed
            if (
              message.type === "user" &&
              (typeof message.message.content === "string" ||
                (Array.isArray(message.message.content) &&
                  message.message.content.length === 1 &&
                  message.message.content[0].type === "text"))
            ) {
              break;
            }
            if (message.message.role === "system") {
              break;
            }

            if (
              message.type === "assistant" &&
              message.message.model === "<synthetic>" &&
              Array.isArray(message.message.content) &&
              message.message.content.length === 1 &&
              message.message.content[0].type === "text" &&
              message.message.content[0].text.includes("Please run /login")
            ) {
              failActive(RequestError.authRequired());
              break;
            }

            let content: typeof message.message.content;
            if (message.type === "assistant" && message.parent_tool_use_id === null) {
              // Top-level assistant message: each text/thinking block may have
              // already been streamed live as deltas. Diff each against what
              // streamed (`streamedBlocks`, in document order) and forward only
              // the un-streamed remainder — nothing if it streamed in full (the
              // common case), the whole block if it never streamed (a
              // non-streaming gateway), or just the tail if the stream was cut
              // short mid-block. `streamPos` walks the streamed blocks in step
              // with the assembled text/thinking blocks; tool_use and other
              // blocks pass through untouched (their own `toolUseCache` collapses
              // the streamed/assembled pair) without advancing it.
              const blocks = message.message.content;
              const kept: typeof blocks = [];
              let streamPos = 0;
              for (const item of blocks) {
                if (item.type !== "text" && item.type !== "thinking") {
                  kept.push(item);
                  continue;
                }
                const full = item.type === "text" ? item.text : item.thinking;
                // Empty assembled blocks carry nothing (some gateways emit an
                // empty `thinking` block before the real text) — drop them.
                if (full.length === 0) {
                  continue;
                }
                // A streamed block of the same type whose accumulated text is a
                // prefix of this one was already (at least partly) delivered as
                // chunks; consume it and forward only what's left. A non-empty
                // streamed text is required so an empty/aborted streamed block
                // doesn't swallow the assembled copy.
                const streamed = streamedBlocks[streamPos];
                if (
                  streamed &&
                  streamed.type === item.type &&
                  streamed.text.length > 0 &&
                  full.startsWith(streamed.text)
                ) {
                  streamPos++;
                  const remainder = full.slice(streamed.text.length);
                  if (remainder.length === 0) {
                    continue;
                  }
                  // Overwrite in place with just the un-streamed tail (the
                  // assembled message isn't read again after this) so the block
                  // keeps its exact SDK type.
                  if (item.type === "text") {
                    item.text = remainder;
                  } else {
                    item.thinking = remainder;
                  }
                  kept.push(item);
                  continue;
                }
                // Not matched: never streamed (or the stream diverged from the
                // assembled text) — forward the block in full.
                kept.push(item);
              }
              content = kept;
              // Consumed: reset so the next message's blocks accumulate fresh and
              // the record stays bounded to the in-flight message.
              streamedBlocks.length = 0;
            } else if (message.type === "assistant") {
              // Subagent assistant message (`parent_tool_use_id !== null`). It is
              // never streamed live and its text/thinking is internal to the tool
              // call — keep dropping it so subagent prose doesn't leak into the
              // top-level feed.
              content = message.message.content.filter(
                (item) => item.type !== "text" && item.type !== "thinking",
              );
            } else {
              content = message.message.content;
            }

            for (const notification of toAcpNotifications(
              content,
              message.message.role,
              params.sessionId,
              session.toolUseCache,
              this.client,
              this.logger,
              {
                clientCapabilities: this.clientCapabilities,
                parentToolUseId: message.parent_tool_use_id,
                cwd: session.cwd,
                taskState: session.taskState,
                emittedToolCalls: session.emittedToolCalls,
                messageId: messageIdForGrouping(message),
              },
            )) {
              await this.client.sessionUpdate(notification);
            }
            break;
          }
          case "tool_progress": {
            await this.client.sessionUpdate({
              sessionId: message.session_id,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: message.tool_use_id,
                status: "in_progress",
                _meta: {
                  claudeCode: {
                    toolName: message.tool_name,
                    toolResponse: { elapsedTimeSeconds: message.elapsed_time_seconds },
                  },
                } satisfies ToolUpdateMeta,
              },
            });
            break;
          }
          case "rate_limit_event": {
            if (lastAssistantTotalUsage !== null) {
              await this.client.sessionUpdate({
                sessionId: message.session_id,
                update: {
                  sessionUpdate: "usage_update",
                  used: lastAssistantTotalUsage,
                  size: session.contextWindowSize,
                  _meta: { "_claude/rateLimit": message.rate_limit_info },
                },
              });
            }
            break;
          }
          case "tool_use_summary":
          case "auth_status":
          case "prompt_suggestion":
            break;
          default:
            unreachable(message);
            break;
        }
      }
      // `while (true)` only exits via the `done` return above or the catch
      // below, so there is no normal fall-through here.
    } catch (error) {
      // The query stream itself died (a transport/process error surfaced from
      // query.next()). Turn-level failures (auth, error results) are handled
      // inline via failActive and never reach here. Reject every in-flight turn;
      // if the process is gone, tear the session down so the client starts fresh.
      const message = error instanceof Error ? error.message : String(error);
      const processDied =
        error instanceof Error &&
        (message.includes("ProcessTransport") ||
          message.includes("terminated process") ||
          message.includes("process exited with") ||
          message.includes("process terminated by signal") ||
          message.includes("Failed to write to process stdin"));
      // Either way the query iterator is finished and the consumer is exiting,
      // so release its resources via closeQueryStream (idempotent). A process
      // death is unrecoverable, so additionally evict the session so the client
      // starts fresh; other stream errors keep the session so prompt()/cancel()
      // can answer with a clear "session ended" error.
      if (processDied) {
        this.logger.error(`Session ${params.sessionId}: Claude Agent process died: ${message}`);
        failAllTurns(
          RequestError.internalError(
            undefined,
            "The Claude Agent process exited unexpectedly. Please start a new session.",
          ),
        );
        this.closeQueryStream(session);
        delete this.sessions[params.sessionId];
      } else {
        this.logger.error(`Session ${params.sessionId}: query stream error: ${message}`);
        failAllTurns(error);
        this.closeQueryStream(session);
      }
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      return;
    }
    // The stream already ended (see closeQueryStream): every in-flight turn was
    // settled when it closed, and there is no live query to interrupt. Calling
    // query.interrupt() on a finished iterator could reject and surface from
    // this fire-and-forget notification, so there is nothing to do here.
    if (session.queryClosed) {
      return;
    }
    session.cancelled = true;
    // Settle queued turns that haven't started yet (no echo seen) right away —
    // they have no in-flight SDK work to interrupt. The active turn is settled
    // by the consumer when it observes the interrupt's trailing idle (or via the
    // backstop below). Mirrors the old pendingMessages cancellation.
    if (session.turnQueue) {
      let orphaned = 0;
      for (const turn of session.turnQueue) {
        if (turn !== session.activeTurn && !turn.settled) {
          turn.settled = true;
          turn.resolve({ stopReason: "cancelled" });
          orphaned++;
        }
      }
      // Each removed queued turn's user message was already pushed to the SDK,
      // which processes input FIFO and will still emit a result for it with no
      // uuid to match. Count those so the consumer skips them (see
      // ensureActiveTurn) rather than misattributing them to the head.
      session.pendingOrphanResults = (session.pendingOrphanResults ?? 0) + orphaned;
      session.turnQueue = session.turnQueue.filter(
        (turn) => turn === session.activeTurn && !turn.settled,
      );
    }

    // Arm a backstop before interrupting: if a turn is actively consuming the
    // query and interrupt() doesn't make the SDK yield (e.g. a wedged TaskOutput
    // block — issue #680), force the consumer to settle the active turn
    // "cancelled" after the floor elapses so the pending session/prompt still
    // resolves per the ACP cancellation contract instead of hanging forever. The
    // consumer clears this timer when interrupt() works and it settles through
    // the normal idle path, so on healthy cancels it is armed but never fires.
    //
    // Arm at most once per turn: the floor is an absolute ceiling from the first
    // cancel, so a client that re-sends cancel (each call still retries
    // interrupt() below) can't keep pushing the deadline out.
    if (
      session.activeTurn &&
      session.cancelController &&
      !session.cancelController.signal.aborted &&
      !session.forceCancelTimer
    ) {
      const cancelController = session.cancelController;
      session.forceCancelTimer = setTimeout(() => {
        this.logger.error(
          `Session ${params.sessionId}: cancel floor elapsed without the SDK yielding; forcing "cancelled". The underlying query may still be wedged — a new session may be required.`,
        );
        cancelController.abort();
      }, this.forceCancelGraceMs);
    }

    await session.query.interrupt();
  }

  /** Mark a session's SDK query stream as permanently ended and release the
   *  resources tied to it: drop the consumer handle, dispose the settings
   *  watchers, end the input stream, and close the query (which terminates the
   *  subprocess). The query iterator is not revivable, so `prompt()`/`cancel()`
   *  consult `queryClosed` and fail/short-circuit instead of acting on a dead
   *  stream. Idempotent (guarded by `queryClosed`), so the consumer's done/error
   *  paths and a later `teardownSession` can all call it without double-releasing.
   *
   *  Deliberately does NOT abort `session.abortController`: that controller may be
   *  CLIENT-supplied (`_meta.claudeCode.options.abortController`) and reused, so
   *  aborting it on a spontaneous stream end would cancel the client's own work
   *  or make a sibling session born aborted. `query.close()` already terminates
   *  the subprocess; aborting the signal belongs in `teardownSession` (explicit
   *  destroy), not here. Also does NOT remove the session from the map — that is
   *  `teardownSession`'s job — so prompt() can still answer with a clear "session
   *  ended" error after an unexpected stream close. The leftover session object
   *  is a lightweight husk (its heavy resources are released here) and is evicted
   *  on the next closeSession/deleteSession or when the connection's `dispose()`
   *  runs. */
  private closeQueryStream(session: Session): void {
    if (session.queryClosed) {
      return;
    }
    session.queryClosed = true;
    session.consumer = undefined;
    session.settingsManager.dispose();
    session.input.end();
    session.query.close();
  }

  /** Cleanly tear down a session: cancel in-flight work, release stream
   *  resources, and remove it from the session map. */
  private async teardownSession(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) {
      return;
    }
    await this.cancel({ sessionId });
    // cancel() arms the force-cancel floor and interrupts gracefully, but a
    // wedged consumer only wakes when `cancelController` aborts — closeQueryStream
    // below doesn't touch it. Since we're tearing the session down anyway, wake
    // the consumer now so the in-flight prompt() resolves immediately instead of
    // after the floor, and clear the timer so it can't outlive the deleted
    // session (it isn't unref'd and would otherwise keep the event loop alive
    // until it fires).
    if (session.forceCancelTimer) {
      clearTimeout(session.forceCancelTimer);
      session.forceCancelTimer = undefined;
    }
    session.cancelController?.abort();
    this.closeQueryStream(session);
    // Abort the SDK abort signal only on explicit destroy. closeQueryStream
    // leaves it alone (it may be a client-owned controller — see its doc), but
    // here the client has asked us to close the session, so signalling abort is
    // appropriate; query.close() above has already torn the subprocess down.
    session.abortController.abort();
    delete this.sessions[sessionId];
  }

  /** Tear down all active sessions. Called when the ACP connection closes. */
  async dispose(): Promise<void> {
    await Promise.all(Object.keys(this.sessions).map((id) => this.teardownSession(id)));
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }
    await this.teardownSession(params.sessionId);
    return {};
  }

  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    // Tear down any active in-memory state first so the on-disk file isn't
    // recreated by an outstanding query writing to it.
    if (this.sessions[params.sessionId]) {
      await this.teardownSession(params.sessionId);
    }
    await deleteSession(params.sessionId);
    return {};
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    // The SDK query stream already ended (see closeQueryStream); the session is
    // a husk and `query.setPermissionMode` below would act on a closed query.
    // Fail with the same clear message prompt()/cancel() give for a dead stream.
    if (session.queryClosed) {
      throw RequestError.internalError(undefined, SESSION_ENDED_MESSAGE);
    }

    await this.applySessionMode(params.sessionId, params.modeId);
    await this.updateConfigOption(params.sessionId, "mode", params.modeId);
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    // The SDK query stream already ended (see closeQueryStream); the session is
    // a husk and the `query.setModel`/`setPermissionMode`/`applyFlagSettings`
    // calls this triggers would act on a closed query. Fail with the same clear
    // message prompt()/cancel() give for a dead stream.
    if (session.queryClosed) {
      throw RequestError.internalError(undefined, SESSION_ENDED_MESSAGE);
    }
    if (typeof params.value !== "string") {
      throw new Error(`Invalid value for config option ${params.configId}: ${params.value}`);
    }

    const option = session.configOptions.find((o) => o.id === params.configId);
    if (!option) {
      throw new Error(`Unknown config option: ${params.configId}`);
    }

    const allValues =
      "options" in option && Array.isArray(option.options)
        ? option.options.flatMap((o) => ("options" in o ? o.options : [o]))
        : [];
    let validValue = allValues.find((o) => o.value === params.value);

    // For model options, fall back to resolveModelPreference when the exact
    // value doesn't match.  This lets callers use human-friendly aliases like
    // "opus" or "sonnet" instead of full model IDs like "claude-opus-4-6".
    if (!validValue && params.configId === "model") {
      const modelInfos: ModelInfo[] = allValues.map((o) => ({
        value: o.value,
        displayName: o.name,
        description: o.description ?? "",
      }));
      const resolved = resolveModelPreference(modelInfos, params.value);
      if (resolved) {
        validValue = allValues.find((o) => o.value === resolved.value);
      }
    }

    if (!validValue) {
      throw new Error(`Invalid value for config option ${params.configId}: ${params.value}`);
    }

    // Use the canonical option value so downstream code always receives the
    // model ID rather than the caller-supplied alias.
    const resolvedValue = validValue.value;

    if (params.configId === "mode") {
      await this.applySessionMode(params.sessionId, resolvedValue);
      await this.client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: resolvedValue,
        },
      });
    } else if (params.configId === "model") {
      await this.sessions[params.sessionId].query.setModel(resolvedValue);
    }
    // Effort SDK sync is handled inside applyConfigOptionValue so that direct
    // effort changes and effort changes induced by a model switch go through
    // the same path.

    await this.applyConfigOptionValue(params.sessionId, session, params.configId, resolvedValue);

    return { configOptions: session.configOptions };
  }

  private async applySessionMode(sessionId: string, modeId: string): Promise<void> {
    switch (modeId) {
      case "auto":
      case "default":
      case "acceptEdits":
      case "bypassPermissions":
      case "dontAsk":
      case "plan":
        break;
      default:
        throw new Error("Invalid Mode");
    }

    const session = this.sessions[sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    if (!session.modes.availableModes.some((mode) => mode.id === modeId)) {
      throw new Error(`Mode ${modeId} is not available in this session`);
    }

    try {
      await session.query.setPermissionMode(modeId);
    } catch (error) {
      if (error instanceof Error) {
        if (!error.message) {
          error.message = "Invalid Mode";
        }
        throw error;
      } else {
        // eslint-disable-next-line preserve-caught-error
        throw new Error("Invalid Mode");
      }
    }
  }

  private async replaySessionHistory(sessionId: string): Promise<void> {
    const toolUseCache: ToolUseCache = {};
    const messages = await getSessionMessages(sessionId);

    for (const message of messages) {
      // Backfill the ACP messageId -> SDK uuid mapping for messages we didn't
      // observe live (resumed/loaded sessions), so rewind/resume can translate
      // a client-supplied id without an extra getSessionMessages read. Not read
      // yet (see Session.messageIdToUuid).
      const replayMessageId = messageIdForGrouping(message);
      const replaySession = this.sessions[sessionId];
      if (replaySession && replayMessageId && message.uuid) {
        replaySession.messageIdToUuid.set(replayMessageId, message.uuid);
      }

      // @ts-expect-error - untyped in SDK but we handle all of these
      let content: unknown = message.message.content;
      // @ts-expect-error - untyped in SDK but we handle all of these
      if (message.message.role === "user") {
        content = stripLocalCommandMetadata(content);
        if (content === null) continue;
      }

      for (const notification of toAcpNotifications(
        // @ts-expect-error - untyped in SDK but we handle all of these
        content,
        // @ts-expect-error - untyped in SDK but we handle all of these
        message.message.role,
        sessionId,
        toolUseCache,
        this.client,
        this.logger,
        {
          registerHooks: false,
          clientCapabilities: this.clientCapabilities,
          cwd: this.sessions[sessionId]?.cwd,
          taskState: this.sessions[sessionId]?.taskState,
          messageId: replayMessageId,
        },
      )) {
        await this.client.sessionUpdate(notification);
      }
    }
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const response = await this.client.readTextFile(params);
    return response;
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const response = await this.client.writeTextFile(params);
    return response;
  }

  /** Forward a permission request to the client, wiring the tool call's
   *  `signal` through as a `cancellationSignal`. When the turn is cancelled
   *  while the client's prompt is still open the signal aborts, the SDK sends
   *  `$/cancel_request`, and the client settles the request (a `cancelled`
   *  outcome or a `requestCancelled` rejection). Either way we surface the same
   *  "Tool use aborted" the callers already expect, so a cancelled dialog no
   *  longer leaves the `await` hanging. */
  private async requestPermissionFromClient(
    params: RequestPermissionRequest,
    toolName: string,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    // The SDK may invoke `canUseTool` (and therefore this permission request)
    // before the assistant message's tool_use block streams to us. Some ACP clients
    // expect the `tool_call` a permission request references to already exist,
    // so emit it now if it hasn't been sent yet. The streamed tool_use chunk
    // later refines it with a `tool_call_update` rather than emitting a
    // duplicate (see `emittedToolCalls` in `toAcpNotifications`).
    await this.ensureToolCallEmitted(
      params.sessionId,
      toolName,
      params.toolCall.toolCallId,
      params.toolCall.rawInput,
    );
    try {
      return await this.client.requestPermission(params, signal);
    } catch (error) {
      if (signal.aborted) {
        throw new Error("Tool use aborted", { cause: error });
      }
      throw error;
    }
  }

  /** Emit the `tool_call` a permission request references if it hasn't been sent
   *  yet, so the client has the tool call before being asked to approve it. The
   *  matching streamed tool_use chunk later refines it with a `tool_call_update`
   *  instead of emitting a duplicate (see `emittedToolCalls`). Built via the same
   *  `toolCallNotification` helper as the streamed path so the two are identical.
   *  Tools the stream renders as a plan (TodoWrite) or suppresses (Task*) are
   *  skipped so a permission prompt for them never surfaces a stray tool_call. */
  private async ensureToolCallEmitted(
    sessionId: string,
    toolName: string,
    toolCallId: string,
    toolInput: unknown,
  ): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session || !shouldEmitToolCall(toolName)) {
      return;
    }
    if (session.emittedToolCalls.has(toolCallId)) {
      return;
    }
    session.emittedToolCalls.add(toolCallId);
    const supportsTerminalOutput = this.clientCapabilities?._meta?.["terminal_output"] === true;
    await this.client.sessionUpdate({
      sessionId,
      update: toolCallNotification(
        { id: toolCallId, name: toolName, input: toolInput },
        toolInput,
        supportsTerminalOutput,
        session.cwd,
      ),
    });
  }

  canUseTool(sessionId: string): CanUseTool {
    return async (toolName, toolInput, { signal, suggestions, toolUseID }) => {
      const alwaysAllowLabel = describeAlwaysAllow(suggestions, toolName);
      const supportsTerminalOutput = this.clientCapabilities?._meta?.["terminal_output"] === true;
      const session = this.sessions[sessionId];
      if (!session) {
        return {
          behavior: "deny",
          message: "Session not found",
        };
      }

      // AskUserQuestion is surfaced to us as a normal permission check (the SDK
      // routes it through canUseTool whenever a callback is registered, rather
      // than the interactive dialog). Present it as an ACP form elicitation and
      // feed the answers back as updatedInput for the tool's own call() to read.
      if (toolName === "AskUserQuestion" && this.clientCapabilities?.elicitation?.form) {
        // Like permission requests, the elicitation references this toolUseID, so
        // make sure the tool_call has surfaced to the client before we send it.
        await this.ensureToolCallEmitted(sessionId, toolName, toolUseID, toolInput);
        return this.handleAskUserQuestion(sessionId, toolInput, toolUseID, signal);
      }

      if (toolName === "ExitPlanMode") {
        const optionsAll: PermissionOption[] = [
          { kind: "allow_always", name: 'Yes, and use "auto" mode', optionId: "auto" },
          {
            kind: "allow_always",
            name: "Yes, and auto-accept edits",
            optionId: "acceptEdits",
          },
          { kind: "allow_once", name: "Yes, and manually approve edits", optionId: "default" },
          { kind: "reject_once", name: "No, keep planning", optionId: "plan" },
        ];
        if (ALLOW_BYPASS) {
          optionsAll.unshift({
            kind: "allow_always",
            name: "Yes, and bypass permissions",
            optionId: "bypassPermissions",
          });
        }
        // Filter against the session's currently-advertised modes so we never
        // present options the active model can't honor (e.g. `auto` on Haiku).
        // `bypassPermissions` is already covered by `availableModes` via
        // `buildAvailableModes`/`ALLOW_BYPASS`. The `plan` option is a
        // "keep planning" reject path; it's always present in `availableModes`.
        const options = optionsAll.filter((o) =>
          session.modes.availableModes.some((m) => m.id === o.optionId),
        );

        const response = await this.requestPermissionFromClient(
          {
            options,
            sessionId,
            toolCall: {
              toolCallId: toolUseID,
              rawInput: toolInput,
              ...toolInfoFromToolUse(
                { name: toolName, input: toolInput, id: toolUseID },
                supportsTerminalOutput,
                session?.cwd,
              ),
            },
          },
          toolName,
          signal,
        );

        if (signal.aborted || response.outcome?.outcome === "cancelled") {
          throw new Error("Tool use aborted");
        }
        const selectedMode =
          response.outcome?.outcome === "selected" ? response.outcome.optionId : undefined;
        const selectedModeWasOffered = options.some((option) => option.optionId === selectedMode);
        if (
          selectedModeWasOffered &&
          (selectedMode === "default" ||
            selectedMode === "acceptEdits" ||
            selectedMode === "auto" ||
            selectedMode === "bypassPermissions")
        ) {
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "current_mode_update",
              currentModeId: selectedMode,
            },
          });
          await this.updateConfigOption(sessionId, "mode", selectedMode);

          return {
            behavior: "allow",
            updatedInput: toolInput,
            updatedPermissions: suggestions ?? [
              { type: "setMode", mode: selectedMode, destination: "session" },
            ],
          };
        } else {
          return {
            behavior: "deny",
            message: "User rejected request to exit plan mode.",
          };
        }
      }

      if (session.modes.currentModeId === "bypassPermissions") {
        return {
          behavior: "allow",
          updatedInput: toolInput,
          updatedPermissions: suggestions ?? [
            { type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" },
          ],
        };
      }

      const response = await this.requestPermissionFromClient(
        {
          options: [
            {
              kind: "allow_always",
              name: alwaysAllowLabel,
              optionId: "allow_always",
            },
            { kind: "allow_once", name: "Allow", optionId: "allow" },
            { kind: "reject_once", name: "Reject", optionId: "reject" },
          ],
          sessionId,
          toolCall: {
            toolCallId: toolUseID,
            rawInput: toolInput,
            ...toolInfoFromToolUse(
              { name: toolName, input: toolInput, id: toolUseID },
              supportsTerminalOutput,
              session?.cwd,
            ),
          },
        },
        toolName,
        signal,
      );
      if (signal.aborted || response.outcome?.outcome === "cancelled") {
        throw new Error("Tool use aborted");
      }
      if (
        response.outcome?.outcome === "selected" &&
        (response.outcome.optionId === "allow" || response.outcome.optionId === "allow_always")
      ) {
        // If Claude Code has suggestions, it will update their settings already
        if (response.outcome.optionId === "allow_always") {
          return {
            behavior: "allow",
            updatedInput: toolInput,
            updatedPermissions: suggestions ?? [
              {
                type: "addRules",
                rules: [{ toolName }],
                behavior: "allow",
                destination: "session",
              },
            ],
          };
        }
        return {
          behavior: "allow",
          updatedInput: toolInput,
        };
      } else {
        return {
          behavior: "deny",
          message: "User refused permission to run tool",
        };
      }
    };
  }

  /**
   * Handle elicitation requests that originate from MCP servers by forwarding
   * them to the client over ACP. Modes the client did not advertise (or
   * requests we can't represent) are declined.
   */
  private handleMcpElicitation(sessionId: string, support: ElicitationSupport): OnElicitation {
    return async (request, { signal }) => {
      const isUrl = request.mode === "url";
      if ((isUrl && !support.url) || (!isUrl && !support.form)) {
        return { action: "decline" };
      }

      const createRequest = mcpElicitationToCreateRequest(request, sessionId);
      if (!createRequest) {
        return { action: "decline" };
      }

      try {
        const response = await this.client.unstable_createElicitation(createRequest, signal);
        if (signal.aborted) {
          return { action: "cancel" };
        }
        return createElicitationResponseToElicitResult(response);
      } catch (error) {
        // A cancellation we requested (signal aborted) settles as a cancel, not
        // a hard decline — the elicitation was abandoned, not refused.
        if (signal.aborted) {
          return { action: "cancel" };
        }
        this.logger.error(`Failed to forward MCP elicitation: ${error}`);
        return { action: "decline" };
      }
    };
  }

  /**
   * Present the built-in AskUserQuestion tool's questions as an ACP form
   * elicitation and return the answers as the tool's `updatedInput`. Called from
   * `canUseTool` since that is where the SDK routes the tool's permission check.
   */
  private async handleAskUserQuestion(
    sessionId: string,
    toolInput: Record<string, unknown>,
    toolUseID: string,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const questions = extractAskUserQuestions(toolInput);
    if (!questions) {
      return { behavior: "deny", message: "AskUserQuestion called with no valid questions." };
    }

    const createRequest = askUserQuestionsToCreateRequest(questions, sessionId, toolUseID);
    let response;
    try {
      response = await this.client.unstable_createElicitation(createRequest, signal);
    } catch (error) {
      // A cancellation we requested (signal aborted) settles as an aborted tool
      // use, matching the post-response check below.
      if (signal.aborted) {
        throw new Error("Tool use aborted", { cause: error });
      }
      this.logger.error(`Failed to present AskUserQuestion elicitation: ${error}`);
      return { behavior: "deny", message: "Could not present the question to the user." };
    }
    if (signal.aborted) {
      throw new Error("Tool use aborted");
    }

    const outcome = applyAskElicitationResponse(response, toolInput, questions);
    if (outcome.action === "cancel") {
      throw new Error("Tool use aborted");
    }
    return { behavior: "allow", updatedInput: outcome.updatedInput };
  }

  private async sendAvailableCommandsUpdate(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return;
    const commands = await session.query.supportedCommands();
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: getAvailableSlashCommands(commands),
      },
    });
  }

  private async updateConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return;

    await this.applyConfigOptionValue(sessionId, session, configId, value);

    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: session.configOptions,
      },
    });
  }

  private async applyConfigOptionValue(
    sessionId: string,
    session: Session,
    configId: string,
    value: string,
  ): Promise<void> {
    if (configId === "mode") {
      session.modes = { ...session.modes, currentModeId: value };
      session.configOptions = session.configOptions.map((o) =>
        o.id === configId && typeof o.currentValue === "string" ? { ...o, currentValue: value } : o,
      );
    } else if (configId === "model") {
      // `ModelInfo.supportsAutoMode` is the canonical SDK signal for clamping
      // modes below; its `displayName`/`description` also let us infer the
      // context window for semantic aliases (e.g. `default`) whose ID alone
      // carries no "1m" token.
      const newModelInfo = session.modelInfos.find((m) => m.value === value);
      if (session.models.currentModelId !== value) {
        // The cached context window was learned for the previous model; reset
        // to the new model's heuristic so mid-stream updates between now and
        // the next `result` reflect the user's selection instead of the old
        // model's window.
        session.contextWindowSize =
          inferContextWindowFromModel(
            value,
            newModelInfo?.displayName,
            newModelInfo?.description,
          ) ?? DEFAULT_CONTEXT_WINDOW;
      }
      session.models = { ...session.models, currentModelId: value };

      // Recompute availableModes for the new model and clamp the current
      // mode if the SDK no longer offers it (today: "auto" on Haiku).
      const newAvailableModes = buildAvailableModes(newModelInfo);
      // Capture BEFORE mutating session.modes so the log message reflects
      // the invalidated mode rather than "default".
      const previousModeId = session.modes.currentModeId;
      let modeDowngraded = false;
      if (!newAvailableModes.some((m) => m.id === previousModeId)) {
        session.modes = {
          availableModes: newAvailableModes,
          currentModeId: "default",
        };
        try {
          await session.query.setPermissionMode("default");
        } catch (err) {
          // Failing the entire model switch over a bookkeeping sync error is
          // worse UX than logging and continuing; the user explicitly asked
          // to change models. The next setPermissionMode from the user will
          // either succeed or surface a fresh error.
          this.logger.error(
            `Failed to sync permissionMode to "default" after model switch invalidated "${previousModeId}":`,
            err,
          );
        }
        modeDowngraded = true;
      } else {
        session.modes = { ...session.modes, availableModes: newAvailableModes };
      }

      // Rebuild config options since effort levels depend on the selected model
      const effortOpt = session.configOptions.find((o) => o.id === "effort");
      const currentEffort =
        typeof effortOpt?.currentValue === "string" ? effortOpt.currentValue : undefined;
      session.configOptions = buildConfigOptions(
        session.modes,
        session.models,
        session.modelInfos,
        currentEffort,
        session.agents,
        session.currentAgent,
      );

      // Sync effort with the SDK if it changed after the model switch
      const newEffortOpt = session.configOptions.find((o) => o.id === "effort");
      const newEffort =
        typeof newEffortOpt?.currentValue === "string" ? newEffortOpt.currentValue : undefined;
      if (newEffort !== currentEffort) {
        await session.query.applyFlagSettings({
          effortLevel: toSdkEffortLevel(newEffort),
        });
      }

      // Emit current_mode_update only after session.modes AND
      // session.configOptions have been fully reconciled. This way, a failure
      // in the configOptions/effort rebuild above can't leave the client with
      // a clamped currentModeId but stale configOptions, and the notification
      // still precedes the caller's config_option_update so order-sensitive
      // clients update currentModeId before re-rendering the option list.
      if (modeDowngraded) {
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: "default",
          },
        });
      }
    } else if (configId === "agent") {
      // Live agent switch — no subprocess restart needed. Apply the SDK flag
      // first so a rejected control request leaves both `currentAgent` and the
      // config option untouched (no UI/SDK desync). Passing `null` clears the
      // flag layer back to the standard Claude Code agent; the change takes
      // effect on the next turn (SDK >= 0.3.161).
      await session.query.applyFlagSettings({
        agent: value === DEFAULT_AGENT_ID ? null : value,
      });
      session.currentAgent = value;
      session.configOptions = session.configOptions.map((o) =>
        o.id === configId && typeof o.currentValue === "string" ? { ...o, currentValue: value } : o,
      );
    } else {
      session.configOptions = session.configOptions.map((o) =>
        o.id === configId && typeof o.currentValue === "string" ? { ...o, currentValue: value } : o,
      );
      if (configId === "effort") {
        await session.query.applyFlagSettings({
          effortLevel: toSdkEffortLevel(value),
        });
      }
    }
  }

  private async getOrCreateSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers?: NewSessionRequest["mcpServers"];
    additionalDirectories?: NewSessionRequest["additionalDirectories"];
    _meta?: NewSessionRequest["_meta"];
  }): Promise<NewSessionResponse> {
    const existingSession = this.sessions[params.sessionId];
    if (existingSession) {
      const fingerprint = computeSessionFingerprint(params);
      if (fingerprint === existingSession.sessionFingerprint) {
        return {
          sessionId: params.sessionId,
          modes: existingSession.modes,
          configOptions: existingSession.configOptions,
        };
      }

      // Session-defining params changed (e.g. cwd pointed at a git worktree,
      // or MCP servers reconfigured). Tear down the existing session and
      // recreate it so the underlying Query process picks up the new values.
      await this.teardownSession(params.sessionId);
    }

    const response = await this.createSession(
      {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        additionalDirectories: params.additionalDirectories,
        _meta: params._meta,
      },
      {
        resume: params.sessionId,
      },
    );

    return {
      sessionId: response.sessionId,
      modes: response.modes,
      configOptions: response.configOptions,
    };
  }

  /**
   * Ensures the requested `cwd` is an absolute path that points at an existing
   * directory before we create a session. Throws an `invalidParams` error with
   * an actionable message so clients (e.g. Zed) can surface it to the user
   * instead of failing later with an opaque SDK error.
   */
  private async validateCwd(cwd: string): Promise<void> {
    if (!path.isAbsolute(cwd)) {
      throw RequestError.invalidParams(
        { cwd },
        `\`cwd\` must be an absolute path, but received: ${cwd}`,
      );
    }

    let stats: Stats;
    try {
      stats = await fs.stat(cwd);
    } catch {
      throw RequestError.invalidParams(
        { cwd },
        `\`cwd\` does not exist on the machine running the agent: ${cwd}`,
      );
    }

    if (!stats.isDirectory()) {
      throw RequestError.invalidParams({ cwd }, `\`cwd\` is not a directory: ${cwd}`);
    }
  }

  private async createSession(
    params: NewSessionRequest,
    creationOpts: { resume?: string; forkSession?: boolean } = {},
  ): Promise<NewSessionResponse> {
    // Validate `cwd` up front. The ACP spec requires an absolute path, and the
    // directory must actually exist on the machine running the agent. Without
    // this check a session is created against a missing directory and the
    // failure only surfaces later as a confusing "native binary failed to
    // launch" error from the SDK (see issue #749).
    await this.validateCwd(params.cwd);

    // We want to create a new session id unless it is resume,
    // but not resume + forkSession.
    let sessionId;
    if (creationOpts.forkSession) {
      sessionId = randomUUID();
    } else if (creationOpts.resume) {
      sessionId = creationOpts.resume;
    } else {
      sessionId = randomUUID();
    }

    const input = new Pushable<SDKUserMessage>();

    const settingsManager = new SettingsManager(params.cwd, {
      logger: this.logger,
    });
    await settingsManager.initialize();

    const mcpServers: Record<string, McpServerConfig> = {};
    if (Array.isArray(params.mcpServers)) {
      for (const server of params.mcpServers) {
        if ("type" in server && (server.type === "http" || server.type === "sse")) {
          // HTTP or SSE type MCP server
          mcpServers[server.name] = {
            type: server.type,
            url: server.url,
            headers: server.headers
              ? Object.fromEntries(server.headers.map((e) => [e.name, e.value]))
              : undefined,
          };
        } else if (!("type" in server)) {
          // Stdio type MCP server (with or without explicit type field)
          mcpServers[server.name] = {
            type: "stdio",
            command: server.command,
            args: server.args,
            env: server.env
              ? Object.fromEntries(server.env.map((e) => [e.name, e.value]))
              : undefined,
          };
        }
      }
    }

    let systemPrompt: Options["systemPrompt"] = { type: "preset", preset: "claude_code" };
    if (params._meta?.systemPrompt) {
      const customPrompt = params._meta.systemPrompt;
      if (typeof customPrompt === "string") {
        systemPrompt = customPrompt;
      } else if (
        typeof customPrompt === "object" &&
        customPrompt !== null &&
        !Array.isArray(customPrompt)
      ) {
        // Forward all preset options (append, excludeDynamicSections, and
        // anything the SDK adds later) while locking type/preset.
        systemPrompt = {
          ...(customPrompt as object),
          type: "preset",
          preset: "claude_code",
        } as Options["systemPrompt"];
      }
    }

    const permissionMode = resolvePermissionMode(
      settingsManager.getSettings().permissions?.defaultMode,
      this.logger,
    );

    // Extract options from _meta if provided
    const sessionMeta = params._meta as NewSessionMeta | undefined;
    const userProvidedOptions = sessionMeta?.claudeCode?.options;

    // Configure thinking behavior from environment variable
    const thinking = resolveThinkingConfig(process.env.MAX_THINKING_TOKENS, this.logger);

    // Parse model configuration from environment (e.g. Bedrock model overrides)
    const modelConfig = parseModelConfig(process.env.CLAUDE_MODEL_CONFIG);

    // Elicitation modes the connected client advertised. We only forward
    // elicitations (and only re-enable AskUserQuestion) for modes the client
    // can actually render.
    const elicitationSupport: ElicitationSupport = {
      form: !!this.clientCapabilities?.elicitation?.form,
      url: !!this.clientCapabilities?.elicitation?.url,
    };

    // AskUserQuestion surfaces as a `permission_ask_user_question` dialog that
    // we render as a form elicitation. Without form-elicitation support there
    // is no way to present it over ACP, so keep it disabled in that case.
    const disallowedTools = elicitationSupport.form ? [] : ["AskUserQuestion"];

    // Resolve which built-in tools to expose.
    // Explicit tools array from _meta.claudeCode.options takes precedence.
    // disableBuiltInTools is a legacy shorthand for tools: [] — kept for
    // backward compatibility but callers should prefer the tools array.
    const tools: Options["tools"] =
      userProvidedOptions?.tools ??
      (params._meta?.disableBuiltInTools === true ? [] : { type: "preset", preset: "claude_code" });

    const abortController = userProvidedOptions?.abortController || new AbortController();

    // Per-session task state. Created here (rather than in the session record
    // below) so the TaskCreated/TaskCompleted hook callbacks can close over
    // the same Map that the streaming message handler will read from.
    const taskState: TaskState = new Map();

    const options: Options = {
      systemPrompt,
      settingSources: ["user", "project", "local"],
      ...(thinking !== undefined && { thinking }),
      ...userProvidedOptions,
      // CLAUDE_MODEL_CONFIG env var is a fallback for model
      // configuration (e.g. Bedrock model ID overrides). When the caller
      // provides settings via _meta, we intentionally ignore the env var —
      // the caller is assumed to have full control over model configuration.
      ...(!userProvidedOptions?.settings &&
        modelConfig && {
          settings: {
            ...(modelConfig.modelOverrides && { modelOverrides: modelConfig.modelOverrides }),
            ...(modelConfig.availableModels && { availableModels: modelConfig.availableModels }),
          },
        }),
      env: {
        ...process.env,
        ...userProvidedOptions?.env,
        ...createEnvForGateway(this.gatewayAuthRequest),
        // Opt-in to session state events like when the agent is idle
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
      },
      // Override certain fields that must be controlled by ACP
      cwd: params.cwd,
      includePartialMessages: true,
      mcpServers: { ...(userProvidedOptions?.mcpServers || {}), ...mcpServers },
      // If we want bypassPermissions to be an option, we have to allow it here.
      // But it doesn't work in root mode, so we only activate it if it will work.
      allowDangerouslySkipPermissions: ALLOW_BYPASS,
      permissionMode,
      canUseTool: this.canUseTool(sessionId),
      // Forward MCP elicitation requests onto ACP elicitation. Only attached
      // when the client advertised support, so non-supporting clients keep the
      // SDK's default (auto-decline) behavior. (AskUserQuestion is handled in
      // canUseTool, not here.)
      ...(elicitationSupport.form || elicitationSupport.url
        ? { onElicitation: this.handleMcpElicitation(sessionId, elicitationSupport) }
        : {}),
      pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE ?? (await claudeCliPath()),
      extraArgs: {
        ...userProvidedOptions?.extraArgs,
        "replay-user-messages": "",
      },
      disallowedTools: [...(userProvidedOptions?.disallowedTools || []), ...disallowedTools],
      tools,
      hooks: {
        ...userProvidedOptions?.hooks,
        PostToolUse: [
          ...(userProvidedOptions?.hooks?.PostToolUse || []),
          {
            hooks: [
              createPostToolUseHook(this.logger, {
                onEnterPlanMode: async () => {
                  await this.client.sessionUpdate({
                    sessionId,
                    update: {
                      sessionUpdate: "current_mode_update",
                      currentModeId: "plan",
                    },
                  });
                  await this.updateConfigOption(sessionId, "mode", "plan");
                },
              }),
            ],
          },
        ],
        TaskCreated: [
          ...(userProvidedOptions?.hooks?.TaskCreated || []),
          {
            hooks: [
              createTaskHook({
                taskState,
                onChange: async () => {
                  await this.client.sessionUpdate({
                    sessionId,
                    update: {
                      sessionUpdate: "plan",
                      entries: taskStateToPlanEntries(taskState),
                    },
                  });
                },
              }),
            ],
          },
        ],
        TaskCompleted: [
          ...(userProvidedOptions?.hooks?.TaskCompleted || []),
          {
            hooks: [
              createTaskHook({
                taskState,
                onChange: async () => {
                  await this.client.sessionUpdate({
                    sessionId,
                    update: {
                      sessionUpdate: "plan",
                      entries: taskStateToPlanEntries(taskState),
                    },
                  });
                },
              }),
            ],
          },
        ],
      },
      ...creationOpts,
      abortController,
    };

    // Prefer the official ACP `additionalDirectories` field. Fall back to the
    // legacy `_meta.additionalRoots` extension for clients that haven't been
    // updated yet. Either source is merged with directories supplied via
    // `_meta.claudeCode.options.additionalDirectories` (SDK pass-through).
    const acpAdditionalDirectories =
      params.additionalDirectories ?? sessionMeta?.additionalRoots ?? [];
    options.additionalDirectories = [
      ...(userProvidedOptions?.additionalDirectories ?? []),
      ...acpAdditionalDirectories,
    ];

    if (creationOpts?.resume === undefined || creationOpts?.forkSession) {
      // Set our own session id if not resuming an existing session.
      options.sessionId = sessionId;
    }

    // Handle abort controller from meta options
    if (abortController?.signal.aborted) {
      throw new Error("Cancelled");
    }

    const q = query({
      prompt: input,
      options,
    });

    let initializationResult;
    try {
      initializationResult = await q.initializationResult();
    } catch (error) {
      if (
        creationOpts.resume &&
        error instanceof Error &&
        (error.message === "Query closed before response received" ||
          error.message.includes("No conversation found with session ID"))
      ) {
        throw RequestError.resourceNotFound(sessionId);
      }
      throw error;
    }

    if (
      shouldHideClaudeAuth() &&
      initializationResult.account.subscriptionType &&
      !this.gatewayAuthRequest
    ) {
      throw RequestError.authRequired(
        undefined,
        "This integration does not support using claude.ai subscriptions.",
      );
    }

    // Apply user's `availableModels` allowlist from settings.json before any
    // downstream model handling. The SDK only enforces this allowlist in its
    // own UI, not in `initializationResult.models`, so we filter here to keep
    // configOptions, the current-model resolver, and the stored modelInfos
    // consistent with what the user configured.
    const settingsAvailableModels = settingsManager.getSettings().availableModels;
    const allowedModels = Array.isArray(settingsAvailableModels)
      ? applyAvailableModelsAllowlist(initializationResult.models, settingsAvailableModels)
      : initializationResult.models;

    const models = await getAvailableModels(
      q,
      allowedModels,
      initializationResult.models,
      settingsManager,
      this.logger,
    );

    // Gate `auto` (and future model-specific modes) on the resolved model's
    // `ModelInfo`. See `buildAvailableModes` for the canonical SDK signal.
    const currentModelInfo = allowedModels.find((m) => m.value === models.currentModelId);
    const availableModes = buildAvailableModes(currentModelInfo);

    // Clamp `permissionMode` if the resolved session does not offer it. The
    // common case is `permissions.defaultMode: "auto"` resolving to a model
    // that does not support auto mode (e.g. Haiku); without this clamp the
    // SDK would later throw `"auto mode unavailable for this model"` from
    // `setPermissionMode`. Keep `permissionMode` as the resolved user intent
    // (matches what was passed into `options.permissionMode` above) and use
    // `effectiveMode` for the post-clamp value the session actually runs in.
    let effectiveMode: PermissionMode = permissionMode;
    if (!availableModes.some((m) => m.id === effectiveMode)) {
      if (effectiveMode === "auto") {
        this.logger.error(
          `permissions.defaultMode "auto" is not available for model ` +
            `"${models.currentModelId}"; falling back to "default".`,
        );
      } else {
        this.logger.error(
          `permissions.defaultMode "${effectiveMode}" is not available in ` +
            `this session; falling back to "default".`,
        );
      }
      effectiveMode = "default";
      // Sync the SDK so it doesn't keep "auto" cached internally. Wrapped in
      // try/catch since failing here would abort session creation entirely.
      try {
        await q.setPermissionMode("default");
      } catch (err) {
        this.logger.error("Failed to sync clamped permissionMode to SDK:", err);
      }
    }

    const modes = {
      currentModeId: effectiveMode,
      availableModes,
    };

    const agents = await discoverCustomAgents(q);
    // Only adopt the requested agent as the selected value if it's one we
    // actually surface in the picker. A built-in (filtered out above) or
    // otherwise-unknown name would leave the config option's `currentValue`
    // pointing at an entry not in its own `options` list, which clients render
    // as a blank/invalid selection.
    const requestedAgent = userProvidedOptions?.agent;
    const currentAgent =
      requestedAgent && agents.some((a) => a.name === requestedAgent)
        ? requestedAgent
        : DEFAULT_AGENT_ID;

    const configOptions = buildConfigOptions(
      modes,
      models,
      allowedModels,
      settingsManager.getSettings().effortLevel,
      agents,
      currentAgent,
    );

    // Apply the initial effort level to the SDK so it matches the UI default
    const initialEffort = configOptions.find((o) => o.id === "effort");
    if (
      initialEffort &&
      typeof initialEffort.currentValue === "string" &&
      initialEffort.currentValue !== "default"
    ) {
      await q.applyFlagSettings({
        effortLevel: initialEffort.currentValue as Settings["effortLevel"],
      });
    }
    this.sessions[sessionId] = {
      query: q,
      input: input,
      cancelled: false,
      cwd: params.cwd,
      sessionFingerprint: computeSessionFingerprint(params),
      settingsManager,
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
      modes,
      models,
      modelInfos: allowedModels,
      configOptions,
      agents,
      currentAgent,
      abortController,
      emitRawSDKMessages: sessionMeta?.claudeCode?.emitRawSDKMessages ?? false,
      contextWindowSize:
        inferContextWindowFromModel(
          models.currentModelId,
          currentModelInfo?.displayName,
          currentModelInfo?.description,
        ) ?? DEFAULT_CONTEXT_WINDOW,
      taskState,
      toolUseCache: {},
      emittedToolCalls: new Set(),
      messageIdToUuid: new Map(),
    };

    return {
      sessionId,
      modes,
      configOptions,
    };
  }
}

function shouldEmitRawMessage(
  config: boolean | SDKMessageFilter[],
  message: { type: string; subtype?: string; origin?: SDKMessageOrigin },
): boolean {
  if (config === true) return true;
  if (config === false) return false;
  return config.some(
    (f) =>
      f.type === message.type &&
      (f.subtype === undefined || f.subtype === message.subtype) &&
      (f.origin === undefined || f.origin === message.origin?.kind),
  );
}

function sessionUsage(session: Session) {
  return {
    inputTokens: session.accumulatedUsage.inputTokens,
    outputTokens: session.accumulatedUsage.outputTokens,
    cachedReadTokens: session.accumulatedUsage.cachedReadTokens,
    cachedWriteTokens: session.accumulatedUsage.cachedWriteTokens,
    totalTokens:
      session.accumulatedUsage.inputTokens +
      session.accumulatedUsage.outputTokens +
      session.accumulatedUsage.cachedReadTokens +
      session.accumulatedUsage.cachedWriteTokens,
  };
}

/** Sum all four fields as a proxy for post-turn context occupancy: the current
 *  turn's output becomes next turn's input. Per the Anthropic API, input_tokens
 *  excludes cache tokens — cache_read and cache_creation are reported
 *  separately — so summing all four is not double-counting. */
function totalTokens(usage: UsageSnapshot): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens
  );
}

/**
 * Build the `data` payload attached to a `RequestError.internalError` when we
 * have a categorical error from the Claude SDK. Returns `undefined` when no
 * categorical error is available, matching the previous behavior of passing
 * `undefined` to `RequestError.internalError`.
 *
 * The `errorKind` field is a convention for ACP clients to dispatch on
 * without having to pattern-match the human-readable message text. Clients
 * that don't understand it fall back to the existing message-based rendering.
 */
function errorKindData(
  errorKind: SDKAssistantMessageError | undefined,
): { errorKind: SDKAssistantMessageError } | undefined {
  return errorKind ? { errorKind } : undefined;
}

/** Project a nullable API usage object into our non-null snapshot shape.
 *  Both SDK message_start and assistant message `usage` have `number | null`
 *  cache fields; we coerce absent values to 0 so `totalTokens` never hits
 *  NaN. `input_tokens`/`output_tokens` are typed `number` by the SDK but
 *  synthetic or third-party-backend stream events have been observed emitting
 *  them as null/undefined — coerce those too so a malformed upstream event
 *  can't leak NaN into the wire `used` field. Delta events have different
 *  semantics (cumulative + prev fallback) and are handled inline. */
function snapshotFromUsage(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): UsageSnapshot {
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function createEnvForGateway(request?: GatewayAuthRequest) {
  if (!request?._meta) {
    return {};
  }
  const customHeaders = Object.entries(request._meta.gateway.headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

  if (request.methodId === "gateway-bedrock") {
    return {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_BEARER_TOKEN_BEDROCK: " ", // Must be non-empty to bypass pass configuration check
      ANTHROPIC_BEDROCK_BASE_URL: request._meta.gateway.baseUrl,
      ANTHROPIC_CUSTOM_HEADERS: customHeaders,
    };
  }
  return {
    ANTHROPIC_BASE_URL: request._meta.gateway.baseUrl,
    ANTHROPIC_CUSTOM_HEADERS: customHeaders,
    ANTHROPIC_AUTH_TOKEN: " ", // Must be specified to bypass claude login requirement
  };
}

/**
 * Build the list of permission modes the agent will advertise for the given
 * model. `auto` is gated by `ModelInfo.supportsAutoMode === true`, which is
 * the SDK's model-level availability signal. `undefined`/`false` both exclude
 * `auto`. `bypassPermissions` is still gated by `ALLOW_BYPASS`.
 */
function buildAvailableModes(modelInfo: ModelInfo | undefined): SessionModeState["availableModes"] {
  const modes: SessionModeState["availableModes"] = [];

  // Only advertise "auto" when the SDK reports the model supports it.
  if (modelInfo?.supportsAutoMode === true) {
    modes.push({
      id: "auto",
      name: "Auto",
      description: "Use a model classifier to approve/deny permission prompts",
    });
  }

  modes.push(
    {
      id: "default",
      name: "Default",
      description: "Standard behavior, prompts for dangerous operations",
    },
    {
      id: "acceptEdits",
      name: "Accept Edits",
      description: "Auto-accept file edit operations",
    },
    {
      id: "plan",
      name: "Plan Mode",
      description: "Planning mode, no actual tool execution",
    },
    {
      id: "dontAsk",
      name: "Don't Ask",
      description: "Don't prompt for permissions, deny if not pre-approved",
    },
  );

  if (ALLOW_BYPASS) {
    modes.push({
      id: "bypassPermissions",
      name: "Bypass Permissions",
      description: "Bypass all permission checks",
    });
  }

  return modes;
}

// Translate a UI effort value into the flag-layer payload. The SDK
// shallow-merges `applyFlagSettings`, drops `undefined` during JSON transport,
// and only clears a key when an explicit `null` is sent — see
// `applyFlagSettings` in @anthropic-ai/claude-agent-sdk. Mapping both the
// `"default"` sentinel and `undefined` (effort option absent for the model) to
// `null` ensures any previously-applied flag is actually cleared.
function toSdkEffortLevel(value: string | undefined): Settings["effortLevel"] | null {
  return value === undefined || value === "default" ? null : (value as Settings["effortLevel"]);
}

// `supportedAgents()` always returns Claude Code's built-in subagents — the
// ones used for Task-tool delegation (Explore, Plan, etc.) — even when the user
// has configured none of their own. Those aren't meaningful *main-thread*
// personas, so we filter them out and only surface the Agent picker when the
// user (or a plugin/project) has configured custom agents. Update this set if
// the SDK's built-in roster changes.
export const BUILTIN_AGENT_NAMES = new Set([
  "claude",
  "general-purpose",
  "Explore",
  "Plan",
  "statusline-setup",
]);

// Value of the synthetic "Default" entry in the agent picker, which maps to the
// standard Claude Code agent (`applyFlagSettings({ agent: null })`). It is a
// reserved sentinel: a custom agent named exactly this would collide with it
// (two options sharing the value, selection silently routing to `null`), so we
// exclude that name from discovery.
export const DEFAULT_AGENT_ID = "default";

/** Discover user/plugin/project-configured main-thread agents, excluding the
 *  built-in subagents and the reserved "default" sentinel. Returns an empty
 *  list if discovery fails so a flaky control request never blocks session
 *  creation. */
export async function discoverCustomAgents(q: Query): Promise<AgentInfo[]> {
  try {
    const agents = await q.supportedAgents();
    return agents.filter((a) => !BUILTIN_AGENT_NAMES.has(a.name) && a.name !== DEFAULT_AGENT_ID);
  } catch {
    return [];
  }
}

export function buildConfigOptions(
  modes: SessionModeState,
  models: SessionModelState,
  modelInfos: ModelInfo[],
  currentEffortLevel?: string,
  agents: AgentInfo[] = [],
  currentAgent: string = DEFAULT_AGENT_ID,
): SessionConfigOption[] {
  const options: SessionConfigOption[] = [
    {
      id: "mode",
      name: "Mode",
      description: "Session permission mode",
      category: "mode",
      type: "select",
      currentValue: modes.currentModeId,
      options: modes.availableModes.map((m) => ({
        value: m.id,
        name: m.name,
        description: m.description,
      })),
    },
    {
      id: "model",
      name: "Model",
      description: "AI model to use",
      category: "model",
      type: "select",
      currentValue: models.currentModelId,
      options: models.availableModels.map((m) => ({
        value: m.modelId,
        name: m.name,
        description: m.description ?? undefined,
      })),
    },
  ];

  // Add effort level option based on the currently selected model
  const currentModelInfo = modelInfos.find((m) => m.value === models.currentModelId);
  const supportedLevels = currentModelInfo?.supportsEffort
    ? (currentModelInfo.supportedEffortLevels ?? [])
    : [];

  if (supportedLevels.length > 0) {
    const effortOptions = [
      { value: "default", name: "Default" },
      ...supportedLevels.map((level) => ({
        value: level,
        name: level
          .split(/[_-]/)
          .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
          .join(" "),
      })),
    ];

    const includes = (l: string) => l === "default" || (supportedLevels as string[]).includes(l);
    const validEffort =
      currentEffortLevel && includes(currentEffortLevel) ? currentEffortLevel : "default";

    options.push({
      id: "effort",
      name: "Effort",
      description: "Available effort levels for this model",
      category: "thought_level",
      type: "select",
      currentValue: validEffort,
      options: effortOptions,
    });
  }

  // Only surface the Agent picker when there's a real choice — i.e. the user
  // has configured at least one custom agent (built-ins are filtered out in
  // discoverCustomAgents). With none configured, "Default" would be the only
  // entry, so we omit the option entirely.
  if (agents.length > 0) {
    options.push({
      id: "agent",
      name: "Agent",
      description: "Main-thread agent persona",
      type: "select",
      currentValue: currentAgent,
      options: [
        { value: DEFAULT_AGENT_ID, name: "Default", description: "Standard Claude Code agent" },
        ...agents.map((a) => ({
          value: a.name,
          name: a.name,
          description: a.description || undefined,
        })),
      ],
    });
  }

  return options;
}

// Claude Code CLI persists display strings like "opus[1m]" in settings,
// but the SDK model list uses IDs like "claude-opus-4-6-1m".
const MODEL_CONTEXT_HINT_PATTERN = /\[(\d+m)\]$/i;

// Captures a model family version such as `4-6` or `4.7` so we can keep
// `claude-opus-4-6` from being copied onto the SDK's `opus` alias when that
// alias currently resolves to a different family version (e.g. Opus 4.7).
const MODEL_FAMILY_VERSION_PATTERN = /\b(\d+)[-.](\d+)\b/;

function extractModelFamilyVersion(s: string): string | null {
  const match = s.match(MODEL_FAMILY_VERSION_PATTERN);
  return match ? `${match[1]}.${match[2]}` : null;
}

function modelVersionsCompatible(preference: string, candidate: ModelInfo): boolean {
  const preferred = extractModelFamilyVersion(preference);
  if (!preferred) return true;
  const candidateVersion =
    extractModelFamilyVersion(candidate.value) ??
    extractModelFamilyVersion(candidate.displayName) ??
    extractModelFamilyVersion(candidate.description);
  if (!candidateVersion) return true;
  return preferred === candidateVersion;
}

function tokenizeModelPreference(model: string): { tokens: string[]; contextHint?: string } {
  const lower = model.trim().toLowerCase();
  const contextHint = lower.match(MODEL_CONTEXT_HINT_PATTERN)?.[1]?.toLowerCase();

  const normalized = lower.replace(MODEL_CONTEXT_HINT_PATTERN, " $1 ");
  const rawTokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = rawTokens
    .map((token) => {
      if (token === "opusplan") return "opus";
      if (token === "best" || token === "default") return "";
      return token;
    })
    .filter((token) => token && token !== "claude")
    .filter((token) => /[a-z]/.test(token) || token.endsWith("m"));

  return { tokens, contextHint };
}

function scoreModelMatch(model: ModelInfo, tokens: string[], contextHint?: string): number {
  const haystack = `${model.value} ${model.displayName}`.toLowerCase();
  let score = 0;
  let nonHintMatched = false;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      if (token !== contextHint) nonHintMatched = true;
      score += token === contextHint ? 3 : 1;
    }
  }
  if (contextHint && !nonHintMatched) return 0;
  return score;
}

function resolveModelPreference(models: ModelInfo[], preference: string): ModelInfo | null {
  const trimmed = preference.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();

  // Exact match on value or display name
  const directMatch = models.find(
    (model) =>
      model.value === trimmed ||
      model.value.toLowerCase() === lower ||
      model.displayName.toLowerCase() === lower,
  );
  if (directMatch) return directMatch;

  // Substring match
  const includesMatch = models.find((model) => {
    if (!modelVersionsCompatible(trimmed, model)) return false;
    const value = model.value.toLowerCase();
    const display = model.displayName.toLowerCase();
    return value.includes(lower) || display.includes(lower) || lower.includes(value);
  });
  if (includesMatch) return includesMatch;

  // Tokenized matching for aliases like "opus[1m]"
  const { tokens, contextHint } = tokenizeModelPreference(trimmed);
  if (tokens.length === 0) return null;

  let bestMatch: ModelInfo | null = null;
  let bestScore = 0;
  for (const model of models) {
    if (!modelVersionsCompatible(trimmed, model)) continue;
    const score = scoreModelMatch(model, tokens, contextHint);
    if (0 < score && (!bestMatch || bestScore < score)) {
      bestMatch = model;
      bestScore = score;
    }
  }

  return bestMatch;
}

function resolveSettingsModel(
  models: ModelInfo[],
  settingsModel: unknown,
  logger: Logger,
): ModelInfo | null {
  if (settingsModel === undefined) {
    return null;
  }
  if (typeof settingsModel !== "string") {
    const typeLabel = settingsModel === null ? "null" : typeof settingsModel;
    logger.error(`Ignoring model from settings: expected a string, got ${typeLabel}.`);
    return null;
  }
  return resolveModelPreference(models, settingsModel);
}

/**
 * Restrict the SDK's model list to the user's `availableModels` allowlist
 * (already merged-and-deduped across settings sources by `SettingsManager`).
 * The user's exact entries become the model IDs surfaced via configOptions
 * and passed to `setModel`, which prevents Claude Code from silently
 * substituting a date-pinned variant (e.g. `haiku` →
 * `claude-haiku-4-5-20251001`) that the user may not have access to.
 *
 * Display info and capability flags are copied from the closest SDK match so
 * the UI still renders sensible names and effort levels.
 *
 * Semantics from https://code.claude.com/docs/en/model-config#restrict-model-selection:
 * - `undefined` is handled by the caller (no allowlist applied).
 * - The Default option is unaffected by `availableModels` — it always remains
 *   available, even when the allowlist is `[]`.
 */
function applyAvailableModelsAllowlist(sdkModels: ModelInfo[], allowlist: string[]): ModelInfo[] {
  // Default is always preserved per the docs. Synthesize one if the SDK
  // didn't surface it so downstream code (e.g. `getAvailableModels` picking
  // `models[0]` as a fallback) still has something to work with.
  const defaultModel = sdkModels.find((m) => m.value === "default") ?? {
    value: "default",
    displayName: "Default",
    description: "",
  };
  const result: ModelInfo[] = [defaultModel];
  const seen = new Set<string>([defaultModel.value]);

  const sdkModelsWithoutDefault = sdkModels.filter((m) => m.value !== "default");

  for (const entry of allowlist) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;

    const sdkMatch = resolveModelPreference(sdkModelsWithoutDefault, trimmed);
    if (sdkMatch) {
      result.push({ ...sdkMatch, value: trimmed });
    } else {
      result.push({ value: trimmed, displayName: trimmed, description: "" });
    }
    seen.add(trimmed);
  }

  // The custom model option (ANTHROPIC_CUSTOM_MODEL_OPTION) is exempt from the
  // allowlist, the same way Default is. Per the model-config docs it adds an
  // entry "without replacing the built-in aliases" and "appears at the bottom of
  // the /model picker", so we append it last and skip the allowlist filter; this
  // keeps a slim alias allowlist from hiding the custom model row.
  // https://code.claude.com/docs/en/model-config#add-a-custom-model-option
  const customModelOption = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION?.trim();
  if (customModelOption && !seen.has(customModelOption)) {
    const customModel = sdkModels.find((m) => m.value === customModelOption);
    if (customModel) {
      result.push(customModel);
      seen.add(customModel.value);
    }
  }

  return result;
}

async function getAvailableModels(
  query: Query,
  models: ModelInfo[],
  sdkModels: ModelInfo[],
  settingsManager: SettingsManager,
  logger: Logger,
): Promise<SessionModelState> {
  const settings = settingsManager.getSettings();

  let currentModel = models[0];
  let resolvedFromInput: string | undefined;

  // Model priority (highest to lowest):
  // 1. ANTHROPIC_MODEL environment variable
  // 2. settings.model (user configuration)
  // 3. models[0] (default first model)
  if (process.env.ANTHROPIC_MODEL) {
    const match = resolveModelPreference(models, process.env.ANTHROPIC_MODEL);
    if (match) {
      currentModel = match;
      resolvedFromInput = process.env.ANTHROPIC_MODEL;
    }
  } else if (typeof settings.model === "string") {
    const match = resolveSettingsModel(models, settings.model, logger);
    if (match) {
      currentModel = match;
      resolvedFromInput = settings.model;
    }
  }

  // Skip the setModel round-trip when we can prove the SDK has already landed
  // on the same model. Two cases qualify:
  //  (a) No override applied — currentModel stayed at models[0]; the SDK is on
  //      its own default and we have nothing to sync.
  //  (b) The resolver returned the user's input verbatim AND that value exists
  //      in the SDK's original model list — meaning no fuzzy match or
  //      allowlist rewrite was involved, and the SDK (which reads the same
  //      ANTHROPIC_MODEL / settings.json) will have arrived at the same entry.
  // Anything else (fuzzy match, allowlist-synthesized value, alias) gets a
  // setModel call so we don't drift from the user's intended pin.
  const sdkSawSameValue = sdkModels.some((m) => m.value === currentModel.value);
  const skipSetModel =
    resolvedFromInput === undefined ||
    (currentModel.value === resolvedFromInput && sdkSawSameValue);
  if (!skipSetModel) {
    await query.setModel(currentModel.value);
  }

  return {
    availableModels: models.map((model) => ({
      modelId: model.value,
      name: model.displayName,
      description: model.description,
    })),
    currentModelId: currentModel.value,
  };
}

function getAvailableSlashCommands(commands: SlashCommand[]): AvailableCommand[] {
  const UNSUPPORTED_COMMANDS = [
    "clear",
    "cost",
    "keybindings-help",
    "login",
    "logout",
    "output-style:new",
    "release-notes",
    "todos",
  ];

  return commands
    .map((command) => {
      const input = command.argumentHint
        ? {
            hint: Array.isArray(command.argumentHint)
              ? command.argumentHint.join(" ")
              : command.argumentHint,
          }
        : null;
      let name = command.name;
      if (command.name.endsWith(" (MCP)")) {
        name = `mcp:${name.replace(" (MCP)", "")}`;
      }
      return {
        name,
        description: command.description || "",
        input,
      };
    })
    .filter((command: AvailableCommand) => !UNSUPPORTED_COMMANDS.includes(command.name));
}

function formatUriAsLink(uri: string): string {
  try {
    if (uri.startsWith("file://")) {
      const path = uri.slice(7); // Remove "file://"
      const name = path.split("/").pop() || path;
      return `[@${name}](${uri})`;
    } else if (uri.startsWith("zed://")) {
      const parts = uri.split("/");
      const name = parts[parts.length - 1] || uri;
      return `[@${name}](${uri})`;
    }
    return uri;
  } catch {
    return uri;
  }
}

export function promptToClaude(prompt: PromptRequest): SDKUserMessage {
  const content: any[] = [];
  const context: any[] = [];

  for (const chunk of prompt.prompt) {
    switch (chunk.type) {
      case "text": {
        let text = chunk.text;
        // change /mcp:server:command args -> /server:command (MCP) args
        const mcpMatch = text.match(/^\/mcp:([^:\s]+):(\S+)(?:\s(.*))?$/);
        if (mcpMatch) {
          const [, server, command, args] = mcpMatch;
          text = `/${server}:${command} (MCP)${args ? ` ${args}` : ""}`;
        }
        content.push({ type: "text", text });
        break;
      }
      case "resource_link": {
        const formattedUri = formatUriAsLink(chunk.uri);
        content.push({
          type: "text",
          text: formattedUri,
        });
        break;
      }
      case "resource": {
        if ("text" in chunk.resource) {
          const formattedUri = formatUriAsLink(chunk.resource.uri);
          content.push({
            type: "text",
            text: formattedUri,
          });
          context.push({
            type: "text",
            text: `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>`,
          });
        }
        // Ignore blob resources (unsupported)
        break;
      }
      case "image":
        if (chunk.data) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              data: chunk.data,
              media_type: chunk.mimeType,
            },
          });
        } else if (chunk.uri && chunk.uri.startsWith("http")) {
          content.push({
            type: "image",
            source: {
              type: "url",
              url: chunk.uri,
            },
          });
        }
        break;
      // Ignore audio and other unsupported types
      default:
        break;
    }
  }

  content.push(...context);

  return {
    type: "user",
    message: {
      role: "user",
      content: content,
    },
    session_id: prompt.sessionId,
    parent_tool_use_id: null,
  };
}

/**
 * Resolves the ACP `messageId` for a Claude SDK message (live) or a persisted
 * transcript message (replay) so chunk grouping is identical in both views.
 *
 * Assistant turns are keyed by the Anthropic API message id (`message.id`),
 * which is identical at `message_start`, on the consolidated assistant message,
 * and in the persisted transcript — unlike the per-`stream_event` uuid, which is
 * unique per event and never persisted. User messages have no API id, but they
 * are never streamed, so their (stable) SDK uuid is used instead. ACP message
 * ids are opaque strings, so no particular format is required.
 */
export function messageIdForGrouping(message: {
  type?: string;
  uuid?: string | null;
  message?: unknown;
}): string | undefined {
  if (message.type === "assistant") {
    const inner = message.message;
    const apiId =
      inner && typeof inner === "object" && "id" in inner
        ? (inner as { id?: unknown }).id
        : undefined;
    if (typeof apiId === "string" && apiId.length > 0) {
      return apiId;
    }
  }
  return typeof message.uuid === "string" && message.uuid.length > 0 ? message.uuid : undefined;
}

/**
 * Stamps an ACP `messageId` onto a session update, but only on the message/
 * thought chunk variants that carry one — tool_call/plan/etc. updates never do.
 * No-op when `messageId` is falsy, so callers can pass it through unconditionally.
 */
function applyMessageId(
  update: SessionNotification["update"],
  messageId: string | undefined,
): void {
  if (
    messageId &&
    (update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "user_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk")
  ) {
    update.messageId = messageId;
  }
}

/** Built-in tools that drive the task list (headless/SDK sessions use these
 *  instead of TodoWrite). Their tool_use/tool_result are surfaced as `plan`
 *  snapshots rather than as tool_calls. */
function isTaskTool(toolName: string): boolean {
  return (
    toolName === "TaskCreate" ||
    toolName === "TaskUpdate" ||
    toolName === "TaskList" ||
    toolName === "TaskGet"
  );
}

/** Whether a tool's tool_use surfaces to the client as a standalone
 *  `tool_call`. TodoWrite is rendered as a `plan` and Task* tools are
 *  suppressed (their plan snapshot is emitted at tool_result time), so neither
 *  produces a tool_call. */
function shouldEmitToolCall(toolName: string): boolean {
  return toolName !== "TodoWrite" && !isTaskTool(toolName);
}

/** Build the `tool_call` (or, with `refine`, the `tool_call_update`)
 *  notification for a tool_use. Shared by every site that surfaces a tool call:
 *  the streamed tool_use path (first encounter → tool_call, later encounter →
 *  refine) and the permission flow (`ensureToolCallEmitted`), so they can't
 *  drift. The initial `tool_call` carries `status: "pending"` and, for Bash, the
 *  `terminal_info` _meta that the later `terminal_output`/`terminal_exit`
 *  updates key off of; a refining `tool_call_update` carries neither. */
function toolCallNotification(
  toolUse: { id: string; name: string; input: unknown },
  rawInput: unknown,
  supportsTerminalOutput: boolean,
  cwd?: string,
  refine = false,
): SessionNotification["update"] {
  if (refine) {
    return {
      _meta: { claudeCode: { toolName: toolUse.name } } satisfies ToolUpdateMeta,
      toolCallId: toolUse.id,
      sessionUpdate: "tool_call_update",
      rawInput,
      ...toolInfoFromToolUse(toolUse, supportsTerminalOutput, cwd),
    };
  }
  return {
    _meta: {
      claudeCode: { toolName: toolUse.name },
      ...(toolUse.name === "Bash" && supportsTerminalOutput
        ? { terminal_info: { terminal_id: toolUse.id } }
        : {}),
    } satisfies ToolUpdateMeta,
    toolCallId: toolUse.id,
    sessionUpdate: "tool_call",
    rawInput,
    status: "pending",
    ...toolInfoFromToolUse(toolUse, supportsTerminalOutput, cwd),
  };
}

/**
 * Convert an SDKAssistantMessage (Claude) to a SessionNotification (ACP).
 * Only handles text, image, and thinking chunks for now.
 */
export function toAcpNotifications(
  content: string | ContentBlockParam[] | BetaContentBlock[] | BetaRawContentBlockDelta[],
  role: "assistant" | "user",
  sessionId: string,
  toolUseCache: ToolUseCache,
  client: AcpClient,
  logger: Logger,
  options?: {
    registerHooks?: boolean;
    clientCapabilities?: ClientCapabilities;
    parentToolUseId?: string | null;
    cwd?: string;
    taskState?: TaskState;
    // Tracks tool_use ids already emitted as a `tool_call` so a permission
    // request (which emits the tool_call eagerly) and the streamed tool_use
    // chunk don't both emit one — whichever arrives second emits a
    // `tool_call_update` instead. Mutated in place. When omitted, the
    // tool_call/update decision falls back to `toolUseCache` presence (the
    // historical single-source behavior).
    emittedToolCalls?: Set<string>;
    // Opaque id identifying the message these chunks belong to (ACP message ids
    // are opaque strings — no particular format is required). Attached to
    // user/agent message and thought chunks so clients can group streamed chunks
    // into a single message. Omit it (leave undefined) when unknown — never send
    // an explicit `null`.
    messageId?: string;
  },
): SessionNotification[] {
  const taskState = options?.taskState ?? new Map();
  const registerHooks = options?.registerHooks !== false;
  const supportsTerminalOutput = options?.clientCapabilities?._meta?.["terminal_output"] === true;
  if (typeof content === "string") {
    const update: SessionNotification["update"] = {
      sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
      content: {
        type: "text",
        text: content,
      },
    };
    applyMessageId(update, options?.messageId);

    if (options?.parentToolUseId) {
      update._meta = {
        ...update._meta,
        claudeCode: {
          ...(update._meta?.claudeCode || {}),
          parentToolUseId: options.parentToolUseId,
        },
      };
    }

    return [{ sessionId, update }];
  }

  const output = [];
  // Only handle the first chunk for streaming; extend as needed for batching
  for (const chunk of content) {
    let update: SessionNotification["update"] | null = null;
    switch (chunk.type) {
      case "text":
      case "text_delta":
        update = {
          sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
          content: {
            type: "text",
            text: chunk.text,
          },
        };
        break;
      case "image":
        update = {
          sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
          content: {
            type: "image",
            data: chunk.source.type === "base64" ? chunk.source.data : "",
            mimeType: chunk.source.type === "base64" ? chunk.source.media_type : "",
            uri: chunk.source.type === "url" ? chunk.source.url : undefined,
          },
        };
        break;
      case "thinking":
      case "thinking_delta":
        // Recent models default `thinking.display` to "omitted", which streams
        // signature-only thinking blocks whose text is empty.
        if (chunk.thinking.length > 0) {
          update = {
            sessionUpdate: "agent_thought_chunk",
            content: {
              type: "text",
              text: chunk.thinking,
            },
          };
        }
        break;
      case "tool_use":
      case "server_tool_use":
      case "mcp_tool_use": {
        const alreadyCached = chunk.id in toolUseCache;
        toolUseCache[chunk.id] = chunk;
        if (chunk.name === "TodoWrite") {
          // @ts-expect-error - sometimes input is empty object or undefined
          if (Array.isArray(chunk.input?.todos)) {
            update = {
              sessionUpdate: "plan",
              entries: planEntries(chunk.input as { todos: ClaudePlanEntry[] }),
            };
          }
        } else if (isTaskTool(chunk.name)) {
          // Task* tool_use is suppressed; the plan update is emitted at
          // tool_result time once we have the task ID (for TaskCreate) and
          // confirmation that the change took effect.
        } else {
          // Only register hooks on first encounter to avoid double-firing
          if (registerHooks && !alreadyCached) {
            // Capture the tool name in the closure rather than re-reading the
            // cache when the hook fires. The cache entry is pruned at
            // tool_result time, and a PostToolUse hook can fire after that, so
            // closing over the name keeps the diff working without depending on
            // (or pinning) the cache entry's lifetime.
            const toolName = chunk.name;
            registerHookCallback(chunk.id, {
              onPostToolUseHook: async (toolUseId, toolInput, toolResponse) => {
                // Both `Edit` and `Write` produce a structuredPatch in their
                // PostToolUse tool_response. For Edit the diff replaces the
                // optimistic content built at tool_use time. For Write the
                // optimistic content (built from `input.content` alone with
                // `oldText: null`) shows "creation" semantics regardless of
                // whether the file existed; the structuredPatch from the
                // hook lets us emit the real diff for `type: "update"`. The
                // helper returns `{}` if the response shape isn't usable.
                const editDiff =
                  toolName === "Edit" || toolName === "Write"
                    ? toolUpdateFromDiffToolResponse(toolResponse)
                    : {};
                const update: SessionNotification["update"] = {
                  _meta: {
                    claudeCode: {
                      toolResponse,
                      toolName,
                    },
                  } satisfies ToolUpdateMeta,
                  toolCallId: toolUseId,
                  sessionUpdate: "tool_call_update",
                  ...editDiff,
                };
                await client.sessionUpdate({
                  sessionId,
                  update,
                });
              },
            });
          }

          let rawInput;
          try {
            rawInput = JSON.parse(JSON.stringify(chunk.input));
          } catch {
            // ignore if we can't turn it to JSON
          }

          // Emit a `tool_call` only the first time this id surfaces to the
          // client; afterwards refine it with a `tool_call_update`. The first
          // surface may be this stream chunk OR an earlier permission request
          // (see `ensureToolCallEmitted`), so emission is tracked separately
          // from `toolUseCache`. Without an `emittedToolCalls` set we fall back
          // to cache presence — the historical streaming-only behavior.
          const emittedToolCalls = options?.emittedToolCalls;
          const alreadyEmitted = emittedToolCalls ? emittedToolCalls.has(chunk.id) : alreadyCached;
          emittedToolCalls?.add(chunk.id);

          if (alreadyEmitted) {
            // Already surfaced (full assistant message after streaming, or a
            // permission request emitted it first) — refine with a
            // tool_call_update rather than emitting a duplicate tool_call.
            update = toolCallNotification(
              chunk,
              rawInput,
              supportsTerminalOutput,
              options?.cwd,
              true,
            );
          } else {
            // First surface (streaming content_block_start or replay) — send as
            // tool_call (with terminal_info for Bash).
            update = toolCallNotification(chunk, rawInput, supportsTerminalOutput, options?.cwd);
          }
        }
        break;
      }

      case "tool_result":
      case "tool_search_tool_result":
      case "web_fetch_tool_result":
      case "web_search_tool_result":
      case "code_execution_tool_result":
      case "bash_code_execution_tool_result":
      case "text_editor_code_execution_tool_result":
      case "mcp_tool_result": {
        options?.emittedToolCalls?.delete(chunk.tool_use_id);
        const toolUse = toolUseCache[chunk.tool_use_id];
        if (!toolUse) {
          logger.error(
            `[claude-agent-acp] Got a tool result for tool use that wasn't tracked: ${chunk.tool_use_id}`,
          );
          break;
        }

        if (isTaskTool(toolUse.name)) {
          // Headless/SDK sessions emit Task* tools instead of TodoWrite.
          // TaskCreate / TaskUpdate mutate the accumulated task list; TaskList
          // and TaskGet are read-only so we just suppress their tool_call /
          // tool_result events. The plan update is emitted as a snapshot of
          // the accumulated state, mirroring the legacy TodoWrite behavior.
          const isError = "is_error" in chunk && chunk.is_error;
          if (!isError) {
            if (toolUse.name === "TaskCreate") {
              applyTaskCreate(
                taskState,
                toolUse.input as Parameters<typeof applyTaskCreate>[1],
                parseTaskCreateOutput(chunk.content),
              );
            } else if (toolUse.name === "TaskUpdate") {
              applyTaskUpdate(taskState, toolUse.input as Parameters<typeof applyTaskUpdate>[1]);
            }
          }
          if (!isError && (toolUse.name === "TaskCreate" || toolUse.name === "TaskUpdate")) {
            update = {
              sessionUpdate: "plan",
              entries: taskStateToPlanEntries(taskState),
            };
          }
        } else if (toolUse.name !== "TodoWrite") {
          const { _meta: toolMeta, ...toolUpdate } = toolUpdateFromToolResult(
            chunk,
            toolUseCache[chunk.tool_use_id],
            supportsTerminalOutput,
          );

          // When terminal output is supported, send terminal_output as a
          // separate notification to match codex-acp's streaming lifecycle:
          //   1. tool_call       → _meta.terminal_info  (already sent above)
          //   2. tool_call_update → _meta.terminal_output (sent here)
          //   3. tool_call_update → _meta.terminal_exit  (sent below with status)
          if (toolMeta?.terminal_output) {
            output.push({
              sessionId,
              update: {
                _meta: {
                  terminal_output: toolMeta.terminal_output,
                  ...(options?.parentToolUseId
                    ? { claudeCode: { parentToolUseId: options.parentToolUseId } }
                    : {}),
                },
                toolCallId: chunk.tool_use_id,
                sessionUpdate: "tool_call_update" as const,
              },
            });
          }

          update = {
            _meta: {
              claudeCode: {
                toolName: toolUse.name,
              },
              ...(toolMeta?.terminal_exit ? { terminal_exit: toolMeta.terminal_exit } : {}),
            } satisfies ToolUpdateMeta,
            toolCallId: chunk.tool_use_id,
            sessionUpdate: "tool_call_update",
            status: "is_error" in chunk && chunk.is_error ? "failed" : "completed",
            rawOutput: chunk.content,
            ...toolUpdate,
          };
        }
        // The tool_use is fully resolved now — drop it so a long session doesn't
        // retain every tool call. The PostToolUse hook (Edit/Write diffs) closes
        // over the tool name and no longer reads the cache, so pruning here is
        // safe regardless of hook/result ordering.
        delete toolUseCache[chunk.tool_use_id];
        break;
      }

      case "document":
      case "search_result":
      case "redacted_thinking":
      case "input_json_delta":
      case "citations_delta":
      case "signature_delta":
      case "container_upload":
      case "compaction":
      case "compaction_delta":
      case "advisor_tool_result":
      case "mid_conv_system":
      case "fallback":
        break;

      default:
        unreachable(chunk, logger);
        break;
    }
    if (update) {
      if (options?.parentToolUseId) {
        update._meta = {
          ...update._meta,
          claudeCode: {
            ...(update._meta?.claudeCode || {}),
            parentToolUseId: options.parentToolUseId,
          },
        };
      }
      applyMessageId(update, options?.messageId);
      output.push({ sessionId, update });
    }
  }

  return output;
}

export function streamEventToAcpNotifications(
  message: SDKPartialAssistantMessage,
  sessionId: string,
  toolUseCache: ToolUseCache,
  client: AcpClient,
  logger: Logger,
  options?: {
    clientCapabilities?: ClientCapabilities;
    cwd?: string;
    taskState?: TaskState;
    emittedToolCalls?: Set<string>;
    messageId?: string;
  },
): SessionNotification[] {
  const event = message.event;
  switch (event.type) {
    case "content_block_start":
      return toAcpNotifications(
        [event.content_block],
        "assistant",
        sessionId,
        toolUseCache,
        client,
        logger,
        {
          clientCapabilities: options?.clientCapabilities,
          parentToolUseId: message.parent_tool_use_id,
          cwd: options?.cwd,
          taskState: options?.taskState,
          emittedToolCalls: options?.emittedToolCalls,
          messageId: options?.messageId,
        },
      );
    case "content_block_delta":
      return toAcpNotifications(
        [event.delta],
        "assistant",
        sessionId,
        toolUseCache,
        client,
        logger,
        {
          clientCapabilities: options?.clientCapabilities,
          parentToolUseId: message.parent_tool_use_id,
          cwd: options?.cwd,
          taskState: options?.taskState,
          emittedToolCalls: options?.emittedToolCalls,
          messageId: options?.messageId,
        },
      );
    // No content. `ping` is a Messages-API keep-alive event that the SDK's
    // `BetaRawMessageStreamEvent` union doesn't include even though the
    // wire format emits it; the `as never` cast lets us no-op it here
    // instead of letting it fall through to `unreachable`.
    case "ping" as never:
    case "message_start":
    case "message_delta":
    case "message_stop":
    case "content_block_stop":
      return [];

    default:
      unreachable(event, logger);
      return [];
  }
}

/** Run a `session/prompt` while honoring `$/cancel_request` for it. ACP clients
 *  normally stop a turn with the `session/cancel` notification, but `signal`
 *  (the prompt request's abort signal) also fires when the client sends the
 *  generic `$/cancel_request` for this prompt — the protocol's complementary
 *  cancellation fallback. Route that to the same `agent.cancel` path so a client
 *  using only the generic mechanism still stops the turn (and the prompt
 *  resolves "cancelled" instead of running to completion).
 *
 *  The listener is scoped to this call: once the prompt settles it is removed,
 *  so a later teardown-time abort of the (per-request) signal can't cancel a
 *  subsequent turn. `signal` also aborts on connection close, in which case
 *  cancelling the in-flight turn is the desired behavior anyway. */
export async function runPromptWithCancellation(
  agent: Pick<ClaudeAcpAgent, "prompt" | "cancel" | "logger">,
  params: PromptRequest,
  signal: AbortSignal,
): Promise<PromptResponse> {
  const onAbort = () => {
    // Fire-and-forget: nothing awaits this listener, so swallow (and log) any
    // rejection rather than surfacing it as an unhandled rejection.
    agent.cancel({ sessionId: params.sessionId }).catch((error) => {
      agent.logger.error(`Failed to cancel prompt via $/cancel_request: ${error}`);
    });
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await agent.prompt(params);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function runAcp() {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);

  // `connect(...)` returns a connection-scoped peer handle (`connection.client`)
  // that stays valid for the whole connection, so the agent captures it once.
  // Handlers close over `agent`, which is assigned synchronously right after
  // `connect()` returns — before the connection processes any inbound message.
  // It cannot be `const`: its value depends on `connection.client`, which does
  // not exist until `connect()` has been called.
  // eslint-disable-next-line prefer-const
  let agent: ClaudeAcpAgent;
  const connection = acpAgent({ name: "claude-code-acp" })
    .onRequest(methods.agent.initialize, (ctx) => agent.initialize(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) => agent.newSession(ctx.params))
    .onRequest(methods.agent.session.load, (ctx) => agent.loadSession(ctx.params))
    .onRequest(methods.agent.session.fork, (ctx) => agent.unstable_forkSession(ctx.params))
    .onRequest(methods.agent.session.list, (ctx) => agent.listSessions(ctx.params))
    .onRequest(methods.agent.session.delete, (ctx) => agent.deleteSession(ctx.params))
    .onRequest(methods.agent.session.resume, (ctx) => agent.resumeSession(ctx.params))
    .onRequest(methods.agent.session.close, (ctx) => agent.closeSession(ctx.params))
    .onRequest(methods.agent.session.setMode, (ctx) => agent.setSessionMode(ctx.params))
    .onRequest(methods.agent.session.setConfigOption, (ctx) =>
      agent.setSessionConfigOption(ctx.params),
    )
    .onRequest(methods.agent.authenticate, (ctx) => agent.authenticate(ctx.params))
    .onRequest(methods.agent.logout, (ctx) => agent.logout(ctx.params))
    .onRequest(methods.agent.session.prompt, (ctx) =>
      runPromptWithCancellation(agent, ctx.params, ctx.signal),
    )
    .onNotification(methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params))
    .connect(stream);

  agent = new ClaudeAcpAgent(new ClientConnection(connection.client));
  return { connection, agent };
}

function commonPrefixLength(a: string, b: string) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }
  return i;
}

/** Best-effort first guess of a model's context window, used only as a
 *  fallback when the SDK's authoritative `getContextUsage` is unavailable (and
 *  until a `result` message arrives with the `modelUsage` value).
 *
 *  Anthropic 1M-context variants encode "1m" as a distinct token in the SDK
 *  model ID (e.g., "claude-opus-4-6-1m"), which `\b1m\b` catches without also
 *  matching things like "10m" or embedded substrings. Semantic aliases like
 *  `default` carry no such token in the ID, but the SDK's human-facing
 *  `displayName`/`description` do (e.g. "Opus 4.7 (1M context)"), so callers
 *  pass those too — the same `\b1m\b` token appears in "1M context". The SDK's
 *  `ModelInfo` exposes no structured context-window field, so this text scan is
 *  the only pre-`result` signal available. A miss falls back to the default
 *  window and is corrected by `result.modelUsage` within one turn. */
function inferContextWindowFromModel(...texts: Array<string | undefined>): number | null {
  if (texts.some((text) => text != null && /\b1m\b/i.test(text))) return 1_000_000;
  return null;
}

/** Fetch the SDK's authoritative context-window occupancy via the
 *  `getContextUsage` control request. Unlike the per-message API usage numbers
 *  (which only count message tokens), this `totalTokens` includes the system
 *  prompt, tool schemas, MCP tools, and memory-file overhead — the real
 *  occupancy the user sees. Returns `null` on any control-request failure.
 *
 *  Note: we deliberately do NOT use this response's window fields for `size`.
 *  They have been observed to under-report extended (1M) context windows, so
 *  the window keeps coming from `modelUsage` / `inferContextWindowFromModel`,
 *  which handle the 1M variants correctly. */
async function fetchContextUsedTokens(query: Query, logger: Logger): Promise<number | null> {
  try {
    const usage = await query.getContextUsage();
    return usage.totalTokens;
  } catch (error) {
    logger.error("Failed to fetch context usage from SDK:", error);
    return null;
  }
}

/** Translate the legacy `MAX_THINKING_TOKENS` env var into the SDK's `thinking`
 *  option. The `maxThinkingTokens` option it used to feed is deprecated and
 *  reduced to on/off on current models, so map the value to explicit thinking
 *  config instead: unset → `undefined` (SDK default, adaptive on models that
 *  support it); `0` → disabled; a positive integer → a fixed token budget.
 *  Anything else is ignored with a warning. */
function resolveThinkingConfig(
  raw: string | undefined,
  logger: Logger,
): ThinkingConfig | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    logger.error(`Ignoring MAX_THINKING_TOKENS: expected a non-negative integer, got '${raw}'.`);
    return undefined;
  }
  return parsed === 0 ? { type: "disabled" } : { type: "enabled", budgetTokens: parsed };
}

function parseModelConfig(
  raw: string | undefined,
): { modelOverrides?: Record<string, string>; availableModels?: string[] } | undefined {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CLAUDE_MODEL_CONFIG must be a JSON object");
  }
  const result: { modelOverrides?: Record<string, string>; availableModels?: string[] } = {};
  if (parsed.modelOverrides !== undefined) result.modelOverrides = parsed.modelOverrides;
  if (parsed.availableModels !== undefined) result.availableModels = parsed.availableModels;
  return Object.keys(result).length > 0 ? result : undefined;
}

function getMatchingModelUsage(modelUsage: Record<string, ModelUsage>, currentModel: string) {
  let bestKey: string | null = null;
  let bestLen = 0;

  for (const key of Object.keys(modelUsage)) {
    const len = commonPrefixLength(key, currentModel);
    if (len > bestLen) {
      bestLen = len;
      bestKey = key;
    }
  }

  if (bestKey) {
    return modelUsage[bestKey];
  }
}
