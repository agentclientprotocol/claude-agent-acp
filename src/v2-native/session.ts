/**
 * One ACP v2 session, served straight from its Claude Code query.
 *
 * ACP v2 and Claude Code describe a session the same way: prompts go into a
 * queue, Claude Code works through them, and the session reports whether it
 * is working. So this session keeps little of its own:
 *
 * - A prompt is pushed to Claude Code at once, with a uuid. Its response is
 *   the prompt's insertion: the `command_lifecycle` frame `started` for that
 *   uuid, or the prompt's echo, whichever comes first. `cancelled`,
 *   `discarded` or `refused` fails the prompt.
 * - The foreground work is Claude Code's turn: it starts with a prompt's
 *   `started` frame or echo, or with the main conversation's output (a
 *   cycle that Claude Code starts on its own, such as after a background
 *   task ends), and ends with the turn's `result`, whose stop reason, usage
 *   and quota the idle carries (see `outcome.ts`). Claude Code's own
 *   `session_state_changed` stays `running` while background subagents work,
 *   which v2 lists as background work instead (`background`), so its `idle`
 *   only ends a turn that ended without a result.
 * - `requires_action` is this session's own: a turn is open, and a
 *   permission request or elicitation of this session is open, or, while
 *   the turn waits on subagents, each of them waits on one.
 * - Subagents are child sessions, and background work is listed on every
 *   state (see {@link SessionTasks}).
 * - `session/cancel` answers the prompts that are not inserted yet with
 *   -32800, and sends Claude Code's interrupt with `cancelQueued`, which ends
 *   them in Claude Code too. A run of one that Claude Code had taken in
 *   already is dropped (see {@link StoppedWork}). With
 *   `perTaskStopAffordance`, the interrupt spares background tasks.
 *
 * Output goes out as it comes, whatever prompt it belongs to (see
 * {@link SessionOutput}).
 */
import { randomUUID } from "node:crypto";
import {
  RequestError,
  type CompleteElicitationNotification,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type PromptRequest,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk/unstable";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {
  FastModeDisabledReason,
  FastModeState,
  PermissionMode,
  PermissionResult,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AUTONOMOUS_RESULT_ORIGINS, promptToClaude, type Logger } from "../acp-agent.js";
import type { McpCommand } from "../mcp-command.js";
import type { ElicitationSupport } from "../elicitation.js";
import { Pushable } from "../utils.js";
import { v1PromptRequest } from "../v2/prompt.js";
import { V2Background, stateUpdate as currentStateUpdate } from "../v2/background.js";
import type { V2UpdateTranslator } from "../v2/update-translator.js";
import { MODEL_CONFIG_ID } from "../session-model.js";
import { modelRefusalFallback, noticeUpdate } from "../session-notices.js";
import { planModeUpdate } from "../exit-plan.js";
import type { ClearContextReset } from "../clear-context-coordinator.js";
import { ClearContext } from "./clear-context.js";
import { SessionCommands } from "./commands.js";
import type { SessionConfig } from "./config.js";
import {
  idleOutcome,
  isPlaceholderResult,
  ResultUsage,
  TurnReport,
  type TurnEnd,
} from "./outcome.js";
import { StoppedWork } from "./stopped-work.js";
import { SessionReports } from "./reports.js";
import { SessionElicitations } from "./elicitation.js";
import { SessionOutput } from "./stream.js";
import { SessionRemoteControl } from "./remote-control.js";
import { SessionTasks, type RequestTarget } from "./tasks.js";

