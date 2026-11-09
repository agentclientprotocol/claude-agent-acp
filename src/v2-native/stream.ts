/**
 * The output of one Claude Code session, as ACP session updates.
 *
 * {@link SessionOutput} maps the SDK's content messages (stream events,
 * consolidated assistant messages, tool results) through the shared mapping
 * of `acp-agent.ts` (`toAcpNotifications`), whose v1 updates the connection's
 * {@link V2UpdateTranslator} turns into v2 updates. It knows nothing about
 * prompts or turns: the session decides what the output belongs to.
 */
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  isReplayHiddenMetaMessage,
  messageIdForGrouping,
  stripLocalCommandMetadata,
  streamEventToAcpNotifications,
  toAcpNotifications,
  type AcpClient,
  type Logger,
  type StreamedToolInputCache,
  type ToolUseCache,
} from "../acp-agent.js";
import type { AcpSessionNotification } from "../acp-subagents.js";
import { ClientCapabilities } from "../tool-calls/client-capabilities.js";
import { ToolCallFieldTracker } from "../tool-calls/field-tracker.js";
import { AcpToolCallRenderer } from "../tool-calls/renderer.js";
import { replayClear, type V2UpdateTranslator } from "../v2/update-translator.js";

/** Every v2 client gets the same tool call reports: v2 diffs and display terminals. */
const V2_TOOL_CALL_CAPABILITIES = ClientCapabilities.from(undefined, { v2: true });

type AssistantContent = SDKAssistantMessage["message"]["content"];
type UserContent = SDKUserMessage["message"]["content"];

export class SessionOutput {
  private readonly toolUseCache: ToolUseCache = {};
  private readonly emittedToolCalls = new Set<string>();
  /** What the client holds of each open tool call: an update carries only what changed. */
  private readonly toolCallFields = new ToolCallFieldTracker();
  private readonly streamedToolInputs: StreamedToolInputCache = new Map();
  /** The API ids of the assistant messages whose text streamed as deltas. */
  private readonly streamedMessages = new Set<string>();
  /** The id of the assistant message that is streaming. */
  private streamingMessageId: string | undefined;
  /** Whether any agent text went out since {@link resetAgentText}. */
  private agentText = false;
  /** During {@link replay}, the messages that it has cleared so far. */
  private replayCleared: Set<string> | undefined;
  /** The open tool calls whose tool use reached a complete assistant message: Claude Code runs them. */
  private readonly dispatched = new Set<string>();
  /**
   * Whether the tool results come from work that a `session/cancel` stopped:
   * an error result then ends a run that the cancel aborted (`cancelled`).
   */
  cancelled = false;

  constructor(
    readonly sessionId: string,
    private readonly cwd: string,
    private readonly translator: V2UpdateTranslator,
    private readonly send: (update: v2.SessionUpdate) => void,
    private readonly logger: Logger,
  ) {}

  /** Tool updates that a hook callback sends outside the stream (an Edit's diff). */
  private readonly hookClient = {
    sessionUpdate: async (notification: AcpSessionNotification) => this.emit([notification]),
  } as unknown as AcpClient;

  /** A partial assistant message: one event of the streaming API response. */
  streamEvent(message: SDKPartialAssistantMessage): void {
    // A subagent's text streams only with `forwardSubagentText`, which this
    // core leaves off: its tool calls come with its consolidated messages.
    if (message.parent_tool_use_id !== null) return;
    if (message.event.type === "message_start") {
      this.streamingMessageId = message.event.message.id;
      this.streamedMessages.add(message.event.message.id);
    }
    this.emit(
      streamEventToAcpNotifications(
        message,
        this.sessionId,
        this.toolUseCache,
        this.hookClient,
        this.logger,
        {
          toolCallCapabilities: V2_TOOL_CALL_CAPABILITIES,
          cwd: this.cwd,
          emittedToolCalls: this.emittedToolCalls,
          toolCallFields: this.toolCallFields,
          messageId: this.streamingMessageId,
          streamedToolInputs: this.streamedToolInputs,
        },
      ),
    );
  }

