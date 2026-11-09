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
 *   permission request of this session is open, or of a subagent that the
 *   turn waits on.
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
import { promptToClaude, type Logger } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import { v1PromptRequest } from "../v2/prompt.js";
import { V2Background } from "../v2/background.js";
import type { V2UpdateTranslator } from "../v2/update-translator.js";
import type { SessionConfig } from "./config.js";
import { idleOutcome, isPlaceholderResult, ResultUsage, type TurnEnd } from "./outcome.js";
import { StoppedWork } from "./stopped-work.js";
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

/** An open permission request of the session. */
type OpenRequest = {
  /** Withdraws the request, with `$/cancel_request`. */
  abort: AbortController;
  /** Whether a cancel came while it was open: its work is being stopped. */
  coveredByCancel: boolean;
};

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
  /** The open permission requests of the session. */
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
  /** The explanation of the open turn's refusal, from its refused assistant message. */
  private refusalExplanation: string | undefined;
  /** Set by `session/close`, or when the query ends: nothing more goes out. */
  private closed = false;
  private closing: Promise<void> | undefined;
  private query: Query | undefined;
  readonly output: SessionOutput;
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
        // A cancel withdraws the requests of the subagents that the work waits on.
        foregroundRequestsChanged: () => this.reportState(this.cancelledWork),
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
  start(query: Query, config: SessionConfig, resumed = false): void {
    this.query = query;
    this.config = config;
    this.usage = new ResultUsage(resumed);
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
        });
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
    this.stopped.cancelled(pushed, this.foreground);
    if (this.foreground) {
      this.cancelledWork = true;
      this.output.cancelled = true;
    }
    for (const request of this.requests) request.coveredByCancel = true;
    // The subagents that the work waits on stop with it. Background ones go on.
    this.tasks.cancelForeground();
  }

  async setConfigOption(
    configId: string,
    type: string | undefined,
    value: unknown,
  ): Promise<v2.SessionConfigOption[]> {
    await this.config.set(configId, type, value);
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
      // response, also its background subagents'.
      this.tasks.withdrawAll();
      for (const request of this.requests) {
        request.coveredByCancel = true;
        request.abort.abort();
      }
      this.closeTurn();
      this.failPending(RequestError.requestCancelled());
      this.closed = true;
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

  async requestPermission(
    request: v2.RequestPermissionRequest,
    toolSignal: AbortSignal,
  ): Promise<v2.RequestPermissionResponse> {
    const open: OpenRequest = { abort: new AbortController(), coveredByCancel: false };
    const signal = AbortSignal.any([toolSignal, open.abort.signal]);
    this.requests.add(open);
    this.reportState();
    try {
      // The subject is an upsert of the tool call: the client may see the
      // request before the tool use streams.
      return await this.connection.requestPermission(request, signal);
    } catch (error) {
      if (signal.aborted) return { outcome: { outcome: "cancelled" } };
      throw error;
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
        if (this.stopped.drops(message)) return;
        if (message.parent_tool_use_id === null) this.outputStarts();
        this.output.streamEvent(message);
        return;
      case "assistant":
        if (message.parent_tool_use_id === null) {
          this.usage.assistant(message.message.model);
          if (message.message.stop_reason === "refusal") {
            this.refusalExplanation =
              message.message.stop_details?.explanation ?? this.refusalExplanation;
          }
        }
        if (this.stopped.drops(message)) return;
        if (message.parent_tool_use_id === null) this.outputStarts();
        this.output.assistant(message);
        return;
      case "user":
        // With `replay-user-messages`, Claude Code echoes each prompt it takes
        // in. A prompt Claude Code reported `started` for is inserted already.
        if ("isReplay" in message && message.isReplay) {
          if (message.uuid && message.parent_tool_use_id === null) {
            this.promptStarted(message.uuid);
          }
          return;
        }
        if (this.stopped.drops(message)) return;
        this.tasks.toolResults(this.output, message);
        return;
      case "result":
        this.result(message);
        return;
      case "system":
        switch (message.subtype) {
          case "init":
            if (message.capabilities?.includes("msg_lifecycle_v1")) this.lifecycleFrames = true;
            return;
          case "status":
            // Each model request starts with one, which lists the prompts it serves.
            if (message.status === "requesting") {
              const prompts = (message as { user_message_uuids?: unknown }).user_message_uuids;
              this.stopped.requesting(Array.isArray(prompts) ? prompts : []);
            }
            return;
          case "local_command_output":
            // The output of a local command, such as `/cost`.
            if (this.stopped.drops(message)) return;
            this.output.agentMessage(message.content, message.uuid);
            return;
          case "session_state_changed":
            if (message.state === "idle") this.claudeCodeIdle();
            return;
          default:
            return;
        }
      default:
        // Not reported yet: tool progress, background tasks, compaction,
        // rate limits, notices and the rest (see docs/v2-native-core.md).
        return;
    }
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
        this.stopped.promptEnded(uuid);
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

  private result(message: SDKResultMessage): void {
    // Every result moves the usage reading on, also one that ends nothing.
    const end = this.usage.record(message);
    if (isPlaceholderResult(message)) return;
    this.idleOwed = true;
    const { dropped, interrupted } = this.stopped.result(message);
    if (dropped) return;
    // The interrupt stopped work that Claude Code had started before the cancel arrived.
    if (interrupted) this.cancelledWork = true;
    // A result with no open turn: a turn that sent nothing before it.
    this.openTurn(undefined);
    this.lastEnd = end;
    if (message.stop_reason === "refusal") {
      // The refused message shows nothing: its explanation answers.
      if (this.refusalExplanation) {
        this.output.agentMessage(this.refusalExplanation, message.uuid);
      }
    } else if (
      message.subtype === "success" &&
      !message.is_error &&
      message.result &&
      !this.output.hasAgentText()
    ) {
      // A local command (such as `/context`) answers with its result alone:
      // no model text streamed for it.
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
    this.closeTurn();
  }

  /** The query ended, with `error` when it failed. The session cannot go on. */
  private ended(error: unknown): void {
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

  // --- State ---------------------------------------------------------------

  /**
   * Opens a turn, if none is open. `command` is the prompt that started it,
   * if one did.
   */
  private openTurn(command: string | undefined): void {
    if (command !== undefined) this.turnCommand = command;
    if (this.foreground) return;
    this.foreground = true;
    this.lastEnd = undefined;
    this.output.resetAgentText();
    this.reportState();
  }

  /** Ends the open turn: its idle goes out with the turn's outcome. */
  private closeTurn(): void {
    if (!this.foreground) return;
    // v2 asks for a final status of the turn's tool calls before its idle.
    const cancelled = idleOutcome(this.lastEnd, this.cancelledWork).stopReason === "cancelled";
    this.output.closeUnfinished(cancelled);
    if (cancelled) {
      // v2 asks to stop waiting for the stopped work's requests. Claude Code's
      // interrupt withdraws them, and this withdraws what it left open.
      for (const request of this.requests) {
        if (request.coveredByCancel) request.abort.abort();
      }
    }
    this.foreground = false;
    this.reportState();
    this.cancelledWork = false;
    this.output.cancelled = false;
    this.lastEnd = undefined;
    this.turnCommand = undefined;
    this.refusalExplanation = undefined;
  }

  private foregroundState(): ForegroundState {
    if (!this.foreground) return "idle";
    return this.requests.size > 0 || this.tasks.foregroundBlocked() ? "requires_action" : "running";
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
    const silent = withdrawnByCancel && state === "running";
    this.reportedState = state;
    if (!silent) this.send(this.stateUpdate(state));
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
          ...idleOutcome(this.lastEnd, this.cancelledWork),
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
    prompt.reject(error);
    return true;
  }

  private failPending(error: unknown): void {
    for (const uuid of [...this.pending.keys()]) this.failPrompt(uuid, error);
  }
}