/** What a session needs of its connection. */
export interface SessionConnection {
  readonly logger: Logger;
  readonly translator: V2UpdateTranslator;
  /** Sends an update of the session. Updates go out in the order of the calls. */
  send(notification: v2.UpdateSessionNotification): void;
  requestPermission(
    request: v2.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<v2.RequestPermissionResponse>;
  /** The elicitation modes that the client advertised. */
  readonly elicitation: ElicitationSupport;
  createElicitation(
    request: CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse>;
  completeElicitation(params: CompleteElicitationNotification): Promise<void>;
  /** The query of `session` ended on its own: the session cannot go on. */
  ended(session: NativeSession): void;
  /** A turn of the session failed for a missing login (`authRequired`). */
  signedOut(sessionId: string): void;
}

type PendingPrompt = {
  prompt: v2.ContentBlock[];
  /** Whether the prompt went to Claude Code (see {@link NativeSession.prompt}). */
  pushed: boolean;
  resolve: (response: v2.PromptResponse) => void;
  reject: (error: unknown) => void;
};

type ForegroundState = "idle" | "running" | "requires_action";

/** An open permission request of the session. */
type OpenRequest = {
  /** Withdraws the request, with `$/cancel_request`. */
  abort: AbortController;
  /** Whether a cancel came while it was open: its work is being stopped. */
  coveredByCancel: boolean;
};

type McpServers = Parameters<Query["setMcpServers"]>[0];

/** The `command_lifecycle` frame of a uuid-stamped prompt. It is not part of the SDK's types. */
type CommandLifecycleFrame = { type: "command_lifecycle"; command_uuid: string; state: string };

export class NativeSession implements RequestTarget {
  /** The prompts not inserted yet, by uuid. */
  private readonly pending = new Map<string, PendingPrompt>();
  /** Whether a turn of Claude Code is open: the session's foreground work. */
  private foreground = false;
  /** The prompt whose `started` frame came last in the open turn. */
  private turnCommand: string | undefined;
  /** The state the client was told last. */
  private reportedState: ForegroundState = "idle";
  /** The open permission requests and elicitations of the session. */
  private readonly requests = new Set<OpenRequest>();
  /** Whether `session/cancel` stops the open turn: its idle reports `cancelled`. */
  private cancelledWork = false;
  /** What a cancel stopped before the client saw it, and the reach of its interrupt. */
  readonly stopped = new StoppedWork();
  /** The interrupt of the last `session/cancel`, while it runs. */
  private interrupting: Promise<void> | undefined;
  /** Pushes prompts in the order they came (see {@link prompt}). */
  private pushes: Promise<void> = Promise.resolve();
  /** The result that ended the open turn, with what the turn spent. */
  private lastEnd: TurnEnd | undefined;
  private usage = new ResultUsage(false);
  /**
   * Whether Claude Code's `idle` for the last result is still to come. It can
   * come after the next cycle's first output, and does not end that cycle.
   */
  private idleOwed = false;
  /** Whether Claude Code sends `command_lifecycle` frames (`msg_lifecycle_v1`). */
  private lifecycleFrames = false;
  /** What the open turn's assistant messages reported about its end (see {@link TurnReport}). */
  private readonly turnReport = new TurnReport();
  /** Set by `session/close`, or when the query ends: nothing more goes out. */
  private closed = false;
  private closing: Promise<void> | undefined;
  private query: Query | undefined;
  readonly output: SessionOutput;
  /** Usage, quota, notices, compactions and the title (see {@link SessionReports}). */
  readonly reports: SessionReports;
  /** Resolves the adapter's own `/compact` once a turn ends (see {@link compact}). */
  private ownCommandDone: (() => void) | undefined;
  /** The `background` lists of the session and its children, stamped on each state. */
  private readonly background: V2Background;
  readonly tasks: SessionTasks;
  readonly elicitations: SessionElicitations;
  config!: SessionConfig;
  commands!: SessionCommands;
  /** ExitPlanMode's "clear context" option (see {@link ClearContext}). */
  readonly clearContext: ClearContext;
  /** The `/mcp` prompts not inserted yet, by uuid, and the open turn's (see `SessionCommands`). */
  private readonly localCommands = new Map<string, McpCommand>();
  private turnLocalCommand: { command: McpCommand; abort: AbortController } | undefined;
  /** The JSON of the query's MCP servers. */
  private mcpServers = "";
  /** The adapter's `/remote-control`, and messages typed in other clients. */
  private readonly remoteControl: SessionRemoteControl;
  /** Who waits for {@link turnBoundary}, with whether it waits for a restart. */
  private readonly boundaryWaiters: Array<{
    restart: boolean;
    resolve: (reached: boolean) => void;
  }> = [];

  constructor(
    readonly sessionId: string,
    readonly cwd: string,
    /** The session's additional directories, as its query got them. */
    readonly additionalDirectories: readonly string[],
    private readonly connection: SessionConnection,
    private readonly input: Pushable<SDKUserMessage>,
    /** Whether Claude Code's interrupt spares background tasks (see {@link SessionTasks}). */
    reportsBackground = true,
  ) {
    this.output = new SessionOutput(
      sessionId,
      cwd,
      connection.translator,
      (update) => this.send(update),
      connection.logger,
    );
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const session = this;
    const titled = {
      get query() {
        return session.query!;
      },
      get queryClosed() {
        return session.closed;
      },
      get cancelled() {
        return session.cancelledWork;
      },
      cwd,
    };
    this.reports = new SessionReports({
      sessionId,
      logger: connection.logger,
      emit: (notifications) => this.output.emitV1(notifications),
      isBusy: () => this.foreground || this.pending.size > 0 || this.requests.size > 0,
      compact: () => this.compact(),
      titledSession: () => (this.query && !this.closed ? titled : undefined),
    });
    this.output.onAgentText = (content) => this.reports.agentText(content);
    this.clearContext = new ClearContext(
      {
        push: (text, uuid) => this.pushOwnPrompt(text, uuid),
        enterMode: (mode) => this.config.enterMode(mode),
        publish: (plan) => {
          this.send({
            sessionUpdate: "config_option_update",
            configOptions: this.config.options(),
          });
          // Otherwise the client shows the old context's usage until the fresh one reports its own.
          this.reports.emptyContext();
          // The approved plan becomes the session's plan. Its ExitPlanMode
          // ended as a rejection, so the stream did not show it.
          this.output.emitV1([{ sessionId, update: planModeUpdate(plan) }]);
        },
        logError: (message, error) =>
          connection.logger.error(`Session ${sessionId}: ${message}`, error),
      },
      () => this.output.toolUses(),
      randomUUID,
    );
    this.background = new V2Background(connection.translator.terminals);
    this.tasks = new SessionTasks(
      {
        sessionId,
        cwd,
        logger: connection.logger,
        translator: connection.translator,
        background: this.background,
        reportsBackground,
        send: (notification) => this.sendNotification(notification),
        rootState: () => this.foregroundState(),
        // A cancel withdraws the requests of the subagents that the work waits on.
        foregroundRequestsChanged: () => this.reportState(this.cancelledWork),
        models: () => this.config.subagentModels(),
        modes: () => this.config.availableModes(),
        stopTask: async (taskId) => {
          await this.query?.stopTask(taskId);
        },
      },
      this.output,
    );
    this.tasks.hostRequest = (request, signal) =>
      unlessWithdrawn(signal, () => connection.requestPermission(request, signal));
    this.elicitations = new SessionElicitations({
      sessionId,
      logger: connection.logger,
      support: connection.elicitation,
      createElicitation: (request, signal) =>
        unlessWithdrawn(signal, () => connection.createElicitation(request, signal)),
      completeElicitation: (params) => connection.completeElicitation(params),
      target: (agentId) => this.target(agentId),
      query: () => this.query,
    });
    this.remoteControl = new SessionRemoteControl({
      logger: connection.logger,
      query: () => this.query,
      terminalCommands: () => this.commands.terminal(),
      idle: () => this.turnBoundary(false),
      begin: (uuid) => {
        this.inserted(uuid);
        this.openTurn(undefined);
      },
      end: (text, messageId) => {
        this.output.agentMessage(text, messageId);
        this.closeTurn();
      },
    });
  }

  /**
   * Starts reading the query. Called once, after its initialization.
   * `mcpServers` are the servers the query started with.
   */
  start(query: Query, config: SessionConfig, mcpServers: McpServers, resumed = false): void {
    this.query = query;
    this.config = config;
    this.usage = new ResultUsage(resumed);
    this.mcpServers = JSON.stringify(mcpServers);
    this.commands = new SessionCommands(query);
    void this.consume(query);
  }

  /** Sends the session's commands in an update, read again from Claude Code. */
  async sendCommands(): Promise<void> {
    const availableCommands = await this.commands.list();
    this.send({ sessionUpdate: "available_commands_update", availableCommands });
  }

  /**
   * What `session/resume` sends before its response: the listed children
   * with their current states, the current update of each listed item, then
   * the session's state, with its list. A snapshot is no new completion, so
   * its idle has no stop reason.
   */
  resumeSnapshot(): v2.UpdateSessionNotification[] {
    return [
      ...this.tasks.currentState(),
      this.background.stamp({
        sessionId: this.sessionId,
        update: currentStateUpdate(this.foregroundState()),
      }),
    ];
  }

  /**
   * Replaces the session's MCP servers, as a resume of the active session
   * asks. The same servers stay as they are, connected, as on the bridge.
   */
  async setMcpServers(servers: McpServers): Promise<void> {
    const key = JSON.stringify(servers);
    if (key === this.mcpServers) return;
    await this.query?.setMcpServers(servers);
    this.reports.mcpServersChanged(Object.keys(servers));
    this.mcpServers = key;
  }

  // --- Requests ---------------------------------------------------------

  /**
   * Pushes the prompt to Claude Code. Answers once Claude Code inserted it
   * (see the module doc), right after the prompt's `user_message`.
   *
   * A prompt waits for the interrupt of an earlier `session/cancel` before it
   * goes to Claude Code: the interrupt's `cancelQueued` must not end a prompt
   * that came after the cancel.
   *
   * `guard`, the subscription guard's check (see `subscription-guard.ts`),
   * runs in the prompt's turn among the session's prompts, so they keep their
   * order, and a cancel or close answers a prompt that waits for it with
   * -32800 as any prompt not inserted yet. Its refusal answers the prompt.
   * The adapter's `/remote-control` is not guarded, as on the bridge.
   */
  prompt(
    params: v2.PromptRequest,
    guard?: (query: Query) => Promise<void> | undefined,
  ): Promise<v2.PromptResponse> {
    if (this.closed) {
      return Promise.reject(RequestError.sessionNotFound(this.sessionId));
    }
    // Throws invalid params for content that Claude cannot take.
    const request: PromptRequest = v1PromptRequest(params);
    const remoteControl = this.remoteControl.mayRun(request.prompt);
    const guarded = guard && !remoteControl ? guard : undefined;
    // As on the bridge, a prompt that the guard refuses titles nothing and
    // sends no notice.
    const sent = () => {
      this.reports.promptSent(request.prompt);
      // The notice of a mode fallback at the session's start, which sends it at once.
      void this.config.promptSent();
    };
    if (!guarded) sent();
    const uuid = randomUUID();
    const message = { ...promptToClaude(request), uuid };
    const localCommand = this.commands.localCommand(request.prompt);
    if (localCommand) this.localCommands.set(uuid, localCommand);
    return new Promise((resolve, reject) => {
      const pending: PendingPrompt = { prompt: params.prompt, pushed: false, resolve, reject };
      this.pending.set(uuid, pending);
      // A cancel or close answered it before it went out.
      const answered = () => this.pending.get(uuid) !== pending || this.closed;
      this.pushes = this.pushes
        .then(() => this.interrupting)
        .then(async () => {
          if (answered()) return;
          if (guarded && this.query) {
            try {
              await guarded(this.query);
            } catch (error) {
              this.failPrompt(uuid, error);
              return;
            }
            if (answered()) return;
            sent();
          }
          // The prompts after the adapter's `/remote-control` wait for it.
          if (remoteControl) {
            try {
              if (await this.remoteControl.run(request.prompt, uuid, () => !answered())) return;
            } catch (error) {
              this.failPrompt(uuid, error);
              return;
            }
            if (answered()) return;
          }
          pending.pushed = true;
          this.remoteControl.pushed(uuid);
          this.input.push(message);
          this.reports.promptQueued(request.prompt);
        });
    });
  }

  /**
   * Whether no turn is open and no prompt waits in Claude Code's queue. With
   * `restart`, for a restart of the query (see `restarts.ts`), also no
   * prompt of the session waits to go to Claude Code, which the restart would
   * answer with -32800, and no subagent runs. Without it, for the adapter's
   * `/remote-control`, whose own prompt waits for the boundary.
   */
  atTurnBoundary(restart: boolean): boolean {
    return (
      !this.closed &&
      !this.foreground &&
      ![...this.pending.values()].some((prompt) => restart || prompt.pushed) &&
      !(restart && this.tasks.hasLiveSubagents())
    );
  }

  /**
   * Resolves `true` at the next turn boundary (see {@link atTurnBoundary}),
   * at once if the session is at one, and `false` once the session closed.
   */
  turnBoundary(restart: boolean): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.atTurnBoundary(restart)) return Promise.resolve(true);
    return new Promise((resolve) => this.boundaryWaiters.push({ restart, resolve }));
  }

