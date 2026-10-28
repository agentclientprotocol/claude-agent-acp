/**
 * The replay of subagents to a client on the subagents RFD form.
 *
 * Claude Code keeps each subagent's history in its own transcript, and the
 * subagent's metadata file names the Agent or Task call that launched it (see
 * `subagentHistory`). The replay announces each child right after that call,
 * under the session id it had live, the SDK agent id, and sends the child's
 * history to the child session. Every child's end goes out before the replay
 * ends. These states are history to the client, so each child's current
 * state goes out again after the load response (`currentStates`).
 *
 * As live, the parent is not shown the Agent or Task call of a child that the
 * replay announces: the launch's prompt is the parent's outgoing message, and
 * a foreground child's answer is its reply to the parent. A child's
 * successful SubagentHandback call is its message to the parent instead.
 * Unlike live, the replay does not tell runs apart, so a child that handed
 * back any report gets no reply from its launch's result.
 *
 * A SendMessage call whose message the replay delivered to a child before it
 * reached the call is that message too: the sender's outgoing view, at the
 * call, and the child's incoming one, in the child's history. A child's
 * history follows its launch, so a call to a child from its parent is always
 * delivered first. Any other SendMessage call stays a tool call.
 *
 * Right after its announcement, each child gets its `model` option: the model
 * of its first response, in its transcript. A later response with another
 * model sends it again. A child without responses gets none. After the load
 * response, a model goes again only when the session's model list, which the
 * replay can lack, maps it to another entry.
 *
 * A launch without metadata has no known id, so it is not announced: the RFD
 * forbids inventing one. Its Agent call stays an ordinary tool call of the
 * parent, and a notice says that subagent history is missing.
 */
import type { SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AcpSessionNotification, SubagentState } from "./acp-subagents.js";
import {
  childModelOption,
  HANDBACK_TOOL,
  handbackMessage,
  isNativeSubagentControlTool,
  launchReply,
  linkedSessionMessages,
  type ModelEntry,
  nativeSubagentState,
  responseModelEntry,
  rfdEndState,
  rfdLabels,
  type SubagentModels,
  type WorkState,
} from "./native-subagents.js";
import { noticeUpdate } from "./session-notices.js";
import type { SubagentHistory, SubagentRecord } from "./subagent-history.js";

type Publish = (notification: AcpSessionNotification) => Promise<void>;

/** A child that the replay shows: its launch has metadata. */
export type ReplayChild = {
  /** The Agent or Task tool use that launched it. */
  launchId: string;
  /** Its session id: the SDK agent id, as live. */
  sessionId: string;
  record: SubagentRecord;
  /** The session that made the launch. */
  parentSessionId: string;
  /** The input of the launch call. */
  input: Record<string, unknown>;
  /** How the launch's tool result ended a foreground child's run. */
  launchEnd?: SubagentState;
  /** The state of the child's last persisted task notification. */
  notified?: SubagentState;
  announced: boolean;
  promptSent: boolean;
  /** Whether it handed a report to its parent with a SubagentHandback call. */
  handedBack?: boolean;
  /** The `model` option entry that the replay sent. */
  model?: ModelEntry;
  /** The model id of the latest response in its transcript. */
  responseModel?: string;
};

type SendMessageCall = {
  toolUseId: string;
  to: string;
  message: string;
  senderSessionId: string;
  /** The child the replay delivered the message to. */
  recipientSessionId?: string;
  /** The replay reached the call before the delivery, so it stays a tool call. */
  shownAsToolCall: boolean;
  /** The sender's view of the message went out, at the call. */
  outgoingSent: boolean;
};

