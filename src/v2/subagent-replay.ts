/**
 * The replay of a session's subagents, for `session/resume` with
 * `replayFrom`, as the v1 core replays them (`RfdSubagentReplay`).
 *
 * Claude Code keeps each subagent's history in its own transcript, and its
 * metadata file names the Agent or Task call that launched it (see
 * `subagentHistory`). The replay announces each child right after that call,
 * under its live session id (the agent id), with no capabilities: it cannot
 * run again in this process. Then it sends the child's history to the child
 * session. As live, the parent is not shown the launch call: its prompt is
 * the parent's outgoing message, and a foreground child's answer its reply. A
 * child's successful SubagentHandback call is its message to the parent
 * instead. Unlike live, the replay does not tell runs apart, so a child that
 * handed back any report gets no reply from its launch's result.
 *
 * A SendMessage call whose message the replay delivered to a child before it
 * reached the call is that message too: the sender's outgoing view, at the
 * call, and the child's incoming one, in the child's history. A child's
 * history follows its launch, so a call to a child from its parent is always
 * delivered first. Any other SendMessage call stays a tool call.
 *
 * Every child's end goes out on its parent at the end of the replay, and
 * each announced child then gets its own `replay_complete`, as v2 requires.
 * These ends are history to the client: a `subagent_update` is an update of
 * the child's parent, so the parent's `replay_complete` is what separates a
 * replayed one from a current one. A child's own stream gets no state in the
 * replay: v2 forbids replaying a past `running` as current activity.
 *
 * Each child's current state goes out after the root's `replay_complete`,
 * which follows every other one, and before the resume's state snapshot
 * ({@link currentStates}): on its parent and on its own stream. A child that
 * works in the live session, on a resume of the active session, gets its
 * current state from the resume snapshot instead
 * (`SessionTasks.currentState`).
 *
 * The replay sends no `config_option_update` of a child: v2 asks an agent not
 * to replay a past one. Each child's configuration goes out after the root's
 * `replay_complete` too, following the child's current state (see
 * `currentChildConfiguration`).
 *
 * A launch without metadata has no known id, so it is not announced: the RFD
 * forbids inventing one. Its Agent call stays an ordinary tool call of the
 * parent, and a notice after the root's `replay_complete` says that subagent
 * history is missing, as it does for a child whose transcript cannot be read.
 */
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../logger.js";
import type { AcpSessionNotification } from "../acp-subagents.js";
import {
  launchReply,
  linkedSessionMessages,
  nativeSubagentState,
  rfdLabels,
  type SubagentModels,
} from "../native-subagents.js";
import {
  readSubagentMessages,
  subagentHistory,
  subagentLaunchIds,
  type SubagentHistory,
} from "../subagent-history.js";
import {
  currentChildConfiguration,
  deliveredCall,
  isDelivery,
  isDirectory,
  missingHistoryNotice,
  ReplayTranscript,
  replayEndState,
  textOf,
  trackResponseModel,
  type ReplayChild as SharedReplayChild,
} from "../subagent-replay.js";
import { taskNotificationsOf } from "../task-notifications.js";
import type { V2UpdateTranslator } from "./update-translator.js";
import { REPLAY_COMPLETE } from "./setup.js";
import { SessionOutput, type ReplayHooks } from "./stream.js";
import { sameDirectory } from "./tasks.js";

/** What the replay needs of its root session. */
export interface ReplayHost {
  readonly sessionId: string;
  readonly cwd: string;
  readonly logger: Logger;
  readonly translator: V2UpdateTranslator;
  /** Sends an update of the root session or one of its children. */
  send(notification: v2.UpdateSessionNotification): void;
  models(): SubagentModels;
}

/** What the live session knows of the replayed children. */
export interface LiveChildren {
  /** Whether the child session `sessionId` works in the live session now. */
  working(sessionId: string): boolean;
  /** The configuration that the client last got for the live child `sessionId`, if any. */
  configuration(sessionId: string): SessionConfigOption[] | undefined;
}

const NO_LIVE_CHILDREN: LiveChildren = { working: () => false, configuration: () => undefined };

/** A replayed child, with the output of its session once announced. */
type ReplayChild = SharedReplayChild & { output?: SessionOutput };

export class SubagentReplay {
  private readonly transcript: ReplayTranscript<ReplayChild>;
  /** Children whose transcript could not be read: only their association is replayed. */
  private withoutHistory = 0;
  private rootOutput: SessionOutput | undefined;

