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
 *   `started` frame or the turn's `system/init` (a turn that Claude Code
 *   starts on its own, such as after a background task ends), and ends with
 *   the turn's `result`, whose stop reason and usage the idle carries.
 *   Claude Code's own `session_state_changed` stays `running` while
 *   background subagents work, which v2 lists as background work instead
 *   (`background`), so it only ends a turn that ended without a result.
 * - `requires_action` is this session's own: a turn is open, and a
 *   permission request of this session is open, or of a subagent that the
 *   turn waits on.
 * - Subagents are child sessions, and background work is listed on every
 *   state (see {@link SessionTasks}).
 * - `session/cancel` is Claude Code's interrupt with `cancelQueued`, which
 *   also ends the prompts that are not inserted yet, as v2 asks: each gets a
 *   `cancelled` lifecycle frame. With `perTaskStopAffordance`, the interrupt
 *   spares background tasks.
 *
 * Output goes out as it comes, whatever prompt it belongs to (see
 * {@link SessionOutput}).
 */
import { randomUUID } from "node:crypto";
import {
  RequestError,
  type AvailableCommand,
  type PromptRequest,
} from "@agentclientprotocol/sdk/unstable";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {
  PermissionMode,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { isLoginRequiredText, promptToClaude, type Logger } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import { v1PromptRequest } from "../v2/prompt.js";
import { V2Background } from "../v2/background.js";
import type { V2UpdateTranslator } from "../v2/update-translator.js";
import { MODEL_CONFIG_ID } from "../session-model.js";
import type { SessionConfig } from "./config.js";
import { SessionReports } from "./reports.js";
import { SessionOutput } from "./stream.js";
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
  /** The session's query ended on its own: the session is no longer active. */
  ended(sessionId: string): void;
}

type PendingPrompt = {
  prompt: v2.ContentBlock[];
  /** Whether the prompt went to Claude Code (see {@link NativeSession.prompt}). */
  pushed: boolean;
  resolve: (response: v2.PromptResponse) => void;
  reject: (error: unknown) => void;
};

type ForegroundState = "idle" | "running" | "requires_action";

/** The `command_lifecycle` frame of a uuid-stamped prompt. It is not part of the SDK's types. */
type CommandLifecycleFrame = { type: "command_lifecycle"; command_uuid: string; state: string };

/** How long `session/close` waits for the cancelled work to end before it ends the query. */
const CLOSE_TIMEOUT_MS = 5000;

export class NativeSession implements RequestTarget {
  /** The prompts not inserted yet, by uuid. */
  private readonly pending = new Map<string, PendingPrompt>();
  /** Whether a turn of Claude Code is open: the session's foreground work. */
  private foreground = false;
  /** The prompt whose `started` frame came last in the open turn. */
  private turnCommand: string | undefined;
  /** The state the client was told last. */
  private reportedState: ForegroundState = "idle";
  private openRequests = 0;
  /** The open permission requests, aborted by `session/cancel`. */
  private readonly requestAborts = new Set<AbortController>();
  /** Whether `session/cancel` stops the open turn: its idle reports `cancelled`. */
  private cancelledWork = false;
  /**
   * The pushed prompts that a `session/cancel` covered, which Claude Code had
   * not reported on yet. Its interrupt ends them, or the turn they start.
   */
  private readonly cancelCovered = new Set<string>();
  /** The interrupt of the last `session/cancel`, while it runs. */
  private interrupting: Promise<void> | undefined;
  /** Pushes prompts in the order they came (see {@link prompt}). */
  private pushes: Promise<void> = Promise.resolve();
  /** The result of the open turn. */
  private lastResult: SDKResultMessage | undefined;
  /** Set by `session/close`, or when the query ends: nothing more goes out. */
  private closed = false;
  private closing: Promise<void> | undefined;
  /** Called when the cancelled work and the covered prompts have ended. */
  private settledWaiters: Array<() => void> = [];
  private query: Query | undefined;
  readonly output: SessionOutput;
  /** Usage, quota, notices, compactions and the title (see {@link SessionReports}). */
  readonly reports: SessionReports;
  /** Resolves the adapter's own `/compact` once a turn ends (see {@link compact}). */
  private ownCommandDone: (() => void) | undefined;
  /** The `background` lists of the session and its children, stamped on each state. */
  private readonly background: V2Background;
  readonly tasks: SessionTasks;
  config!: SessionConfig;

