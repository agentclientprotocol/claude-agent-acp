import {
  RequestError,
  type SessionConfigOption,
  type SessionNotification,
} from "@agentclientprotocol/sdk/unstable";
import type { AcpSessionNotification, SubagentForm, SubagentState } from "./acp-subagents.js";
import { AIR_SUBAGENT_KEY, airExtensionMeta } from "./air-extension.js";
import { MODEL_CONFIG_ID } from "./session-model.js";
import { isFinalToolCallStatus } from "./tool-calls/renderer.js";

/** The work state of a child, as the RFD's `subagent_update.state` carries it. */
export type WorkState = NonNullable<
  Extract<SessionNotification["update"], { sessionUpdate: "subagent_update" }>["state"]
>;

export type NativeSubagent = {
  sessionId: string;
  parentSessionId: string;
  parentToolUseId?: string;
  name: string;
  task: string;
  /**
   * The exact prompt of this generation, sent as `prompt` in
   * `subagent_spawned`, or as the child's first `session_message` in the RFD
   * form. It is absent when the adapter has no prompt.
   */
  prompt?: string;
  /** The RFD form: the parent's label for the child, `subagent_update.title`. */
  title?: string;
  /** The RFD form: the child's role, its `subagent_type`, for the title. */
  role?: string;
  /** The RFD form: the child's purpose, `subagent_update.description`. */
  description?: string;
  /**
   * The RFD form: the work state the client holds. The child is reusable, so
   * `idle` is not terminal. AIR's draft uses {@link terminalState} instead.
   */
  workState?: WorkState["state"];
  /**
   * The RFD form: the child's idle snapshot reports a failure without the
   * SDK's error text, which a later event of the same failure may carry.
   */
  missingError?: boolean;
  /** The RFD form: the open permission and question requests of the child. */
  openRequests?: number;
  /** The RFD form: how many times the client cancelled the child (see
   *  `NativeSubagentRuntime.cancelChild`). */
  cancels?: number;
  /** The RFD form: the ids of the prompt messages in the child's transcript. */
  promptIds?: Set<string>;
  /** The RFD form: the calls that delegated to the child, whose runs ended. */
  endedRuns?: Set<string>;
  /** The RFD form: the calls that delegated to the child, whose runs handed back a report. */
  handedBack?: Set<string>;
  announced?: boolean;
  terminalState?: SubagentState;
  /** Connection-local single-flight state; never serialized on the wire. */
  announcePromise?: Promise<void>;
  /** Connection-local single-flight state; never serialized on the wire. */
  terminalPromise?: Promise<void>;
};

export type NativeSubagentSession = {
  nativeSubagentsByTaskId?: Map<string, NativeSubagent>;
  nativeSubagentTaskIdByToolUseId?: Map<string, string>;
  nativeSubagentParentByToolUseId?: Map<string, string>;
};

type Publish = (notification: AcpSessionNotification) => Promise<void>;
type Logger = { log(message: string): void };

/** An entry of a session's `model` select option. */
export type ModelEntry = { value: string; name: string };

/**
 * The models of the root session. A child's model is an entry of the root
 * session's `model` option when one matches, so that a client can compare the
 * two sessions' models.
 */
export type SubagentModels = {
  /**
   * The entry of the root session's `model` option for `model`, a model id
   * that a response reported. Undefined when no entry matches.
   */
  entry(model: string): ModelEntry | undefined;
  /** The display name of the model id `model` in the session's model list, if the list has it. */
  name(model: string): string | undefined;
};

type ChildConfiguration = {
  options: Map<string, SessionConfigOption>;
  published?: string;
  publishing: Promise<void>;
};

/** What the SDK says about the end of a task, beyond its status. */
export type TaskEnd = {
  /** The SDK's text for a failure. */
  error?: string;
  /** The SDK's reason for an unusual end, such as `worker_restart`. */
  reason?: string;
  /**
   * The adapter knows that the work ended, but not why: the stream ended, or
   * the conversation was reset, with the task still running.
   */
  unexplained?: boolean;
};

type TaskStarted = {
  taskId: string;
  toolUseId?: string | null;
  subagentType?: unknown;
  description?: unknown;
  prompt?: unknown;
};

type SubagentIdentity = {
  name?: string;
  description?: string;
  prompt?: string;
  subagentType?: string;
};

/** An agent of the session's subagent history, as the runtime restores it. */
export type HistoricalSubagent = {
  agentId: string;
  /** The Agent or Task call that launched it. */
  launchId: string;
  /** The agent that made that call. None means the root session. */
  parentAgentId?: string;
  name?: string;
  agentType?: string;
  description?: string;
};

/**
 * The agent `agentId` and its ancestors, root first, from the session's
 * subagent history; empty when the history cannot place it (see
 * `subagentLineage`).
 */
export type SubagentLineage = (agentId: string) => Promise<readonly HistoricalSubagent[]>;

/**
 * The agent that the Agent or Task call `launchId` launched, from the session's
 * subagent history; undefined when the history has no such call.
 */
export type LaunchedAgent = (launchId: string) => Promise<string | undefined>;

const MAX_PENDING_PARENTS = 64;
const MAX_PENDING_UPDATES = 256;
const MAX_PENDING_UPDATES_PER_PARENT = 32;
/** The number of child tool calls whose owning child session the runtime remembers. */
const MAX_CHILD_TOOL_CALLS = 2048;

/**
 * Owns the connection-local native subagent registry and all ACP lifecycle
 * ordering. The main agent only supplies SDK facts and delivers routed output.
 */
export class NativeSubagentRuntime {
  readonly enabled: boolean;
  /** The form of the child sessions; see {@link SubagentForm}. */
  readonly form: SubagentForm | undefined;

  private readonly children: Map<string, NativeSubagent>;
  private readonly taskByToolUse: Map<string, string>;
  private readonly parentByToolUse: Map<string, string>;
  private readonly identityByToolUse = new Map<string, SubagentIdentity>();
  private readonly controlByToolUse = new Map<string, AcpSessionNotification>();
  private readonly configBySession = new Map<string, ChildConfiguration>();
  private readonly childByParentToolUse = new Map<string, NativeSubagent>();
  /**
   * The child session of each tool call that went to a child session. A later
   * update of that tool call can lose `parentToolUseId`, for example a progress
   * beat after the child finished. It still belongs to the child session.
   */
  private readonly childByToolCall = new Map<string, NativeSubagent>();
  private readonly taskFinishPromises = new Map<string, Promise<void>>();
  /** The session that made each SendMessage call. */
  private readonly senderByToolUse = new Map<string, string>();
  /**
   * The RFD form: the Agent/Task calls that the client is not shown, until
   * their final update. Kept by id because the adapter's own report that
   * closes an unfinished call has no `toolName` to recognize it by.
   */
  private readonly hiddenLaunches = new Map<string, { background: boolean }>();
  /**
   * The RFD form: the SendMessage calls that the client is not shown, until
   * their final update, with their first report and the session that made
   * them. A message that reaches an announced child replaces its call.
   */
  private readonly hiddenSendMessages = new Map<
    string,
    { initial: AcpSessionNotification; sender: string; delivered: boolean }
  >();
  /**
   * The RFD form: the SubagentHandback calls of announced children that the
   * client is not shown yet, with their first report, the report from their
   * input, and the call that delegated the run.
   */
  private readonly handbacks = new Map<
    string,
    { initial: AcpSessionNotification; message?: string; delegationId?: string }
  >();
  private readonly generationByTaskId = new Map<string, number>();
  private readonly pending = new Map<string, AcpSessionNotification[]>();
  private pendingCount = 0;
  /** The AIR form: agents being restored from the history, by agent id. */
  private readonly agentRestores = new Map<string, Promise<void>>();
  /** The AIR form: launch ids being resolved to an agent, by launch id. */
  private readonly launchRestores = new Map<string, Promise<void>>();
  /** The AIR form: launch ids that the history has no restorable agent for. */
  private readonly unresolvedLaunches = new Set<string>();
  /** The AIR form: agents that the history could not place, so it is read once. */
  private readonly unrestorableAgents = new Set<string>();
  /** The latest generation number given to a restored agent. */
  private lastRestoredGeneration = 0;
  /** Bumped when the restore state is dropped; a restore that began before it is void. */
  private restoreEpoch = 0;
  /** The RFD form: how many times the parent was cancelled (see {@link awaitingUser}). */
  private parentCancels = 0;

  /**
   * `form` is undefined for a client without native subagent sessions. The RFD
   * form restores an agent from before a load or resume with `lineage`. The AIR
   * form does too, and `launchedAgent` finds the agent that a launch call made.
   * `models` maps the model of a child response to the root session's entry
   * (see {@link reportModel}).
   */
  constructor(
    form: SubagentForm | undefined,
    private readonly rootSessionId: string,
    private readonly session: NativeSubagentSession,
    private readonly publish: Publish,
    private readonly logger: Logger,
    private readonly lineage?: SubagentLineage,
    private readonly launchedAgent?: LaunchedAgent,
    private readonly models?: SubagentModels,
  ) {
    this.form = form;
    this.enabled = form !== undefined;
    this.children = session.nativeSubagentsByTaskId ??= new Map();
    this.taskByToolUse = session.nativeSubagentTaskIdByToolUseId ??= new Map();
    this.parentByToolUse = session.nativeSubagentParentByToolUseId ??= new Map();
    for (const child of this.children.values()) {
      if (child.parentToolUseId) {
        this.childByParentToolUse.set(child.parentToolUseId, child);
      }
    }
  }

