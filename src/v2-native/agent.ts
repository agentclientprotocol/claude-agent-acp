/**
 * The native ACP v2 core: serves ACP v2 straight from Claude Code, without
 * `ClaudeAcpAgent`.
 *
 * The bridge in `src/v2/` serves v2 by converting each request to v1 and
 * running it through the v1 core, which holds turns open, matches echoes,
 * and keeps the v1 and AIR extensions. This core serves only v2, so it keeps
 * none of that: each session mirrors its Claude Code query (see
 * `session.ts`). It shares the protocol-neutral pieces with v1: the SDK
 * message mapping, tool call rendering, permission options, and the mode
 * catalog. What it does not serve yet is listed in `docs/v2-native-core.md`.
 *
 * Opt in with `CLAUDE_AGENT_ACP_V2_CORE=native` (see `serve.ts`).
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  RequestError,
  type CompleteElicitationNotification,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
} from "@agentclientprotocol/sdk/unstable";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
  deleteSession,
  getSessionMessages,
  listSessions,
  query,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import packageJson from "../../package.json" with { type: "json" };
import type { Logger } from "../acp-agent.js";
import { claudeCliPath } from "../claude-cli.js";
import { clientSystemPrompt, sdkSystemPrompt } from "../client-system-prompt.js";
import type { ElicitationSupport } from "../elicitation.js";
import { sdkMcpServers } from "../mcp-servers.js";
import { ALLOW_BYPASS, autoModeDisabled } from "../permissions/modes.js";
import { buildAvailableModes, resolveInitialPermissionMode } from "../session-mode.js";
import { sanitizeTitle } from "../session-titles.js";
import { SettingsManager } from "../settings.js";
import { STARTUP_FAILURE_RESULTS_ENV, startupFailureError } from "../startup-failure.js";
import { createPostToolUseHook } from "../tools.js";
import { Pushable } from "../utils.js";
import { V2_SESSION_CAPABILITIES } from "../v2/initialize.js";
import { v1NewSessionRequest, v2AvailableCommands } from "../v2/session.js";
import { V2UpdateTranslator } from "../v2/update-translator.js";
import { NativeAuth } from "./auth.js";
import { SessionConfig } from "./config.js";
import { canUseTool } from "./permissions.js";
import { NativeSession, type SessionConnection } from "./session.js";
import { restrictedChild } from "./tasks.js";

/** The sessions per `session/list` page. */
const SESSION_LIST_PAGE_SIZE = 1000;

/** What the owner of the process holds of the agent: its shutdown. */
export interface AgentHandle {
  dispose(): Promise<void>;
}

/** The native ACP v2 surface, for one connection. */
export function nativeV2AgentApp(
  logger: Logger | undefined,
  onAgent: (agent: AgentHandle) => void,
): v2.AgentApp {
  let agent!: NativeV2Agent;
  return (
    v2
      .agent({ name: "claude-code-acp" })
      .onConnect((connection) => {
        agent = new NativeV2Agent(connection.client, logger ?? console);
        onAgent(agent);
      })
      .onRequest(v2.methods.agent.initialize, ({ params }) => agent.initialize(params))
      .onRequest(v2.methods.agent.auth.login, ({ params }) => agent.auth.login(params))
      .onRequest(v2.methods.agent.auth.logout, () => agent.auth.logout())
      .onRequest(v2.methods.agent.providers.list, () => agent.auth.listProviders())
      .onRequest(v2.methods.agent.providers.set, ({ params }) => agent.auth.setProvider(params))
      .onRequest(v2.methods.agent.providers.disable, ({ params }) =>
        agent.auth.disableProvider(params),
      )
      .onRequest(v2.methods.agent.session.new, ({ params }) => agent.newSession(params))
      .onRequest(v2.methods.agent.session.resume, ({ params }) => agent.resumeSession(params))
      .onRequest(v2.methods.agent.session.list, ({ params }) => agent.listSessions(params))
      .onRequest(v2.methods.agent.session.close, ({ params }) => agent.closeSession(params))
      .onRequest(v2.methods.agent.session.delete, ({ params }) => agent.deleteSession(params))
      .onRequest(v2.methods.agent.session.setConfigOption, ({ params }) =>
        agent.setConfigOption(params),
      )
      .onRequest(v2.methods.agent.session.prompt, ({ params }) => agent.prompt(params))
      .onRequest(v2.methods.agent.terminal.cancel, ({ params }) =>
        agent.cancelItem(params.sessionId, { terminalId: params.terminalId }),
      )
      .onRequest(v2.methods.agent.toolCall.cancel, ({ params }) =>
        agent.cancelItem(params.sessionId, { toolCallId: params.toolCallId }),
      )
      // `session/cancel` of a session that is not active is ignored. A
      // subagent's session advertises `cancel`: it stops the subagent's run.
      .onNotification(v2.methods.agent.session.cancel, ({ params }) =>
        agent.cancel(params.sessionId),
      )
  );
}