  private checkBoundary(): void {
    for (const waiter of [...this.boundaryWaiters]) {
      if (!this.closed && !this.atTurnBoundary(waiter.restart)) continue;
      this.boundaryWaiters.splice(this.boundaryWaiters.indexOf(waiter), 1);
      waiter.resolve(!this.closed);
    }
  }

  /**
   * The adapter's idle compaction: `/compact`, as Claude Code's own turn. It
   * is no prompt of the client's, so it gets no `user_message`, and the client
   * sees its turn as `running`, then `idle`. Resolves when a turn ends after
   * it: the idle compaction runs it only while the session is idle, so the
   * next turn to end is its own.
   */
  private compact(): Promise<void> {
    return new Promise((resolve) => {
      this.ownCommandDone?.();
      this.ownCommandDone = resolve;
      const message = {
        ...promptToClaude({
          sessionId: this.sessionId,
          prompt: [{ type: "text", text: "/compact" }],
        }),
        uuid: randomUUID(),
      };
      this.pushes = this.pushes
        .then(() => this.interrupting)
        .then(() => {
          if (this.closed) {
            resolve();
            return;
          }
          this.remoteControl.pushed(message.uuid);
          this.input.push(message);
        });
    });
  }

  /**
   * Sends Claude Code the adapter's own prompt `text`, after the interrupt of
   * an earlier `session/cancel`, as {@link prompt} does. It is no prompt of
   * the client's: it gets no `user_message`, also when its echo carries the
   * human `origin` that `promptToClaude` stamps.
   */
  private pushOwnPrompt(text: string, uuid: ReturnType<typeof randomUUID>): void {
    const message = {
      ...promptToClaude({ sessionId: this.sessionId, prompt: [{ type: "text", text }] }),
      uuid,
    };
    this.pushes = this.pushes
      .then(() => this.interrupting)
      .then(() => {
        if (this.closed) return;
        this.remoteControl.pushed(uuid);
        this.input.push(message);
      });
  }

