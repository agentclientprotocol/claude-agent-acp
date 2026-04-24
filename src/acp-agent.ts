import {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthMethod,
  AvailableCommand,
  CancelNotification,
  ClientCapabilities,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestError,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionModelState,
  SessionModeState,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  TerminalHandle,
  TerminalOutputResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  StopReason,
} from "@agentclientprotocol/sdk";
import {
  CanUseTool,
  getSessionMessages,
  listSessions,
  McpServerConfig,
  ModelInfo,
  ModelUsage,
  Options,
  PermissionMode,
  Query,
  query,
  Settings,
  SDKAssistantMessageError,
  SDKPartialAssistantMessage,
  SDKUserMessage,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { BetaContentBlock, BetaRawContentBlockDelta } from "@anthropic-ai/sdk/resources/beta.mjs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { SettingsManager } from "./settings.js";
import {
  ClaudePlanEntry,
  createPostToolUseHook,
  planEntries,
  registerHookCallback,
  toolInfoFromToolUse,
  toolUpdateFromEditToolResponse,
  toolUpdateFromToolResult,
} from "./tools.js";
import { nodeToWebReadable, nodeToWebWritable, Pushable, unreachable } from "./utils.js";

export const CLAUDE_CONFIG_DIR =
  process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");

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

type Session = {
  query: Query;
  input: Pushable<SDKUserMessage>;
  cancelled: boolean;
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
  promptRunning: boolean;
  pendingMessages: Map<string, { resolve: (cancelled: boolean) => void; order: number }>;
  nextPendingOrder: number;
  abortController: AbortController;
  emitRawSDKMessages: boolean | SDKMessageFilter[];
  /** Context window size of the last top-level assistant model, carried across
   *  prompts so mid-stream usage_update notifications report a correct `size`
   *  before the turn's first result message arrives. Defaults to
   *  DEFAULT_CONTEXT_WINDOW, refreshed from each result's modelUsage, and
   *  invalidated when the user switches the session's model. */
  contextWindowSize: number;
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

type BackgroundTerminal =
  | {
      handle: TerminalHandle;
      status: "started";
      lastOutput: TerminalOutputResponse | null;
    }
  | {
      status: "aborted" | "exited" | "killed" | "timedOut";
      pendingOutput: TerminalOutputResponse;
    };

export type SDKMessageFilter = {
  type: string;
  subtype?: string;
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
  const candidates =
    process.platform === "linux"
      ? [
          `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/claude${ext}`,
          `@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude${ext}`,
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

function shouldHideClaudeAuth(): boolean {
  return process.argv.includes("--hide-claude-auth");
}

// Bypass Permissions doesn't work if we are a root/sudo user
const IS_ROOT = (process.geteuid?.() ?? process.getuid?.()) === 0;
const ALLOW_BYPASS = !IS_ROOT || !!process.env.IS_SANDBOX;

// Slash commands that the SDK handles locally without replaying the user
// message and without invoking the model.
const LOCAL_ONLY_COMMANDS = new Set(["/context", "/heapdump", "/extra-usage"]);

const PERMISSION_MODE_ALIASES: Record<string, PermissionMode> = {
  auto: "auto",
  default: "default",
  acceptedits: "acceptEdits",
  dontask: "dontAsk",
  plan: "plan",
  bypasspermissions: "bypassPermissions",
  bypass: "bypassPermissions",
};

export function resolvePermissionMode(defaultMode?: unknown): PermissionMode {
  if (defaultMode === undefined) {
    return "default";
  }

  if (typeof defaultMode !== "string") {
    throw new Error("Invalid permissions.defaultMode: expected a string.");
  }

  const normalized = defaultMode.trim().toLowerCase();
  if (normalized === "") {
    throw new Error("Invalid permissions.defaultMode: expected a non-empty string.");
  }

  const mapped = PERMISSION_MODE_ALIASES[normalized];
  if (!mapped) {
    throw new Error(`Invalid permissions.defaultMode: ${defaultMode}.`);
  }

  if (mapped === "bypassPermissions" && !ALLOW_BYPASS) {
    throw new Error(
      "Invalid permissions.defaultMode: bypassPermissions is not available when running as root.",
    );
  }

  return mapped;
}

// Implement the ACP Agent interface
export class ClaudeAcpAgent implements Agent {
  sessions: {
    [key: string]: Session;
  };
  client: AgentSideConnection;
  toolUseCache: ToolUseCache;
  backgroundTerminals: { [key: string]: BackgroundTerminal } = {};
  clientCapabilities?: ClientCapabilities;
  logger: Logger;
  gatewayAuthMeta?: GatewayAuthMeta;

  constructor(client: AgentSideConnection, logger?: Logger) {
    this.sessions = {};
    this.client = client;
    this.toolUseCache = {};
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
        loadSession: true,
        sessionCapabilities: {
          fork: {},
          list: {},
          resume: {},
          close: {},
        },
      },
      agentInfo: {
        name: packageJson.name,
        title: "Claude Agent",
        version: packageJson.version,
      },
      authMethods: [...terminalAuthMethods, ...(supportsGatewayAuth ? [gatewayAuthMethod] : [])],
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

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    if (_params.methodId === "gateway") {
      this.gatewayAuthMeta = _params._meta as GatewayAuthMeta | undefined;
      return;
    }
    throw new Error("Method not implemented.");
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }

    session.cancelled = false;
    session.accumulatedUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    };

    let lastAssistantTotalUsage: number | null = null;
    let lastAssistantUsage: UsageSnapshot | null = null;
    let lastAssistantModel: string | null = null;
    // When the Claude SDK classifies a turn as failed (e.g. rate limit, auth
    // problem, billing), it sets a categorical `error` field on the
    // `SDKAssistantMessage` that precedes the final `result` message. We
    // capture it here so the subsequent `RequestError.internalError` can
    // forward it to clients as structured `data`, sparing them from
    // pattern-matching on the human-readable message text.
    let lastAssistantError: SDKAssistantMessageError | undefined;

    const userMessage = promptToClaude(params);

    const promptUuid = randomUUID();
    userMessage.uuid = promptUuid;

    // These local-only commands return a result without replaying the user
    // message. Mark promptReplayed=true so their result isn't consumed as a
    // background task result.
    const firstText = params.prompt[0]?.type === "text" ? params.prompt[0].text : "";
    const isLocalOnlyCommand =
      firstText.startsWith("/") && LOCAL_ONLY_COMMANDS.has(firstText.split(" ", 1)[0]);

    if (session.promptRunning) {
      session.input.push(userMessage);
      const order = session.nextPendingOrder++;
      const cancelled = await new Promise<boolean>((resolve) => {
        session.pendingMessages.set(promptUuid, { resolve, order });
      });
      if (cancelled) {
        return { stopReason: "cancelled" };
      }
    } else {
      session.input.push(userMessage);
    }

    session.promptRunning = true;
    let handedOff = false;
    let stopReason: StopReason = "end_turn";

    try {
      while (true) {
        const { value: message, done } = await session.query.next();

        if (done || !message) {
          if (session.cancelled) {
            return { stopReason: "cancelled" };
          }
          break;
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
                  await this.client.sessionUpdate({
                    sessionId: message.session_id,
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "Compacting..." },
                    },
                  });
                }
                break;
              }
              case "compact_boundary": {
                // Send used:0 immediately so the client doesn't keep showing
                // the stale pre-compaction context size until the next turn.
                //
                // This is a deliberate approximation: we don't know the exact
                // post-compaction token count (only the SDK's next API call
                // reveals that). But used:0 is directionally correct — context
                // just dropped dramatically — and the real value replaces it
                // within seconds when the next result message arrives.
                // The alternative (no update) leaves the client showing e.g.
                // "944k/1m" right after the user sees "Compacting completed",
                // which is confusing and wrong.
                lastAssistantTotalUsage = 0;
                lastAssistantUsage = null;
                await this.client.sessionUpdate({
                  sessionId: message.session_id,
                  update: {
                    sessionUpdate: "usage_update",
                    used: 0,
                    size: session.contextWindowSize,
                  },
                });
                await this.client.sessionUpdate({
                  sessionId: message.session_id,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "\n\nCompacting completed." },
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
                  return { stopReason, usage: sessionUsage(session) };
                }
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
              case "elicitation_complete":
              case "plugin_install":
              case "memory_recall":
              case "notification":
              case "api_retry":
              case "mirror_error":
                // Todo: process via status api: https://docs.claude.com/en/docs/claude-code/hooks#hook-output
                break;
              default:
                unreachable(message, this.logger);
                break;
            }
            break;
          case "result": {
            // Accumulate usage from this result
            session.accumulatedUsage.inputTokens += message.usage.input_tokens;
            session.accumulatedUsage.outputTokens += message.usage.output_tokens;
            session.accumulatedUsage.cachedReadTokens += message.usage.cache_read_input_tokens;
            session.accumulatedUsage.cachedWriteTokens += message.usage.cache_creation_input_tokens;

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
                },
              });
            }

            if (session.cancelled) {
              stopReason = "cancelled";
              break;
            }

            switch (message.subtype) {
              case "success": {
                if (message.result.includes("Please run /login")) {
                  throw RequestError.authRequired();
                }
                if (message.stop_reason === "max_tokens") {
                  stopReason = "max_tokens";
                  break;
                }
                if (message.is_error) {
                  throw RequestError.internalError(
                    errorKindData(lastAssistantError),
                    message.result,
                  );
                }
                // For local-only commands (no model invocation), the result
                // text is the command output — forward it to the client.
                if (isLocalOnlyCommand) {
                  for (const notification of toAcpNotifications(
                    message.result,
                    "assistant",
                    params.sessionId,
                    this.toolUseCache,
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
                  stopReason = "max_tokens";
                  break;
                }
                if (message.is_error) {
                  throw RequestError.internalError(
                    errorKindData(lastAssistantError),
                    message.errors.join(", ") || message.subtype,
                  );
                }
                stopReason = "end_turn";
                break;
              }
              case "error_max_budget_usd":
              case "error_max_turns":
              case "error_max_structured_output_retries":
                if (message.is_error) {
                  throw RequestError.internalError(
                    errorKindData(lastAssistantError),
                    message.errors.join(", ") || message.subtype,
                  );
                }
                stopReason = "max_turn_requests";
                break;
              default:
                unreachable(message, this.logger);
                break;
            }
            break;
          }
          case "stream_event": {
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
              this.toolUseCache,
              this.client,
              this.logger,
              {
                clientCapabilities: this.clientCapabilities,
                cwd: session.cwd,
              },
            )) {
              await this.client.sessionUpdate(notification);
            }
            break;
          }
          case "user":
          case "assistant": {
            if (session.cancelled) {
              break;
            }

            // Check for prompt replay
            if (message.type === "user" && "uuid" in message && message.uuid) {
              if (message.uuid === promptUuid) {
                break;
              }

              const pending = session.pendingMessages.get(message.uuid as string);
              if (pending) {
                pending.resolve(false);
                session.pendingMessages.delete(message.uuid as string);
                handedOff = true;
                // the current loop stops with end_turn,
                // the loop of the next prompt continues running
                return { stopReason: "end_turn", usage: sessionUsage(session) };
              }
              if ("isReplay" in message && message.isReplay) {
                // not pending or unrelated replay message
                break;
              }
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
            }

            // Slash commands like /compact can generate invalid output... doesn't match
            // their own docs: https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-slash-commands#%2Fcompact-compact-conversation-history
            if (
              typeof message.message.content === "string" &&
              message.message.content.includes("<local-command-stdout>")
            ) {
              this.logger.log(message.message.content);
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

            if (
              message.type === "assistant" &&
              message.message.model === "<synthetic>" &&
              Array.isArray(message.message.content) &&
              message.message.content.length === 1 &&
              message.message.content[0].type === "text" &&
              message.message.content[0].text.includes("Please run /login")
            ) {
              throw RequestError.authRequired();
            }

            const content =
              message.type === "assistant"
                ? // Handled by stream events above
                  message.message.content.filter(
                    (item) => !["text", "thinking"].includes(item.type),
                  )
                : message.message.content;

            for (const notification of toAcpNotifications(
              content,
              message.message.role,
              params.sessionId,
              this.toolUseCache,
              this.client,
              this.logger,
              {
                clientCapabilities: this.clientCapabilities,
                parentToolUseId: message.parent_tool_use_id,
                cwd: session.cwd,
              },
            )) {
              await this.client.sessionUpdate(notification);
            }
            break;
          }
          case "tool_progress":
          case "tool_use_summary":
          case "auth_status":
          case "prompt_suggestion":
          case "rate_limit_event":
            break;
          default:
            unreachable(message);
            break;
        }
      }
      throw new Error("Session did not end in result");
    } catch (error) {
      if (error instanceof RequestError || !(error instanceof Error)) {
        throw error;
      }
      const message = error.message;
      if (
        message.includes("ProcessTransport") ||
        message.includes("terminated process") ||
        message.includes("process exited with") ||
        message.includes("process terminated by signal") ||
        message.includes("Failed to write to process stdin")
      ) {
        this.logger.error(`Session ${params.sessionId}: Claude Agent process died: ${message}`);
        session.settingsManager.dispose();
        session.input.end();
        delete this.sessions[params.sessionId];
        throw RequestError.internalError(
          undefined,
          "The Claude Agent process exited unexpectedly. Please start a new session.",
        );
      }
      throw error;
    } finally {
      if (!handedOff) {
        session.promptRunning = false;
        // This usually should not happen, but in case the loop finishes
        // without claude sending all message replays, we resolve the
        // next pending prompt call to ensure no prompts get stuck.
        if (session.pendingMessages.size > 0) {
          const next = [...session.pendingMessages.entries()].sort(
            (a, b) => a[1].order - b[1].order,
          )[0];
          if (next) {
            next[1].resolve(false);
            session.pendingMessages.delete(next[0]);
          }
        }
      }
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      return;
    }
    session.cancelled = true;
    for (const [, pending] of session.pendingMessages) {
      pending.resolve(true);
    }
    session.pendingMessages.clear();
    await session.query.interrupt();
  }

  /** Cleanly tear down a session: cancel in-flight work, dispose resources,
   *  and remove it from the session map. */
  private async teardownSession(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) {
      return;
    }
    await this.cancel({ sessionId });
    session.settingsManager.dispose();
    session.abortController.abort();
    session.query.close();
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

  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    // Resolve aliases (e.g. "opus", "opus[1m]") to canonical model IDs so
    // downstream lookups in modelInfos succeed and the effort option isn't
    // silently dropped.
    const resolved = resolveModelPreference(session.modelInfos, params.modelId);
    const modelId = resolved?.value ?? params.modelId;
    await session.query.setModel(modelId);
    await this.updateConfigOption(params.sessionId, "model", modelId);
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
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

    await this.applyConfigOptionValue(session, params.configId, resolvedValue);

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
    try {
      await this.sessions[sessionId].query.setPermissionMode(modeId);
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
      for (const notification of toAcpNotifications(
        // @ts-expect-error - untyped in SDK but we handle all of these
        message.message.content,
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

  canUseTool(sessionId: string): CanUseTool {
    return async (toolName, toolInput, { signal, suggestions, toolUseID }) => {
      const supportsTerminalOutput = this.clientCapabilities?._meta?.["terminal_output"] === true;
      const session = this.sessions[sessionId];
      if (!session) {
        return {
          behavior: "deny",
          message: "Session not found",
        };
      }

      if (toolName === "ExitPlanMode") {
        const options = [
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
          options.unshift({
            kind: "allow_always",
            name: "Yes, and bypass permissions",
            optionId: "bypassPermissions",
          });
        }

        const response = await this.client.requestPermission({
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
        });

        if (signal.aborted || response.outcome?.outcome === "cancelled") {
          throw new Error("Tool use aborted");
        }
        if (
          response.outcome?.outcome === "selected" &&
          (response.outcome.optionId === "default" ||
            response.outcome.optionId === "acceptEdits" ||
            response.outcome.optionId === "auto" ||
            response.outcome.optionId === "bypassPermissions")
        ) {
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "current_mode_update",
              currentModeId: response.outcome.optionId,
            },
          });
          await this.updateConfigOption(sessionId, "mode", response.outcome.optionId);

          return {
            behavior: "allow",
            updatedInput: toolInput,
            updatedPermissions: suggestions ?? [
              { type: "setMode", mode: response.outcome.optionId, destination: "session" },
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

      const response = await this.client.requestPermission({
        options: [
          {
            kind: "allow_always",
            name: "Always Allow",
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
      });
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

    await this.applyConfigOptionValue(session, configId, value);

    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: session.configOptions,
      },
    });
  }

  private async applyConfigOptionValue(
    session: Session,
    configId: string,
    value: string,
  ): Promise<void> {
    // Sync top-level session state
    if (configId === "mode") {
      session.modes = { ...session.modes, currentModeId: value };
    } else if (configId === "model") {
      if (session.models.currentModelId !== value) {
        // The cached context window was learned for the previous model; reset
        // to the new model's heuristic so mid-stream updates between now and
        // the next `result` reflect the user's selection instead of the old
        // model's window.
        session.contextWindowSize = inferContextWindowFromModel(value) ?? DEFAULT_CONTEXT_WINDOW;
      }
      session.models = { ...session.models, currentModelId: value };
    }

    // Update configOptions
    if (configId === "model") {
      // Rebuild config options since effort levels depend on the selected model
      const effortOpt = session.configOptions.find((o) => o.id === "effort");
      const currentEffort =
        typeof effortOpt?.currentValue === "string" ? effortOpt.currentValue : undefined;
      session.configOptions = buildConfigOptions(
        session.modes,
        session.models,
        session.modelInfos,
        currentEffort,
      );

      // Sync effort with the SDK if it changed after the model switch
      const newEffortOpt = session.configOptions.find((o) => o.id === "effort");
      const newEffort =
        typeof newEffortOpt?.currentValue === "string" ? newEffortOpt.currentValue : undefined;
      if (newEffort !== currentEffort) {
        await session.query.applyFlagSettings({
          effortLevel: newEffort as Settings["effortLevel"],
        });
      }
    } else {
      session.configOptions = session.configOptions.map((o) =>
        o.id === configId && typeof o.currentValue === "string" ? { ...o, currentValue: value } : o,
      );
      if (configId === "effort") {
        await session.query.applyFlagSettings({
          effortLevel: value as Settings["effortLevel"],
        });
      }
    }
  }

  private async getOrCreateSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers?: NewSessionRequest["mcpServers"];
    _meta?: NewSessionRequest["_meta"];
  }): Promise<NewSessionResponse> {
    const existingSession = this.sessions[params.sessionId];
    if (existingSession) {
      const fingerprint = computeSessionFingerprint(params);
      if (fingerprint === existingSession.sessionFingerprint) {
        return {
          sessionId: params.sessionId,
          modes: existingSession.modes,
          models: existingSession.models,
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
        _meta: params._meta,
      },
      {
        resume: params.sessionId,
      },
    );

    return {
      sessionId: response.sessionId,
      modes: response.modes,
      models: response.models,
      configOptions: response.configOptions,
    };
  }

  private async createSession(
    params: NewSessionRequest,
    creationOpts: { resume?: string; forkSession?: boolean } = {},
  ): Promise<NewSessionResponse> {
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
        } else {
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
    );

    // Extract options from _meta if provided
    const sessionMeta = params._meta as NewSessionMeta | undefined;
    const userProvidedOptions = sessionMeta?.claudeCode?.options;

    // Configure thinking tokens from environment variable
    const maxThinkingTokens = process.env.MAX_THINKING_TOKENS
      ? parseInt(process.env.MAX_THINKING_TOKENS, 10)
      : undefined;

    // Parse model configuration from environment (e.g. Bedrock model overrides)
    const modelConfig = parseModelConfig(process.env.CLAUDE_MODEL_CONFIG);

    // Disable this for now, not a great way to expose this over ACP at the moment (in progress work so we can revisit)
    const disallowedTools = ["AskUserQuestion"];

    // Resolve which built-in tools to expose.
    // Explicit tools array from _meta.claudeCode.options takes precedence.
    // disableBuiltInTools is a legacy shorthand for tools: [] — kept for
    // backward compatibility but callers should prefer the tools array.
    const tools: Options["tools"] =
      userProvidedOptions?.tools ??
      (params._meta?.disableBuiltInTools === true ? [] : { type: "preset", preset: "claude_code" });

    const abortController = userProvidedOptions?.abortController || new AbortController();

    const options: Options = {
      systemPrompt,
      settingSources: ["user", "project", "local"],
      ...(maxThinkingTokens !== undefined && { maxThinkingTokens }),
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
        ...createEnvForGateway(this.gatewayAuthMeta),
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
      pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE,
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
      },
      ...creationOpts,
      abortController,
    };

    options.additionalDirectories = [
      ...(userProvidedOptions?.additionalDirectories ?? []),
      ...(sessionMeta?.additionalRoots ?? []),
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
      !this.gatewayAuthMeta
    ) {
      throw RequestError.authRequired(
        undefined,
        "This integration does not support using claude.ai subscriptions.",
      );
    }

    const models = await getAvailableModels(q, initializationResult.models, settingsManager);

    const availableModes = [
      {
        id: "auto",
        name: "Auto",
        description: "Use a model classifier to approve/deny permission prompts",
      },
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
    ];
    // Only works in non-root mode
    if (ALLOW_BYPASS) {
      availableModes.push({
        id: "bypassPermissions",
        name: "Bypass Permissions",
        description: "Bypass all permission checks",
      });
    }

    const modes = {
      currentModeId: permissionMode,
      availableModes,
    };

    const configOptions = buildConfigOptions(
      modes,
      models,
      initializationResult.models,
      settingsManager.getSettings().effortLevel,
    );

    // Apply the initial effort level to the SDK so it matches the UI default
    const initialEffort = configOptions.find((o) => o.id === "effort");
    if (initialEffort && typeof initialEffort.currentValue === "string") {
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
      modelInfos: initializationResult.models,
      configOptions,
      promptRunning: false,
      pendingMessages: new Map(),
      nextPendingOrder: 0,
      abortController,
      emitRawSDKMessages: sessionMeta?.claudeCode?.emitRawSDKMessages ?? false,
      contextWindowSize:
        inferContextWindowFromModel(models.currentModelId) ?? DEFAULT_CONTEXT_WINDOW,
    };

    return {
      sessionId,
      models,
      modes,
      configOptions,
    };
  }
}