/** The capabilities of the native core: the bridge's, without fork. */
const NATIVE_SESSION_CAPABILITIES: v2.SessionCapabilities = Object.fromEntries(
  Object.entries(V2_SESSION_CAPABILITIES).filter(([capability]) => capability !== "fork"),
);

class NativeV2Agent implements AgentHandle, SessionConnection {
  readonly sessions = new Map<string, NativeSession>();
  readonly translator = new V2UpdateTranslator();
  readonly auth: NativeAuth;
  /** The elicitation modes that the client advertised in `initialize`. */
  elicitation: ElicitationSupport = { form: false, url: false };

  constructor(
    private readonly ctx: v2.AgentContext,
    readonly logger: Logger,
  ) {
    this.auth = new NativeAuth(ctx, logger);
  }

  // --- SessionConnection ---------------------------------------------------

  send(notification: v2.UpdateSessionNotification): void {
    this.ctx.notify(v2.methods.client.session.update, notification).catch((error) => {
      this.logger.error(`Failed to send a ${notification.update.sessionUpdate} update:`, error);
    });
  }

  requestPermission(
    request: v2.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<v2.RequestPermissionResponse> {
    // Aborting `signal` sends `$/cancel_request`, and stops waiting for the answer.
    return this.ctx.request(v2.methods.client.session.requestPermission, request, {
      cancellationSignal: signal,
      stopWaitingOnCancel: true,
    });
  }

  createElicitation(
    request: CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    // The v1 types accept a property schema with any tag; the v2 types accept
    // one only in a received value. An MCP server's schema is relayed
    // unchanged, as on the bridge, so this cast does not check it.
    return this.ctx.request(
      v2.methods.client.elicitation.create,
      request as v2.CreateElicitationRequest,
      { cancellationSignal: signal, stopWaitingOnCancel: true },
    );
  }

  completeElicitation(params: CompleteElicitationNotification): Promise<void> {
    return this.ctx.notify(v2.methods.client.elicitation.complete, params);
  }

  ended(sessionId: string): void {
    // A later `session/resume` starts the session again from its transcript.
    this.sessions.delete(sessionId);
    this.translator.forget(sessionId);
    this.auth.sessionEnded(sessionId);
  }

  // --- Requests --------------------------------------------------------------

  initialize(request: v2.InitializeRequest): v2.InitializeResponse {
    this.elicitation = {
      form: request.capabilities?.elicitation?.form != null,
      url: request.capabilities?.elicitation?.url != null,
    };
    const { authMethods, _meta } = this.auth.initialize(request.capabilities);
    return {
      protocolVersion: v2.PROTOCOL_VERSION,
      info: { name: packageJson.name, title: "Claude Agent", version: packageJson.version },
      // `providers/list`, `set`, and `disable`, served for every client.
      capabilities: { session: NATIVE_SESSION_CAPABILITIES, providers: {}, _meta },
      authMethods,
    };
  }

  /** `session/prompt`. Each prompt reads the auth identity again, as on v1. */
  prompt(params: v2.PromptRequest): Promise<v2.PromptResponse> {
    const session = this.session(params.sessionId, "prompt");
    this.auth.promptStarted(params.sessionId);
    return session.prompt(params);
  }

  async newSession(params: v2.NewSessionRequest): Promise<v2.NewSessionResponse> {
    const sessionId = randomUUID();
    const session = await this.startSession(sessionId, params, undefined);
    const response = { sessionId, ...(await this.setupFields(session)) };
    afterSetupResponse(session, params);
    return response;
  }

  /**
   * Resumes a stored session, or attaches to a live one. With `replayFrom:
   * { type: "start" }` the stored history replays first. Either way, the
   * state snapshot goes out after any replay and before the response.
   */
  async resumeSession(params: v2.ResumeSessionRequest): Promise<v2.ResumeSessionResponse> {
    const { sessionId, replayFrom } = params;
    if (replayFrom != null && replayFrom.type !== "start") {
      throw RequestError.invalidParams(
        { replayFrom },
        `Replaying from a ${replayFrom.type} cursor is not supported`,
      );
    }
    if (this.ownerOfChild(sessionId)) throw restrictedChild(sessionId, "resume");
    let session = this.sessions.get(sessionId);
    if (session) {
      // Resuming the active session synchronizes it again. Its work goes on,
      // and the request's MCP servers replace the session's.
      const request = await validatedSetup(params);
      if (request.cwd !== session.cwd) {
        throw RequestError.invalidParams(
          { cwd: request.cwd },
          `Session ${sessionId} works in ${session.cwd}: resume it with that \`cwd\``,
        );
      }
      if (!sameDirectories(request.additionalDirectories ?? [], session.additionalDirectories)) {
        throw RequestError.invalidParams(
          { additionalDirectories: request.additionalDirectories },
          `Session ${sessionId} is active with other additional directories: close it, then resume it with these`,
        );
      }
      await session.setMcpServers(sdkMcpServers(request.mcpServers));
    } else {
      session = await this.startSession(sessionId, params, sessionId);
    }
    if (replayFrom != null) {
      session.output.replay(await getSessionMessages(sessionId, { dir: session.cwd }));
    }
    for (const notification of session.resumeSnapshot()) this.send(notification);
    const response = await this.setupFields(session);
    afterSetupResponse(session, params);
    return response;
  }

  async listSessions(params: v2.ListSessionsRequest): Promise<v2.ListSessionsResponse> {
    if (params.cwd != null && !path.isAbsolute(params.cwd)) {
      throw RequestError.invalidParams({ cwd: params.cwd }, "`cwd` must be an absolute path");
    }
    const offset = listOffset(params.cursor);
    // One more than a page tells whether a next page exists.
    const stored = await listSessions({
      dir: params.cwd ?? undefined,
      includeWorktrees: false,
      limit: SESSION_LIST_PAGE_SIZE + 1,
      offset,
    });
    const sessions = stored.slice(0, SESSION_LIST_PAGE_SIZE).flatMap((session) =>
      session.cwd
        ? [
            {
              sessionId: session.sessionId,
              cwd: session.cwd,
              title: sanitizeTitle(session.summary),
              updatedAt: new Date(session.lastModified).toISOString(),
            },
          ]
        : [],
    );
    return stored.length > SESSION_LIST_PAGE_SIZE
      ? { sessions, nextCursor: `offset:${offset + SESSION_LIST_PAGE_SIZE}` }
      : { sessions };
  }

  /** Closing is idempotent: a session that is not active closes at once. */
  async closeSession({ sessionId }: v2.CloseSessionRequest): Promise<v2.CloseSessionResponse> {
    if (this.ownerOfChild(sessionId)) throw restrictedChild(sessionId, "close");
    const session = this.sessions.get(sessionId);
    if (!session) return {};
    await session.close();
    if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
    this.translator.forget(sessionId);
    this.auth.sessionEnded(sessionId);
    return {};
  }

  /** Deleting a session that does not exist succeeds, as v2 asks. */
  async deleteSession({ sessionId }: v2.DeleteSessionRequest): Promise<v2.DeleteSessionResponse> {
    if (this.ownerOfChild(sessionId)) throw restrictedChild(sessionId, "delete");
    const live = this.sessions.get(sessionId);
    if (live) await this.closeSession({ sessionId });
    try {
      await deleteSession(sessionId, live ? { dir: live.cwd } : undefined);
    } catch (error) {
      // A session without a transcript, such as one never prompted, has nothing to delete.
      if (error instanceof Error && /not found/i.test(error.message)) return {};
      throw error;
    }
    return {};
  }

  async setConfigOption(
    params: v2.SetSessionConfigOptionRequest,
  ): Promise<v2.SetSessionConfigOptionResponse> {
    const configOptions = await this.session(params.sessionId, "configure").setConfigOption(
      params.configId,
      (params as { type?: string }).type,
      params.value,
    );
    return { configOptions };
  }

  /**
   * The active session `sessionId`, for a request that `method` names. A
   * subagent's session takes no such request: the client can only watch it
   * and cancel its run.
   */
  session(sessionId: string, method: string): NativeSession {
    const session = this.sessions.get(sessionId);
    if (session) return session;
    if (this.ownerOfChild(sessionId)) throw restrictedChild(sessionId, method);
    throw RequestError.sessionNotFound(sessionId);
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) return session.cancel();
    await this.ownerOfChild(sessionId)?.tasks.cancelChild(sessionId);
  }

