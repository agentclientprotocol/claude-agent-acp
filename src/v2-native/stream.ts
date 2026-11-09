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
import type { ContentBlock } from "@agentclientprotocol/sdk/unstable";
import type {
  SDKAssistantMessage,
  SDKMemoryRecallMessage,
  SDKPartialAssistantMessage,
  SDKToolProgressMessage,
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
import { isCompactSummaryMessage, replayCompactSummary } from "../context-compaction.js";
import { ClientCapabilities } from "../tool-calls/client-capabilities.js";
import { ToolCallFieldTracker } from "../tool-calls/field-tracker.js";
import { AcpToolCallRenderer } from "../tool-calls/renderer.js";
import { changedTaskPlanEntries, type TaskState } from "../tools.js";
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
  /** The session's Task* list (TaskCreate, TaskUpdate, TaskList), sent as plan updates. */
  readonly taskState: TaskState = new Map();
  /** The API ids of the assistant messages whose text streamed as deltas. */
  private readonly streamedMessages = new Set<string>();
  /** The id of the assistant message that is streaming. */
  private streamingMessageId: string | undefined;
  /** Whether any agent text went out since {@link resetAgentText}. */
  private agentText = false;
  /** During {@link replay}, the messages that it has cleared so far. */
  private replayCleared: Set<string> | undefined;

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

  /**
   * A tool's progress beat, on its tool call: the beat's own `tool_use_id`
   * when the client holds that call, else the call it runs in
   * (`parent_tool_use_id`), such as the Agent call of a subagent's tool or
   * a heartbeat's derived id. A beat for a call that returned is dropped.
   */
  toolProgress(message: SDKToolProgressMessage): void {
    const toolCallId = this.emittedToolCalls.has(message.tool_use_id)
      ? message.tool_use_id
      : message.parent_tool_use_id;
    if (toolCallId === null || !this.emittedToolCalls.has(toolCallId)) return;
    const beat = new AcpToolCallRenderer(V2_TOOL_CALL_CAPABILITIES).progress({
      toolCallId,
      toolName: message.tool_name,
      elapsedTimeSeconds: message.elapsed_time_seconds,
      subagentType: message.subagent_type,
      subagentRetry: message.subagent_retry,
    });
    if (this.toolCallFields.apply(beat)) this.emit([{ sessionId: this.sessionId, update: beat }]);
  }

  /** Claude Code recalled memories: a completed read tool call. */
  memoryRecall(message: SDKMemoryRecallMessage): void {
    this.emit([
      {
        sessionId: this.sessionId,
        update: new AcpToolCallRenderer(V2_TOOL_CALL_CAPABILITIES).memoryRecall(message),
      },
    ]);
  }

  /** The Task* list changed outside a tool result (the TaskCreated and TaskCompleted hooks). */
  taskPlanChanged(): void {
    const entries = changedTaskPlanEntries(this.taskState, false);
    if (entries)
      this.emit([{ sessionId: this.sessionId, update: { sessionUpdate: "plan", entries } }]);
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
        // A compaction's summary message replays as the completed compaction.
        // `emit` sends at once, before the call returns, so the update keeps
        // its place among the replayed messages.
        if (isCompactSummaryMessage(message) && message.uuid) {
          void replayCompactSummary(message, async (n) => this.emit([n]), {
            sessionId: this.sessionId,
          });
          continue;
        }
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
          taskState: this.taskState,
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

  /** The tool calls that the client holds without a final status. */
  private readonly unfinished = new Set<string>();

  /** Called with each live agent text chunk, for the session's title. */
  onAgentText: ((content: ContentBlock) => void) | undefined;

  private emit(notifications: AcpSessionNotification[]): void {
    for (const { update } of notifications) {
      const replaying = this.replayCleared !== undefined;
      if (update.sessionUpdate === "agent_message_chunk") {
        this.agentText = true;
        if (!replaying) this.onAgentText?.(update.content);
      }
      for (const v2Update of this.translator.updates(this.sessionId, update, replaying)) {
        const clear = this.replayCleared && replayClear(this.replayCleared, v2Update);
        if (clear) this.send(clear);
        if (v2Update.sessionUpdate === "tool_call_update" && !replaying) {
          const { toolCallId, status } = v2Update as { toolCallId: string; status?: string | null };
          if (status != null) {
            if (FINAL_STATUSES.has(status)) this.unfinished.delete(toolCallId);
            else this.unfinished.add(toolCallId);
          }
        }
        this.send(v2Update);
      }
    }
  }
}

type ToolCallFinalStatus = "completed" | "failed" | "cancelled";

const FINAL_STATUSES = new Set<string>(["completed", "failed", "cancelled"]);