  async route(
    notification: AcpSessionNotification,
    deliver: Publish,
    forcedSessionId?: string,
  ): Promise<AcpSessionNotification | null> {
    const routed = await this.routeUpdate(notification, deliver, forcedSessionId);
    if (!routed) return routed;
    this.rememberSendMessage(routed);
    return this.form === "rfd" ? this.routeRfdSendMessage(routed, forcedSessionId) : routed;
  }

  /**
   * The RFD form: the work state that the client holds for the announced child
   * `sessionId` of this live session, or undefined when no such child runs here.
   */
  liveWorkState(sessionId: string): WorkState["state"] | undefined {
    if (this.form !== "rfd") return undefined;
    const child = this.children.get(sessionId);
    return child?.announced ? child.workState : undefined;
  }

  /**
   * Reports the model of a child response, an exact model id, as the entry of
   * the root session's `model` option that matches it, else as the id (see
   * {@link responseModelEntry}). The child gets no model before its first
   * response: the adapter cannot tell the model that Claude Code picks for it.
   * The client gets a new configuration only when the entry changes.
   */
  async reportModel(
    parentToolUseId: string | null,
    model: string | undefined,
    deliver: Publish,
  ): Promise<void> {
    const entry = this.form && parentToolUseId ? responseModelEntry(model, this.models) : undefined;
    if (!entry) return;
    // Every response of a child reports its model: most repeat the model that
    // the client already has, and need no routing.
    const child = this.childByParentToolUse.get(parentToolUseId!);
    const current = child?.announced
      ? this.configBySession.get(child.sessionId)?.options.get(MODEL_CONFIG_ID)
      : undefined;
    if (current?.type === "select" && current.currentValue === entry.value) {
      const shown = current.options[0];
      if (shown && "name" in shown && shown.name === entry.name) return;
    }
    await deliver({
      sessionId: this.rootSessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [childModelOption(entry)],
        _meta: { claudeCode: { parentToolUseId } },
      },
    });
  }

  /** The configuration that the client last got for the announced child `sessionId`, if any. */
  configurationOf(sessionId: string): SessionConfigOption[] | undefined {
    const published = this.configBySession.get(sessionId)?.published;
    if (!this.childOfSession(sessionId)?.announced || !published) return undefined;
    return JSON.parse(published) as SessionConfigOption[];
  }

  /**
   * Takes configuration options of the child `agentId`: an SDK agent id, as a
   * hook names it, or a child session id. Hook observations can precede the
   * task event that establishes a child's parent.
   */
  async reportConfiguration(
    agentId: string,
    options: SessionConfigOption[],
    meta?: SessionNotification["update"]["_meta"],
  ): Promise<void> {
    if (!this.form || agentId === this.rootSessionId || options.length === 0) return;
    // In AIR's draft, the session id of a resumed or restored agent is
    // `<agent id>:generation:<n>`, so the agent id names its current generation.
    const known = this.children.get(agentId) ?? this.childOfSession(agentId);
    const sessionId = known?.sessionId ?? agentId;
    // AIR's draft takes no configuration of an ended child (see `finishTask`).
    if (
      this.form === "air" &&
      known &&
      (known.terminalState !== undefined || known.terminalPromise)
    ) {
      return;
    }
    let config = this.configBySession.get(sessionId);
    if (!config) {
      const pending = [...this.configBySession.keys()].filter(
        (id) => !this.childOfSession(id),
      ).length;
      if (!known && pending >= MAX_PENDING_PARENTS) {
        this.logger.log(
          `Session ${this.rootSessionId}: dropping configuration for unannounced subagent ${agentId}; pending buffer limit reached`,
        );
        return;
      }
      config = { options: new Map(), publishing: Promise.resolve() };
      this.configBySession.set(sessionId, config);
    }
    for (const option of options) config.options.set(option.id, option);
    if (known?.announced) await this.publishConfiguration(known, meta);
  }

  private async publishConfiguration(
    child: NativeSubagent,
    meta?: SessionNotification["update"]["_meta"],
  ): Promise<void> {
    const config = this.configBySession.get(child.sessionId);
    // AIR's draft ends a child for good, so it gets no update after its end,
    // also when the end comes while this publication waits for an earlier one.
    const ended = () =>
      this.form === "air" && (child.terminalState !== undefined || !!child.terminalPromise);
    if (!config || ended()) return;
    // SDK hooks can run concurrently with streamed responses. Serialize snapshots
    // so a delayed publication cannot replace newer settings with older ones.
    const publishing = config.publishing.then(async () => {
      if (this.configBySession.get(child.sessionId) !== config || ended()) return;
      const priority = ["mode", "model", "thought_level", "model_config"];
      const rank = (option: SessionConfigOption) => {
        const index = priority.indexOf(option.category ?? "");
        return index < 0 ? priority.length : index;
      };
      const configOptions = [...config.options.values()].sort(
        (left, right) => rank(left) - rank(right),
      );
      const snapshot = JSON.stringify(configOptions);
      if (config.published === snapshot) return;
      await this.publish({
        sessionId: child.sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions,
          ...(meta ? { _meta: meta } : {}),
        },
      });
      config.published = snapshot;
    });
    // The caller receives the error; later observations must still be able to retry.
    config.publishing = publishing.catch(() => {});
    await publishing;
  }

  private async routeUpdate(
    notification: AcpSessionNotification,
    deliver: Publish,
    forcedSessionId?: string,
  ): Promise<AcpSessionNotification | null> {
    const { update } = notification;
    const claudeMeta = update._meta?.claudeCode as
      { parentToolUseId?: string | null; toolName?: string } | undefined;
    const isControl = this.isControlUpdate(update);

    if (!this.enabled) return notification;

    if (this.enabled && isControl) {
      const toolCallId = update.toolCallId;
      if (update.sessionUpdate === "tool_call") {
        this.controlByToolUse.set(toolCallId, notification);
      }
      const identity = subagentIdentity(update.rawInput);
      if (identity) {
        this.identityByToolUse.set(
          toolCallId,
          mergeSubagentIdentity(this.identityByToolUse.get(toolCallId), identity),
        );
      }
      const parentChild = claudeMeta?.parentToolUseId
        ? this.childByParentToolUse.get(claudeMeta.parentToolUseId)
        : undefined;
      const parentSessionId = claudeMeta?.parentToolUseId
        ? parentChild?.sessionId
        : this.rootSessionId;
      // The RFD form: a call made inside a child that is not announced yet
      // establishes no parent, because the RFD forbids announcing its child
      // under the root or before that child. The update is buffered below
      // under the child's tool use, and routed again, with the child as the
      // parent, once the child is announced.
      const parentPending =
        this.form === "rfd" && !!claudeMeta?.parentToolUseId && !parentChild?.announced;
      const child = this.childByParentToolUse.get(toolCallId);
      if (!parentPending) {
        this.parentByToolUse.set(toolCallId, parentSessionId ?? this.rootSessionId);
        if (child && !child.announced) {
          child.parentSessionId = parentSessionId ?? this.rootSessionId;
          applySubagentIdentity(child, this.identityByToolUse.get(toolCallId));
          await this.announce(child);
          for (const pending of this.takePending(toolCallId)) await deliver(pending);
        }
      }
      if (this.form === "air") {
        if (!child && isFailedToolCallUpdate(update)) {
          this.takePending(toolCallId);
          const initial = this.controlByToolUse.get(toolCallId);
          this.cleanupControl(toolCallId);
          if (forcedSessionId) {
            return { ...notification, sessionId: forcedSessionId };
          }
          return unexposedControlFallback(
            initial,
            notification,
            parentSessionId ?? this.rootSessionId,
          );
        }
        return forcedSessionId ? { ...notification, sessionId: forcedSessionId } : null;
      }
      // The RFD form: the parent's session messages replace the Agent/Task
      // tool call, its prompt as the parent's outgoing message (see
      // `linkedSessionMessages`) and its result as the child's reply (see
      // `launchReply`). A call made inside a child that is not announced yet
      // is buffered below, as any update of that child.
      if (!parentPending) {
        return this.routeRfdLaunch(
          notification,
          child,
          parentSessionId ?? this.rootSessionId,
          forcedSessionId,
        );
      }
    }

    const toolCallId =
      update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"
        ? update.toolCallId
        : undefined;

    // A permission request may have had to create the tool call before native
    // child ownership was known. Keep every later update in that original ACP
    // session; moving a lifecycle after its initial call creates an orphan in
    // both transcripts.
    if (forcedSessionId) {
      const forcedChild = this.childOfSession(forcedSessionId);
      if (toolCallId && forcedChild) this.rememberToolCallOwner(toolCallId, forcedChild);
      return { ...notification, sessionId: forcedSessionId };
    }

    const owner = toolCallId ? this.childByToolCall.get(toolCallId) : undefined;
    const announcedChild =
      owner ??
      (claudeMeta?.parentToolUseId
        ? this.childByParentToolUse.get(claudeMeta.parentToolUseId)
        : undefined);
    if (announcedChild?.announced && update.sessionUpdate === "config_option_update") {
      await this.reportConfiguration(announcedChild.sessionId, update.configOptions, update._meta);
      return null;
    }
    if (this.form === "rfd" && announcedChild?.announced) {
      const handback = await this.routeRfdHandback(notification, announcedChild);
      if (handback !== undefined) return handback;
    }
    if (owner) return this.toChild(owner, notification, toolCallId);

    if (this.enabled && claudeMeta?.parentToolUseId) {
      const child = this.childByParentToolUse.get(claudeMeta.parentToolUseId);
      if (!child || !child.announced) {
        const launchId = claudeMeta.parentToolUseId;
        this.buffer(launchId, notification);
        // An id that this process never saw is the launch call of an agent
        // from before a load or resume; a new Agent call is known by now.
        if (!child && this.form === "air" && this.isUnseenLaunch(launchId)) {
          await this.restoreLaunch(launchId, deliver);
        }
        return null;
      }
      return this.toChild(child, notification, toolCallId);
    }

    return notification;
  }

  async taskStarted(task: TaskStarted, deliver: Publish): Promise<void> {
    if (!this.enabled) return;
    const known =
      this.form === "rfd"
        ? (this.children.get(task.taskId) ??
          (await this.restore(task.taskId, task.toolUseId ?? undefined, deliver)))
        : undefined;
    if (known) {
      // A child keeps its session for every delegation to it. The SDK starts
      // a resumed agent again under the id of the call that resumed it.
      await this.resumeChild(
        known,
        task.taskId,
        promptText(task.prompt),
        task.toolUseId ?? undefined,
        deliver,
      );
      return;
    }
    // The SDK starts an agent from before a restart under the id of the
    // SendMessage call that resumed it, as in the RFD form (see `restore`).
    // Its output comes under the id of the call that launched it.
    if (
      this.form === "air" &&
      task.subagentType &&
      task.toolUseId &&
      this.senderByToolUse.has(task.toolUseId) &&
      !this.children.has(task.taskId)
    ) {
      await this.restoreAgent(task.taskId, deliver, promptText(task.prompt));
      const restored = this.children.get(task.taskId);
      if (restored) {
        this.taskByToolUse.set(task.toolUseId, task.taskId);
        this.childByParentToolUse.set(task.toolUseId, restored);
        return;
      }
    }
    if (!task.subagentType) {
      if (task.toolUseId) {
        this.takePending(task.toolUseId);
        this.cleanupControl(task.toolUseId);
      }
      return;
    }
    const previous = this.children.get(task.taskId);
    if (previous && previous.terminalState === undefined) return;

    // A SendMessage resume reuses the finished generation's tool id, whose
    // control state is already cleaned up.
    const knownParentSessionId =
      (task.toolUseId ? this.parentByToolUse.get(task.toolUseId) : undefined) ??
      (previous && this.resumedParentSessionId(previous));
    const identity = task.toolUseId ? this.identityByToolUse.get(task.toolUseId) : undefined;
    // A nested child must wait for the spawning Agent/Task frame to establish
    // its immediate parent. Root children without a tool id can be announced.
    await this.openGeneration(
      task.taskId,
      previous,
      {
        parentSessionId: knownParentSessionId ?? this.rootSessionId,
        parentToolUseId: task.toolUseId ?? undefined,
        name: subagentDisplayName(
          identity?.name,
          identity?.description ?? task.description,
          identity?.subagentType ?? task.subagentType,
          task.taskId,
        ),
        task: subagentDescription(
          identity?.prompt ?? task.prompt,
          identity?.description ?? task.description,
        ),
        ...promptField(promptText(task.prompt) ?? identity?.prompt),
        ...rfdLabels(
          identity?.name,
          identity?.subagentType ?? task.subagentType,
          identity?.description ?? task.description,
        ),
      },
      !!knownParentSessionId || !task.toolUseId,
      deliver,
    );
  }

  /**
   * Opens a new generation of a finished child when the SDK resumes the same
   * agent id. The SDK can resume a child without a new `task_started`, so a
   * running `task_updated` patch or a SendMessage `resumedAgentId` is the
   * signal. A child that did not finish is not changed. The `prompt` is the
   * SendMessage text that resumed the child, when the adapter knows it.
   *
   * In the RFD form, the running patch only reports that the child runs: its
   * prompt is a guess (the latest SendMessage to the agent), and the
   * `task_started` or the SendMessage result carries the delegation.
   *
   * In the AIR form, an agent that the runtime does not know is restored from
   * the session's history (see {@link restoreAgent}).
   */
  async taskResumed(taskId: string, deliver: Publish, prompt?: string): Promise<void> {
    if (!this.enabled) return;
    const previous = this.children.get(taskId);
    if (!previous) {
      if (this.form === "air") await this.restoreAgent(taskId, deliver, prompt);
      return;
    }
    const finishing = this.taskFinishPromises.get(taskId) ?? previous.terminalPromise;
    if (finishing) await finishing.catch(() => {});
    if (this.form === "rfd") {
      await this.resumeChild(previous, taskId, undefined, undefined, deliver);
      return;
    }
    if (this.children.get(taskId) !== previous || previous.terminalState === undefined) return;
    await this.openGeneration(
      taskId,
      previous,
      {
        parentSessionId: this.resumedParentSessionId(previous),
        parentToolUseId: previous.parentToolUseId,
        name: previous.name,
        task: previous.task,
        ...promptField(promptText(prompt)),
      },
      true,
      deliver,
    );
  }

  /**
   * The SDK reports in a SendMessage result that the call `toolUseId`, with
   * the message `prompt`, resumed the agent `taskId`. AIR's draft treats it as
   * any resume signal. In the RFD form, the call is the delegation, which the
   * child takes unless its run already ended: the result can arrive after it.
   */
  async sendMessageResumed(
    taskId: string,
    deliver: Publish,
    prompt?: string,
    toolUseId?: string,
  ): Promise<void> {
    if (this.form !== "rfd") return this.taskResumed(taskId, deliver, prompt);
    const child = this.children.get(taskId) ?? (await this.restore(taskId, toolUseId, deliver));
    if (!child) return;
    const finishing = this.taskFinishPromises.get(taskId);
    if (finishing) await finishing.catch(() => {});
    if (this.isEndedDelegation(taskId, toolUseId)) return;
    await this.resumeChild(child, taskId, promptText(prompt), toolUseId, deliver);
  }

  /**
   * The RFD form: whether the run of the call `toolUseId` that delegated to
   * the child `taskId` already ended. AIR's draft has no such runs.
   */
  isEndedDelegation(taskId: string, toolUseId: string | null | undefined): boolean {
    if (this.form !== "rfd" || !toolUseId) return false;
    return this.children.get(taskId)?.endedRuns?.has(toolUseId) ?? false;
  }

  /**
   * The RFD form: whether `toolUseId` is an earlier delegation of the child
   * `taskId`, whose end does not end the current one. AIR's draft has no
   * such delegations.
   */
  isStaleEnd(taskId: string, toolUseId: string | null | undefined): boolean {
    if (this.form !== "rfd" || !toolUseId) return false;
    const child = this.children.get(taskId);
    return (
      !!child &&
      child.parentToolUseId !== undefined &&
      toolUseId !== child.parentToolUseId &&
      this.childByParentToolUse.get(toolUseId) === child
    );
  }

  /**
   * Reports that the SDK ended the task's work. `end` has what the SDK says
   * about it: its text for a failure, and its reason for an unusual end.
   */
  async finishTask(
    taskId: string,
    status: unknown,
    deliver: Publish,
    toolUseId?: string | null,
    end?: TaskEnd,
  ): Promise<void> {
    if (!this.enabled) return;
    const state = nativeSubagentState(status);
    const child = toolUseId ? this.childByParentToolUse.get(toolUseId) : this.children.get(taskId);
    if (child && toolUseId && this.taskByToolUse.get(toolUseId) !== taskId) return;
    if (!state || !child) return;
    if (this.form === "rfd") {
      if (this.isStaleEnd(taskId, toolUseId)) return;
      if (!child.announced && !child.announcePromise) {
        this.withdraw(taskId, child);
        return;
      }
    }
    const existing = this.taskFinishPromises.get(taskId);
    if (existing) {
      await existing;
      if (this.form === "rfd") await this.supplyError(child, state, end?.error);
      return;
    }
    if (this.form === "air" ? child.terminalState !== undefined : child.workState === "idle") {
      if (this.form === "rfd") await this.supplyError(child, state, end?.error);
      return;
    }

    const finish = Promise.resolve().then(async () => {
      try {
        await this.announce(child);
        if (child.parentToolUseId) {
          for (const pending of this.takePending(child.parentToolUseId)) await deliver(pending);
        }
        if (this.form === "rfd") {
          await this.reportState(child, rfdEndState(state, end));
          child.missingError = state === "failed" && !end?.error && !end?.unexplained;
          if (child.parentToolUseId) (child.endedRuns ??= new Set()).add(child.parentToolUseId);
        } else {
          await finishNativeSubagent(this.session, taskId, state, this.publish);
          // AIR's draft takes no configuration of an ended child.
          this.configBySession.delete(child.sessionId);
        }
      } finally {
        if (child.parentToolUseId) {
          this.cleanupControl(child.parentToolUseId);
        }
      }
    });
    this.taskFinishPromises.set(taskId, finish);
    try {
      await finish;
    } finally {
      if (this.taskFinishPromises.get(taskId) === finish) this.taskFinishPromises.delete(taskId);
    }
  }

  /**
   * Ends every child that still runs, because the stream ended or the
   * conversation was reset. AIR's draft reports `state` for each. In the RFD
   * form the cause of each child's end is unknown, so it is idle with no stop
   * reason: a child that a cancel stopped already reported it from the SDK's
   * events, and a background child that outlived the cancel was not cancelled.
   */
  async finishAll(state: SubagentState, deliver: Publish): Promise<void> {
    const errors: unknown[] = [];
    const end = this.form === "rfd" ? { unexplained: true } : undefined;
    try {
      for (const taskId of [...this.children.keys()].reverse()) {
        try {
          await this.finishTask(taskId, state, deliver, undefined, end);
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      this.pending.clear();
      this.pendingCount = 0;
      this.identityByToolUse.clear();
      this.controlByToolUse.clear();
      this.configBySession.clear();
      this.parentByToolUse.clear();
      this.forgetRestores();
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Failed to finish native subagents");
  }

  /**
   * The parent session got `session/cancel`. AIR's draft ends every child as
   * cancelled here. The RFD form reports nothing: acknowledging a cancel is no
   * evidence that a child stopped. Claude Code's interrupt stops the
   * foreground children that the turn waits on and, currently, background
   * children too, and the SDK's task events report each as cancelled. A child
   * that keeps running keeps its open requests
   * (agentclientprotocol/agent-client-protocol#2308). The RFD form only counts
   * the cancel, for {@link awaitingUser}.
   */
  async parentCancelled(deliver: Publish): Promise<void> {
    if (this.form === "air") await this.finishAll("cancelled", deliver);
    else this.parentCancels++;
  }

  /**
   * The RFD form: the client sent `session/cancel` for the child session
   * `sessionId`, which the child's `cancel` capability permits (see
   * `announceNativeSubagent`). `stop` stops the child's task, as
   * `Query.stopTask` does: Claude Code stops the child's current work and the
   * foreground subagents that it waits on, and the parent's work goes on. The
   * SDK's task events report each stopped child `idle` with `cancelled` (see
   * {@link finishTask}). Accepting the stop is no evidence that the child
   * stopped, so nothing is reported here, and a child whose work already ended
   * keeps its outcome. Returns false when `sessionId` is not a child session
   * of this runtime. AIR's draft grants no `cancel`.
   */
  async cancelChild(sessionId: string, stop: (taskId: string) => Promise<void>): Promise<boolean> {
    if (this.form !== "rfd") return false;
    for (const [taskId, child] of this.children) {
      if (child.sessionId !== sessionId || !child.announced) continue;
      child.cancels = (child.cancels ?? 0) + 1;
      await stop(taskId);
      return true;
    }
    return false;
  }

  /**
   * Runs `request`, a permission or question request of the session
   * `sessionId`. In the RFD form, a child waiting on it is `requires_action`
   * until its last open request ends, and then `running` again.
   *
   * `signal` aborts when Claude Code withdraws the request, which is not an
   * answer. If the root session, the child, or an ancestor of the child was
   * cancelled while the request was open, Claude Code withdrew it as it
   * stopped the child, and the SDK's events report the child `idle` next. The
   * end of the request then reports no `running`, which would show a child
   * that is being stopped as working. Without a cancel, something else
   * answered the request in the user's place, such as a `PermissionRequest`
   * hook, and the child runs on, so the end reports `running`.
   */
  async awaitingUser<T>(
    sessionId: string,
    request: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const child = this.form === "rfd" ? this.childOfSession(sessionId) : undefined;
    if (!child?.announced) return request();
    const cancelsAtOpen = this.cancelsAbove(child);
    child.openRequests = (child.openRequests ?? 0) + 1;
    if (child.openRequests === 1 && child.workState === "running") {
      await this.reportState(child, { state: "requires_action" }).catch((error) =>
        this.logger.log(`Failed to report that subagent ${child.sessionId} waits: ${error}`),
      );
    }
    try {
      return await request();
    } finally {
      child.openRequests = (child.openRequests ?? 1) - 1;
      // Withdrawn after a cancel that came while the request was open.
      const stopped = signal?.aborted === true && this.cancelsAbove(child) !== cancelsAtOpen;
      if (child.openRequests === 0 && child.workState === "requires_action" && !stopped) {
        await this.reportState(child, { state: "running" }).catch((error) =>
          this.logger.log(`Failed to report that subagent ${child.sessionId} runs: ${error}`),
        );
      }
    }
  }

  discardPending(parentToolUseId: string): void {
    this.takePending(parentToolUseId);
  }

  /**
   * The RFD form: restores the agent `agentId` when the SendMessage call
   * `toolUseId` resumes it and the runtime does not know it, because it ran
   * before the session was loaded or resumed. A new launch is no resume: its
   * call is an Agent or Task call.
   *
   * The agent keeps its session id from before, its agent id. The session's
   * subagent history (see {@link SubagentLineage}) gives the call that
   * launched it and its ancestors. The launch call is its delegation again:
   * Claude Code sends the resumed run's messages under that call's id. Before the agent's traffic, the RFD requires its complete
   * ancestor chain, parent before child. So each ancestor that the client was
   * not told about in this connection is announced, with no work state since
   * nothing says that it runs; then the agent, as running. The RFD forbids
   * guessing a parent, so an agent that the history cannot place stays
   * unexposed, as before.
   */
  private async restore(
    agentId: string,
    toolUseId: string | undefined,
    deliver: Publish,
  ): Promise<NativeSubagent | undefined> {
    if (!this.lineage || !toolUseId || !this.senderByToolUse.has(toolUseId)) return undefined;
    const lineage = await this.lineage(agentId).catch((error: unknown) => {
      this.logger.log(
        `Session ${this.rootSessionId}: failed to read the history of subagent ${agentId}: ${error}`,
      );
      return [];
    });
    for (const entry of lineage) {
      let child = this.children.get(entry.agentId);
      if (!child) {
        child = {
          sessionId: entry.agentId,
          parentSessionId: entry.parentAgentId
            ? (this.children.get(entry.parentAgentId)?.sessionId ?? entry.parentAgentId)
            : this.rootSessionId,
          parentToolUseId: entry.launchId,
          name: subagentDisplayName(entry.name, entry.description, entry.agentType, entry.agentId),
          task: subagentDescription(undefined, entry.description),
          ...rfdLabels(entry.name, entry.agentType, entry.description),
        };
        this.children.set(entry.agentId, child);
        this.taskByToolUse.set(entry.launchId, entry.agentId);
        this.childByParentToolUse.set(entry.launchId, child);
      }
      if (child.announced) continue;
      if (entry.agentId === agentId) {
        await this.announce(child);
      } else {
        await this.publish({
          sessionId: child.parentSessionId,
          update: {
            sessionUpdate: "subagent_update",
            sessionId: child.sessionId,
            ...(child.title ? { title: child.title } : {}),
            ...(child.description ? { description: child.description } : {}),
          },
        });
        child.announced = true;
      }
      for (const pending of this.takePending(entry.launchId)) await deliver(pending);
    }
    return this.children.get(agentId);
  }

  /**
   * The AIR form: whether no call of this process made `launchId`. A new Agent
   * call has a control update before its `task_started`, and a launch that was
   * restored or looked up is registered or remembered.
   */
  private isUnseenLaunch(launchId: string): boolean {
    return (
      !!this.launchedAgent && !this.unresolvedLaunches.has(launchId) && this.isUnseenCall(launchId)
    );
  }

  /** Whether this runtime has no record of the tool call `toolUseId`. */
  private isUnseenCall(toolUseId: string): boolean {
    return (
      !this.taskByToolUse.has(toolUseId) &&
      !this.childByParentToolUse.has(toolUseId) &&
      !this.controlByToolUse.has(toolUseId) &&
      !this.parentByToolUse.has(toolUseId) &&
      !this.identityByToolUse.has(toolUseId)
    );
  }

  /**
   * The AIR form: restores the agent that the call `launchId` launched, once.
   * Concurrent callers wait for the same lookup. Without an agent, the updates
   * buffered under `launchId` stay buffered and `launchId` is not looked up again.
   */
  private restoreLaunch(launchId: string, deliver: Publish): Promise<void> {
    const existing = this.launchRestores.get(launchId);
    if (existing) return existing;
    const epoch = this.restoreEpoch;
    const restoring = (async () => {
      const agentId = await this.launchedAgent?.(launchId).catch((error: unknown) => {
        this.logger.log(
          `Session ${this.rootSessionId}: failed to read the history of launch ${launchId}: ${error}`,
        );
        return undefined;
      });
      if (epoch !== this.restoreEpoch) return;
      if (agentId) await this.restoreAgent(agentId, deliver);
      if (epoch !== this.restoreEpoch) return;
      const child = this.childByParentToolUse.get(launchId);
      if (!child) {
        this.unresolvedLaunches.add(launchId);
        return;
      }
      // Updates that arrived while the generation was announced.
      if (child.announced) for (const pending of this.takePending(launchId)) await deliver(pending);
    })().finally(() => {
      if (this.launchRestores.get(launchId) === restoring) this.launchRestores.delete(launchId);
    });
    this.launchRestores.set(launchId, restoring);
    return restoring;
  }

  /**
   * The AIR form: opens a generation for the agent `agentId` that the runtime
   * does not know, because it ran before the session was loaded or resumed.
   * The session's subagent history (see {@link SubagentLineage}) gives the
   * call that launched it: Claude Code sends the resumed run's messages under
   * that call's id, so it is the generation's parent tool use, and the updates
   * buffered under it are delivered. The parent is the agent that made the call
   * if it is live, else the root. An agent that the history cannot place is
   * not restored. Concurrent signals for one agent open one generation.
   */
  private restoreAgent(agentId: string, deliver: Publish, prompt?: string): Promise<void> {
    if (!this.lineage || this.children.has(agentId) || this.unrestorableAgents.has(agentId)) {
      return Promise.resolve();
    }
    const existing = this.agentRestores.get(agentId);
    if (existing) return existing;
    const lineage = this.lineage;
    const epoch = this.restoreEpoch;
    const restoring = (async () => {
      const entries = await lineage(agentId).catch((error: unknown) => {
        this.logger.log(
          `Session ${this.rootSessionId}: failed to read the history of subagent ${agentId}: ${error}`,
        );
        return [];
      });
      if (epoch !== this.restoreEpoch || this.children.has(agentId)) return;
      const entry = entries.at(-1);
      if (!entry || entry.agentId !== agentId) {
        this.unrestorableAgents.add(agentId);
        return;
      }
      const parent = entry.parentAgentId ? this.children.get(entry.parentAgentId) : undefined;
      await this.openGeneration(
        agentId,
        undefined,
        {
          parentSessionId:
            parent && this.isLiveSession(parent.sessionId) ? parent.sessionId : this.rootSessionId,
          parentToolUseId: entry.launchId,
          name: subagentDisplayName(entry.name, entry.description, entry.agentType, agentId),
          task: subagentDescription(undefined, entry.description),
          ...promptField(promptText(prompt)),
        },
        true,
        deliver,
        true,
      );
    })().finally(() => {
      if (this.agentRestores.get(agentId) === restoring) this.agentRestores.delete(agentId);
    });
    this.agentRestores.set(agentId, restoring);
    return restoring;
  }

  /**
   * The RFD form: the child runs again, and keeps its session. `toolUseId` is
   * the call that delegated, usually a SendMessage: the SDK runs the resumed
   * work under its id, so it becomes the child's current delegation, whose
   * end ends the run, and its prompt is the message with that id. A child
   * that is already working only takes the delegation; a prompt already in
   * its transcript is not sent again. A child that was never announced is
   * not changed.
   */
  private async resumeChild(
    child: NativeSubagent,
    taskId: string,
    prompt: string | undefined,
    toolUseId: string | undefined,
    deliver: Publish,
  ): Promise<void> {
    if (!child.announced) return;
    if (toolUseId && toolUseId !== child.parentToolUseId) {
      this.taskByToolUse.set(toolUseId, taskId);
      this.childByParentToolUse.set(toolUseId, child);
      child.parentToolUseId = toolUseId;
    }
    if (!isWorking(child)) {
      await this.reportState(child, {
        state: child.openRequests ? "requires_action" : "running",
      });
    }
    if (prompt && toolUseId) {
      const sendMessage = this.hiddenSendMessages.get(toolUseId);
      await publishPrompt(
        child,
        prompt,
        toolUseId,
        sendMessage?.sender ?? this.senderByToolUse.get(toolUseId),
        this.publish,
        { replacesCall: sendMessage !== undefined },
      );
      if (sendMessage) sendMessage.delivered = true;
    }
    for (const pending of toolUseId ? this.takePending(toolUseId) : []) await deliver(pending);
  }

  /**
   * The RFD form: a child that ends before its parent is known stays
   * unexposed, since the RFD forbids guessing its parent. Its buffered updates
   * are dropped, and it is forgotten, so a late frame does not announce it.
   * (Buffering until that frame would also meet the RFD, but the frame comes
   * before the task in the SDK's order, so a child ending without it is rare.)
   */
  private withdraw(taskId: string, child: NativeSubagent): void {
    this.children.delete(taskId);
    this.configBySession.delete(child.sessionId);
    if (child.parentToolUseId) {
      this.takePending(child.parentToolUseId);
      this.cleanupControl(child.parentToolUseId);
      this.childByParentToolUse.delete(child.parentToolUseId);
      this.taskByToolUse.delete(child.parentToolUseId);
    }
  }

  /**
   * The RFD form: a later event of a failure can carry the SDK's error text
   * that the reported idle snapshot lacks.
   */
  private async supplyError(
    child: NativeSubagent,
    state: SubagentState,
    error: string | undefined,
  ): Promise<void> {
    if (state !== "failed" || !error || !child.missingError) return;
    await this.reportState(child, rfdEndState("failed", { error }));
  }

  /**
   * Announces `child` in the client's form, then its configuration. A runtime
   * without a form never does.
   */
  private async announce(child: NativeSubagent): Promise<void> {
    if (!this.form) return;
    await announceNativeSubagent(child, this.publish, this.form);
    await this.publishConfiguration(child);
  }

  /** The RFD form: publishes the work state of `child` on its parent. */
  private async reportState(child: NativeSubagent, state: WorkState): Promise<void> {
    child.workState = state.state;
    child.missingError = false;
    await this.publish({
      sessionId: child.parentSessionId,
      update: { sessionUpdate: "subagent_update", sessionId: child.sessionId, state },
    });
  }

  /**
   * Routes an update to the child session. It never goes to the root session:
   * in AIR's draft, an update of a finished child is dropped.
   */
  private toChild(
    child: NativeSubagent,
    notification: AcpSessionNotification,
    toolCallId: string | undefined,
  ): AcpSessionNotification | null {
    // AIR's draft ends a child for good. In the RFD form an idle child is
    // reusable, and its background work can still report.
    if (this.form === "air" && (child.terminalState !== undefined || child.terminalPromise)) {
      this.logger.log(
        `Session ${this.rootSessionId}: ignoring late update for terminal subagent ${child.sessionId}`,
      );
      return null;
    }
    if (toolCallId) this.rememberToolCallOwner(toolCallId, child);
    return { ...notification, sessionId: child.sessionId };
  }

  /**
   * The route of the work that a child tool call started, for example an async
   * task. The route sends each update to the child generation that owned the
   * tool call when the work started. An async task can outlive that child: a
   * subagent can start a background command and end its turn. So the route
   * still sends `async_task_spawned`, `async_task_progress` and
   * `async_task_state_update` to the child generation after it finished. In
   * AIR's draft, the route drops every other update after the child finished;
   * in the RFD form, an idle child gets them all. `undefined` means that the
   * root session owns the tool call. `eagerSessionId` is the session where a
   * permission request created the tool call before the stream routed it.
   */
  routeOfToolCall(
    toolCallId: string,
    eagerSessionId?: string,
  ): ((notification: AcpSessionNotification) => AcpSessionNotification | null) | undefined {
    if (!this.enabled) return undefined;
    const owner =
      this.childByToolCall.get(toolCallId) ??
      (eagerSessionId ? this.childOfSession(eagerSessionId) : undefined);
    return (
      owner &&
      ((notification) =>
        isLateAsyncTaskUpdate(notification)
          ? { ...notification, sessionId: owner.sessionId }
          : this.toChild(owner, notification, undefined))
    );
  }

  /**
   * The RFD form: remembers the session that made a SendMessage call, the
   * sender of the prompt when the call resumes a child.
   */
  private rememberSendMessage(notification: AcpSessionNotification): void {
    const { update } = notification;
    if (update.sessionUpdate !== "tool_call") return;
    const claudeMeta = update._meta?.claudeCode as { toolName?: string } | undefined;
    if (claudeMeta?.toolName !== "SendMessage") return;
    this.senderByToolUse.delete(update.toolCallId);
    this.senderByToolUse.set(update.toolCallId, notification.sessionId);
    if (this.senderByToolUse.size > MAX_CHILD_TOOL_CALLS) {
      const oldest = this.senderByToolUse.keys().next().value;
      if (oldest !== undefined) this.senderByToolUse.delete(oldest);
    }
  }

  /**
   * The RFD form: an update of the Agent/Task call that launches `child`,
   * which the parent's session messages replace. Only a launch whose child
   * was never exposed stays a tool call of the parent, with its final status,
   * since the RFD lets the Agent represent unexposed work through the parent.
   * A background launch completes before its child starts, so its completion
   * is not such a case.
   */
  private async routeRfdLaunch(
    notification: AcpSessionNotification,
    child: NativeSubagent | undefined,
    parentSessionId: string,
    forcedSessionId: string | undefined,
  ): Promise<AcpSessionNotification | null> {
    const { update } = notification;
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      return null;
    }
    const toolCallId = update.toolCallId;
    // A permission request already showed the call to the client, so it
    // keeps getting its updates.
    if (forcedSessionId) return { ...notification, sessionId: forcedSessionId };
    const launch = this.hiddenLaunches.get(toolCallId) ?? { background: false };
    if (isBackgroundLaunch(update.rawInput)) launch.background = true;
    if (!isFinalToolCallStatus(update.status)) {
      this.hiddenLaunches.set(toolCallId, launch);
      return null;
    }
    this.hiddenLaunches.delete(toolCallId);
    if (child?.announcePromise) await child.announcePromise;
    const background = launch.background;
    if (child?.announced) {
      const reply =
        update.status === "completed" && !background && !child.handedBack?.has(toolCallId)
          ? launchReply(toolCallId, child.sessionId, child.parentSessionId, update)
          : undefined;
      if (reply) await this.publish(reply);
      return null;
    }
    if (background && update.status === "completed") return null;
    this.takePending(toolCallId);
    const initial = this.controlByToolUse.get(toolCallId);
    this.cleanupControl(toolCallId);
    return unexposedControlFallback(initial, notification, parentSessionId);
  }

  /**
   * The RFD form: an update of a SubagentHandback call of the announced
   * `child`, which its report replaces: the child's message to its parent,
   * see {@link linkedSessionMessages}. A failed call delivered nothing, so the
   * child is shown the call after all. `undefined` for any other update.
   */
  private async routeRfdHandback(
    notification: AcpSessionNotification,
    child: NativeSubagent,
  ): Promise<AcpSessionNotification | null | undefined> {
    const { update } = notification;
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      return undefined;
    }
    const claudeMeta = update._meta?.claudeCode as
      { parentToolUseId?: string | null; toolName?: string } | undefined;
    let handback = this.handbacks.get(update.toolCallId);
    if (!handback) {
      if (claudeMeta?.toolName !== HANDBACK_TOOL) return undefined;
      handback = {
        initial: notification,
        delegationId: claudeMeta.parentToolUseId ?? child.parentToolUseId,
      };
      this.handbacks.set(update.toolCallId, handback);
    }
    handback.message = handbackMessage(update.rawInput) ?? handback.message;
    if (!isFinalToolCallStatus(update.status)) return null;
    this.handbacks.delete(update.toolCallId);
    if (update.status === "completed" && handback.message) {
      for (const view of linkedSessionMessages(
        update.toolCallId,
        child.sessionId,
        child.parentSessionId,
        handback.message,
      )) {
        await this.publish(view);
      }
      if (handback.delegationId) (child.handedBack ??= new Set()).add(handback.delegationId);
      return null;
    }
    return unexposedControlFallback(handback.initial, notification, child.sessionId);
  }

  /**
   * The RFD form: an update of a SendMessage call, which its message replaces
   * once it reaches an announced child: the sender's outgoing view and the
   * child's incoming one, see {@link linkedSessionMessages}. The SDK reports
   * that delivery before the call's final update. A call whose message reached
   * no announced child, such as one to the parent, is shown after all, with its
   * final status. Any other update is returned as is.
   */
  private routeRfdSendMessage(
    notification: AcpSessionNotification,
    forcedSessionId: string | undefined,
  ): AcpSessionNotification | null {
    const { update } = notification;
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      return notification;
    }
    const toolCallId = update.toolCallId;
    // A permission request already showed the call to the client, so it keeps
    // getting its updates, and its message goes only to the child.
    if (forcedSessionId) {
      this.hiddenSendMessages.delete(toolCallId);
      return notification;
    }
    let sendMessage = this.hiddenSendMessages.get(toolCallId);
    if (!sendMessage) {
      const claudeMeta = update._meta?.claudeCode as { toolName?: string } | undefined;
      if (update.sessionUpdate !== "tool_call" || claudeMeta?.toolName !== "SendMessage") {
        return notification;
      }
      sendMessage = { initial: notification, sender: notification.sessionId, delivered: false };
      this.hiddenSendMessages.set(toolCallId, sendMessage);
    }
    if (!isFinalToolCallStatus(update.status)) return null;
    this.hiddenSendMessages.delete(toolCallId);
    if (sendMessage.delivered) return null;
    return unexposedControlFallback(sendMessage.initial, notification, sendMessage.sender);
  }

  /** Whether `update` is of an Agent/Task call, by its tool name or, in the
   *  RFD form, by the id of a call the client is not shown. */
  private isControlUpdate(
    update: AcpSessionNotification["update"],
  ): update is Extract<
    AcpSessionNotification["update"],
    { sessionUpdate: "tool_call" | "tool_call_update" }
  > {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      return false;
    }
    return this.hiddenLaunches.has(update.toolCallId) || isNativeSubagentControlUpdate(update);
  }

  private rememberToolCallOwner(toolCallId: string, child: NativeSubagent): void {
    this.childByToolCall.delete(toolCallId);
    this.childByToolCall.set(toolCallId, child);
    if (this.childByToolCall.size > MAX_CHILD_TOOL_CALLS) {
      const oldest = this.childByToolCall.keys().next().value;
      if (oldest !== undefined) this.childByToolCall.delete(oldest);
    }
  }

  /**
   * The RFD form: how many cancels the client sent for `child`, its
   * ancestors, and the root session. Each cancel stops the foreground work
   * under it, and the counts only grow, so a changed sum shows that a cancel
   * that reaches the child came.
   */
  private cancelsAbove(child: NativeSubagent): number {
    let cancels = this.parentCancels;
    const seen = new Set<NativeSubagent>();
    let next: NativeSubagent | undefined = child;
    while (next && !seen.has(next)) {
      seen.add(next);
      cancels += next.cancels ?? 0;
      next = this.childOfSession(next.parentSessionId);
    }
    return cancels;
  }

  /** The child generation with the ACP session `sessionId`, if one exists. */
  private childOfSession(sessionId: string): NativeSubagent | undefined {
    if (sessionId === this.rootSessionId) return undefined;
    for (const child of this.children.values()) {
      if (child.sessionId === sessionId) return child;
    }
    return undefined;
  }

  clear(): void {
    this.children.clear();
    this.childByToolCall.clear();
    this.taskByToolUse.clear();
    this.parentByToolUse.clear();
    this.identityByToolUse.clear();
    this.controlByToolUse.clear();
    this.configBySession.clear();
    this.childByParentToolUse.clear();
    this.taskFinishPromises.clear();
    this.senderByToolUse.clear();
    this.hiddenLaunches.clear();
    this.hiddenSendMessages.clear();
    this.handbacks.clear();
    this.generationByTaskId.clear();
    this.pending.clear();
    this.pendingCount = 0;
    this.forgetRestores();
  }

  /** Lets a later resume signal restore an agent again, and look up a launch again. */
  private forgetRestores(): void {
    this.agentRestores.clear();
    this.launchRestores.clear();
    this.unresolvedLaunches.clear();
    this.unrestorableAgents.clear();
    this.restoreEpoch++;
  }

  private takePending(parentToolUseId: string): AcpSessionNotification[] {
    const updates = this.pending.get(parentToolUseId) ?? [];
    if (updates.length > 0) {
      this.pending.delete(parentToolUseId);
      this.pendingCount -= updates.length;
    }
    return updates;
  }

  private buffer(parentToolUseId: string, notification: AcpSessionNotification): void {
    const updates = this.pending.get(parentToolUseId);
    // A child reports its model with each response before its announcement.
    // Only the latest configuration waits, so they do not fill the buffer.
    if (notification.update.sessionUpdate === "config_option_update" && updates) {
      const index = updates.findIndex(
        ({ update }) => update.sessionUpdate === "config_option_update",
      );
      if (index >= 0) {
        updates[index] = notification;
        return;
      }
    }
    if (
      this.pendingCount >= MAX_PENDING_UPDATES ||
      (updates === undefined && this.pending.size >= MAX_PENDING_PARENTS) ||
      (updates?.length ?? 0) >= MAX_PENDING_UPDATES_PER_PARENT
    ) {
      this.logger.log(
        `Session ${this.rootSessionId}: dropping unattributed subagent update for ${parentToolUseId}; pending buffer limit reached`,
      );
      return;
    }
    if (updates) updates.push(notification);
    else this.pending.set(parentToolUseId, [notification]);
    this.pendingCount++;
  }

  private cleanupControl(toolUseId: string): void {
    this.identityByToolUse.delete(toolUseId);
    this.controlByToolUse.delete(toolUseId);
    this.parentByToolUse.delete(toolUseId);
  }

  /** The parent of a resumed generation: the old parent while it is live, else the root. */
  private resumedParentSessionId(previous: NativeSubagent): string {
    return this.isLiveSession(previous.parentSessionId)
      ? previous.parentSessionId
      : this.rootSessionId;
  }

  private isLiveSession(sessionId: string): boolean {
    if (sessionId === this.rootSessionId) return true;
    for (const child of this.children.values()) {
      if (child.sessionId === sessionId) return child.terminalState === undefined;
    }
    return false;
  }

  /**
   * Registers a new child session for the task and makes it the owner of its
   * parent tool call. With `announce`, it publishes `subagent_spawned` and
   * delivers the updates that waited for the child.
   */
  private async openGeneration(
    taskId: string,
    previous: NativeSubagent | undefined,
    fields: Pick<
      NativeSubagent,
      | "parentSessionId"
      | "parentToolUseId"
      | "name"
      | "task"
      | "prompt"
      | "title"
      | "role"
      | "description"
    >,
    announce: boolean,
    deliver: Publish,
    restored = false,
  ): Promise<void> {
    const child: NativeSubagent = {
      sessionId: this.nextChildSessionId(taskId, previous, restored),
      ...fields,
    };
    const toolUseId = child.parentToolUseId;
    this.children.set(taskId, child);
    if (toolUseId) {
      this.taskByToolUse.set(toolUseId, taskId);
      this.childByParentToolUse.set(toolUseId, child);
      this.controlByToolUse.delete(toolUseId);
    }
    if (!announce) return;
    await this.announce(child);
    for (const pending of toolUseId ? this.takePending(toolUseId) : []) await deliver(pending);
  }

  /**
   * The ACP session id of a child: the SDK agent id, and in AIR's draft a
   * generation suffix for each resume. The RFD needs it unique within the
   * connection and never under two parents. Agent ids are random, and an
   * agent keeps its parent, so only a fork could repeat one under another
   * root. That holds today because the SDK's `forkSession` copies no
   * `subagents/` history, so a fork cannot resume an agent of the original.
   * If a fork ever can, the RFD requires remapping the copied ids, for
   * example by deriving the child id from the root session id.
   *
   * An agent restored from the history (`restored`) is not on its first
   * generation: before the restart the client already stored ids such as
   * `taskId` and `taskId:generation:2`. Its generation is the current time in
   * milliseconds, so it is `taskId:generation:1760000000000`, and each later
   * resume in this process adds one.
   */
  private nextChildSessionId(
    taskId: string,
    previous: NativeSubagent | undefined,
    restored = false,
  ): string {
    if (restored) {
      // A clear() and a new restore within one millisecond must not repeat an id.
      const generation = Math.max(Date.now(), this.lastRestoredGeneration + 1);
      this.lastRestoredGeneration = generation;
      this.generationByTaskId.set(taskId, generation);
      return `${taskId}:generation:${generation}`;
    }
    if (!previous) {
      this.generationByTaskId.set(taskId, 1);
      return taskId;
    }
    const generation = (this.generationByTaskId.get(taskId) ?? 1) + 1;
    this.generationByTaskId.set(taskId, generation);
    return `${taskId}:generation:${generation}`;
  }
}

