/**
 * The replay of subagents to a client on the subagents RFD form.
 *
 * Claude Code keeps each subagent's history in its own transcript, and the
 * subagent's metadata file names the Agent or Task call that launched it (see
 * `subagentHistory`). The replay announces each child right after that call,
 * under the session id it had live, the SDK agent id, and sends the child's
 * history to the child session. Every child's end goes out before the replay
 * ends, since no subagent from before the reload still runs.
 *
 * A launch without metadata has no known id, so it is not announced: the RFD
 * forbids inventing one. Its Agent call stays an ordinary tool call of the
 * parent, and a notice says that subagent history is missing.
 */
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AcpSessionNotification, SubagentState } from "./acp-subagents.js";
import {
  isNativeSubagentControlTool,
  nativeSubagentState,
  rfdEndState,
  rfdLabels,
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
};

type SendMessageCall = {
  toolUseId: string;
  to: string;
  message: string;
  senderSessionId: string;
  delivered: boolean;
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

  constructor(
    private readonly history: SubagentHistory,
    private readonly publish: Publish,
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
          } else if (block.name === "SendMessage") {
            const input = inputOf(block);
            if (typeof input.to === "string" && typeof input.message === "string") {
              this.sendMessages.push({
                toolUseId: block.id,
                to: input.to,
                message: input.message,
                senderSessionId: ownerSessionId,
                delivered: false,
              });
            }
          }
        } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
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

  /** Announces `child` on its parent, as live: running, with the parent's labels. */
  async announce(child: ReplayChild): Promise<void> {
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
   * Sends the end of every announced child, and a notice when subagent history
   * is missing. The end is the state of the child's last task notification,
   * else `cancelled` for a child the user stopped, else the result of its
   * foreground launch, else `idle` with no stop reason.
   */
  async finish(supportsNotices: boolean, rootSessionId: string): Promise<void> {
    for (const child of [...this.children.values()].reverse()) {
      if (!child.announced) continue;
      const end = child.notified ?? (child.record.stoppedByUser ? "cancelled" : child.launchEnd);
      const state: WorkState = end ? rfdEndState(end, undefined) : { state: "idle" };
      await this.publish({
        sessionId: child.parentSessionId,
        update: { sessionUpdate: "subagent_update", sessionId: child.sessionId, state },
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

  /** The prompt of the launch, with the launch's id, as live. */
  private async sendPrompt(child: ReplayChild, text: string): Promise<void> {
    child.promptSent = true;
    await this.sendMessage(child, child.launchId, text, child.parentSessionId);
  }

  /**
   * A message that a SendMessage call delivered. Claude Code frames it for the
   * child's model ("The coordinator sent a message while you were working:",
   * then the message, then an instruction), so the call it came from is the
   * first undelivered SendMessage to the child whose message the delivered
   * text contains. With that call, the message has the call's id and text and
   * its sender, as live; without it, its transcript id and the delivered text.
   */
  private async sendDelivery(
    child: ReplayChild,
    message: SessionMessage,
    text: string,
  ): Promise<void> {
    const names = [child.sessionId, child.record.name, child.input.name];
    const call = this.sendMessages.find(
      (candidate) =>
        !candidate.delivered &&
        names.includes(candidate.to) &&
        text.includes(candidate.message.trim()),
    );
    if (call) {
      call.delivered = true;
      await this.sendMessage(child, call.toolUseId, call.message, call.senderSessionId);
    } else {
      await this.sendMessage(child, message.uuid, text, undefined);
    }
  }

  private async sendMessage(
    child: ReplayChild,
    messageId: string,
    text: string,
    sender: string | undefined,
  ): Promise<void> {
    await this.publish({
      sessionId: child.sessionId,
      update: {
        sessionUpdate: "session_message",
        messageId,
        ...(sender ? { senderSessionId: sender } : {}),
        recipientSessionId: child.sessionId,
        content: [{ type: "text", text }],
      },
    });
  }
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