  /** `terminal/cancel` and `tool_call/cancel`: stops a listed item of a session or a child. */
  async cancelItem(
    sessionId: string,
    target: { terminalId: string } | { toolCallId: string },
  ): Promise<Record<string, never>> {
    const root = this.sessions.get(sessionId) ?? this.ownerOfChild(sessionId);
    if (!root) throw RequestError.sessionNotFound(sessionId);
    if (!(await root.tasks.cancelItem(sessionId, target))) {
      throw "terminalId" in target
        ? RequestError.invalidParams(
            { sessionId, terminalId: target.terminalId },
            `Terminal ${target.terminalId} is not a command running in the background, so it cannot be cancelled.`,
          )
        : RequestError.invalidParams(
            { sessionId, toolCallId: target.toolCallId },
            `Tool call ${target.toolCallId} is not running in the background, so it cannot be cancelled.`,
          );
    }
    return {};
  }

  /** The root session that `sessionId` is a subagent session of. */
  private ownerOfChild(sessionId: string): NativeSession | undefined {
    return [...this.sessions.values()].find((session) => session.tasks.hasChild(sessionId));
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }

  // --- Session setup -----------------------------------------------------------

  /** The config options and commands of a setup response. */
  private async setupFields(session: NativeSession): Promise<{
    configOptions: v2.SessionConfigOption[];
    availableCommands?: v2.AvailableCommand[];
  }> {
    const commands = await session.commands().catch((error) => {
      // The session works without its command list; the response goes without it.
      this.logger.error(`Session ${session.sessionId}: failed to read its commands`, error);
      return [];
    });
    return {
      configOptions: session.config.options(),
      ...(commands.length > 0 ? { availableCommands: v2AvailableCommands(commands) } : {}),
    };
  }