/**
 * The `model` option of a child session. The client cannot change a child's
 * configuration, so the select offers only the current model.
 */
export function childModelOption(entry: ModelEntry): SessionConfigOption {
  return {
    id: MODEL_CONFIG_ID,
    name: "Model",
    category: "model",
    type: "select",
    currentValue: entry.value,
    options: [{ value: entry.value, name: entry.name }],
  };
}

/** Whether two model entries have the same value and name. */
export function sameModelEntry(left: ModelEntry | undefined, right: ModelEntry): boolean {
  return left?.value === right.value && left.name === right.name;
}

/**
 * The model entry for `model`, the model id of a child's response: the entry
 * of the root session's `model` option that matches it, else the id, with its
 * display name when the session's model list has one. Undefined for no model,
 * and for `<synthetic>`, which marks a message that no model wrote.
 */
export function responseModelEntry(
  model: unknown,
  models: SubagentModels | undefined,
): ModelEntry | undefined {
  if (typeof model !== "string" || !model || model === "<synthetic>") return undefined;
  return models?.entry(model) ?? { value: model, name: models?.name(model) ?? model };
}

/**
 * Announces the child on its parent, once, before any update of the child.
 * The RFD form announces it as running and then sends the prompt as the
 * first message of the child. It grants the child `cancel`: the client may
 * stop the child's current work with `session/cancel` (see
 * `NativeSubagentRuntime.cancelChild`), and nothing else. AIR's draft grants
 * no capabilities.
 */
