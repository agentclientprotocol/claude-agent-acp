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
import { RequestError, type PromptRequest } from "@agentclientprotocol/sdk/unstable";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {
  PermissionMode,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { promptToClaude, type Logger } from "../acp-agent.js";
import type { McpCommand } from "../mcp-command.js";
import { Pushable } from "../utils.js";
import { v1PromptRequest } from "../v2/prompt.js";
import { V2Background } from "../v2/background.js";
import type { V2UpdateTranslator } from "../v2/update-translator.js";
import { MODEL_CONFIG_ID } from "../session-model.js";
import { SessionCommands } from "./commands.js";
import type { SessionConfig } from "./config.js";
import { idleOutcome, isPlaceholderResult, ResultUsage, type TurnEnd } from "./outcome.js";
import { StoppedWork } from "./stopped-work.js";
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
  /** Usage, quota, notices, compactions and the title (see {@link SessionReports}). */
  readonly reports: SessionReports;
  /** Resolves the adapter's own `/compact` once a turn ends (see {@link compact}). */
  private ownCommandDone: (() => void) | undefined;
  /** The `background` lists of the session and its children, stamped on each state. */
  private readonly background: V2Background;
  readonly tasks: SessionTasks;
  config!: SessionConfig;
  commands!: SessionCommands;
  /** The `/mcp` prompts not inserted yet, by uuid, and the open turn's (see `SessionCommands`). */
  private readonly localCommands = new Map<string, McpCommand>();
  private turnLocalCommand: { command: McpCommand; abort: AbortController } | undefined;
  /** The JSON of the query's MCP servers. */
  private mcpServers = "";

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
      isBusy: () => this.foreground || this.pending.size > 0 || this.requests.size > 0,
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
   * What `session/resume` sends before its response: the children with their
   * current states, the current update of each listed item, then the
   * session's state, with its list. An idle snapshot reports no completion,
   * so it carries no stop reason, as on the bridge.
   */
  resumeSnapshot(): v2.UpdateSessionNotification[] {
    const state = this.foregroundState();
    return [
      ...this.tasks.currentState(),
      this.background.stamp({
        sessionId: this.sessionId,
        update:
          state === "idle" ? { sessionUpdate: "state_update", state } : this.stateUpdate(state),
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
    const localCommand = this.commands.localCommand(request.prompt);
    if (localCommand) this.localCommands.set(uuid, localCommand);
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
    this.turnLocalCommand?.abort.abort();
    // The subagents that the work waits on stop with it. Background ones go on.
    this.tasks.cancelForeground();
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
          await this.handle(message);
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

  /** Handles one message. Only a `/mcp` turn's result is awaited (see {@link result}). */
  private handle(message: SDKMessage): void | Promise<void> {
    if ((message as { type: string }).type === "command_lifecycle") {
      this.lifecycle(message as unknown as CommandLifecycleFrame);
      return;
    }
    // Task events, and a subagent's messages, which go to its session.
    if (this.tasks.handle(message)) return;
    switch (message.type) {
      case "stream_event":
        if (this.stopped.drops(message)) return;
        if (message.parent_tool_use_id === null) {
          this.outputStarts();
          this.reports.streamEvent(message);
        }
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
        if (message.parent_tool_use_id === null) {
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
            this.promptStarted(message.uuid);
          }
          return;
        }
        if (this.stopped.drops(message)) return;
        this.tasks.toolResults(this.output, message);
        return;
      case "result":
        return this.result(message);
      case "system":
        switch (message.subtype) {
          case "init":
            if (message.capabilities?.includes("msg_lifecycle_v1")) this.lifecycleFrames = true;
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

  private result(message: SDKResultMessage): void | Promise<void> {
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
    this.reports.result(message);
    const local = this.turnLocalCommand;
    if (message.stop_reason === "refusal") {
      // The refused message shows nothing: its explanation answers.
      if (this.refusalExplanation) {
        this.output.agentMessage(this.refusalExplanation, message.uuid);
      }
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
    this.reports.turnEnded();
    this.foreground = false;
    this.reportState();
    this.cancelledWork = false;
    this.output.cancelled = false;
    this.lastEnd = undefined;
    this.turnCommand = undefined;
    this.refusalExplanation = undefined;
    const ownCommandDone = this.ownCommandDone;
    this.ownCommandDone = undefined;
    ownCommandDone?.();
    this.turnLocalCommand = undefined;
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
    this.localCommands.delete(uuid);
    prompt.reject(error);
    return true;
  }

  private failPending(error: unknown): void {
    for (const uuid of [...this.pending.keys()]) this.failPrompt(uuid, error);
  }
}