export class RfdSubagentReplay {
  /** The children by the id of the tool use that launched each. */
  private readonly children = new Map<string, ReplayChild>();
  private readonly byAgentId = new Map<string, ReplayChild>();
  private readonly sendMessages: SendMessageCall[] = [];
  /** Launches without metadata, which the replay leaves out. */
  private readonly omitted = new Set<string>();
  /** Children whose transcript could not be read: only their association is replayed. */
  private withoutHistory = 0;
  /** The SubagentHandback calls, with their report and whether their result failed. */
  private readonly handbacks = new Map<
    string,
    { message: string; failed: boolean; sent: boolean }
  >();

  constructor(
    private readonly history: SubagentHistory,
    private readonly publish: Publish,
    private readonly models?: SubagentModels,
    /**
     * Whether the replay maps a model to the session's model list as it goes.
     * A load lacks the list until the CLI started, so it maps only in
     * {@link currentStates}, after the load response.
     */
    private readonly mapsDuringReplay = true,
  ) {}

  /**
   * Registers the launches, the launch results, and the SendMessage calls in
   * `messages`, the transcript of the session `ownerSessionId`.
   */
  scan(messages: readonly SessionMessage[], ownerSessionId: string): void {
    for (const message of messages) {
      for (const block of contentBlocks(message)) {
        if (block.type === "tool_use" && typeof block.id === "string") {
          if (isNativeSubagentControlTool(block.name)) {
            this.registerLaunch(block.id, inputOf(block), ownerSessionId);
          } else if (block.name === HANDBACK_TOOL) {
            const message = handbackMessage(block.input);
            if (message) this.handbacks.set(block.id, { message, failed: false, sent: false });
          } else if (block.name === "SendMessage") {
            const input = inputOf(block);
            if (typeof input.to === "string" && typeof input.message === "string") {
              this.sendMessages.push({
                toolUseId: block.id,
                to: input.to,
                message: input.message,
                senderSessionId: ownerSessionId,
                shownAsToolCall: false,
                outgoingSent: false,
              });
            }
          }
        } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const handback = this.handbacks.get(block.tool_use_id);
          if (handback && block.is_error === true) handback.failed = true;
          const child = this.children.get(block.tool_use_id);
          // A background launch answers at once; its result is not the end.
          if (child && !child.record.background) {
            child.launchEnd = replaySubagentTerminalState(block);
          }
        }
      }
    }
  }

  /** The child that the tool use `toolUseId` launched, when the replay shows it. */
  childOfLaunch(toolUseId: string): ReplayChild | undefined {
    return this.children.get(toolUseId);
  }

  /**
   * Announces `child` on its parent, as live: running, with the parent's
   * labels. Then it sends `firstModel`, the model of the child's first
   * response, when the transcript has one.
   */
  async announce(child: ReplayChild, firstModel?: string): Promise<void> {
    if (child.announced) return;
    const labels = rfdLabels(
      child.record.name ?? child.input.name,
      child.record.agentType ?? child.input.subagent_type,
      child.record.description ?? child.input.description,
    );
    await this.publish({
      sessionId: child.parentSessionId,
      update: {
        sessionUpdate: "subagent_update",
        sessionId: child.sessionId,
        ...(labels.title ? { title: labels.title } : {}),
        ...(labels.description ? { description: labels.description } : {}),
        state: { state: "running" },
      },
    });
    child.announced = true;
    await this.responseModel(child, firstModel);
  }

  /**
   * Takes the model of a replayed response of the child `owner`. A child
   * whose model changes gets its `model` option again.
   */
  async responseModel(owner: ReplayChild, model: string | undefined): Promise<void> {
    const entry = responseModelEntry(model, this.mapsDuringReplay ? this.models : undefined);
    if (!entry || !owner.announced) return;
    owner.responseModel = model;
    await this.sendModel(owner, entry);
  }

  private async sendModel(child: ReplayChild, model: ModelEntry): Promise<void> {
    if (child.model?.value === model.value && child.model.name === model.name) return;
    child.model = model;
    await this.publish({
      sessionId: child.sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [childModelOption(model)],
      },
    });
  }

  /**
   * The rest of a child's user message to replay, or `null` when nothing is
   * left, after its text went out as the child's incoming `session_message`.
   *
   * A child session has no user, so the text of its user messages is never a
   * user message. The first text is the prompt of the launch. A message that
   * a SendMessage call delivered (`origin.kind: "coordinator"`) is another
   * incoming message. Any other text is harness text, such as "[Request
   * interrupted by user for tool use]", which the live child session does not
   * show. Tool results stay.
   */
  async childContent(
    child: ReplayChild,
    message: SessionMessage,
    content: unknown,
  ): Promise<unknown> {
    const text = textOf(content);
    if (text.trim()) {
      if (isDelivery(message)) await this.sendDelivery(child, message, text);
      else if (!child.promptSent) await this.sendPrompt(child, text);
    }
    if (!Array.isArray(content)) return null;
    const rest = content.filter(
      (block) => !(typeof block === "object" && block !== null && block.type === "text"),
    );
    return rest.length > 0 ? rest : null;
  }

  /**
   * Ends the replay of `child`'s history. `messages` is its transcript: when
   * it is empty, the replay has only the child's association, and the prompt
   * comes from the launch call.
   */
  async childReplayed(child: ReplayChild, messages: readonly SessionMessage[]): Promise<void> {
    if (messages.length === 0) this.withoutHistory++;
    if (!child.promptSent && typeof child.input.prompt === "string") {
      await this.sendPrompt(child, child.input.prompt);
    }
  }

  /**
   * Takes a replayed update of a tool call, from the transcript of `owner`
   * when it is a child's. Returns whether the client is not shown it: an
   * update of the launch of a child that the replay shows, of a SendMessage
   * call whose message the replay already delivered, or of a successful
   * SubagentHandback call of `owner`. A foreground launch's completed result
   * goes out as the child's reply, a delivered SendMessage as the sender's
   * outgoing message, and a hand-back as the child's message to its parent.
   */
  async toolCallUpdate(
    update: AcpSessionNotification["update"],
    owner: ReplayChild | undefined,
  ): Promise<boolean> {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      return false;
    }
    const sendMessage = this.sendMessages.find((call) => call.toolUseId === update.toolCallId);
    if (sendMessage) {
      if (sendMessage.recipientSessionId === undefined) {
        sendMessage.shownAsToolCall = true;
        return false;
      }
      if (!sendMessage.outgoingSent) {
        sendMessage.outgoingSent = true;
        const [outgoing] = linkedSessionMessages(
          sendMessage.toolUseId,
          sendMessage.senderSessionId,
          sendMessage.recipientSessionId,
          sendMessage.message,
        );
        if (outgoing) await this.publish(outgoing);
      }
      return true;
    }
    const handback = owner ? this.handbacks.get(update.toolCallId) : undefined;
    if (owner && handback && !handback.failed) {
      if (!handback.sent) {
        handback.sent = true;
        owner.handedBack = true;
        for (const view of linkedSessionMessages(
          update.toolCallId,
          owner.sessionId,
          owner.parentSessionId,
          handback.message,
        )) {
          await this.publish(view);
        }
      }
      return true;
    }
    const child = this.children.get(update.toolCallId);
    if (!child) return false;
    if (
      update.status === "completed" &&
      child.announced &&
      !child.record.background &&
      !child.handedBack
    ) {
      const reply = launchReply(child.launchId, child.sessionId, child.parentSessionId, update);
      if (reply) await this.publish(reply);
    }
    return true;
  }

  /**
   * Takes a persisted task notification. Returns whether it was a child's:
   * its task id is the agent id.
   */
  taskNotification(taskId: string, status: string): boolean {
    const child = this.byAgentId.get(taskId);
    if (!child) return false;
    child.notified = nativeSubagentState(status) ?? child.notified;
    return true;
  }

  /**
   * Sends the end of every announced child (see `endState`), and a notice when
   * subagent history is missing.
   */
  async finish(supportsNotices: boolean, rootSessionId: string): Promise<void> {
    for (const child of [...this.children.values()].reverse()) {
      if (!child.announced) continue;
      await this.publish({
        sessionId: child.parentSessionId,
        update: {
          sessionUpdate: "subagent_update",
          sessionId: child.sessionId,
          state: endState(child),
        },
      });
    }
    const missing = this.omitted.size + this.withoutHistory;
    if (missing > 0 && supportsNotices) {
      await this.publish({
        sessionId: rootSessionId,
        update: noticeUpdate({
          severity: "info",
          title: "Some subagent history is not available",
          description:
            missing === 1
              ? "The history of 1 subagent of this session could not be restored."
              : `The history of ${missing} subagents of this session could not be restored.`,
        }),
      });
    }
  }

  /**
   * The current state of each announced child, to send after the load
   * response. The RFD makes that response the freshness boundary: a client
   * treats the replayed states before it as history, so they show no current
   * activity and allow no cancel.
   *
   * `live` gives the work state of a child that still runs in this process, as
   * when a live session is loaded again. Such a child reports that state and
   * can be cancelled, as live. Any other child cannot be running, because the
   * process that ran it is gone, so its replayed end is its current state.
   */
  currentStates(
    live: (sessionId: string) => WorkState["state"] | undefined,
    liveConfiguration?: (sessionId: string) => SessionConfigOption[] | undefined,
  ): AcpSessionNotification[] {
    return [...this.children.values()]
      .filter((child) => child.announced)
      .flatMap((child): AcpSessionNotification[] => {
        const liveState = live(child.sessionId);
        const state: WorkState =
          liveState === undefined || liveState === "idle" ? endState(child) : { state: liveState };
        // The session's model list may be known only now, after the load response.
        const entry = responseModelEntry(child.responseModel, this.models);
        const replayed = child.model ? JSON.stringify([childModelOption(child.model)]) : undefined;
        const current =
          liveConfiguration?.(child.sessionId) ?? (entry ? [childModelOption(entry)] : undefined);
        // A configuration that the replay already sent does not go again.
        const configOptions = current && JSON.stringify(current) !== replayed ? current : undefined;
        return [
          {
            sessionId: child.parentSessionId,
            update: {
              sessionUpdate: "subagent_update",
              sessionId: child.sessionId,
              ...(liveState !== undefined ? { capabilities: { cancel: {} } } : {}),
              state,
            },
          },
          ...(configOptions
            ? [
                {
                  sessionId: child.sessionId,
                  update: { sessionUpdate: "config_option_update" as const, configOptions },
                },
              ]
            : []),
        ];
      });
  }

  private registerLaunch(
    toolUseId: string,
    input: Record<string, unknown>,
    parentSessionId: string,
  ): void {
    if (this.children.has(toolUseId)) return;
    const record = this.history.agents.get(toolUseId);
    if (!record) {
      this.omitted.add(toolUseId);
      return;
    }
    const child: ReplayChild = {
      launchId: toolUseId,
      sessionId: record.agentId,
      record,
      parentSessionId,
      input,
      announced: false,
      promptSent: false,
    };
    this.children.set(toolUseId, child);
    this.byAgentId.set(record.agentId, child);
  }

  /** The prompt of the launch, with the launch's id, to the parent and the child, as live. */
  private async sendPrompt(child: ReplayChild, text: string): Promise<void> {
    child.promptSent = true;
    for (const view of linkedSessionMessages(
      child.launchId,
      child.parentSessionId,
      child.sessionId,
      text,
    )) {
      await this.publish(view);
    }
  }

  /**
   * A message that a SendMessage call delivered. Claude Code frames it for the
   * child's model ("The coordinator sent a message while you were working:",
   * then the message, then an instruction), so the call it came from is the
   * first undelivered SendMessage to the child whose message the delivered
   * text contains. With that call, the message has the call's id and text and
   * its sender, as live; without it, its transcript id and the delivered text.
   * Unless the replay already showed the call as a tool call, the message
   * replaces it, so this view names the sender's view, which goes out at the
   * call (see {@link toolCallUpdate}).
   */
  private async sendDelivery(
    child: ReplayChild,
    message: SessionMessage,
    text: string,
  ): Promise<void> {
    const names = [child.sessionId, child.record.name, child.input.name];
    const call = this.sendMessages.find(
      (candidate) =>
        candidate.recipientSessionId === undefined &&
        names.includes(candidate.to) &&
        text.includes(candidate.message.trim()),
    );
    if (call) {
      call.recipientSessionId = child.sessionId;
      await this.sendMessage(child, call.toolUseId, call.message, call.senderSessionId, {
        linked: !call.shownAsToolCall,
      });
    } else {
      await this.sendMessage(child, message.uuid, text, undefined);
    }
  }

  private async sendMessage(
    child: ReplayChild,
    messageId: string,
    text: string,
    sender: string | undefined,
    { linked = false }: { linked?: boolean } = {},
  ): Promise<void> {
    await this.publish({
      sessionId: child.sessionId,
      update: {
        sessionUpdate: "session_message",
        messageId,
        ...(sender ? { senderSessionId: sender } : {}),
        recipientSessionId: child.sessionId,
        ...(linked ? { senderMessageId: messageId } : {}),
        content: [{ type: "text", text }],
      },
    });
  }
}