function shouldEmitRawMessage(
  config: boolean | SDKMessageFilter[],
  message: { type: string; subtype?: string },
): boolean {
  if (config === true) return true;
  if (config === false) return false;
  return config.some(
    (f) => f.type === message.type && (f.subtype === undefined || f.subtype === message.subtype),
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

function createEnvForGateway(gatewayMeta?: GatewayAuthMeta) {
  if (!gatewayMeta) {
    return {};
  }
  return {
    ANTHROPIC_BASE_URL: gatewayMeta.gateway.baseUrl,
    ANTHROPIC_CUSTOM_HEADERS: Object.entries(gatewayMeta.gateway.headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n"),
    ANTHROPIC_AUTH_TOKEN: "", // Must be specified to bypass claude login requirement
  };
}

function buildConfigOptions(
  modes: SessionModeState,
  models: SessionModelState,
  modelInfos: ModelInfo[],
  currentEffortLevel?: string,
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
    const effortOptions = supportedLevels.map((level) => ({
      value: level,
      name: level
        .split(/[_-]/)
        .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
        .join(" "),
    }));

    // Keep the current level if valid, otherwise prefer xhigh (Claude Code's
    // recommended default for capable models), then high (the API default).
    const includes = (l: string) => (supportedLevels as string[]).includes(l);
    const validEffort =
      currentEffortLevel && includes(currentEffortLevel)
        ? currentEffortLevel
        : includes("xhigh")
          ? "xhigh"
          : includes("high")
            ? "high"
            : supportedLevels[0];

    options.push({
      id: "effort",
      name: "Effort",
      description: "Available effort levels for this model",
      category: "effort",
      type: "select",
      currentValue: validEffort,
      options: effortOptions,
    });
  }

  return options;
}

// Claude Code CLI persists display strings like "opus[1m]" in settings,
// but the SDK model list uses IDs like "claude-opus-4-6-1m".
const MODEL_CONTEXT_HINT_PATTERN = /\[(\d+m)\]$/i;

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
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += token === contextHint ? 3 : 1;
    }
  }
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
    const score = scoreModelMatch(model, tokens, contextHint);
    if (0 < score && (!bestMatch || bestScore < score)) {
      bestMatch = model;
      bestScore = score;
    }
  }

  return bestMatch;
}