  private constructor(
    private readonly host: ReplayHost,
    private readonly history: SubagentHistory,
    /** The transcript of each child, by agent id. */
    private readonly transcripts: Map<string, SessionMessage[]>,
    private readonly live: LiveChildren,
  ) {
    this.transcript = new ReplayTranscript(history);
  }

  /**
   * Reads the subagent history that `messages`, the session's transcript,
   * launched, with every child's transcript. Undefined when it launched none.
   */
  static async load(
    host: ReplayHost,
    messages: SessionMessage[],
    live: LiveChildren = NO_LIVE_CHILDREN,
  ): Promise<SubagentReplay | undefined> {
    if (!messages.some((message) => launchIdsOf(message).length > 0)) return undefined;
    const history = await subagentHistory(host.sessionId);
    const transcripts = new Map<string, SessionMessage[]>();
    const queue = messages.flatMap(launchIdsOf);
    while (queue.length > 0) {
      const record = history.agents.get(queue.shift()!);
      if (!record || transcripts.has(record.agentId)) continue;
      const transcript = (
        await readSubagentMessages(host.sessionId, record.agentId, history, host.logger)
      ).map((message) => ({ ...message, parent_tool_use_id: null }));
      transcripts.set(record.agentId, transcript);
      queue.push(...transcript.flatMap(launchIdsOf));
    }
    return new SubagentReplay(host, history, transcripts, live);
  }

  /** The hooks of the replay of the root session's history (`messages`). */
  hooks(output: SessionOutput, messages: SessionMessage[]): ReplayHooks {
    this.rootOutput = output;
    this.transcript.scan(messages, output.sessionId);
    return this.ownerHooks(output, undefined);
  }

  /** Whether the replay announced the child session `sessionId`. */
  announced(sessionId: string): boolean {
    return this.transcript.byAgentId.get(sessionId)?.announced === true;
  }

  /**
   * Ends the replay of the children. Every child's end goes out on its
   * parent, whose history it is. Then each announced child gets its
   * `replay_complete`, also one without history. The caller sends the root's
   * `replay_complete` next, then the current states ({@link currentStates}).
   */
  finish(): void {
    const announced = [...this.transcript.children.values()].filter((child) => child.announced);
    for (const child of [...announced].reverse()) {
      this.host.send({
        sessionId: child.parentSessionId,
        update: {
          sessionUpdate: "subagent_update",
          sessionId: child.sessionId,
          state: replayEndState(child) as v2.StateUpdate,
        },
      });
    }
    for (const child of announced) {
      this.host.send({ sessionId: child.sessionId, update: REPLAY_COMPLETE });
    }
  }

  /**
   * The notice when subagent history is missing, on the root session. It is
   * no history, so the caller sends the root's `replay_complete` first.
   */
  reportMissingHistory(): void {
    const missing = this.transcript.omitted.size + this.withoutHistory;
    if (missing > 0) {
      this.rootOutput?.emitV1([
        { sessionId: this.host.sessionId, update: missingHistoryNotice(missing) },
      ]);
    }
  }

  /**
   * What is current of the replayed children. The caller sends it after the
   * root's `replay_complete`, so every child's parent has sent its own, and
   * before the resume's state snapshot.
   *
   * The current state of each replayed child that does not work in the live
   * session: its work ended, or its process is gone, so its replayed end, on
   * its parent and on its own stream. A `cwd` that is gone, such as a
   * worktree that Claude Code removed, is cleared. Then each replayed child's
   * configuration (see `currentChildConfiguration`): the live child's, else
   * the model of its latest response, by the session's model list.
   *
   * The v1 core sends the same after the response (`currentStates`): on v1
   * the response is what separates a replayed child state from a current one.
   */
  currentStates(): void {
    for (const child of this.transcript.children.values()) {
      if (!child.announced) continue;
      if (!this.live.working(child.sessionId)) this.sendEndState(child);
      this.sendConfiguration(child);
    }
  }

  private sendConfiguration(child: ReplayChild): void {
    const configOptions = currentChildConfiguration(
      child,
      this.live.configuration(child.sessionId),
      this.host.models(),
    );
    if (!configOptions) return;
    child.output!.emitV1([
      {
        sessionId: child.sessionId,
        update: { sessionUpdate: "config_option_update", configOptions },
      },
    ]);
  }