export async function announceNativeSubagent(
  child: NativeSubagent,
  publish: Publish,
  form: SubagentForm,
): Promise<void> {
  if (child.announced) return;
  if (child.announcePromise) return child.announcePromise;
  const announce = Promise.resolve().then(async () => {
    if (form === "rfd") {
      child.workState = "running";
      await publish({
        sessionId: child.parentSessionId,
        update: {
          sessionUpdate: "subagent_update",
          sessionId: child.sessionId,
          ...(child.title ? { title: child.title } : {}),
          ...(child.description ? { description: child.description } : {}),
          capabilities: { cancel: {} },
          state: { state: "running" },
        },
      });
      child.announced = true;
      // The immediate parent made the Agent/Task call that launched the child.
      if (child.prompt) {
        await publishPrompt(
          child,
          child.prompt,
          child.parentToolUseId,
          child.parentSessionId,
          publish,
          { replacesCall: true },
        );
      }
      return;
    }
    await publish({
      sessionId: child.parentSessionId,
      update: {
        sessionUpdate: "subagent_spawned",
        subagentSessionId: child.sessionId,
        name: child.name,
        task: child.task,
        ...promptField(child.prompt),
        capabilities: {},
      },
    });
    child.announced = true;
  });
  child.announcePromise = announce;
  try {
    await announce;
  } finally {
    if (child.announcePromise === announce) child.announcePromise = undefined;
  }
}