async function getAvailableModels(
  query: Query,
  models: ModelInfo[],
  settingsManager: SettingsManager,
): Promise<SessionModelState> {
  const settings = settingsManager.getSettings();

  let currentModel = models[0];

  // Model priority (highest to lowest):
  // 1. ANTHROPIC_MODEL environment variable
  // 2. settings.model (user configuration)
  // 3. models[0] (default first model)
  if (process.env.ANTHROPIC_MODEL) {
    const match = resolveModelPreference(models, process.env.ANTHROPIC_MODEL);
    if (match) {
      currentModel = match;
    }
  } else if (settings.model) {
    const match = resolveModelPreference(models, settings.model);
    if (match) {
      currentModel = match;
    }
  }

  await query.setModel(currentModel.value);

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
 * Convert an SDKAssistantMessage (Claude) to a SessionNotification (ACP).
 * Only handles text, image, and thinking chunks for now.
 */
export function toAcpNotifications(
  content: string | ContentBlockParam[] | BetaContentBlock[] | BetaRawContentBlockDelta[],
  role: "assistant" | "user",
  sessionId: string,
  toolUseCache: ToolUseCache,
  client: AgentSideConnection,
  logger: Logger,
  options?: {
    registerHooks?: boolean;
    clientCapabilities?: ClientCapabilities;
    parentToolUseId?: string | null;
    cwd?: string;
  },
): SessionNotification[] {
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
        update = {
          sessionUpdate: "agent_thought_chunk",
          content: {
            type: "text",
            text: chunk.thinking,
          },
        };
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
        } else {
          // Only register hooks on first encounter to avoid double-firing
          if (registerHooks && !alreadyCached) {
            registerHookCallback(chunk.id, {
              onPostToolUseHook: async (toolUseId, toolInput, toolResponse) => {
                const toolUse = toolUseCache[toolUseId];
                if (toolUse) {
                  const editDiff =
                    toolUse.name === "Edit" ? toolUpdateFromEditToolResponse(toolResponse) : {};
                  const update: SessionNotification["update"] = {
                    _meta: {
                      claudeCode: {
                        toolResponse,
                        toolName: toolUse.name,
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
                } else {
                  logger.error(
                    `[claude-agent-acp] Got a tool response for tool use that wasn't tracked: ${toolUseId}`,
                  );
                }
              },
            });
          }

          let rawInput;
          try {
            rawInput = JSON.parse(JSON.stringify(chunk.input));
          } catch {
            // ignore if we can't turn it to JSON
          }

          if (alreadyCached) {
            // Second encounter (full assistant message after streaming) —
            // send as tool_call_update to refine the existing tool_call
            // rather than emitting a duplicate tool_call.
            update = {
              _meta: {
                claudeCode: {
                  toolName: chunk.name,
                },
              } satisfies ToolUpdateMeta,
              toolCallId: chunk.id,
              sessionUpdate: "tool_call_update",
              rawInput,
              ...toolInfoFromToolUse(chunk, supportsTerminalOutput, options?.cwd),
            };
          } else {
            // First encounter (streaming content_block_start or replay) —
            // send as tool_call with terminal_info for Bash tools.
            update = {
              _meta: {
                claudeCode: {
                  toolName: chunk.name,
                },
                ...(chunk.name === "Bash" && supportsTerminalOutput
                  ? { terminal_info: { terminal_id: chunk.id } }
                  : {}),
              } satisfies ToolUpdateMeta,
              toolCallId: chunk.id,
              sessionUpdate: "tool_call",
              rawInput,
              status: "pending",
              ...toolInfoFromToolUse(chunk, supportsTerminalOutput, options?.cwd),
            };
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
        const toolUse = toolUseCache[chunk.tool_use_id];
        if (!toolUse) {
          logger.error(
            `[claude-agent-acp] Got a tool result for tool use that wasn't tracked: ${chunk.tool_use_id}`,
          );
          break;
        }

        if (toolUse.name !== "TodoWrite") {
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
      output.push({ sessionId, update });
    }
  }

  return output;
}

export function streamEventToAcpNotifications(
  message: SDKPartialAssistantMessage,
  sessionId: string,
  toolUseCache: ToolUseCache,
  client: AgentSideConnection,
  logger: Logger,
  options?: {
    clientCapabilities?: ClientCapabilities;
    cwd?: string;
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
        },
      );
    // No content
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

export function runAcp() {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);
  let agent!: ClaudeAcpAgent;
  const connection = new AgentSideConnection((client) => {
    agent = new ClaudeAcpAgent(client);
    return agent;
  }, stream);
  return { connection, agent };
}

function commonPrefixLength(a: string, b: string) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }
  return i;
}

/** Best-effort first guess of a model's context window from its ID, used only
 *  until a `result` message arrives with the authoritative `modelUsage` value.
 *  Anthropic 1M-context variants encode "1m" as a distinct token in the SDK
 *  model ID (e.g., "claude-opus-4-6-1m"), which `\b1m\b` catches without also
 *  matching things like "10m" or embedded substrings. */
function inferContextWindowFromModel(model: string): number | null {
  if (/\b1m\b/i.test(model)) return 1_000_000;
  return null;
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