  /**
   * Stops the foreground work, and answers the prompts not inserted yet with
   * -32800. The work's idle reports `cancelled`. Background work goes on.
   *
   * The interrupt goes out also while the session is idle, as on the bridge:
   * Claude Code may run a cycle that this session has not read yet.
   */
  async cancel(): Promise<void> {
    if (this.closed || !this.query) return;
    this.reports.disarmIdleCompaction("cancel");
    this.stopForeground();
    // `cancelQueued` is untyped in the SDK (`Query.interrupt` takes it since
    // the CLI's `interrupt_cancel_queued_v1`): Claude Code then drops the
    // queued prompts, which this session answered already.
    const interrupt = this.query.interrupt as (options: {
      cancelQueued: boolean;
    }) => Promise<unknown>;
    const done = interrupt.call(this.query, { cancelQueued: true }).then(
      () => undefined,
      (error: unknown) => {
        // `session/cancel` is a notification: no one can be answered. Nothing
        // stopped, so the work's idle reports how it really ends.
        this.connection.logger.error(`Session ${this.sessionId}: the interrupt failed`, error);
        this.cancelledWork = false;
        this.output.cancelled = false;
        this.stopped.interruptFailed();
        this.tasks.foregroundCancelFailed();
        // The withdrawn requests reported no `running`: the work goes on.
        this.reportState();
      },
    );
    this.interrupting = done;
    await done;
    if (this.interrupting === done) this.interrupting = undefined;
  }

  /**
   * What a cancel or close stops at once: the prompts not inserted yet, the
   * open turn, and the work of the subagents that it waits on. The open
   * permission requests stay open: Claude Code's interrupt withdraws them,
   * and the end of the stopped work withdraws what is left (see
   * {@link closeTurn}).
   */
  private stopForeground(): void {
    const pushed: string[] = [];
    for (const [uuid, prompt] of [...this.pending]) {
      if (prompt.pushed) pushed.push(uuid);
      this.failPrompt(uuid, RequestError.requestCancelled());
    }
    // A turn that waits for its plan's prompt in a fresh context: the
    // adapter's prompts are stopped work too, and no frame of the turn's own
    // prompt is left to end it.
    const heldTurn = this.clearContext.holdsTurn();
    pushed.push(...this.clearContext.stop());
    this.stopped.cancelled(pushed, this.foreground);
    if (this.foreground) {
      this.cancelledWork = true;
      this.output.cancelled = true;
    }
    for (const request of this.requests) request.coveredByCancel = true;
    this.turnLocalCommand?.abort.abort();
    // The subagents that the work waits on stop with it. Background ones go on.
    this.tasks.cancelForeground();
    if (heldTurn) this.closeTurn();
  }

  async setConfigOption(
    params: v2.SetSessionConfigOptionRequest,
  ): Promise<v2.SessionConfigOption[]> {
    await this.config.set(params);
    if (params.configId === MODEL_CONFIG_ID) this.modelChangedReports();
    const options = this.config.options();
    // v2 sends every config change as an update too, for the session's other clients.
    this.send({ sessionUpdate: "config_option_update", configOptions: options });
    return options;
  }

  /**
   * Cancels as `session/cancel` does, ends the open turn with its cancelled
   * idle, then ends the query, which stops the background work too. Nothing
   * of the session goes out after it resolves. As on the bridge, it does not
   * wait for Claude Code to end the work: the query's end stops it, and the
   * tool calls that the work leaves open end `cancelled` before its idle.
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      if (!this.closed) this.stopForeground();
      // v2 asks to withdraw every request of the session before the close
      // response, also its background subagents' and the MCP OAuth runs'.
      this.tasks.withdrawAll();
      this.elicitations.close();
      for (const request of this.requests) {
        request.coveredByCancel = true;
        request.abort.abort();
      }
      this.closeTurn();
      this.failPending(RequestError.requestCancelled());
      this.closed = true;
      this.checkBoundary();
      this.endReports();
      this.input.end();
      this.query?.close();
    })();
    return this.closing;
  }

  /**
   * Ends the session's query, which a new one replaced (see `restarts.ts`).
   * The session is idle then. Its background work ends with the query: its
   * terminals exit and its listed tool calls end before the list drops them,
   * as when a query ends. Then it closes as {@link close} does.
   */
  retire(): Promise<void> {
    if (!this.closed && !this.closing) {
      this.tasks.queryEnded({
        code: RequestError.internalError().code,
        message: "The session's query restarted",
      });
    }
    return this.close();
  }