export async function finishNativeSubagent(
  session: NativeSubagentSession,
  taskId: string,
  state: SubagentState,
  publish: Publish,
): Promise<void> {
  const child = session.nativeSubagentsByTaskId?.get(taskId);
  if (!child || child.terminalState !== undefined) return;
  if (child.terminalPromise) return child.terminalPromise;
  const finish = Promise.resolve().then(async () => {
    await announceNativeSubagent(child, publish, "air");
    await publish({
      sessionId: child.parentSessionId,
      update: {
        sessionUpdate: "subagent_state_update",
        subagentSessionId: child.sessionId,
        state,
      },
    });
    child.terminalState = state;
  });
  child.terminalPromise = finish;
  try {
    await finish;
  } finally {
    if (child.terminalPromise === finish) child.terminalPromise = undefined;
  }
}

/**
 * The RFD form: a message to the child, in the child's transcript (its
 * incoming view). Its id is the id of the tool use that sent it, the
 * Agent/Task call or a SendMessage, so a prompt whose id is already in the
 * transcript is the same delegation and is not sent again. `sender` is the
 * session that made that call, when known.
 *
 * When the message replaces its call (`replacesCall`), a launch's or a
 * SendMessage call the client is not shown, it also goes to the sender, see
 * {@link linkedSessionMessages}. Otherwise it has only the incoming view.
 */
