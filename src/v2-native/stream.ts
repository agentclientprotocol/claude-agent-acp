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
import { V2_CANCELLED } from "../tool-calls/renderer.js";
import { replayClear, type V2UpdateTranslator } from "../v2/update-translator.js";

/** Every v2 client gets the same tool call reports: v2 diffs and display terminals. */
const V2_TOOL_CALL_CAPABILITIES = ClientCapabilities.from(undefined, { v2: true });

type AssistantContent = SDKAssistantMessage["message"]["content"];
type UserContent = SDKUserMessage["message"]["content"];

/**
 * Rewrites a v1 update of the output before it is translated: the updates it
 * returns go out instead, such as none for the Agent call of a child session
 * (see `tasks.ts`).
 */
export type OutputRoute = (notification: AcpSessionNotification) => AcpSessionNotification[];

/** What a replay asks of the session's subagents (see `subagent-replay.ts`). */
export interface ReplayHooks {
  /** Rewrites each replayed update, as {@link OutputRoute} does live. */
  route: OutputRoute;
  /** A message of the history was replayed, such as one that launched subagents. */
  replayed(message: SessionMessage): void;
  /**
   * The part of a user message's content to replay, or `null` for none. A
   * child's prompt replays as a `session_message` instead.
   */
  userContent?(message: SessionMessage, content: unknown): unknown;
}

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
  /** During {@link replay}, what the session's subagents ask of it. */
  private replayHooks: ReplayHooks | undefined;
  /** Set by the session's tasks: rewrites the live updates (see {@link OutputRoute}). */
  route: OutputRoute | undefined;

  constructor(
    readonly sessionId: string,
    private readonly cwd: string,
    private readonly translator: V2UpdateTranslator,
    private readonly send: (update: v2.SessionUpdate) => void,
    private readonly logger: Logger,
    /**
     * Whether this is a subagent's session. Its messages keep the
     * `parent_tool_use_id` of the Agent call that launched it, and its text
     * streams (`forwardSubagentText`).
     */
    private readonly subagent = false,
  ) {}

  /** Tool updates that a hook callback sends outside the stream (an Edit's diff). */
  private readonly hookClient = {
    sessionUpdate: async (notification: AcpSessionNotification) => this.emit([notification]),
  } as unknown as AcpClient;

  /** A partial assistant message: one event of the streaming API response. */
  streamEvent(message: SDKPartialAssistantMessage): void {
    // A subagent's stream goes to its own session (see `tasks.ts`).
    if (message.parent_tool_use_id !== null && !this.subagent) return;
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
   * A message that never streamed (a gateway without streaming) goes out
   * whole. A subagent's message on the root session goes without its text,
   * which belongs to the subagent's own session.
   *
   * A stream that an interrupt cut short leaves its tail out. The v1 core
   * diffs the text against the deltas to send that tail
   * (`unstreamedRemainder`); this core does not.
   */
  assistant(message: SDKAssistantMessage): void {
    const messageId = messageIdForGrouping(message);
    const streamed =
      message.message.id !== undefined && this.streamedMessages.delete(message.message.id);
    const dropText = streamed || (message.parent_tool_use_id !== null && !this.subagent);
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
   * `hooks` replays the subagents' own histories to their sessions.
   */
  replay(messages: SessionMessage[], hooks?: ReplayHooks): void {
    this.replayCleared = new Set();
    this.replayHooks = hooks;
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
          let content = stripLocalCommandMetadata(inner.content);
          if (content !== null && hooks?.userContent) content = hooks.userContent(message, content);
          if (content === null) continue;
          this.content(content as UserContent, "user", null, {
            messageId: message.uuid,
            replay: true,
          });
        }
        hooks?.replayed(message);
      }
    } finally {
      this.replayCleared = undefined;
      this.replayHooks = undefined;
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
   * With `exitTerminals`, a command's terminal exits with its call, with no
   * exit code. Returns the ids of the calls it ended.
   */
  finishUnfinished(
    status: "failed" | "cancelled",
    keep: ReadonlySet<string> = new Set(),
    { exitTerminals = false }: { exitTerminals?: boolean } = {},
  ): string[] {
    const finished: string[] = [];
    for (const toolCallId of [...this.unfinished]) {
      if (keep.has(toolCallId)) continue;
      this.unfinished.delete(toolCallId);
      finished.push(toolCallId);
      if (!exitTerminals) {
        this.send({ sessionUpdate: "tool_call_update", toolCallId, status });
        continue;
      }
      // The translator ignores `terminal_exit` for a call without a terminal.
      this.emit([
        {
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: status === "cancelled" ? V2_CANCELLED : status,
            _meta: { terminal_exit: { terminal_id: toolCallId, exit_code: null, signal: null } },
          },
        },
      ]);
    }
    return finished;
  }

  /** The tool calls that the client holds without a final status. */
  private readonly unfinished = new Set<string>();

  private emit(notifications: AcpSessionNotification[]): void {
    // A replay routes only what its hooks ask: the live routing tracks live calls.
    const route = this.replayCleared !== undefined ? this.replayHooks?.route : this.route;
    for (const { update } of route ? notifications.flatMap(route) : notifications) {
      if (update.sessionUpdate === "agent_message_chunk") this.agentText = true;
      const replaying = this.replayCleared !== undefined;
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