  // --- Permission requests -----------------------------------------------

  availableModes(): string[] {
    return this.config.availableModeIds();
  }

  cancelling(): boolean {
    return this.cancelledWork;
  }

  dropsToolUse(
    toolUseId: string,
    agentId: string | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.stopped.dropsToolUse(toolUseId, agentId, signal);
  }

  /** The session of a permission request: this one, or a subagent's (see `canUseTool`). */
  target(agentId: string | undefined): Promise<RequestTarget> {
    return this.tasks.target(agentId, this);
  }

  requestPermission(
    request: v2.RequestPermissionRequest,
    toolSignal: AbortSignal,
  ): Promise<v2.RequestPermissionResponse> {
    return this.openRequest(toolSignal, async (signal) => {
      try {
        // The subject is an upsert of the tool call: the client may see the
        // request before the tool use streams.
        return await unlessWithdrawn(signal, () =>
          this.connection.requestPermission(request, signal),
        );
      } catch (error) {
        if (signal.aborted) return { outcome: { outcome: "cancelled" } };
        throw error;
      }
    });
  }

  /** Runs `send` as an open request of this session (see {@link RequestTarget.openRequest}). */
  async openRequest<T>(
    toolSignal: AbortSignal,
    send: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const open: OpenRequest = { abort: new AbortController(), coveredByCancel: false };
    // After `session/close` nothing of the session goes out: the request is
    // withdrawn before it is sent.
    if (this.closed) open.abort.abort();
    const signal = AbortSignal.any([toolSignal, open.abort.signal]);
    this.requests.add(open);
    this.reportState();
    try {
      return await send(signal);
    } finally {
      this.requests.delete(open);
      // A request withdrawn after a cancel (Claude Code's interrupt aborts
      // `toolSignal`) ends work that is stopping: its idle follows, so no
      // `running` comes first. One that the user answers, or that Claude Code
      // withdraws without a cancel (a hook answered it), lets the work go on.
      this.reportState(open.coveredByCancel && signal.aborted);
    }
  }

  modeChanged(mode: PermissionMode): void {
    if (this.config.modeChanged(mode)) {
      this.send({ sessionUpdate: "config_option_update", configOptions: this.config.options() });
    }
  }

  prePlanMode(): string | undefined {
    return this.config.prePlanMode();
  }

  /** A fresh context continues the open turn: only the root's plan in a turn offers it. */
  contextReset(agentId: string | undefined): {
    offered: boolean;
    usedPercent: number | undefined;
  } {
    return {
      offered: agentId === undefined && this.foreground,
      usedPercent: this.reports.contextUsedPercent(),
    };
  }

  exitPlanInterrupting(toolUseId: string, reset: ClearContextReset | undefined): void {
    // The fresh context starts in the mode that the answer's mode runs as on
    // the model, such as `acceptEdits` for `auto` on a model without Auto,
    // with no fallback notice, as the bridge starts its fresh query.
    this.clearContext.interrupting(
      toolUseId,
      reset && { ...reset, mode: this.config.effectiveMode(reset.mode) },
    );
  }

  permissionAllowed(result: PermissionResult): Promise<PermissionResult> {
    return this.config.permissionAllowed(result);
  }

  requestShows(target: RequestTarget, toolName: string, toolCallId: string): void {
    this.tasks.requestShows(target.output, toolName, toolCallId);
  }

  toolCallSubject<T extends ToolCallUpdate>(sessionId: string, toolCall: T): T {
    return this.connection.translator.toolCallMeta.subject(sessionId, toolCall);
  }

  /**
   * Claude Code switched the model without the adapter: a typed `/model`
   * (see `modelSwitchHook`), or a refusal fallback.
   */
  modelSwitched(model: string): void {
    this.config.modelSwitched(model).then(
      (changed) => {
        if (!changed) return;
        this.modelChangedReports();
        this.send({ sessionUpdate: "config_option_update", configOptions: this.config.options() });
      },
      (error: unknown) => {
        this.connection.logger.error(
          `Session ${this.sessionId}: failed to follow a model switch`,
          error,
        );
      },
    );
  }

  /** The reports follow the model: its context window, and the idle compaction. */
  private modelChangedReports(): void {
    const { id, info } = this.config.currentModel();
    this.reports.modelChanged(id, info);
  }

  /** Claude Code reported a Fast mode state, on `system`/init or a result. */
  private fastModeReported(message: {
    fast_mode_state?: FastModeState;
    fast_mode_disabled_reason?: FastModeDisabledReason;
  }): void {
    if (this.config.fastModeReported(message.fast_mode_state, message.fast_mode_disabled_reason)) {
      this.send({ sessionUpdate: "config_option_update", configOptions: this.config.options() });
    }
  }

  /**
   * Claude Code mounted a fresh conversation (such as for `/clear`), whose
   * Task* ids and task store are independent of the previous transcript. As
   * on the bridge, the client's plan of Task* entries is cleared before a
   * follow-up prompt can republish stale tasks, and the title and the idle
   * compaction start over. The fresh context of an approved plan sends no
   * empty Task* plan, as the bridge's fresh query sends none.
   */
  private conversationReset(): void {
    // First, as on the bridge: the subagents of the dropped conversation end.
    this.tasks.conversationReset();
    this.output.taskState.clear();
    if (!this.clearContext.holdsTurn()) this.output.taskPlanChanged();
    this.reports.conversationReset();
    // A fresh context for an approved plan: the plan goes out in it.
    this.clearContext.conversationReset();
  }

  // --- The query's messages ----------------------------------------------

