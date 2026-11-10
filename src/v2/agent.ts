/**
 * The ACP v2 core: serves ACP v2 straight from Claude Code, without
 * `ClaudeAcpAgent`.
 *
 * The adapter's ACP v2 implementation. Unlike the v1 core, it holds no turn
 * open and matches no echoes: each session mirrors its Claude Code query (see
 * `session.ts`). It shares the protocol-neutral pieces with v1: the SDK
 * message mapping, tool call rendering, permission options, and the mode
 * catalog. It serves a JetBrains AIR client the AIR extensions that v2 does
 * not cover (see `air.ts`).
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
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import packageJson from "../../package.json" with { type: "json" };
import { messageIdForGrouping, type Logger } from "../acp-agent.js";
import { customAgents } from "../session-config-options.js";
import { claudeCliPath } from "../claude-cli.js";
import { clientSystemPrompt, sessionSystemPrompt } from "../client-system-prompt.js";
import type { ElicitationSupport } from "../elicitation.js";
import { forkSession } from "../fork-session.js";
import { supportsMcpOAuth } from "../mcp-oauth.js";
import { sdkMcpServers } from "../mcp-servers.js";
import { ALLOW_BYPASS, autoModeDisabled } from "../permissions/modes.js";
import { readResumedTail, resumedModelFromTranscript } from "../resumed-session.js";
import { mergeEffortSettings } from "../session-effort.js";
import { configuredSettings, resolveThinkingConfig } from "../session-env.js";
import { resolveInitialPermissionMode } from "../session-mode.js";
import { sanitizeTitle } from "../session-titles.js";
import { SettingsManager } from "../settings.js";
import { STARTUP_FAILURE_RESULTS_ENV, startupFailureError } from "../startup-failure.js";
import { createPostToolUseHook } from "../tools.js";
import { Pushable } from "../utils.js";
import { V2_SESSION_CAPABILITIES } from "./initialize.js";
import { v1ForkSessionRequest, v1NewSessionRequest } from "./session-requests.js";
import { V2UpdateTranslator } from "./update-translator.js";
import { airInitializeMeta, airSupport, NO_AIR, type AirSupport } from "./air.js";
import { V2Auth } from "./auth.js";
import { subagentHooks } from "./child-config.js";
import { modelSwitchHook, SessionConfig } from "./config.js";
import { fileChangePreviewHook } from "./file-preview.js";
import { canUseTool, denyingStoppedWork } from "./permissions.js";
import { reportHooks } from "./reports.js";
import { SessionRestarts, type SetupParams } from "./restarts.js";
import { V2Session, type SessionConnection } from "./session.js";
import {
  afterSetupResponse,
  clientOptions,
  replayEndUpdate,
  sessionModels,
  withClientHooks,
} from "./setup.js";
import type { SubagentReplay } from "./subagent-replay.js";
import { SubscriptionGuard } from "./subscription-guard.js";
import { restrictedChild } from "./tasks.js";

/** The sessions per `session/list` page. */
const SESSION_LIST_PAGE_SIZE = 1000;

/** What the owner of the process holds of the agent: its shutdown. */
export interface AgentHandle {
  dispose(): Promise<void>;
}