  /** Starts the query of a session: a new one, or `resume` of a stored one. */
  private async startSession(
    sessionId: string,
    params: v2.NewSessionRequest | v2.ResumeSessionRequest,
    resume: string | undefined,
  ): Promise<NativeSession> {
    const request = await validatedSetup(params);
    const settings = new SettingsManager(request.cwd, { logger: this.logger });
    await settings.initialize();
    const allowBypass =
      ALLOW_BYPASS &&
      settings.getSettings().permissions?.disableBypassPermissionsMode !== "disable";
    const allowAuto = !autoModeDisabled(settings.getSettings());
    const { mode } = resolveInitialPermissionMode(
      { defaultMode: settings.getSettings().permissions?.defaultMode },
      this.logger,
      { allowBypass, allowAuto },
    );
    settings.dispose();
    // The settings keep the values they read: their cwd and key helper.
    const authStarted = this.auth.sessionStarting(settings);
    const routing = this.auth.routing();

    const clientPrompt = clientSystemPrompt(request.systemPrompt);
    const input = new Pushable<SDKUserMessage>();
    const session = new NativeSession(
      sessionId,
      request.cwd,
      request.additionalDirectories ?? [],
      this,
      input,
    );
    const options: Options = {
      systemPrompt: clientPrompt
        ? sdkSystemPrompt(clientPrompt, undefined)
        : { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
      ...(routing.settings ? { settings: routing.settings } : {}),
      cwd: request.cwd,
      additionalDirectories: request.additionalDirectories ?? [],
      includePartialMessages: true,
      // A subagent's text, for its own session's stream (see `tasks.ts`).
      forwardSubagentText: true,
      // Claude Code's interrupt then spares background tasks, which the
      // client stops one at a time: `session/cancel` must leave listed work
      // running.
      perTaskStopAffordance: true,
      mcpServers: sdkMcpServers(request.mcpServers),
      permissionMode: mode,
      allowDangerouslySkipPermissions: allowBypass,
      canUseTool: session.elicitations.canUseTool(canUseTool(session)),
      // MCP elicitations and the refusal fallback, for the modes the client
      // renders. Without forms, AskUserQuestion is disallowed.
      ...session.elicitations.queryOptions(),
      pathToClaudeCodeExecutable: await claudeCliPath(),
      // Echoes each prompt that Claude Code takes in (see `NativeSession`).
      extraArgs: { "replay-user-messages": "" },
      tools: { type: "preset", preset: "claude_code" },
      hooks: {
        SubagentStart: [
          {
            hooks: [
              async (input) => {
                // Its `cwd` is the subagent's, such as its worktree.
                if (input.hook_event_name === "SubagentStart") {
                  session.tasks.subagentStarted(input.agent_id, input.cwd, input.agent_type);
                }
                return { continue: true };
              },
            ],
          },
        ],
        PostToolUse: [
          {
            hooks: [
              createPostToolUseHook({ onEnterPlanMode: async () => session.modeChanged("plan") }),
            ],
          },
        ],
      },
      env: {
        ...process.env,
        // The gateway login or the provider (see `auth.ts`).
        ...routing.env,
        // `session_state_changed`, which is the session's state.
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
        ...STARTUP_FAILURE_RESULTS_ENV,
      },
      ...(resume !== undefined ? { resume } : { sessionId }),
    };
    const q = query({ prompt: input, options });
    let initialization;
    try {
      initialization = await q.initializationResult();
    } catch (error) {
      q.close();
      if (
        resume !== undefined &&
        error instanceof Error &&
        error.message.includes("No conversation found with session ID")
      ) {
        throw RequestError.sessionNotFound(sessionId);
      }
      throw startupFailureError(error) ?? error;
    }
    authStarted(sessionId, initialization.account);
    const models = routing.models(initialization.models);
    const currentModel =
      models.find((model) => model.value === "default")?.value ?? models[0]?.value ?? "default";
    const availableModes = buildAvailableModes({ allowBypass, allowAuto });
    session.start(
      q,
      new SessionConfig(q, { currentModeId: mode, availableModes }, models, currentModel),
    );
    this.sessions.set(sessionId, session);
    return session;
  }
}

/**
 * The setup request in v1 form, once it is valid: the MCP transports and the
 * system prompt as the bridge checks them, an absolute `cwd` that is a
 * directory, and absolute additional directories.
 */
async function validatedSetup(params: v2.NewSessionRequest | v2.ResumeSessionRequest) {
  const request = v1NewSessionRequest({ ...params, mcpServers: params.mcpServers ?? [] });
  const { cwd } = request;
  if (!path.isAbsolute(cwd)) {
    throw RequestError.invalidParams({ cwd }, `\`cwd\` must be an absolute path, not ${cwd}`);
  }
  const stat = await fs.stat(cwd).catch(() => undefined);
  if (!stat?.isDirectory()) {
    throw RequestError.invalidParams({ cwd }, `\`cwd\` is not a directory: ${cwd}`);
  }
  for (const directory of request.additionalDirectories ?? []) {
    if (!path.isAbsolute(directory)) {
      throw RequestError.invalidParams(
        { additionalDirectories: request.additionalDirectories },
        `Additional directories must be absolute paths, not ${directory}`,
      );
    }
  }
  return request;
}

/**
 * Starts OAuth for the setup request's MCP servers that need it, once the
 * setup response is sent: v2 asks for no elicitation before it. The handler
 * returns the response right after this call, and the SDK writes it before a
 * timer runs. Nothing else orders the two.
 */
function afterSetupResponse(
  session: NativeSession,
  params: v2.NewSessionRequest | v2.ResumeSessionRequest,
): void {
  // The setup already rejected servers of an unknown transport.
  const names = (params.mcpServers ?? []).flatMap((server) =>
    typeof server.name === "string" ? [server.name] : [],
  );
  if (names.length === 0) return;
  setTimeout(() => session.elicitations.authenticateMcpServers(names), 0);
}

function sameDirectories(left: readonly string[], right: readonly string[]): boolean {
  const normalize = (directories: readonly string[]) =>
    [...new Set(directories.map((directory) => path.resolve(directory)))].sort().join("\n");
  return normalize(left) === normalize(right);
}

function listOffset(cursor: string | null | undefined): number {
  if (cursor == null) return 0;
  const match = /^offset:(\d+)$/.exec(cursor);
  if (!match)
    throw RequestError.invalidParams({ cursor }, `Unknown session/list cursor: ${cursor}`);
  return Number(match[1]);
}