async function publishPrompt(
  child: NativeSubagent,
  prompt: string,
  toolUseId: string | undefined,
  sender: string | undefined,
  publish: Publish,
  { replacesCall = false }: { replacesCall?: boolean } = {},
): Promise<void> {
  child.promptIds ??= new Set();
  const messageId = toolUseId ?? `${child.sessionId}:prompt:${child.promptIds.size + 1}`;
  if (child.promptIds.has(messageId)) return;
  child.promptIds.add(messageId);
  if (replacesCall && sender !== undefined && toolUseId !== undefined) {
    for (const view of linkedSessionMessages(toolUseId, sender, child.sessionId, prompt)) {
      await publish(view);
    }
    return;
  }
  await publish({
    sessionId: child.sessionId,
    update: {
      sessionUpdate: "session_message",
      messageId,
      ...(sender ? { senderSessionId: sender } : {}),
      recipientSessionId: child.sessionId,
      content: [{ type: "text", text: prompt }],
    },
  });
}

/**
 * The RFD form: a message that a tool call sent, which the client is not
 * shown, as two session messages: the sender's outgoing view, then the
 * recipient's incoming one. That call is a launch's Agent/Task call, whose
 * prompt goes from the parent to the child, a SendMessage call, whose message
 * goes from its sender to a child, or a child's SubagentHandback call, whose
 * report goes from the child to the parent. Both views use the
 * call's tool use id, and each names the other with the draft RFD's
 * `recipientMessageId` and `senderMessageId`.
 */