  constructor(
    readonly sessionId: string,
    readonly cwd: string,
    /** The session's additional directories, as its query got them. */
    readonly additionalDirectories: readonly string[],
    private readonly connection: SessionConnection,
    private readonly input: Pushable<SDKUserMessage>,
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
      isBusy: () => this.foreground || this.pending.size > 0 || this.openRequests > 0,
      compact: () => this.compact(),
      titledSession: () => (this.query && !this.closed ? titled : undefined),
    });
    this.output.onAgentText = (content) => this.reports.agentText(content);
    this.background = new V2Background(connection.translator.terminals);
    this.tasks = new SessionTasks(
      {
        sessionId,
        cwd,
        logger: connection.logger,
        translator: connection.translator,
        background: this.background,
        send: (notification) => this.sendNotification(notification),
        rootState: () => this.foregroundState(),
        foregroundRequestsChanged: () => this.reportState(),
        stopTask: async (taskId) => {
          await this.query?.stopTask(taskId);
        },
      },
      this.output,
    );
    this.tasks.hostRequest = (request, signal) => connection.requestPermission(request, signal);
    // The session reports its background work: every state carries a list.
    this.background.changed({ sessionId, items: [], state: undefined });
  }

  /** Starts reading the query. Called once, after its initialization. */
  start(query: Query, config: SessionConfig): void {
    this.query = query;
    this.config = config;
    void this.consume(query);
  }

  /** The session's commands, from Claude Code, in v1 form. */
  async commands(): Promise<AvailableCommand[]> {
    if (!this.query) return [];
    const commands = await this.query.supportedCommands();
    return commands.map((command) => ({
      name: command.name,
      description: command.description,
      ...(command.argumentHint ? { input: { hint: command.argumentHint } } : {}),
    }));
  }

  /**
   * What `session/resume` sends before its response: the children with their
   * current states, the current update of each listed item, then the
   * session's state, with its list.
   */
  resumeSnapshot(): v2.UpdateSessionNotification[] {
    return [
      ...this.tasks.currentState(),
      this.background.stamp({
        sessionId: this.sessionId,
        update: this.stateUpdate(this.foregroundState()),
      }),
    ];
  }

  /** Replaces the session's MCP servers, as a resume of the active session asks. */
  async setMcpServers(servers: Parameters<Query["setMcpServers"]>[0]): Promise<void> {
    await this.query?.setMcpServers(servers);
    this.reports.mcpServersChanged(Object.keys(servers));
  }

  // --- Requests ---------------------------------------------------------

  /**
   * Pushes the prompt to Claude Code. Answers once Claude Code inserted it
   * (see the module doc), right after the prompt's `user_message`.
   *
   * A prompt waits for the interrupt of an earlier `session/cancel` before it
   * goes to Claude Code: the interrupt's `cancelQueued` must not end a prompt
   * that came after the cancel.
   */
  prompt(params: v2.PromptRequest): Promise<v2.PromptResponse> {
    if (this.closed) {
      return Promise.reject(RequestError.sessionNotFound(this.sessionId));
    }
    // Throws invalid params for content that Claude cannot take.
    const request: PromptRequest = v1PromptRequest(params);
    this.reports.promptSent(request.prompt);
    const uuid = randomUUID();
    const message = { ...promptToClaude(request), uuid };
    return new Promise((resolve, reject) => {
      const pending: PendingPrompt = { prompt: params.prompt, pushed: false, resolve, reject };
      this.pending.set(uuid, pending);
      this.pushes = this.pushes
        .then(() => this.interrupting)
        .then(() => {
          // A cancel or close answered it before it went out.
          if (this.pending.get(uuid) !== pending || this.closed) return;
          pending.pushed = true;
          this.input.push(message);
          this.reports.promptQueued(request.prompt);
        });
    });
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
          if (this.closed) resolve();
          else this.input.push(message);
        });
    });
  }

  /**
   * Stops the foreground work, and the prompts not inserted yet. The work's
   * idle reports `cancelled`. Open permission requests are withdrawn with
   * `$/cancel_request`. Background work goes on.
   */
  async cancel(): Promise<void> {
    if (this.closed || !this.query) return;
    this.reports.disarmIdleCompaction("cancel");
    // Not pushed yet: no one but this session knows of them.
    for (const [uuid, prompt] of [...this.pending]) {
      if (!prompt.pushed) this.failPrompt(uuid, RequestError.requestCancelled());
    }
    const covered = [...this.pending.keys()];
    // With no turn open, the interrupt still goes out, as on the bridge: it
    // stops a turn that Claude Code started but did not report yet. Over an
    // idle query, Claude Code only reports `idle` again.
    if (this.foreground) this.cancelledWork = true;
    for (const uuid of covered) this.cancelCovered.add(uuid);
    for (const abort of this.requestAborts) abort.abort();
    // The subagents that the work waits on stop with it. Background ones go on.
    this.tasks.cancelForeground();
    // `cancelQueued` is untyped in the SDK (`Query.interrupt` takes it since
    // the CLI's `interrupt_cancel_queued_v1`): Claude Code then ends each
    // queued prompt with a `cancelled` lifecycle frame, which fails it here.
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
        this.cancelCovered.clear();
      },
    );
    this.interrupting = done;
    await done;
    if (this.interrupting === done) this.interrupting = undefined;
  }

  async setConfigOption(
    configId: string,
    type: string | undefined,
    value: unknown,
  ): Promise<v2.SessionConfigOption[]> {
    await this.config.set(configId, type, value);
    if (configId === MODEL_CONFIG_ID) this.reports.disarmIdleCompaction("model change");
    const options = this.config.options();
    // v2 sends every config change as an update too, for the session's other clients.
    this.send({ sessionUpdate: "config_option_update", configOptions: options });
    return options;
  }

  /**
   * Cancels as `session/cancel` does, waits for the cancelled work's idle and
   * for the covered prompts' answers, then ends the query, which stops the
   * background work too. Nothing of the session goes out after it resolves.
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.cancel();
      // v2 asks to withdraw every request of the session before the close
      // response, also its background subagents'.
      this.tasks.withdrawAll();
      await this.settled(CLOSE_TIMEOUT_MS);
      // Claude Code did not end the work in time: it ends with the query.
      if (this.foreground) {
        this.cancelledWork = true;
        this.closeTurn();
      }
      this.failPending(RequestError.requestCancelled());
      this.closed = true;
      this.endReports();
      this.input.end();
      this.query?.close();
    })();
    return this.closing;
  }

  // --- Permission requests -----------------------------------------------

  availableModes(): string[] {
    return this.config.availableModeIds();
  }

  cancelling(): boolean {
    return this.cancelledWork;
  }

  /** The session of a permission request: this one, or a subagent's (see `canUseTool`). */
  target(agentId: string | undefined): Promise<RequestTarget> {
    return this.tasks.target(agentId, this);
  }

  async requestPermission(
    request: v2.RequestPermissionRequest,
    toolSignal: AbortSignal,
  ): Promise<v2.RequestPermissionResponse> {
    const abort = new AbortController();
    const signal = AbortSignal.any([toolSignal, abort.signal]);
    this.requestAborts.add(abort);
    this.openRequests++;
    this.reportState();
    try {
      // The subject is an upsert of the tool call: the client may see the
      // request before the tool use streams.
      return await this.connection.requestPermission(request, signal);
    } catch (error) {
      if (signal.aborted) return { outcome: { outcome: "cancelled" } };
      throw error;
    } finally {
      this.requestAborts.delete(abort);
      this.openRequests--;
      this.reportState();
    }
  }

  modeChanged(mode: PermissionMode): void {
    if (this.config.modeChanged(mode)) {
      this.send({ sessionUpdate: "config_option_update", configOptions: this.config.options() });
    }
  }

  // --- The query's messages ----------------------------------------------

  private async consume(query: Query): Promise<void> {
    try {
      for await (const message of query) {
        if (this.closed) break;
        try {
          this.handle(message);
        } catch (error) {
          this.connection.logger.error(
            `Session ${this.sessionId}: failed to handle a ${message.type} message`,
            error,
          );
        }
        this.checkSettled();
      }
      this.ended(undefined);
    } catch (error) {
      this.ended(error);
    }
  }

  private handle(message: SDKMessage): void {
    if ((message as { type: string }).type === "command_lifecycle") {
      this.lifecycle(message as unknown as CommandLifecycleFrame);
      return;
    }
    // Task events, and a subagent's messages, which go to its session.
    if (this.tasks.handle(message)) return;
    switch (message.type) {
      case "stream_event":
        if (message.parent_tool_use_id === null) {
          this.openTurn(undefined);
          this.reports.streamEvent(message);
        }
        this.output.streamEvent(message);
        return;
      case "assistant":
        if (message.parent_tool_use_id === null) {
          this.openTurn(undefined);
          this.reports.assistant(message);
        }
        this.output.assistant(message);
        return;
      case "user":
        // With `replay-user-messages`, Claude Code echoes each prompt it takes
        // in. A prompt Claude Code reported `started` for is inserted already.
        if ("isReplay" in message && message.isReplay) {
          if (message.uuid && message.parent_tool_use_id === null) {
            this.inserted(message.uuid);
            this.openTurn(message.uuid);
          }
          return;
        }
        this.tasks.toolResults(this.output, message);
        return;
      case "result":
        this.result(message);
        return;
      case "system":
        switch (message.subtype) {
          case "init":
            // Each turn starts with one, also a turn that no prompt started.
            this.openTurn(undefined);
            this.reports.handle(message);
            return;
          case "session_state_changed":
            // The turn's `result` ends it. An idle without one ends it too,
            // such as a turn that an interrupt stopped before it ran.
            if (message.state === "idle") {
              this.closeTurn();
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
    const uuid = frame.command_uuid;
    switch (frame.state) {
      case "started":
        // The prompt's `user_message` comes before the turn's `running`, as
        // on the bridge. v2 allows either order.
        this.inserted(uuid);
        this.openTurn(uuid);
        return;
      case "cancelled":
        this.cancelCovered.delete(uuid);
        if (this.failPrompt(uuid, RequestError.requestCancelled())) return;
        // The prompt had started: the interrupt stopped its turn.
        if (uuid === this.turnCommand) this.closeTurn();
        return;
      case "discarded":
      case "refused":
        this.cancelCovered.delete(uuid);
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
        if (uuid === this.turnCommand) this.closeTurn();
        return;
      default:
        // `queued`: the prompt waits in Claude Code's queue.
        return;
    }
  }

  private inserted(uuid: string): void {
    const prompt = this.pending.get(uuid);
    if (!prompt) return;
    this.pending.delete(uuid);
    this.send({ sessionUpdate: "user_message", messageId: uuid, content: prompt.prompt });
    prompt.resolve({ messageId: uuid });
  }

  private result(message: SDKResultMessage): void {
    // A result with no open turn: a turn that sent nothing before it.
    this.openTurn(undefined);
    this.lastResult = message;
    this.reports.result(message);
    // A local command (such as `/context`) answers with its result alone: no
    // model text streamed for it. A result that only repeats a notice or a
    // compaction of the turn is not shown again.
    if (
      message.subtype === "success" &&
      !message.is_error &&
      message.result &&
      !this.output.hasAgentText() &&
      !this.reports.repeats(message.result)
    ) {
      this.output.agentMessage(message.result, message.uuid);
    }
    this.closeTurn();
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
      this.output.finishUnfinished(this.cancelledWork ? "cancelled" : "failed");
      this.foreground = false;
      this.reportedState = "idle";
      this.send({
        sessionUpdate: "state_update",
        state: "idle",
        ...(this.cancelledWork
          ? { stopReason: "cancelled" as const }
          : {
              stopReason: "error" as const,
              error: { code: failure.code, message: failure.message },
            }),
      });
    }
    this.closed = true;
    this.connection.ended(this.sessionId);
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
   * if one did. A prompt that a cancel covered starts work that the cancel's
   * interrupt stops.
   */
  private openTurn(command: string | undefined): void {
    if (command !== undefined) {
      this.turnCommand = command;
      if (this.cancelCovered.delete(command)) this.cancelledWork = true;
    }
    if (this.foreground) return;
    this.foreground = true;
    this.lastResult = undefined;
    this.output.resetAgentText();
    this.reports.turnStarted();
    this.reportState();
  }

  /** Ends the open turn: its idle goes out with the turn's outcome. */
  private closeTurn(): void {
    if (!this.foreground) return;
    // v2 asks for a final status of the tool calls of stopped work before its idle.
    const outcome = idleOutcome(this.lastResult, this.cancelledWork).stopReason;
    if (outcome === "cancelled" || outcome === "error") {
      this.output.finishUnfinished(outcome === "cancelled" ? "cancelled" : "failed");
    }
    this.reports.turnEnded();
    this.foreground = false;
    this.reportState();
    this.cancelledWork = false;
    this.lastResult = undefined;
    this.turnCommand = undefined;
    const ownCommandDone = this.ownCommandDone;
    this.ownCommandDone = undefined;
    ownCommandDone?.();
  }

  private foregroundState(): ForegroundState {
    if (!this.foreground) return "idle";
    return this.openRequests > 0 || this.tasks.foregroundBlocked() ? "requires_action" : "running";
  }

  /** Reports the foreground state when it changed. */
  private reportState(): void {
    if (this.closed) return;
    const state = this.foregroundState();
    if (state === this.reportedState) return;
    // A cancel withdrew the open requests: the work is stopping, and its idle follows.
    if (this.reportedState === "requires_action" && state === "running" && this.cancelledWork) {
      return;
    }
    this.reportedState = state;
    this.send(this.stateUpdate(state));
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
          ...idleOutcome(this.lastResult, this.cancelledWork),
          // The result's `_meta.quota`, as the bridge sends it.
          ...this.reports.idleMeta(this.lastResult),
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

  /** Resolves once no turn is open and every prompt is answered, or after `timeoutMs`. */
  private settled(timeoutMs: number): Promise<void> {
    if (!this.foreground && this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.settledWaiters.push(done);
    });
  }

  private checkSettled(): void {
    if (this.foreground || this.pending.size > 0) return;
    const waiters = this.settledWaiters;
    this.settledWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /** Fails the prompt `uuid` if it is not answered yet. Returns whether it was pending. */
  private failPrompt(uuid: string, error: unknown): boolean {
    const prompt = this.pending.get(uuid);
    if (!prompt) return false;
    this.pending.delete(uuid);
    prompt.reject(error);
    return true;
  }

  private failPending(error: unknown): void {
    for (const uuid of [...this.pending.keys()]) this.failPrompt(uuid, error);
  }
}

/**
 * The idle members this core reports. Typed as those members, so the checker
 * matches each stop reason to its own, which it cannot against the whole
 * union with its custom and unknown members.
 */
type IdleOutcome = Extract<
  v2.IdleStateUpdate,
  {
    stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | "error";
  }
>;

/** The stop reason, usage and error of an idle, from the turn's result. */
function idleOutcome(result: SDKResultMessage | undefined, cancelled: boolean): IdleOutcome {
  const usage = usageOf(result);
  if (cancelled) return { stopReason: "cancelled", ...usage };
  if (!result) return { stopReason: "end_turn" };
  if (result.subtype === "error_max_turns") return { stopReason: "max_turn_requests", ...usage };
  if (result.stop_reason === "max_tokens") return { stopReason: "max_tokens", ...usage };
  if (result.stop_reason === "refusal") return { stopReason: "refusal", ...usage };
  if (result.subtype !== "success" || result.is_error) {
    const text = result.subtype === "success" ? result.result : result.errors.join("\n");
    const error =
      result.subtype === "success" && isLoginRequiredText(text)
        ? RequestError.authRequired()
        : RequestError.internalError(undefined, text || `Claude Code ended with ${result.subtype}`);
    return { stopReason: "error", error: { code: error.code, message: error.message }, ...usage };
  }
  return { stopReason: "end_turn", ...usage };
}

function usageOf(result: SDKResultMessage | undefined): { usage?: v2.Usage } {
  if (!result) return {};
  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } =
    result.usage;
  const inputTokens = input_tokens ?? 0;
  const outputTokens = output_tokens ?? 0;
  const cachedReadTokens = cache_read_input_tokens ?? 0;
  const cachedWriteTokens = cache_creation_input_tokens ?? 0;
  return {
    usage: {
      inputTokens,
      outputTokens,
      cachedReadTokens,
      cachedWriteTokens,
      totalTokens: inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens,
    },
  };
}