/** The ACP v2 surface, for one connection. */
export function v2AgentApp(
  logger: Logger | undefined,
  onAgent: (agent: AgentHandle) => void,
): v2.AgentApp {
  let agent!: V2Agent;
  return (
    v2
      .agent({ name: "claude-code-acp" })
      .onConnect((connection) => {
        agent = new V2Agent(connection.client, logger ?? console);
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
      .onRequest(v2.methods.agent.session.fork, ({ params }) => agent.forkSession(params))
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

class V2Agent implements AgentHandle, SessionConnection {
  readonly sessions = new Map<string, V2Session>();
  /**
   * The sessions whose query ended without `session/close`, with what to tell
   * the client. v2 keeps a session active until it is closed or the
   * connection ends, so its requests fail with what happened, not -32002,
   * until a resume starts it again.
   */
  private readonly stopped = new Map<string, string>();
  /**
   * The query starts that run, by session id, until each settles (see
   * {@link startSession}). A resume, close or dispose of a session waits for
   * its start, so a second start never replaces a running query.
   */
  private readonly starting = new Map<string, Promise<V2Session>>();
  /**
   * The `session/resume` handlers that run, by session id. A close waits for
   * them, so a resume's replay, snapshot and response go out before the close
   * response, and nothing of the session after it.
   */
  private readonly resuming = new Map<string, Set<Promise<unknown>>>();
  readonly translator = new V2UpdateTranslator();
  readonly auth: V2Auth;
  /** The `--hide-claude-auth` subscription guard (see `subscription-guard.ts`). */
  private readonly guard: SubscriptionGuard;
  /** The restarts of the sessions' queries, for a new route or account (see `restarts.ts`). */
  private readonly restarts: SessionRestarts;
  /** What the client declared in `initialize`. */
  private clientCapabilities: v2.ClientCapabilities | null | undefined;
  /** The elicitation modes that the client advertised in `initialize`. */
  elicitation: ElicitationSupport = { form: false, url: false };
  /** The AIR extensions that the client takes (see `air.ts`). */
  air: AirSupport = NO_AIR;

  constructor(
    private readonly ctx: v2.AgentContext,
    readonly logger: Logger,
  ) {
    this.auth = new V2Auth(ctx, logger, {
      routeChanged: () => this.restarts.reroute(),
      probed: (kind) => this.guard.probed(kind),
    });
    this.guard = new SubscriptionGuard(this.auth, logger, (sessionId) =>
      this.restarts.accountMayHaveChanged(sessionId),
    );
    this.restarts = new SessionRestarts({
      logger,
      active: (sessionId) => this.sessions.get(sessionId),
      start: (sessionId, params) => this.restartSession(sessionId, params),
      lost: async (sessionId, previous) => {
        await previous.retire();
        if (this.sessions.get(sessionId) === previous) {
          this.stop(
            sessionId,
            "Claude Code could not start again. Resume the session to continue.",
          );
        }
      },
      send: (notification) => this.send(notification),
    });
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
    // unchanged, as on v1, so this cast does not check it.
    return this.ctx.request(
      v2.methods.client.elicitation.create,
      request as v2.CreateElicitationRequest,
      { cancellationSignal: signal, stopWaitingOnCancel: true },
    );
  }

  completeElicitation(params: CompleteElicitationNotification): Promise<void> {
    return this.ctx.notify(v2.methods.client.elicitation.complete, params);
  }

  ended(session: V2Session): void {
    // The old query of a restart that replaced it already.
    if (this.sessions.get(session.sessionId) !== session) return;
    this.stop(session.sessionId, "Claude Code stopped. Resume the session to continue.");
  }

  /** The session's query ended: a later `session/resume` starts it again from its transcript. */
  private stop(sessionId: string, message: string): void {
    this.sessions.delete(sessionId);
    this.stopped.set(sessionId, message);
    this.translator.forget(sessionId);
    this.auth.sessionEnded(sessionId);
    this.guard.sessionEnded(sessionId);
    this.restarts.forget(sessionId);
  }

  signedOut(sessionId: string): void {
    this.guard.signedOut(sessionId);
  }

  // --- Requests --------------------------------------------------------------

  /**
   * The v2 handshake. An AIR client gets the AIR capabilities that this core
   * serves in the response's `_meta` (see `air.ts`).
   */
  initialize(request: v2.InitializeRequest): v2.InitializeResponse {
    this.clientCapabilities = request.capabilities;
    this.elicitation = {
      form: request.capabilities?.elicitation?.form != null,
      url: request.capabilities?.elicitation?.url != null,
    };
    this.air = airSupport(request.capabilities);
    const { authMethods, _meta } = this.auth.initialize(request.capabilities);
    const airMeta = airInitializeMeta(this.air);
    return {
      ...(airMeta ? { _meta: airMeta } : {}),
      protocolVersion: v2.PROTOCOL_VERSION,
      info: { name: packageJson.name, title: "Claude Agent", version: packageJson.version },
      capabilities: {
        session: V2_SESSION_CAPABILITIES,
        // `providers/list`, `set`, and `disable`, served for every client.
        providers: {},
        // A prompt that comes while Claude works waits in Claude Code's queue.
        _meta: { claudeCode: { promptQueueing: true }, ..._meta },
      },
      authMethods,
    };
  }

  /**
   * `session/prompt`. Each prompt reads the auth identity again, as on v1. A
   * restart of the session's query that is due runs first (see
   * `restarts.ts`), then the subscription guard judges the account, among
   * the session's prompts (see `V2Session.prompt`). The restart's await
   * happens only when one is due, so the prompts of a session keep their
   * order.
   *
   * Not `async`, and the session's promise is returned as is: the response
   * then goes out before the turn's `running`, which the session sends right
   * after it resolves the prompt. Nothing enforces this
   * order but the number of promise hops (v2 allows either), and the golden
   * files of the scenarios (`acp-scenarios-v2.test.ts`) hold it.
   */
  prompt(params: v2.PromptRequest): Promise<v2.PromptResponse> {
    const prompt = () =>
      this.session(params.sessionId, "prompt").prompt(params, (query) =>
        this.guard.beforePrompt(params.sessionId, query),
      );
    try {
      this.session(params.sessionId, "prompt");
      this.auth.promptStarted(params.sessionId);
      const restart = this.restarts.beforePrompt(params.sessionId);
      return restart ? restart.then(prompt) : prompt();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async newSession(params: v2.NewSessionRequest): Promise<v2.NewSessionResponse> {
    const sessionId = randomUUID();
    const session = await this.startSession(sessionId, params, undefined);
    const response = { sessionId, ...(await this.setupFields(session)) };
    this.afterSetup(session, params);
    return response;
  }

  /**
   * Copies the session's transcript into a new session (`forkSession`), and
   * starts it from the copy, so the client can prompt it at once.
   */
  async forkSession(params: v2.ForkSessionRequest): Promise<v2.ForkSessionResponse> {
    if (this.ownerOfChild(params.sessionId)) throw restrictedChild(params.sessionId, "fork");
    // Rejects a bad `cwd` or MCP server before the transcript is copied.
    await validatedSetup(params);
    const { sessionId } = await forkSession(v1ForkSessionRequest(params), {
      logger: this.logger,
      messageIdForGrouping,
    });
    const session = await this.startSession(sessionId, params, sessionId);
    const response = { sessionId, ...(await this.setupFields(session)) };
    this.afterSetup(session, params);
    return response;
  }

  /**
   * Resumes a stored session, or attaches to a live one. With `replayFrom:
   * { type: "start" }` the stored history replays first. Either way, the
   * state snapshot goes out after any replay and before the response.
   */
  resumeSession(params: v2.ResumeSessionRequest): Promise<v2.ResumeSessionResponse> {
    const { sessionId } = params;
    const run = this.resume(params);
    let runs = this.resuming.get(sessionId);
    if (!runs) this.resuming.set(sessionId, (runs = new Set()));
    runs.add(run);
    const settled = () => {
      runs.delete(run);
      if (runs.size === 0 && this.resuming.get(sessionId) === runs) this.resuming.delete(sessionId);
    };
    run.then(settled, settled);
    return run;
  }

  /** The handler of {@link resumeSession}. */
  private async resume(params: v2.ResumeSessionRequest): Promise<v2.ResumeSessionResponse> {
    const { sessionId, replayFrom } = params;
    if (replayFrom != null && replayFrom.type !== "start") {
      throw RequestError.invalidParams(
        { replayFrom },
        `Replaying from a ${replayFrom.type} cursor is not supported`,
      );
    }
    if (this.ownerOfChild(sessionId)) throw restrictedChild(sessionId, "resume");
    await this.restarts.settled(sessionId);
    // A concurrent resume of this session started its query: this one then
    // attaches to the session that it started.
    await this.startSettled(sessionId);
    let session = this.sessions.get(sessionId);
    let history: Promise<SessionMessage[]> | undefined;
    if (session) {
      // Resuming the active session synchronizes it again. Its work goes on,
      // and the request's MCP servers and additional directories replace the
      // session's.
      const request = await validatedSetup(params);
      if (request.cwd !== session.cwd) {
        throw RequestError.invalidParams(
          { cwd: request.cwd },
          `Session ${sessionId} works in ${session.cwd}: resume it with that \`cwd\``,
        );
      }
      await session.setMcpServers({
        ...clientOptions(params._meta)?.mcpServers,
        ...sdkMcpServers(request.mcpServers),
      });
      if (!sameDirectories(request.additionalDirectories ?? [], session.additionalDirectories)) {
        // The SDK cannot change them on a running query: it restarts with
        // them at its next turn boundary (see `restarts.ts`).
        this.restarts.rootsChanged(sessionId, params);
      } else {
        // A restart of its query starts with these servers.
        this.restarts.track(sessionId, params);
      }
    } else {
      // One read of the transcript serves the replay and the resumed model.
      history = replayFrom != null ? getSessionMessages(sessionId, { dir: params.cwd }) : undefined;
      // A failed start leaves it unawaited.
      history?.catch(() => {});
      session = await this.startSession(sessionId, params, sessionId, history);
    }
    let subagents: SubagentReplay | undefined;
    if (replayFrom != null) {
      const messages = await (history ?? getSessionMessages(sessionId, { dir: session.cwd }));
      subagents = await session.tasks.loadReplay(messages);
      session.output.replay(
        messages,
        subagents?.hooks(session.output, messages),
        session.tasks.backgroundWork(sessionId),
        session.tasks.replayedBackground(sessionId),
      );
      subagents?.finish();
      const end = replayEndUpdate(this.clientCapabilities);
      if (end) this.send({ sessionId, update: end });
    }
    // The current title, after the replay and before the state.
    await session.reports.publishTitle();
    for (const notification of session.resumeSnapshot()) this.send(notification);
    const response = await this.setupFields(session);
    this.afterSetup(session, params);
    // The response ends the replay, and the replayed children's states before
    // it are history: their current states follow it. Nothing enforces that
    // the timer runs after the response goes out; it relies on the response
    // being written when this handler returns, as the v1 core's
    // `afterSetupResponse` does.
    if (subagents) setTimeout(() => subagents.afterResponse(), 0);
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
    // A restart that runs ends first, so the close ends the session it started.
    await this.restarts.closing(sessionId);
    // A resume that runs answers first: the close ends what it started, and
    // its updates go out before the close response.
    await this.setupSettled(sessionId);
    this.stopped.delete(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.close();
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
      this.translator.forget(sessionId);
      this.auth.sessionEnded(sessionId);
      this.guard.sessionEnded(sessionId);
    }
    this.restarts.closed(sessionId);
    return {};
  }

  /** Deleting a session that does not exist succeeds, as v2 asks. */
  async deleteSession({ sessionId }: v2.DeleteSessionRequest): Promise<v2.DeleteSessionResponse> {
    if (this.ownerOfChild(sessionId)) throw restrictedChild(sessionId, "delete");
    // A resume that runs, or its start, may make the session live.
    await this.setupSettled(sessionId);
    const live = this.sessions.get(sessionId);
    if (live || this.stopped.has(sessionId)) await this.closeSession({ sessionId });
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
    // On the new query, when a restart runs.
    await this.restarts.settled(params.sessionId);
    const configOptions = await this.session(params.sessionId, "configure").setConfigOption(params);
    return { configOptions };
  }

  /**
   * The active session `sessionId`, for a request that `method` names. A
   * subagent's session takes no such request: the client can only watch it
   * and cancel its run.
   */
  session(sessionId: string, method: string): V2Session {
    const session = this.sessions.get(sessionId);
    if (session) return session;
    if (this.ownerOfChild(sessionId)) throw restrictedChild(sessionId, method);
    throw this.inactive(sessionId);
  }

  /** The error of a request of `sessionId`, which is not running. */
  private inactive(sessionId: string): RequestError {
    const stopped = this.stopped.get(sessionId);
    return stopped !== undefined
      ? RequestError.internalError({ sessionId }, stopped)
      : RequestError.sessionNotFound(sessionId);
  }

  async cancel(sessionId: string): Promise<void> {
    this.restarts.cancelled(sessionId);
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
    if (!root) throw this.inactive(sessionId);
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
  private ownerOfChild(sessionId: string): V2Session | undefined {
    return [...this.sessions.values()].find((session) => session.tasks.hasChild(sessionId));
  }

  async dispose(): Promise<void> {
    await this.restarts.dispose();
    await Promise.all([...this.starting.keys()].map((sessionId) => this.startSettled(sessionId)));
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.stopped.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }

  // --- Session setup -----------------------------------------------------------

  /**
   * Starts the query of the live session `sessionId` again, resuming its
   * conversation (see `restarts.ts`). Claude Code writes the conversation at
   * the first prompt, so a session never prompted has none to resume: it
   * starts afresh under the same id.
   */
  private async restartSession(sessionId: string, params: SetupParams): Promise<V2Session> {
    try {
      return await this.startSession(sessionId, params, sessionId);
    } catch (error) {
      if (!(
        error instanceof RequestError && error.code === RequestError.sessionNotFound(sessionId).code
      )) {
        throw error;
      }
      return this.startSession(sessionId, params, undefined);
    }
  }

  /**
   * The config options and commands of a setup response. When reading the
   * commands fails, the response goes without them, and an
   * `available_commands_update` with the commands, read again, follows it.
   */
  private async setupFields(session: V2Session): Promise<{
    configOptions: v2.SessionConfigOption[];
    availableCommands?: v2.AvailableCommand[];
  }> {
    const commands = await session.commands.list().catch((error: unknown) => {
      this.logger.error(`Session ${session.sessionId}: failed to read its commands`, error);
      // After the response, which the SDK sends once this handler returns.
      setTimeout(() => {
        session.sendCommands().catch((error: unknown) => {
          this.logger.error(`Session ${session.sessionId}: failed to send its commands`, error);
        });
      }, 0);
      return [];
    });
    return {
      configOptions: session.config.options(),
      // The draft leaves out an empty list.
      ...(commands.length > 0 ? { availableCommands: commands } : {}),
    };
  }

  /**
   * Resolves once the resumes of `sessionId` that run now, and every start of
   * it, settled, whether they succeeded or not. A resume that comes later is
   * not waited for.
   */
  private async setupSettled(sessionId: string): Promise<void> {
    const resumes = [...(this.resuming.get(sessionId) ?? [])];
    await Promise.all(resumes.map((resume) => resume.catch(() => {})));
    await this.startSettled(sessionId);
  }

  /**
   * What follows a setup response: OAuth for its MCP servers, and a route
   * restart that the session's start missed (`SessionRestarts.setupAnswered`).
   * A restart that runs, such as for other additional directories, retires
   * `session` and starts OAuth on the new query instead.
   */
  private afterSetup(session: V2Session, params: SetupParams): void {
    if (!this.restarts.restarting(session.sessionId)) afterSetupResponse(session, params);
    this.restarts.setupAnswered(session.sessionId);
  }

  /** Resolves once no start of `sessionId` runs, whether the starts succeeded or not. */
  private async startSettled(sessionId: string): Promise<void> {
    // Each wait can end with another start running, which began after it.
    let start = this.starting.get(sessionId);
    while (start) {
      await start.catch(() => {});
      start = this.starting.get(sessionId);
    }
  }

  /**
   * Starts the query of a session: a new one, or `resume` of a stored one
   * (also a fork's copy), and tracks the start in {@link starting} until it
   * settles. A resume checks that no start of `sessionId` runs right
   * before, with no await in between. A restart's start is serialized by
   * `restarts.ts`, which a resume and a close wait for first.
   */
  private startSession(
    sessionId: string,
    params: v2.NewSessionRequest | v2.ResumeSessionRequest | v2.ForkSessionRequest,
    resume: string | undefined,
    history?: Promise<SessionMessage[]>,
  ): Promise<V2Session> {
    const start = this.launchSession(sessionId, params, resume, history);
    this.starting.set(sessionId, start);
    const settled = () => {
      if (this.starting.get(sessionId) === start) this.starting.delete(sessionId);
    };
    start.then(settled, settled);
    return start;
  }

  /**
   * The query start of {@link startSession}. Its options are the client's
   * `_meta.claudeCode.options` under the ones this core controls.
   */
  private async launchSession(
    sessionId: string,
    params: v2.NewSessionRequest | v2.ResumeSessionRequest | v2.ForkSessionRequest,
    resume: string | undefined,
    /** The resumed transcript, when the caller reads it anyway (a replay). */
    history?: Promise<SessionMessage[]>,
  ): Promise<V2Session> {
    const request = await validatedSetup(params);
    const client = clientOptions(params._meta);
    // After a provider change that is still listing its models.
    await this.auth.routeSettled();
    // The resumed transcript's last model and mode.
    const resumed =
      resume === undefined
        ? undefined
        : history
          ? {
              ...(await readResumedTail(resume, this.logger, false)),
              model: await history.then(resumedModelFromTranscript, () => undefined),
            }
          : await readResumedTail(resume, this.logger);
    // Read before the settings watchers open: only a failed query start disposes them.
    const configured = await configuredSettings(client?.settings, request.cwd);
    const pathToClaudeCodeExecutable = await claudeCliPath();
    const settings = new SettingsManager(request.cwd, { logger: this.logger });
    await settings.initialize();
    // A client can remove bypass from the session with `false`.
    const allowBypass =
      ALLOW_BYPASS &&
      settings.getSettings().permissions?.disableBypassPermissionsMode !== "disable" &&
      client?.allowDangerouslySkipPermissions !== false;
    const allowAuto = !autoModeDisabled(settings.getSettings());
    const { mode, builtInDefault } = resolveInitialPermissionMode(
      {
        resumed: resumed?.permissionMode,
        defaultMode: settings.getSettings().permissions?.defaultMode,
      },
      this.logger,
      { allowBypass, allowAuto },
    );
    // The settings stay live for the idle compaction (see `reports.ts`) until the session
    // ends. They keep the values they read: their cwd and key helper.
    const authStarted = this.auth.sessionStarting(settings);
    const routeGeneration = this.auth.routeGeneration;
    const routing = this.auth.routing();
    const thinking = resolveThinkingConfig(
      process.env.MAX_THINKING_TOKENS,
      process.env.CLAUDE_CODE_THINKING_DISPLAY,
      this.logger,
    );
    const mcpServers = { ...client?.mcpServers, ...sdkMcpServers(request.mcpServers) };

    const clientPrompt = clientSystemPrompt(request.systemPrompt);
    const input = new Pushable<SDKUserMessage>();
    // A client can turn the affordance off (`_meta.claudeCode.options`). Then
    // Claude Code's interrupt stops background tasks, so `session/cancel`
    // could not leave listed work running, and the session lists none.
    const perTaskStopAffordance = client?.perTaskStopAffordance !== false;
    const additionalDirectories = [
      ...(client?.additionalDirectories ?? []),
      ...(request.additionalDirectories ?? []),
    ];
    const session = new V2Session(
      sessionId,
      request.cwd,
      request.additionalDirectories ?? [],
      this,
      input,
      perTaskStopAffordance,
      additionalDirectories,
    );
    const elicitationOptions = session.elicitations.queryOptions();
    const subagent = subagentHooks((input) => session.tasks.subagentHook(input));
    const options: Options = {
      systemPrompt: sessionSystemPrompt(clientPrompt, params._meta?.systemPrompt),
      settingSources: ["user", "project", "local"],
      ...(thinking !== undefined && { thinking }),
      // Claude Code's interrupt then spares background tasks, which the
      // client stops one at a time: `session/cancel` must leave listed work
      // running. Before the client's options.
      perTaskStopAffordance: true,
      // AIR's predicted follow-up prompt (see `reports.ts`), as on v1. Only
      // AIR gets it, so no other client's session spends a request on it.
      // Before the client's options: `promptSuggestions: false` turns it off.
      ...(this.air.client ? { promptSuggestions: true } : {}),
      ...client,
      // The checkpoints that AIR's file-change reports read (see
      // `file-changes.ts`), only for a client that declared them, as on v1.
      ...(this.air.fileChangeReport ? { enableFileCheckpointing: true } : {}),
      // Claude Code applies the env of settings.json after the process env:
      // the route goes into the programmatic settings too.
      ...(routing.settings
        ? {
            settings: {
              ...configured,
              ...routing.settings,
              env: { ...configured?.env, ...routing.settings.env },
            },
          }
        : configured && { settings: configured }),
      cwd: request.cwd,
      additionalDirectories,
      includePartialMessages: true,
      // A subagent's text, for its own session's stream (see `tasks.ts`).
      forwardSubagentText: true,
      mcpServers,
      permissionMode: mode,
      allowDangerouslySkipPermissions: allowBypass,
      canUseTool: denyingStoppedWork(session, session.elicitations.canUseTool(canUseTool(session))),
      // MCP elicitations and the refusal fallback, for the modes the client
      // renders. Without forms, AskUserQuestion is disallowed (below).
      ...elicitationOptions,
      pathToClaudeCodeExecutable,
      // Echoes each prompt that Claude Code takes in (see `V2Session`).
      extraArgs: { ...client?.extraArgs, "replay-user-messages": "" },
      disallowedTools: [
        ...(client?.disallowedTools ?? []),
        ...(elicitationOptions.disallowedTools ?? []),
      ],
      tools:
        client?.tools ??
        (params._meta?.disableBuiltInTools === true
          ? []
          : { type: "preset", preset: "claude_code" }),
      hooks: withClientHooks(client?.hooks, {
        // A subagent's `cwd` (such as its worktree) and configuration, from its hooks.
        SubagentStart: [subagent.SubagentStart],
        SubagentStop: [subagent.SubagentStop],
        PostToolUseFailure: [subagent.PostToolUseFailure],
        // An Edit or Write shows its exact patch before it runs.
        PreToolUse: [subagent.PreToolUse, fileChangePreviewHook(session, this.logger)],
        PostToolUse: [
          subagent.PostToolUse,
          {
            hooks: [
              createPostToolUseHook({ onEnterPlanMode: async () => session.modeChanged("plan") }),
            ],
          },
        ],
        PostModelSwitch: [
          subagent.PostModelSwitch,
          modelSwitchHook((model) => session.modelSwitched(model)),
        ],
        ...reportHooks(session),
      }),
      env: {
        ...process.env,
        ...client?.env,
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
      settings.dispose();
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
    try {
      this.guard.sessionStarted(sessionId, initialization.account, settings.getApiKeyHelper());
    } catch (error) {
      q.close();
      settings.dispose();
      throw error;
    }
    // For the description of a child's agent type in its configuration.
    session.tasks.configs.configureAgents(customAgents(initialization.agents ?? []));
    let models;
    try {
      models = await sessionModels(
        q,
        initialization.models,
        settings,
        routing.models,
        routing.narrowsModels,
        resumed,
        sessionId,
        this.logger,
      );
    } catch (error) {
      // Claude Code refused a fresh session's model pin.
      q.close();
      settings.dispose();
      throw error;
    }
    // A failed sync of the mode is logged (`SessionModeManager.initialize`),
    // and a failed read of the agents or of ultracode leaves them out. Only
    // the effort that `recommendedValue` sets can fail the start.
    let config;
    try {
      config = await SessionConfig.start(
        sessionId,
        q,
        { mode, builtInDefault, allowBypass, allowAuto },
        models.models,
        models.modelInfos,
        models.currentModelInfo,
        {
          fastMode: {
            state: initialization.fast_mode_state,
            disabledReason: initialization.fast_mode_disabled_reason,
          },
          client,
          effortSettings: () => mergeEffortSettings(settings.getSettings(), configured),
          recommendedValue: this.air.recommendedValue,
        },
        (notification) => session.output.emitV1([notification]),
        this.logger,
      );
    } catch (error) {
      q.close();
      settings.dispose();
      throw error;
    }
    session.reports.configure({
      settings,
      env: options.env ?? {},
      mcpServers: request.mcpServers.map((server) => server.name),
      mcpOAuth: this.elicitation.url && supportsMcpOAuth(q),
      query: q,
      model: { id: models.models.currentModelId, info: models.allowlistedModelInfo },
    });
    session.start(q, config, mcpServers, resume !== undefined);
    this.sessions.set(sessionId, session);
    this.stopped.delete(sessionId);
    // A route change during the start did not find this session live.
    this.restarts.track(sessionId, params, {
      staleRoute: this.auth.routeGeneration !== routeGeneration,
    });
    return session;
  }
}

/**
 * The setup request in v1 form, once it is valid: the MCP transports that
 * `V2_SESSION_CAPABILITIES` lists, a `systemPrompt` that the session can apply
 * (`clientSystemPrompt`), an absolute `cwd` that is a directory, and
 * absolute additional directories. Every setup path calls it before it acts,
 * so an invalid request creates, resumes or forks nothing.
 */
async function validatedSetup(
  params: v2.NewSessionRequest | v2.ResumeSessionRequest | v2.ForkSessionRequest,
) {
  const request = v1NewSessionRequest({ ...params, mcpServers: params.mcpServers ?? [] });
  clientSystemPrompt(request.systemPrompt);
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