export function linkedSessionMessages(
  toolUseId: string,
  senderSessionId: string,
  recipientSessionId: string,
  text: string,
): AcpSessionNotification[] {
  const message = {
    sessionUpdate: "session_message" as const,
    messageId: toolUseId,
    senderSessionId,
    recipientSessionId,
    content: [{ type: "text" as const, text }],
  };
  return [
    {
      sessionId: senderSessionId,
      update: { ...message, recipientMessageId: toolUseId } as AcpSessionNotification["update"],
    },
    {
      sessionId: recipientSessionId,
      update: { ...message, senderMessageId: toolUseId } as AcpSessionNotification["update"],
    },
  ];
}

/**
 * The tool with which a child hands its report to its parent, when Claude
 * Code runs in hand-back mode. The Agent/Task result then only says that the
 * report was delivered as a message, with `handback: "send"` in its
 * structured result.
 */
export const HANDBACK_TOOL = "SubagentHandback";

/** The report of a SubagentHandback call, from its input. */
export function handbackMessage(input: unknown): string | undefined {
  const message = (input as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message.trim() ? message : undefined;
}

/**
 * The RFD form: the answer of a foreground child, from the completed result
 * of the Agent/Task call `launchId` that launched it, as the child's message
 * in the parent's transcript (its incoming view). It replaces that call's
 * result, which the parent is not shown. The child's transcript has its
 * answer as its own agent message, not as a session message, so this view
 * links to no other. `undefined` for a result without text. Not used for a
 * run whose child handed back its report: the result has no report then.
 */
export function launchReply(
  launchId: string,
  childSessionId: string,
  parentSessionId: string,
  result: Extract<
    AcpSessionNotification["update"],
    { sessionUpdate: "tool_call_update" | "tool_call" }
  >,
): AcpSessionNotification | undefined {
  const content = replyContent(result);
  if (content.length === 0) return undefined;
  return {
    sessionId: parentSessionId,
    update: {
      sessionUpdate: "session_message",
      messageId: `${launchId}:reply`,
      senderSessionId: childSessionId,
      recipientSessionId: parentSessionId,
      content,
    },
  };
}

/**
 * The text of a completed launch's result, from the tool call's `content`:
 * `AgentReporter` removed the parts meant for the model there (the
 * `agentId: … (use SendMessage …)` line, the `<usage>` block and the hand-back
 * frame), which `rawOutput` still has.
 */
function replyContent(
  result: Extract<
    AcpSessionNotification["update"],
    { sessionUpdate: "tool_call_update" | "tool_call" }
  >,
): Array<{ type: "text"; text: string }> {
  return (result.content ?? []).flatMap((item) =>
    item.type === "content" && item.content.type === "text" && item.content.text.trim()
      ? [{ type: "text" as const, text: item.content.text }]
      : [],
  );
}

/** Whether an Agent/Task call's input runs its child in the background. */
function isBackgroundLaunch(rawInput: unknown): boolean {
  return (
    typeof rawInput === "object" &&
    rawInput !== null &&
    (rawInput as { run_in_background?: unknown }).run_in_background === true
  );
}

/** The RFD form: whether the child's foreground work is in progress. */
function isWorking(child: NativeSubagent): boolean {
  return child.workState === "running" || child.workState === "requires_action";
}

/**
 * The RFD form: the work state at the end of a child's work.
 *
 * A failure is idle with the `error` stop reason and, when the SDK gives its
 * text, the JSON-RPC `error`, as the RFD asks: a v1 child has no prompt
 * response, so this is how a client learns that its work failed. The error is
 * an internal error, as for a failed turn on the v2 surface.
 *
 * A task that a worker restart orphaned, or that was still running when the
 * stream ended, is idle with no stop reason: its work ended, but the adapter
 * did not see a cancellation or a failure, which the RFD forbids claiming.
 */
export function rfdEndState(state: SubagentState, end: TaskEnd | undefined): WorkState {
  if (end?.unexplained || end?.reason === "worker_restart") return { state: "idle" };
  switch (state) {
    case "completed":
      return { state: "idle", stopReason: "end_turn" };
    case "cancelled":
      return { state: "idle", stopReason: "cancelled" };
    case "failed":
      return {
        state: "idle",
        stopReason: "error",
        ...(end?.error
          ? { error: { code: RequestError.internalError().code, message: end.error } }
          : {}),
      };
    default:
      // "disconnected": the child can no longer be observed.
      return { state: "unknown" };
  }
}

/**
 * The RFD form: the parent's labels for a child. The title is the agent's
 * name, with its role after it when both are known, else the role. The
 * description is the task's short description, never the prompt.
 */
export function rfdLabels(
  name: unknown,
  role: unknown,
  description: unknown,
): { title?: string; role?: string; description?: string } {
  const agentName = nonBlankString(name);
  const agentRole = nonBlankString(role);
  const title =
    agentName && agentRole && agentName !== agentRole
      ? `${agentName} (${agentRole})`
      : (agentName ?? agentRole);
  const text = nonBlankString(description);
  return {
    ...(title ? { title } : {}),
    ...(agentRole ? { role: agentRole } : {}),
    ...(text ? { description: text } : {}),
  };
}

/**
 * The agent id that a successful SendMessage result resumed. The SDK puts it
 * in `tool_use_result.resumedAgentId` when a finished agent runs again.
 */
export function resumedNativeSubagentId(toolUseResult: unknown): string | undefined {
  if (typeof toolUseResult !== "object" || toolUseResult === null) return undefined;
  const result = toolUseResult as { success?: unknown; resumedAgentId?: unknown };
  return result.success === true ? nonBlankString(result.resumedAgentId) : undefined;
}

/**
 * The SendMessage text that resumed the agent `agentId`. The tool uses of
 * `resultToolUseIds` come first: they are the SendMessage calls whose result
 * carried the resume. Otherwise the latest SendMessage call to `agentId` counts.
 */
export function sendMessageResumePrompt(
  toolUses: Record<string, { name: string; input: unknown } | undefined>,
  agentId: string,
  resultToolUseIds: readonly string[] = [],
): string | undefined {
  return sendMessageResume(toolUses, agentId, resultToolUseIds)?.text;
}

/**
 * The SendMessage call that resumed the agent `agentId`, and its text when it
 * has one; see {@link sendMessageResumePrompt}. The call is known even
 * without text, so a late result still names the delegation it reports.
 */
export function sendMessageResume(
  toolUses: Record<string, { name: string; input: unknown } | undefined>,
  agentId: string,
  resultToolUseIds: readonly string[] = [],
): { toolUseId: string; text?: string } | undefined {
  let withoutText: string | undefined;
  for (const toolUseId of resultToolUseIds) {
    const toolUse = toolUses[toolUseId];
    if (toolUse?.name !== "SendMessage") continue;
    const text = promptText((toolUse.input as { message?: unknown } | null)?.message);
    if (text) return { toolUseId, text };
    withoutText ??= toolUseId;
  }
  if (resultToolUseIds.length > 0) return withoutText ? { toolUseId: withoutText } : undefined;
  for (const [toolUseId, toolUse] of Object.entries(toolUses).reverse()) {
    if (toolUse?.name !== "SendMessage") continue;
    const input = toolUse.input as { to?: unknown; message?: unknown } | null;
    if (input?.to !== agentId) continue;
    const text = promptText(input.message);
    return text ? { toolUseId, text } : { toolUseId };
  }
  return undefined;
}

export function nativeSubagentState(status: unknown): SubagentState | undefined {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "disconnected") return "disconnected";
  if (status === "killed" || status === "cancelled" || status === "stopped") return "cancelled";
  return undefined;
}