  /**
   * A consolidated assistant message. Its text and thinking streamed already
   * when the message's stream started (`message_start` with the same id),
   * so only its other blocks go out: a tool use then gets its complete input.
   * A message that never streamed (a gateway without streaming, a subagent)
   * goes out whole, a subagent's without its text, as it streamed none.
   *
   * A stream that an interrupt cut short leaves its tail out. The v1 core
   * diffs the text against the deltas to send that tail
   * (`unstreamedRemainder`); this core does not.
   */
  assistant(message: SDKAssistantMessage): void {
    const messageId = messageIdForGrouping(message);
    for (const block of message.message.content) {
      if (block.type === "tool_use") this.dispatched.add(block.id);
    }
    const streamed =
      message.message.id !== undefined && this.streamedMessages.delete(message.message.id);
    const dropText = streamed || message.parent_tool_use_id !== null;
    const content = dropText
      ? message.message.content.filter(
          (block) => block.type !== "text" && block.type !== "thinking",
        )
      : message.message.content;
    this.content(content, "assistant", message.parent_tool_use_id, { messageId });
  }

  /**
   * A user message that Claude Code adds: the results of tool uses. Its other
   * blocks (command output, reminders, a prompt's echo) are not output.
   * `transform` rewrites each update before it goes out, such as a background
   * command's result, whose terminal keeps running.
   */
  toolResults(
    message: SDKUserMessage,
    transform: (notification: AcpSessionNotification) => AcpSessionNotification = (n) => n,
  ): void {
    if (!Array.isArray(message.message.content)) return;
    const results = message.message.content.filter((block) => block.type === "tool_result");
    if (results.length === 0) return;
    this.content(
      results,
      "user",
      message.parent_tool_use_id,
      {
        toolUseResult: message.tool_use_result,
        toolResultMeta: (message as { tool_result_meta?: unknown }).tool_result_meta,
        cancelled: this.cancelled,
      },
      transform,
    );
  }

  /** The tool uses of the session's tool calls, by id. */
  toolUses(): Readonly<ToolUseCache> {
    return this.toolUseCache;
  }

  /** Sends v1-shaped updates of the session, as the shared mapping makes them. */
  emitV1(notifications: AcpSessionNotification[]): void {
    this.emit(notifications);
  }

  /** Sets the status of a tool call, such as a background task's when it ends. */
  toolCallStatus(toolCallId: string, status: "in_progress" | "paused" | ToolCallFinalStatus): void {
    if (FINAL_STATUSES.has(status)) this.unfinished.delete(toolCallId);
    this.send({ sessionUpdate: "tool_call_update", toolCallId, status } as v2.SessionUpdate);
  }

  /**
   * Replays the stored history of the session: its prompts, Claude's
   * messages and its tool calls, as the live session sent them. Subagent
   * transcripts are left out, as live. The client may hold the replayed
   * messages already, so each message is cleared before its first chunk.
   */
  replay(messages: SessionMessage[]): void {
    this.replayCleared = new Set();
    try {
      for (const message of messages) {
        if (message.parent_tool_use_id !== null || isReplayHiddenMetaMessage(message)) continue;
        const inner = message.message as { id?: string; content?: unknown };
        if (message.type === "assistant" && Array.isArray(inner.content)) {
          this.content(inner.content as AssistantContent, "assistant", null, {
            messageId: inner.id ?? message.uuid,
            replay: true,
          });
        } else if (message.type === "user" && inner.content !== undefined) {
          // `null`: the message was command metadata alone.
          const content = stripLocalCommandMetadata(inner.content);
          if (content === null) continue;
          this.content(content as UserContent, "user", null, {
            messageId: message.uuid,
            replay: true,
          });
        }
      }
    } finally {
      this.replayCleared = undefined;
    }
  }

  /** Agent text that is not a model message, such as a local command's result. */
  agentMessage(text: string, messageId: string): void {
    this.content(text, "assistant", null, { messageId });
  }

  /** Whether agent text went out since the last {@link resetAgentText}. */
  hasAgentText(): boolean {
    return this.agentText;
  }