  private async consume(query: Query): Promise<void> {
    try {
      for await (const message of query) {
        if (this.closed) break;
        try {
          await this.handle(message);
        } catch (error) {
          this.connection.logger.error(
            `Session ${this.sessionId}: failed to handle a ${message.type} message`,
            error,
          );
        }
        this.checkBoundary();
      }
      this.ended(undefined);
    } catch (error) {
      this.ended(error);
    }
  }

  /**
   * Claude Code's tool results. A SendMessage result can restore the agent
   * that it resumed from the history: the results go out after the restore
   * (see `SessionTasks.restoreResumed`).
   */
  private toolResultMessage(message: SDKUserMessage): void | Promise<void> {
    const restoring = this.tasks.restoreResumed(this.output, message);
    if (restoring) return restoring.then(() => this.toolResults(message));
    this.toolResults(message);
  }

  private toolResults(message: SDKUserMessage): void {
    if (message.parent_tool_use_id !== null) {
      this.tasks.toolResults(this.output, message);
      return;
    }
    // The rewrite applies to the updates of this message only.
    this.output.rewrite = this.clearContext.toolResults(message);
    try {
      this.tasks.toolResults(this.output, message);
    } finally {
      this.output.rewrite = undefined;
    }
  }

  /**
   * Handles one message. Only a `/mcp` turn's result and a subagent's restore
   * from the history are awaited (see {@link result} and `SessionTasks.restored`).
   */
  private handle(message: SDKMessage): void | Promise<void> {
    if ((message as { type: string }).type === "command_lifecycle") {
      this.lifecycle(message as unknown as CommandLifecycleFrame);
      return;
    }
    // Task events, and a subagent's messages, which go to its session.
    // A subagent that a task restores from the history is read before the next message.
    if (this.tasks.handle(message)) return this.tasks.restored();
    switch (message.type) {
      case "conversation_reset":
        this.conversationReset();
        return;
      case "stream_event":
        if (this.stopped.drops(message)) return;
        if (message.parent_tool_use_id === null) {
          this.outputStarts();
          this.reports.streamEvent(message);
        }
        this.output.streamEvent(message);
        return;
      case "assistant":
        if (message.parent_tool_use_id === null) this.usage.assistant(message.message.model);
        if (this.stopped.drops(message)) return;
        if (message.parent_tool_use_id === null) {
          // Claude Code's sign-in message is not shown (see `TurnReport`).
          if (this.turnReport.assistant(message)) return;
          this.outputStarts();
          this.reports.assistant(message);
        }
        this.output.assistant(message);
        return;
      case "user":
        // With `replay-user-messages`, Claude Code echoes each prompt it takes
        // in. A prompt Claude Code reported `started` for is inserted already.
        if ("isReplay" in message && message.isReplay) {
          if (message.uuid && message.parent_tool_use_id === null) {
            // A message typed in another client of the session, as on the bridge.
            const remote = this.remoteControl.remoteMessage(message);
            if (remote !== undefined) this.output.userMessage(remote, message.uuid);
            this.promptStarted(message.uuid);
          }
          return;
        }
        if (this.stopped.drops(message)) return;
        return this.toolResultMessage(message);
      case "result":
        return this.result(message);
      case "system":
        switch (message.subtype) {
          case "init":
            if (message.capabilities?.includes("msg_lifecycle_v1")) this.lifecycleFrames = true;
            this.elicitations.init(message.capabilities);
            // A fresh init (such as after a reinitialize) can carry another Fast mode state.
            this.fastModeReported(message);
            this.reports.handle(message);
            // Its terminal-bound commands leave the list.
            if (this.commands.init(message)) this.resendCommands();
            return;
          case "status":
            // Each model request starts with one, which lists the prompts it serves.
            if (message.status === "requesting") {
              const prompts = (message as { user_message_uuids?: unknown }).user_message_uuids;
              this.stopped.requesting(Array.isArray(prompts) ? prompts : []);
            }
            this.report(message);
            return;
          case "local_command_output":
            // The output of a local command, such as `/cost`.
            if (this.stopped.drops(message)) return;
            this.output.agentMessage(message.content, message.uuid);
            return;
          case "commands_changed":
            this.send(this.commands.changed(message.commands));
            return;
          case "elicitation_complete":
            this.elicitations.completed(message.elicitation_id);
            return;
          case "model_refusal_fallback": {
            // Claude Code retried a refused turn on the fallback model.
            const fallback = modelRefusalFallback(message);
            this.output.emitV1([
              { sessionId: this.sessionId, update: noticeUpdate(fallback.notice) },
            ]);
            if (fallback.persistent) this.modelSwitched(message.fallback_model);
            return;
          }
          case "model_refusal_no_fallback":
            this.turnReport.refusalWithoutFallback(message);
            return;
          case "permission_denied":
            // A rule, the classifier or the mode denied a tool use before it ran.
            this.tasks.permissionDenied(message);
            return;
          case "session_state_changed":
            if (message.state === "idle") {
              this.claudeCodeIdle();
              this.reports.idle();
            }
            return;
          default:
            this.report(message);
            return;
        }
      default:
        this.report(message);
        return;
    }
  }

  /**
   * The messages that report on the session rather than carry Claude's
   * output (see {@link SessionReports}). Not reported yet: the rest (see
   * docs/v2-native-core.md).
   */
  private report(message: SDKMessage): void {
    if (message.type === "tool_progress") {
      this.output.toolProgress(message);
      return;
    }
    if (message.type === "system" && message.subtype === "memory_recall") {
      this.output.memoryRecall(message);
      return;
    }
    // A compaction runs in a turn: it opens the turn if nothing reported it yet.
    if (
      message.type === "system" &&
      message.subtype === "status" &&
      message.status === "compacting"
    ) {
      this.openTurn(undefined);
    }
    this.reports.handle(message);
  }