  private sendEndState(child: ReplayChild): void {
    const state = replayEndState(child);
    this.host.send({
      sessionId: child.parentSessionId,
      update: {
        sessionUpdate: "subagent_update",
        sessionId: child.sessionId,
        ...(child.cwd && !isDirectory(child.cwd) ? { cwd: null } : {}),
        state: state as v2.StateUpdate,
      },
    });
    this.host.send({
      sessionId: child.sessionId,
      update: { sessionUpdate: "state_update", ...state } as v2.SessionUpdate,
    });
  }

  private ownerHooks(output: SessionOutput, owner: ReplayChild | undefined): ReplayHooks {
    return {
      route: (notification) => this.route(notification, output, owner),
      replaying: (message) => this.replaying(message, owner),
      replayed: (message) => this.replayed(message, output),
      ...(owner
        ? { userContent: (message, content) => this.childContent(owner, message, content) }
        : {}),
    };
  }

  /**
   * A replayed update of a tool call of `output`, the session of `owner`
   * when it is a child's. The client is not shown the launch of a replayed
   * child, a SendMessage call whose message the replay delivered, or a
   * pending or successful SubagentHandback call: a foreground launch's completed result
   * goes out as the child's reply, a delivered SendMessage as the sender's
   * outgoing message, and a hand-back as the child's message to its parent.
   */
  private route(
    notification: AcpSessionNotification,
    output: SessionOutput,
    owner: ReplayChild | undefined,
  ): AcpSessionNotification[] {
    const { update } = notification;
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      return [notification];
    }
    const sendMessage = this.transcript.sendMessages.find(
      (call) => call.toolUseId === update.toolCallId,
    );
    if (sendMessage) {
      if (sendMessage.recipientSessionId === undefined) {
        sendMessage.shownAsToolCall = true;
        return [this.transcript.withTarget(notification, output.sessionId)];
      }
      if (sendMessage.outgoingSent) return [];
      sendMessage.outgoingSent = true;
      const [outgoing] = linkedSessionMessages(
        sendMessage.toolUseId,
        sendMessage.senderSessionId,
        sendMessage.recipientSessionId,
        sendMessage.message,
      );
      return [outgoing!];
    }
    const handback = owner ? this.transcript.handbackUpdate(update) : undefined;
    if (owner && handback !== undefined) {
      if (handback === null) return [];
      owner.handedBack = true;
      const [outgoing, incoming] = linkedSessionMessages(
        update.toolCallId,
        owner.sessionId,
        owner.parentSessionId,
        handback.text,
      );
      // Sent here, in order: an output routes each update once the ones before it went out.
      output.emitV1([outgoing!]);
      this.outputOf(owner.parentSessionId)?.emitV1([incoming!]);
      return [];
    }
    const child = this.transcript.children.get(update.toolCallId);
    if (!child) return [this.transcript.withTarget(notification, output.sessionId)];
    if (
      update.status === "completed" &&
      child.announced &&
      !child.record.background &&
      !child.handedBack
    ) {
      const reply = launchReply(child.launchId, child.sessionId, child.parentSessionId, update);
      if (reply) return [reply];
    }
    return [];
  }

  /**
   * Before a message of `owner`'s history (the root's when undefined): the
   * model of a child's response is its latest one (see `trackResponseModel`),
   * and a persisted task notification of a child is the state its work ended
   * in.
   */
  private replaying(message: SessionMessage, owner: ReplayChild | undefined): void {
    const inner = message.message as { model?: unknown; content?: unknown } | undefined;
    if (message.type === "assistant") {
      if (owner) trackResponseModel(owner, inner?.model);
      return;
    }
    for (const notification of taskNotificationsOf(inner?.content)) {
      const child = [...this.transcript.children.values()].find(
        (c) => c.sessionId === notification.task_id,
      );
      if (child) child.notified = nativeSubagentState(notification.status) ?? child.notified;
    }
  }

  /** After a message that launched children: each is announced, and its history replays. */
  private replayed(message: SessionMessage, parent: SessionOutput): void {
    if (message.type !== "assistant") return;
    for (const launchId of launchIdsOf(message)) {
      const child = this.transcript.children.get(launchId);
      if (!child || child.announced) continue;
      const messages = this.transcripts.get(child.sessionId) ?? [];
      if (messages.length === 0) this.withoutHistory++;
      this.announce(child);
      this.transcript.scan(messages, child.sessionId);
      child.output!.replay(messages, this.ownerHooks(child.output!, child));
      if (!child.promptSent && typeof child.input.prompt === "string") {
        this.sendPrompt(child, parent, child.input.prompt);
      }
    }
  }

  private announce(child: ReplayChild): void {
    const labels = rfdLabels(
      child.record.name ?? child.input.name,
      child.record.agentType ?? child.input.subagent_type,
      child.record.description ?? child.input.description,
    );
    const parentCwd = this.cwdOf(child.parentSessionId);
    child.cwd =
      child.record.cwd && !sameDirectory(child.record.cwd, parentCwd)
        ? child.record.cwd
        : undefined;
    child.announced = true;
    this.host.send({
      sessionId: child.parentSessionId,
      update: {
        sessionUpdate: "subagent_update",
        sessionId: child.sessionId,
        ...(labels.title ? { title: labels.title } : {}),
        ...(labels.description ? { description: labels.description } : {}),
        ...(child.cwd ? { cwd: child.cwd } : {}),
        state: { state: "running" },
      },
    });
    child.output = new SessionOutput(
      child.sessionId,
      child.cwd ?? parentCwd,
      this.host.translator,
      (update) => this.host.send({ sessionId: child.sessionId, update }),
      this.host.logger,
      true,
    );
  }

  /**
   * The rest of a child's user message to replay, or `null` when nothing is
   * left, after its text went out as the child's incoming `session_message`.
   * The first text is the prompt of the launch. A message that a SendMessage
   * call delivered (`origin.kind: "coordinator"`) is another incoming
   * message. Any other text is Claude Code's, such as "[Request interrupted
   * by user]", which the live child session does not show. Tool results stay.
   */
  private childContent(child: ReplayChild, message: SessionMessage, content: unknown): unknown {
    const text = textOf(content);
    if (text.trim()) {
      if (isDelivery(message)) this.sendDelivery(child, message, text);
      else if (!child.promptSent) {
        const parent = this.outputOf(child.parentSessionId);
        if (parent) this.sendPrompt(child, parent, text);
      }
    }
    if (!Array.isArray(content)) return null;
    const rest = content.filter(
      (block) => !(typeof block === "object" && block !== null && block.type === "text"),
    );
    return rest.length > 0 ? rest : null;
  }

  /**
   * A message that a SendMessage call delivered to `child` (see
   * `deliveredCall`). With the call, the message has the call's id and text
   * and its sender, as live, and, unless the replay already showed the call
   * as a tool call, it replaces the call: the sender's view goes out at the
   * call (see {@link route}). Without the call, it has its transcript id and
   * the delivered text.
   */
  private sendDelivery(child: ReplayChild, message: SessionMessage, text: string): void {
    const call = deliveredCall(
      this.transcript.sendMessages,
      [child.sessionId, child.record.name, child.input.name],
      text,
    );
    if (call) call.recipientSessionId = child.sessionId;
    const messageId = call?.toolUseId ?? message.uuid;
    const linked = call !== undefined && !call.shownAsToolCall;
    child.output!.emitV1([
      {
        sessionId: child.sessionId,
        update: {
          sessionUpdate: "session_message",
          messageId,
          ...(call ? { senderSessionId: call.senderSessionId } : {}),
          recipientSessionId: child.sessionId,
          ...(linked ? { senderMessageId: messageId } : {}),
          content: [{ type: "text", text: call?.message ?? text }],
        },
      },
    ]);
  }

  private sendPrompt(child: ReplayChild, parent: SessionOutput, text: string): void {
    child.promptSent = true;
    const [outgoing, incoming] = linkedSessionMessages(
      child.launchId,
      child.parentSessionId,
      child.sessionId,
      text,
    );
    parent.emitV1([outgoing!]);
    child.output!.emitV1([incoming!]);
  }

  private outputOf(sessionId: string): SessionOutput | undefined {
    if (sessionId === this.host.sessionId) return this.rootOutput;
    return [...this.transcript.children.values()].find((child) => child.sessionId === sessionId)
      ?.output;
  }

  private cwdOf(sessionId: string): string {
    const child = [...this.transcript.children.values()].find((c) => c.sessionId === sessionId);
    if (!child) return this.host.cwd;
    return child.cwd ?? this.cwdOf(child.parentSessionId);
  }
}

function launchIdsOf(message: SessionMessage): string[] {
  if (message.type !== "assistant") return [];
  return subagentLaunchIds((message.message as { content?: unknown } | undefined)?.content);
}