  resetAgentText(): void {
    this.agentText = false;
  }

  private content(
    content: Parameters<typeof toAcpNotifications>[0],
    role: "assistant" | "user",
    parentToolUseId: string | null,
    options: {
      messageId?: string;
      toolUseResult?: unknown;
      toolResultMeta?: unknown;
      cancelled?: boolean;
      replay?: boolean;
    },
    transform: (notification: AcpSessionNotification) => AcpSessionNotification = (n) => n,
  ): void {
    this.emit(
      toAcpNotifications(
        content,
        role,
        this.sessionId,
        this.toolUseCache,
        this.hookClient,
        this.logger,
        {
          toolCallCapabilities: V2_TOOL_CALL_CAPABILITIES,
          cwd: this.cwd,
          emittedToolCalls: this.emittedToolCalls,
          toolCallFields: this.toolCallFields,
          parentToolUseId,
          // A replayed tool use runs no hook that could report its result.
          registerHooks: !options.replay,
          ...options,
        },
      ).map(transform),
    );
  }

  /**
   * Gives each tool call that has no final status yet the final `status`,
   * except those in `keep` (background work, which goes on). For the end of
   * stopped work: v2 asks for a final status of its tool calls before the idle.
   */
  finishUnfinished(status: "failed" | "cancelled", keep: ReadonlySet<string> = new Set()): void {
    for (const toolCallId of [...this.unfinished]) {
      if (keep.has(toolCallId)) continue;
      this.unfinished.delete(toolCallId);
      this.send({ sessionUpdate: "tool_call_update", toolCallId, status });
    }
  }

  /**
   * Ends the open tool calls that will get no result, for the end of the work
   * (see `AcpToolCallRenderer.unfinished`), before its idle. After a cancel
   * (`stopped`), every open call ends `cancelled`. Otherwise only the calls
   * that Claude dropped before they ran end, `cancelled` too: a streamed
   * tool_use that no complete message holds. A call that runs, such as one in
   * the background, gets Claude Code's result. A command's report also ends
   * its terminal. The call is forgotten, so a late result changes nothing.
   */
  closeUnfinished(stopped: boolean): void {
    const renderer = new AcpToolCallRenderer(V2_TOOL_CALL_CAPABILITIES);
    for (const toolCallId of [...this.unfinished]) {
      const ran = this.dispatched.has(toolCallId);
      if (ran && !stopped) continue;
      const report = renderer.unfinished({ toolCallId, ran, cancelled: stopped });
      const toolUse = this.toolUseCache[toolCallId];
      const terminalExit = toolUse && renderer.terminalExit(toolUse);
      if (terminalExit) report._meta = { ...report._meta, ...terminalExit };
      this.emittedToolCalls.delete(toolCallId);
      delete this.toolUseCache[toolCallId];
      this.toolCallFields.delete(toolCallId);
      this.emit([{ sessionId: this.sessionId, update: report }]);
    }
  }

  /** The tool calls that the client holds without a final status. */
  private readonly unfinished = new Set<string>();

  private emit(notifications: AcpSessionNotification[]): void {
    for (const { update } of notifications) {
      if (update.sessionUpdate === "agent_message_chunk") this.agentText = true;
      const replaying = this.replayCleared !== undefined;
      for (const v2Update of this.translator.updates(this.sessionId, update, replaying)) {
        const clear = this.replayCleared && replayClear(this.replayCleared, v2Update);
        if (clear) this.send(clear);
        if (v2Update.sessionUpdate === "tool_call_update" && !replaying) {
          const { toolCallId, status } = v2Update as { toolCallId: string; status?: string | null };
          if (status != null) {
            if (FINAL_STATUSES.has(status)) {
              this.unfinished.delete(toolCallId);
              this.dispatched.delete(toolCallId);
            } else {
              this.unfinished.add(toolCallId);
            }
          }
        }
        this.send(v2Update);
      }
    }
  }
}

type ToolCallFinalStatus = "completed" | "failed" | "cancelled";

const FINAL_STATUSES = new Set<string>(["completed", "failed", "cancelled"]);