  private lifecycle(frame: CommandLifecycleFrame): void {
    this.lifecycleFrames = true;
    const uuid = frame.command_uuid;
    switch (frame.state) {
      case "started":
        this.promptStarted(uuid);
        return;
      case "cancelled":
        if (this.failPrompt(uuid, RequestError.requestCancelled())) return;
        this.stopped.promptEnded(uuid, true);
        // The prompt had started: the interrupt stopped its turn.
        if (uuid === this.turnCommand) this.closeTurn();
        return;
      case "discarded":
      case "refused":
        this.failPrompt(
          uuid,
          RequestError.internalError(
            { lifecycle: frame.state },
            `Claude Code ${frame.state} the prompt before it ran`,
          ),
        );
        return;
      case "completed":
        // Comes after the turn's result. A turn that ended without one ends here.
        this.stopped.promptEnded(uuid);
        if (uuid === this.turnCommand) this.closeTurn();
        return;
      default:
        // `queued`: the prompt waits in Claude Code's queue.
        return;
    }
  }

  /**
   * Claude Code took in the prompt `uuid`: its `started` frame or its echo.
   * The prompt's `user_message` comes before the turn's `running`, as on the
   * bridge. v2 allows either order. A prompt that a cancel abandoned starts
   * nothing (see {@link StoppedWork}).
   */
  private promptStarted(uuid: string): void {
    if (this.stopped.promptStarted(uuid, this.foreground)) return;
    // Claude Code takes its prompts in order: the work that a cancel stopped
    // has ended, also when the cancel came while it ran nothing.
    this.tasks.foregroundCancelEnded();
    this.clearContext.promptStarted(uuid);
    this.inserted(uuid);
    this.openTurn(uuid);
  }

  private inserted(uuid: string): void {
    const prompt = this.pending.get(uuid);
    if (!prompt) return;
    this.pending.delete(uuid);
    this.send({ sessionUpdate: "user_message", messageId: uuid, content: prompt.prompt });
    prompt.resolve({ messageId: uuid });
  }

  /**
   * Output of the main conversation while no turn is open starts a cycle
   * that Claude Code started on its own. Without lifecycle frames, a pushed
   * prompt's output can come before its echo, so output while one waits is
   * that prompt's, and its echo opens the turn, as on the bridge.
   */
  private outputStarts(): void {
    if (this.foreground) return;
    if (!this.lifecycleFrames && [...this.pending.values()].some((prompt) => prompt.pushed)) {
      return;
    }
    this.openTurn(undefined);
  }

  private result(message: SDKResultMessage): void | Promise<void> {
    // Every result moves the usage reading on, also one that ends nothing.
    const end = this.usage.record(message);
    if (isPlaceholderResult(message)) return;
    this.idleOwed = true;
    const { dropped, interrupted } = this.stopped.result(message);
    // Also a dropped result: the cancel's interrupt reached no further.
    this.tasks.foregroundCancelEnded();
    if (dropped) {
      this.turnReport.reset();
      return;
    }
    // The interrupt stopped work that Claude Code had started before the cancel arrived.
    if (interrupted) this.cancelledWork = true;
    // A result with no open turn: a turn that sent nothing before it.
    this.openTurn(undefined);
    // A cycle that Claude Code started on its own leaves its Fast mode state
    // to the next result of a prompt, as on the bridge.
    if (!(message.origin && AUTONOMOUS_RESULT_ORIGINS.has(message.origin.kind))) {
      this.fastModeReported(message);
    }
    this.reports.result(message);
    // The turn goes on in a fresh context (see `ClearContext`).
    if (this.clearContext.holdsResult(message, end)) {
      this.turnReport.reset();
      return;
    }
    this.lastEnd = this.clearContext.turnEnd(end);
    const local = this.turnLocalCommand;
    if (message.stop_reason === "refusal") {
      // The refused message shows nothing: its explanation answers.
      const explanation = this.turnReport.refusalExplanation;
      if (explanation) this.output.agentMessage(explanation, message.uuid);
    } else if (
      message.subtype === "success" &&
      !message.is_error &&
      message.result &&
      !this.output.hasAgentText() &&
      !this.reports.repeats(message.result)
    ) {
      // A local command (such as `/context`) answers with its result alone:
      // no model text streamed for it. A result that only repeats a notice or
      // a compaction of the turn is not shown again.
      if (local && this.query) {
        // The adapter's `/mcp` text replaces Claude Code's. `consume` waits
        // for it, so it goes out before the turn's idle.
        return this.commands
          .replace(this.query, local.command, message.result, local.abort.signal, (error) =>
            this.connection.logger.error(`Session ${this.sessionId}: ${error}`),
          )
          .then((text) => {
            this.output.agentMessage(text, message.uuid);
            this.closeTurn();
          });
      }
      this.output.agentMessage(message.result, message.uuid);
    }
    this.closeTurn();
  }

  /**
   * Claude Code's `idle`. The one that follows a result is that result's, and
   * can come after the next cycle's first output. Any other ends the open
   * turn, such as one that an interrupt stopped before it ran.
   */
  private claudeCodeIdle(): void {
    if (this.idleOwed) {
      this.idleOwed = false;
      return;
    }
    this.stopped.idle();
    this.tasks.foregroundCancelEnded();
    this.closeTurn();
  }

  /** Sends the commands again, without failing the message that changed them. */
  private resendCommands(): void {
    this.sendCommands().catch((error) => {
      this.connection.logger.error(`Session ${this.sessionId}: failed to send its commands`, error);
    });
  }