export function isNativeSubagentControlUpdate(
  update: AcpSessionNotification["update"],
): update is Extract<
  AcpSessionNotification["update"],
  { sessionUpdate: "tool_call" | "tool_call_update" }
> {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return false;
  }
  const claudeMeta = update._meta?.claudeCode as { toolName?: string } | undefined;
  return (
    airExtensionMeta(update._meta)?.[AIR_SUBAGENT_KEY] === true ||
    isNativeSubagentControlTool(claudeMeta?.toolName)
  );
}

export function isNativeSubagentControlTool(toolName: unknown): boolean {
  return toolName === "Agent" || toolName === "Task";
}

/**
 * An async task update that may reach a child generation after it finished.
 * The spawn is one of them: a held task can get its tool call id, and so its
 * spawn, after the child finished.
 */
function isLateAsyncTaskUpdate(notification: AcpSessionNotification): boolean {
  const kind = notification.update.sessionUpdate;
  return (
    kind === "async_task_spawned" ||
    kind === "async_task_progress" ||
    kind === "async_task_state_update"
  );
}

function isFailedToolCallUpdate(update: AcpSessionNotification["update"]): boolean {
  return (
    (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
    update.status === "failed"
  );
}

/**
 * A tool call that the client was not shown, as one `tool_call` with its
 * final status, shown after all: an Agent/Task call whose child was never
 * exposed (AIR's draft shows only a failed one, the RFD form also a completed
 * one), a SendMessage call whose message reached no announced child, or a
 * failed SubagentHandback call.
 */
function unexposedControlFallback(
  initial: AcpSessionNotification | undefined,
  terminal: AcpSessionNotification,
  sessionId: string,
): AcpSessionNotification {
  if (
    terminal.update.sessionUpdate !== "tool_call" &&
    terminal.update.sessionUpdate !== "tool_call_update"
  ) {
    return { ...terminal, sessionId };
  }
  if (!initial || initial.update.sessionUpdate !== "tool_call") {
    const claudeMeta = terminal.update._meta?.claudeCode as { toolName?: unknown } | undefined;
    return {
      ...terminal,
      sessionId,
      update: {
        ...terminal.update,
        sessionUpdate: "tool_call",
        status: terminal.update.status ?? "failed",
        // The synthesized tool_call is this call's first report, so give it
        // the standard `name` the initial one would have carried.
        ...(typeof claudeMeta?.toolName === "string" ? { name: claudeMeta.toolName } : {}),
        title:
          typeof terminal.update.title === "string" && terminal.update.title.length > 0
            ? terminal.update.title
            : claudeMeta?.toolName === "Task"
              ? "Task"
              : "Agent",
        _meta: ordinaryToolMeta(terminal.update._meta),
      } as AcpSessionNotification["update"],
    };
  }
  return {
    ...initial,
    sessionId,
    update: {
      ...initial.update,
      ...terminal.update,
      sessionUpdate: "tool_call",
      status: terminal.update.status ?? "failed",
      title:
        typeof terminal.update.title === "string" && terminal.update.title.trim().length > 0
          ? terminal.update.title
          : initial.update.title,
      _meta: {
        ...initial.update._meta,
        ...terminal.update._meta,
        ...ordinaryToolMeta(initial.update._meta, terminal.update._meta),
      },
    } as AcpSessionNotification["update"],
  };
}

function ordinaryToolMeta(
  ...values: Array<Record<string, unknown> | null | undefined>
): Record<string, unknown> {
  const merged = Object.assign({}, ...values);
  const claudeCode = Object.assign(
    {},
    ...values.map(
      (value) => (value?.claudeCode as Record<string, unknown> | null | undefined) ?? {},
    ),
  );
  const result: Record<string, unknown> = { ...merged, claudeCode };
  const air = airExtensionMeta(merged);
  if (air && AIR_SUBAGENT_KEY in air) {
    const rest = { ...air };
    delete rest[AIR_SUBAGENT_KEY];
    result.jetbrains = { ...(merged.jetbrains as Record<string, unknown>), air: rest };
  }
  return result;
}

function subagentDisplayName(
  explicitName: unknown,
  description: unknown,
  type: unknown,
  taskId: string,
): string {
  for (const value of [explicitName, description, type]) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  const suffix = taskId.length > 8 ? taskId.slice(-8) : taskId;
  return `Agent ${suffix}`;
}

function subagentDescription(prompt: unknown, description: unknown): string {
  for (const value of [prompt, description]) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "Delegated task";
}

function subagentIdentity(input: unknown): SubagentIdentity | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const identity: SubagentIdentity = {
    name: nonBlankString(value.name),
    description: nonBlankString(value.description),
    prompt: promptText(value.prompt),
    subagentType: nonBlankString(value.subagent_type),
  };
  return Object.values(identity).some(Boolean) ? identity : undefined;
}

function mergeSubagentIdentity(
  previous: SubagentIdentity | undefined,
  next: SubagentIdentity,
): SubagentIdentity {
  return {
    name: next.name ?? previous?.name,
    description: next.description ?? previous?.description,
    prompt: next.prompt ?? previous?.prompt,
    subagentType: next.subagentType ?? previous?.subagentType,
  };
}

function applySubagentIdentity(
  child: NativeSubagent,
  identity: SubagentIdentity | undefined,
): void {
  if (!identity) return;
  if (identity.name || identity.description) {
    child.name = subagentDisplayName(
      identity.name,
      identity.description,
      identity.subagentType,
      child.sessionId,
    );
  }
  if (identity.prompt || identity.description) {
    child.task = subagentDescription(identity.prompt, identity.description);
  }
  child.prompt ??= identity.prompt;
  const labels = rfdLabels(
    identity.name,
    identity.subagentType ?? child.role,
    identity.description,
  );
  child.title = labels.title ?? child.title;
  child.role = labels.role ?? child.role;
  child.description = labels.description ?? child.description;
}

/** The prompt text unchanged, or `undefined` when it is not a non-blank string. */
function promptText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function promptField(prompt: string | undefined): { prompt?: string } {
  return prompt === undefined ? {} : { prompt };
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