/** The model of the first response in `messages`, a subagent's transcript. */
export function firstResponseModel(messages: readonly SessionMessage[]): string | undefined {
  for (const message of messages) {
    if (message.type !== "assistant") continue;
    const model = (message.message as { model?: unknown } | undefined)?.model;
    if (typeof model === "string" && model && model !== "<synthetic>") return model;
  }
  return undefined;
}

/**
 * The end of a foreground launch from its tool result: an error result that
 * names a stop is a cancellation, any other error a failure.
 */
export function replaySubagentTerminalState(
  block: Record<string, unknown>,
): "completed" | "failed" | "cancelled" {
  if (block.is_error !== true) return "completed";
  const text = replayContentText(block.content).toLowerCase();
  return /\b(?:cancelled|canceled|interrupted|stopped|killed)\b/.test(text)
    ? "cancelled"
    : "failed";
}

/**
 * How `child`'s work ended: the state of its last task notification, else
 * `cancelled` for a child the user stopped, else the result of its foreground
 * launch, else `idle` with no stop reason.
 */
function endState(child: ReplayChild): WorkState {
  const end = child.notified ?? (child.record.stoppedByUser ? "cancelled" : child.launchEnd);
  return end ? rfdEndState(end, undefined) : { state: "idle" };
}

function replayContentText(value: unknown, seen = new Set<unknown>()): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => replayContentText(item, seen)).join(" ");
  const record = value as Record<string, unknown>;
  return [record.text, record.content, record.message]
    .map((item) => replayContentText(item, seen))
    .filter(Boolean)
    .join(" ");
}

function contentBlocks(message: SessionMessage): Record<string, unknown>[] {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  return Array.isArray(content)
    ? content.filter(
        (block): block is Record<string, unknown> => typeof block === "object" && block !== null,
      )
    : [];
}

function inputOf(block: Record<string, unknown>): Record<string, unknown> {
  return typeof block.input === "object" && block.input !== null
    ? (block.input as Record<string, unknown>)
    : {};
}

/** The text of user message content: a string, or its text blocks. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      typeof block === "object" && block !== null && block.type === "text" ? [block.text] : [],
    )
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

/** A message that a SendMessage call delivered to the child. */
function isDelivery(message: SessionMessage): boolean {
  return (message as { origin?: { kind?: unknown } | null }).origin?.kind === "coordinator";
}