  /** The query ended, with `error` when it failed. The session cannot go on. */
  private ended(error: unknown): void {
    this.endReports();
    if (this.closing || this.closed) {
      this.tasks.queryEnded(undefined);
      this.failPending(RequestError.requestCancelled());
      this.closed = true;
      return;
    }
    const failure = RequestError.internalError(
      error instanceof Error ? { cause: error.message } : undefined,
      "Claude Code stopped. Resume the session to continue.",
    );
    this.failPending(failure);
    this.connection.logger.error(`Session ${this.sessionId}: the query ended`, error);
    this.tasks.queryEnded({ code: failure.code, message: failure.message });
    if (this.foreground) {
      // Cancelled work that ended with the query was still cancelled.
      if (this.cancelledWork) this.output.closeUnfinished(true);
      else this.output.finishUnfinished("failed");
      this.foreground = false;
      this.reportedState = "idle";
      this.send({
        sessionUpdate: "state_update",
        state: "idle",
        ...(this.cancelledWork
          ? idleOutcome(undefined, true, undefined, this.turnCommand !== undefined)
          : {
              stopReason: "error" as const,
              error: { code: failure.code, message: failure.message },
            }),
      });
    }
    this.closed = true;
    this.checkBoundary();
    this.connection.ended(this);
  }

  /** The session ends: its idle compaction is off, and its own `/compact` settles. */
  private endReports(): void {
    this.reports.dispose();
    this.ownCommandDone?.();
    this.ownCommandDone = undefined;
  }

  // --- State ---------------------------------------------------------------

  /**
   * Opens a turn, if none is open. `command` is the prompt that started it,
   * if one did.
   */
  private openTurn(command: string | undefined): void {
    if (command !== undefined) {
      this.turnCommand = command;
      const local = this.localCommands.get(command);
      this.localCommands.delete(command);
      if (local) this.turnLocalCommand = { command: local, abort: new AbortController() };
    }
    if (this.foreground) return;
    this.foreground = true;
    this.lastEnd = undefined;
    this.output.resetAgentText();
    this.reports.turnStarted();
    this.reportState();
  }

  /**
   * Ends the open turn: its idle goes out with the turn's outcome. A turn
   * that waits for its plan's prompt in a fresh context goes on: its end is
   * that prompt's.
   */
  private closeTurn(): void {
    if (!this.foreground || this.clearContext.holdsTurn()) return;
    // v2 asks for a final status of the turn's tool calls before its idle. A
    // tool call whose task goes on in the background is not part of the work.
    const cancelled = idleOutcome(this.lastEnd, this.cancelledWork).stopReason === "cancelled";
    this.output.closeUnfinished(cancelled, this.tasks.backgroundCalls(this.sessionId));
    if (cancelled) {
      // v2 asks to stop waiting for the stopped work's requests. Claude Code's
      // interrupt withdraws them, and this withdraws what it left open.
      for (const request of this.requests) {
        if (request.coveredByCancel) request.abort.abort();
      }
    }
    this.reports.turnEnded();
    this.elicitations.turnEnded();
    this.foreground = false;
    this.reportState();
    this.cancelledWork = false;
    this.output.cancelled = false;
    this.lastEnd = undefined;
    this.turnCommand = undefined;
    this.turnReport.reset();
    const ownCommandDone = this.ownCommandDone;
    this.ownCommandDone = undefined;
    ownCommandDone?.();
    this.turnLocalCommand = undefined;
    this.checkBoundary();
  }

  /**
   * While the turn waits on subagents, it is blocked when each of them is
   * (see `SessionTasks.foregroundBlocked`). Otherwise by the session's own
   * open requests.
   */
  private foregroundState(): ForegroundState {
    if (!this.foreground) return "idle";
    const blocked = this.tasks.foregroundBlocked() ?? this.requests.size > 0;
    return blocked ? "requires_action" : "running";
  }

  /**
   * Reports the foreground state when it changed. `withdrawnByCancel`: the
   * change is the end of a request that a cancel withdrew, so the work is
   * stopping and its idle follows: no `running` goes out for it.
   */
  private reportState(withdrawnByCancel = false): void {
    if (this.closed) return;
    const state = this.foregroundState();
    if (state === this.reportedState) return;
    // The client keeps `requires_action`: the next report sends `running`
    // if the work goes on after all, such as when the interrupt fails.
    if (withdrawnByCancel && state === "running") return;
    this.reportedState = state;
    const update = this.stateUpdate(state);
    this.send(update);
    const error = (update as { error?: { code?: unknown } }).error;
    if (state === "idle" && error?.code === RequestError.authRequired().code) {
      this.connection.signedOut(this.sessionId);
    }
  }

  private stateUpdate(state: ForegroundState): v2.SessionUpdate {
    switch (state) {
      case "running":
        return { sessionUpdate: "state_update", state };
      case "requires_action":
        return { sessionUpdate: "state_update", state };
      default:
        return {
          sessionUpdate: "state_update",
          state,
          ...idleOutcome(
            this.lastEnd,
            this.cancelledWork,
            this.turnReport,
            this.turnCommand !== undefined,
          ),
        };
    }
  }

  private send(update: v2.SessionUpdate): void {
    this.sendNotification({ sessionId: this.sessionId, update });
  }

  /** Sends an update of the session or of a child, with its `background` list. */
  private sendNotification(notification: v2.UpdateSessionNotification): void {
    if (this.closed) return;
    this.connection.send(this.background.stamp(notification));
  }

  /** Fails the prompt `uuid` if it is not answered yet. Returns whether it was pending. */
  private failPrompt(uuid: string, error: unknown): boolean {
    const prompt = this.pending.get(uuid);
    if (!prompt) return false;
    this.pending.delete(uuid);
    this.localCommands.delete(uuid);
    prompt.reject(error);
    this.checkBoundary();
    return true;
  }

  private failPending(error: unknown): void {
    for (const uuid of [...this.pending.keys()]) this.failPrompt(uuid, error);
  }
}

/**
 * Sends a request to the client unless `signal` aborted already. The ACP SDK
 * would send it anyway, then withdraw it with `$/cancel_request`.
 */
function unlessWithdrawn<T>(signal: AbortSignal, send: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("The request was withdrawn"));
  return send();
}
