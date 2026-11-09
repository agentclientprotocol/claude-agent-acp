/**
 * The mapping of Claude Code output to ACP session updates: content blocks
 * (`toAcpNotifications`) and partial stream events
 * (`streamEventToAcpNotifications`) become message chunks, thoughts, tool
 * calls and plans. The live stream and the `session/load` replay of both
 * protocol versions use it; v2 converts the v1 updates it returns.
 */
import type { ClientCapabilities, SessionNotification } from "@agentclientprotocol/sdk/unstable";
import type { SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type {
  BetaContentBlock,
  BetaRawContentBlockDelta,
} from "@anthropic-ai/sdk/resources/beta.mjs";
import type { AcpClient } from "./acp-client.js";
import { clientSupportsSubagents } from "./acp-subagents.js";
import { approvedPlan, planModeUpdate } from "./exit-plan.js";
import type { Logger } from "./logger.js";
import { checklistPlanUpdate, todoWritePlanUpdate, type SubagentChecklists } from "./plans.js";
import { ClientCapabilities as ToolCallClientCapabilities } from "./tool-calls/client-capabilities.js";
import type { ToolCallFieldTracker } from "./tool-calls/field-tracker.js";
import { AcpToolCallRenderer, type ToolUpdateMeta } from "./tool-calls/renderer.js";
import { parseToolResultMeta } from "./tool-result-meta.js";
import {
  applyTaskCreate,
  applyTaskList,
  applyTaskUpdate,
  changedTaskPlanEntries,
  type ClaudePlanEntry,
  completeHookCallback,
  hasHookCallback,
  parseTaskCreateOutput,
  parseTaskListOutput,
  parseTaskUpdateOutput,
  planEntries,
  registerHookCallback,
  type TaskState,
  unregisterHookCallback,
} from "./tools.js";
import { unreachable } from "./utils.js";

/** Attributes a report to the Agent/Task tool call of the subagent that made it. */
export function stampParentToolUseId(
  update: SessionNotification["update"],
  parentToolUseId: string,
) {
  update._meta = {
    ...update._meta,
    claudeCode: {
      ...((update._meta?.claudeCode as Record<string, unknown> | undefined) ?? {}),
      parentToolUseId,
    },
  };
}

export type ToolUseCache = {
  [key: string]: {
    type: "tool_use" | "server_tool_use" | "mcp_tool_use";
    id: string;
    name: string;
    input: unknown;
  };
};

type StreamedToolInput = {
  id: string;
  name: string;
  partialJson: string;
  inString: boolean;
  escaped: boolean;
  objectDepth: number;
  arrayDepth: number;
  /** Offset of the most recent comma at the top level of the input object
   *  (-1 before the first). Everything before it is a complete field. */
  lastTopLevelComma: number;
  /** The comma offset the last emitted refinement was sliced at (-1 before the
   *  first), so a field boundary only triggers one recovery attempt. */
  emittedThroughComma: number;
};

export type StreamedToolInputCache = Map<string, Map<number, StreamedToolInput>>;

/**
 * Advance the lexer state across the fragment appended since the last delta:
 * just enough JSON awareness (string/escape, nesting depth) to spot commas
 * that sit at the top level of the input object — everything before such a
 * comma is a set of complete fields. Returns true once the input object's
 * closing brace arrives.
 *
 * The lexer reads the fragment itself, never `partialJson` by index. V8 keeps a
 * string built with `+=` as a chain of parts, and the first index access
 * copies the whole chain into one flat string. An index scan of `partialJson`
 * would copy the whole input on each delta, so a large Write would cost
 * quadratic time. A test in `acp-agent.test.ts` checks this.
 */
function scanStreamedToolInput(state: StreamedToolInput, fragment: string): boolean {
  const offset = state.partialJson.length;
  state.partialJson += fragment;
  let complete = false;
  for (let index = 0; index < fragment.length; index++) {
    const character = fragment[index];
    if (state.inString) {
      if (state.escaped) {
        state.escaped = false;
      } else if (character === "\\") {
        state.escaped = true;
      } else if (character === '"') {
        state.inString = false;
      }
      continue;
    }

    if (character === '"') {
      state.inString = true;
    } else if (character === "{") {
      state.objectDepth++;
    } else if (character === "}") {
      state.objectDepth--;
      if (state.objectDepth === 0) {
        complete = true;
      }
    } else if (character === "[") {
      state.arrayDepth++;
    } else if (character === "]") {
      state.arrayDepth--;
    } else if (character === "," && state.objectDepth === 1 && state.arrayDepth === 0) {
      state.lastTopLevelComma = offset + index;
    }
  }
  return complete;
}

/** Parse the complete top-level fields before a top-level comma by closing the
 *  object at that boundary. */
function recoveredToolInput(prefix: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(prefix + "}");
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the ACP `messageId` for a Claude SDK message (live) or a persisted
 * transcript message (replay) so chunk grouping is identical in both views.
 *
 * Assistant turns are keyed by the Anthropic API message id (`message.id`),
 * which is identical at `message_start`, on the consolidated assistant message,
 * and in the persisted transcript — unlike the per-`stream_event` uuid, which is
 * unique per event and never persisted. User messages have no API id, but they
 * are never streamed, so their (stable) SDK uuid is used instead. ACP message
 * ids are opaque strings, so no particular format is required.
 */
export function messageIdForGrouping(message: {
  type?: string;
  uuid?: string | null;
  message?: unknown;
}): string | undefined {
  if (message.type === "assistant") {
    const inner = message.message;
    const apiId =
      inner && typeof inner === "object" && "id" in inner
        ? (inner as { id?: unknown }).id
        : undefined;
    if (typeof apiId === "string" && apiId.length > 0) {
      return apiId;
    }
  }
  return typeof message.uuid === "string" && message.uuid.length > 0 ? message.uuid : undefined;
}

/**
 * Stamps an ACP `messageId` onto a session update, but only on the message/
 * thought chunk variants that carry one — tool_call/plan/etc. updates never do.
 * No-op when `messageId` is falsy, so callers can pass it through unconditionally.
 */
function applyMessageId(
  update: SessionNotification["update"],
  messageId: string | undefined,
): void {
  if (
    messageId &&
    (update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "user_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk")
  ) {
    update.messageId = messageId;
  }
}

/** Built-in tools that drive the task list (headless/SDK sessions use these
 *  instead of TodoWrite). Their tool_use/tool_result are surfaced as `plan`
 *  snapshots rather than as tool_calls. */
function isTaskTool(toolName: string): boolean {
  return (
    toolName === "TaskCreate" ||
    toolName === "TaskUpdate" ||
    toolName === "TaskList" ||
    toolName === "TaskGet"
  );
}

/** Whether the streamed tool_use path surfaces this tool as a standalone
 *  `tool_call`. TodoWrite is rendered as a `plan` and Task* tools are
 *  suppressed (their plan snapshot is emitted at tool_result time), so neither
 *  produces a streamed tool_call/tool_call_update — which means a
 *  permission-surfaced tool_call for them (see `ensureToolCallEmitted`) must be
 *  resolved explicitly at tool_result time. */
function shouldEmitToolCall(toolName: string): boolean {
  return toolName !== "TodoWrite" && !isTaskTool(toolName);
}

/**
 * The renderer of the notification functions: the agent's tool call
 * capabilities when they are passed, else those of the ACP capabilities.
 */
function toolCallRenderer(options?: {
  clientCapabilities?: ClientCapabilities;
  toolCallCapabilities?: ToolCallClientCapabilities;
  replay?: boolean;
}): AcpToolCallRenderer {
  return options?.toolCallCapabilities
    ? new AcpToolCallRenderer(options.toolCallCapabilities, options.replay)
    : AcpToolCallRenderer.for(options?.clientCapabilities, options?.replay);
}

/**
 * Convert an SDKAssistantMessage (Claude) to a SessionNotification (ACP).
 * Only handles text, image, and thinking chunks for now.
 */
export function toAcpNotifications(
  content: string | ContentBlockParam[] | BetaContentBlock[] | BetaRawContentBlockDelta[],
  role: "assistant" | "user",
  sessionId: string,
  toolUseCache: ToolUseCache,
  client: AcpClient,
  logger: Logger,
  options?: {
    registerHooks?: boolean;
    clientCapabilities?: ClientCapabilities;
    // The agent's tool call capabilities. They win over clientCapabilities,
    // and carry what ACP capabilities cannot (ToolCallClientCapabilities.v2).
    toolCallCapabilities?: ToolCallClientCapabilities;
    parentToolUseId?: string | null;
    cwd?: string;
    taskState?: TaskState;
    // The subagent TodoWrite checklists that the client holds in the session.
    // Mutated in place.
    subagentChecklists?: SubagentChecklists;
    // Tracks tool_use ids already emitted as a `tool_call` so a permission
    // request (which emits the tool_call eagerly) and the streamed tool_use
    // chunk don't both emit one — whichever arrives second emits a
    // `tool_call_update` instead. Mutated in place. When omitted, the
    // tool_call/update decision falls back to `toolUseCache` presence (the
    // historical single-source behavior).
    emittedToolCalls?: Set<string>;
    // False while the input of a streamed tool_use still streams: the first
    // tool_call then leaves `rawInput` out, and the consolidated message
    // sends it once it is complete.
    inputComplete?: boolean;
    // Remembers the fields sent for each open tool call. When present, a
    // tool_call_update carries only the fields that changed, and an update
    // with nothing new is dropped. Mutated in place.
    toolCallFields?: ToolCallFieldTracker;
    // Opaque id identifying the message these chunks belong to (ACP message ids
    // are opaque strings — no particular format is required). Attached to
    // user/agent message and thought chunks so clients can group streamed chunks
    // into a single message. Omit it (leave undefined) when unknown — never send
    // an explicit `null`.
    messageId?: string;
    // The SDK user message's `tool_use_result`: the structured Output object of
    // the tool_result this message carries (shape is per-tool). Used to render
    // Agent/Task results from the structured subagent report instead of the raw
    // text (which ends in a model-directed agentId/usage trailer).
    toolUseResult?: unknown;
    // The SDK user message's `tool_result_meta` sidecar, passed raw (it's
    // untyped in sdk.d.ts) and validated by `parseToolResultMeta`. Stamps
    // denied/interrupted tool_call_updates with why the tool never ran.
    toolResultMeta?: unknown;
    // True when the content is a result of the work that a `session/cancel`
    // stopped. An error result then ends a run that the cancel aborted,
    // whichever kind the SDK stamped on it (see `resultStatus`).
    cancelled?: boolean;
    // True when the content comes from the history of a loaded session.
    replay?: boolean;
  },
): SessionNotification[] {
  const taskState = options?.taskState ?? new Map();
  const registerHooks = options?.registerHooks !== false;
  const renderer = toolCallRenderer(options);
  if (typeof content === "string") {
    if (content.length === 0) {
      return [];
    }
    const update: SessionNotification["update"] = {
      sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
      content: {
        type: "text",
        text: content,
      },
    };
    applyMessageId(update, options?.messageId);

    if (options?.parentToolUseId) stampParentToolUseId(update, options.parentToolUseId);

    return [{ sessionId, update }];
  }

  // `tool_use_result` is message-level and carries no tool_use_id of its own:
  // it describes "the" tool_result block of the message it rode in on. If
  // several tool_result blocks were ever batched into one message it couldn't
  // be attributed, so it is only honored when the message carries exactly one.
  const toolUseResult =
    options?.toolUseResult !== undefined &&
    content.filter((c) => typeof c === "object" && c !== null && c.type === "tool_result")
      .length === 1
      ? options.toolUseResult
      : undefined;

  // Unlike `tool_use_result`, entries carry their own tool_use_id, so batched
  // messages need no single-block guard.
  const toolResultMeta = parseToolResultMeta(options?.toolResultMeta);
  const output = [];
  // Only handle the first chunk for streaming; extend as needed for batching
  for (const chunk of content) {
    let update: SessionNotification["update"] | null = null;
    // The tool call that this chunk finishes, if it is a tool result.
    let finishedToolCallId: string | undefined;
    // The plan that this chunk approves, if it is an ExitPlanMode result.
    let approvedPlanUpdate: SessionNotification["update"] | undefined;
    switch (chunk.type) {
      case "text":
      case "text_delta": {
        if (chunk.text) {
          update = {
            sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
            content: {
              type: "text",
              text: chunk.text,
            },
          };
        }
        break;
      }
      case "image":
        update = {
          sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
          content: {
            type: "image",
            data: chunk.source.type === "base64" ? chunk.source.data : "",
            mimeType: chunk.source.type === "base64" ? chunk.source.media_type : "",
            uri: chunk.source.type === "url" ? chunk.source.url : undefined,
          },
        };
        break;
      case "thinking":
      case "thinking_delta": {
        // Recent models default `thinking.display` to "omitted", which streams
        // signature-only thinking blocks whose text is empty.
        if (chunk.thinking) {
          update = {
            sessionUpdate: "agent_thought_chunk",
            content: {
              type: "text",
              text: chunk.thinking,
            },
          };
        }
        break;
      }
      case "tool_use":
      case "server_tool_use":
      case "mcp_tool_use": {
        const alreadyCached = chunk.id in toolUseCache;
        toolUseCache[chunk.id] = chunk;
        if (chunk.name === "TodoWrite") {
          // @ts-expect-error - sometimes input is empty object or undefined
          if (Array.isArray(chunk.input?.todos)) {
            update = todoWritePlanUpdate(planEntries(chunk.input as { todos: ClaudePlanEntry[] }), {
              planOperations: options?.clientCapabilities?.plan != null,
              parentToolUseId: options?.parentToolUseId,
              // With native subagent sessions, an update of a subagent goes
              // to the subagent's session (see NativeSubagentRuntime).
              childSessions: clientSupportsSubagents(options?.clientCapabilities),
              shown: options?.subagentChecklists,
            });
          }
        } else if (isTaskTool(chunk.name)) {
          // Task* tool_use is suppressed; the plan update is emitted at
          // tool_result time once we have the task ID (for TaskCreate) and
          // confirmation that the change took effect.
        } else {
          // Only register hooks on first encounter to avoid double-firing
          if (registerHooks && !alreadyCached) {
            // Capture the tool name in the closure rather than re-reading the
            // cache when the hook fires. The cache entry is pruned at
            // tool_result time, and a PostToolUse hook can fire after that, so
            // closing over the name keeps the diff working without depending on
            // (or pinning) the cache entry's lifetime.
            const toolName = chunk.name;
            const hookToolCallId = chunk.id;
            registerHookCallback(
              chunk.id,
              {
                onPostToolUseHook: async (toolUseId, _toolInput, toolResponse) => {
                  // The final diff of an Edit or a Write replaces the
                  // optimistic content built from the input. Only the marker
                  // fields of the tool_response travel: the rest repeats
                  // output that the content already carries.
                  const update = await renderer.hookResult(
                    { id: toolUseId, name: toolName },
                    toolResponse,
                    options?.cwd,
                  );
                  if (!update) return;
                  if (options?.parentToolUseId) {
                    stampParentToolUseId(update, options.parentToolUseId);
                  }
                  // The final result may replace a pinned approval patch.
                  if (
                    options?.toolCallFields &&
                    !options.toolCallFields.apply(update, { replacePinnedContent: true })
                  ) {
                    return;
                  }
                  await client.sessionUpdate({ sessionId, update });
                },
                onRelease: () => options?.toolCallFields?.finishHook(hookToolCallId),
              },
              sessionId,
            );
          }

          let rawInput;
          try {
            rawInput = JSON.parse(JSON.stringify(chunk.input));
          } catch {
            // ignore if we can't turn it to JSON
          }
          const toolUse = { id: chunk.id, name: chunk.name, input: rawInput };

          // Emit a `tool_call` only the first time this id surfaces to the
          // client; afterwards refine it with a `tool_call_update`. The first
          // surface may be this stream chunk OR an earlier permission request
          // (see `ensureToolCallEmitted`), so emission is tracked separately
          // from `toolUseCache`. Without an `emittedToolCalls` set we fall back
          // to cache presence — the historical streaming-only behavior.
          const emittedToolCalls = options?.emittedToolCalls;
          const alreadyEmitted = emittedToolCalls ? emittedToolCalls.has(chunk.id) : alreadyCached;
          emittedToolCalls?.add(chunk.id);

          // A permission request surfaced the tool call with its complete
          // input. The empty input at the stream start has nothing to add.
          if (alreadyEmitted && options?.inputComplete === false) break;
          update = alreadyEmitted
            ? // Already surfaced (full assistant message after streaming, or a
              // permission request emitted it first): refine it with the
              // complete input.
              renderer.refinement(toolUse, options?.cwd)
            : // First surface (streaming content_block_start or replay).
              renderer.toolCall(toolUse, {
                cwd: options?.cwd,
                inputComplete: options?.inputComplete,
              });
        }
        break;
      }

      case "advisor_tool_result": {
        // Advisor results arrive in assistant content, including encrypted advice.
        // Resolve the server tool through the normal result path without rendering
        // opaque ciphertext. Server tools have no later PostToolUse hook to await.
        const result = chunk.content;
        unregisterHookCallback(chunk.tool_use_id);
        output.push(
          ...toAcpNotifications(
            [
              {
                type: "tool_result",
                tool_use_id: chunk.tool_use_id,
                is_error: result.type === "advisor_tool_result_error",
                content:
                  result.type === "advisor_result"
                    ? result.text
                    : result.type === "advisor_redacted_result"
                      ? "Advisor guidance applied server-side."
                      : `Advisor error: ${result.error_code}`,
              },
            ],
            role,
            sessionId,
            toolUseCache,
            client,
            logger,
            options,
          ),
        );
        break;
      }

      case "tool_result":
      case "tool_search_tool_result":
      case "web_fetch_tool_result":
      case "web_search_tool_result":
      case "code_execution_tool_result":
      case "bash_code_execution_tool_result":
      case "text_editor_code_execution_tool_result":
      case "mcp_tool_result": {
        const wasEmitted = options?.emittedToolCalls?.has(chunk.tool_use_id) === true;
        options?.emittedToolCalls?.delete(chunk.tool_use_id);
        completeHookCallback(chunk.tool_use_id);
        finishedToolCallId = chunk.tool_use_id;
        // Why this is_error result carries harness prose instead of tool
        // output (user-rejected / interrupted / …), when the SDK said so.
        // Spread into the claudeCode meta of every update emitted below; the
        // untracked-tool fallback can't carry it (claudeCode metas always
        // carry `toolName`, which is unknown there).
        const nonExecution = toolResultMeta?.get(chunk.tool_use_id);
        const toolUse = toolUseCache[chunk.tool_use_id];
        if (!toolUse) {
          // The permission flow may have surfaced this tool_call even though
          // its tool_use never reached the cache (e.g. the assistant message
          // carrying it was dropped by the cancelled-turn guard and a straggler
          // result landed later). Resolve the surfaced call anyway so it can't
          // stay pending in the client forever; without the cache entry the
          // tool name is unknown, so no claudeCode meta is attached.
          if (wasEmitted) {
            output.push({
              sessionId,
              update: {
                toolCallId: chunk.tool_use_id,
                sessionUpdate: "tool_call_update" as const,
                status: renderer.resultStatus(
                  "is_error" in chunk && chunk.is_error === true,
                  nonExecution,
                  { cancelled: options?.cancelled },
                ),
                rawOutput: chunk.content,
              },
            });
          }
          logger.error(
            `[claude-agent-acp] Got a tool result for tool use that wasn't tracked: ${chunk.tool_use_id}`,
          );
          break;
        }

        // A permission request may have surfaced a plan-rendered (TodoWrite) or
        // suppressed (Task*) tool as a real tool_call so the request referenced
        // a tool call the client knows about (see `ensureToolCallEmitted`,
        // issue #851). The branches below never emit a tool_call_update for
        // those tools, which would leave the surfaced call pending in the
        // client forever — resolve it here. `wasEmitted` is only ever true for
        // these tools via the permission flow: the streamed plan/suppressed
        // branches don't record emissions.
        if (wasEmitted && !shouldEmitToolCall(toolUse.name)) {
          output.push({
            sessionId,
            update: {
              _meta: {
                claudeCode: {
                  toolName: toolUse.name,
                  ...(nonExecution ?? {}),
                  ...(options?.parentToolUseId ? { parentToolUseId: options.parentToolUseId } : {}),
                },
              } satisfies ToolUpdateMeta,
              toolCallId: chunk.tool_use_id,
              sessionUpdate: "tool_call_update" as const,
              status: renderer.resultStatus(
                "is_error" in chunk && chunk.is_error === true,
                nonExecution,
                { cancelled: options?.cancelled },
              ),
              rawOutput: chunk.content,
            },
          });
        }

        if (isTaskTool(toolUse.name)) {
          // Headless/SDK sessions emit Task* tools instead of TodoWrite.
          // TaskCreate / TaskUpdate mutate the accumulated task list. TaskList
          // reconciles it from the SDK's authoritative snapshot, which repairs
          // resumed or compacted sessions whose creating calls are no longer in
          // replay history. TaskGet is read-only and remains suppressed. Plan
          // updates always carry the full accumulated snapshot, mirroring the
          // legacy TodoWrite behavior.
          const isError = "is_error" in chunk && chunk.is_error;
          let shouldEmitTaskPlan = false;
          if (!isError) {
            if (toolUse.name === "TaskCreate") {
              applyTaskCreate(
                taskState,
                toolUse.input as Parameters<typeof applyTaskCreate>[1],
                parseTaskCreateOutput(toolUseResult) ?? parseTaskCreateOutput(chunk.content),
              );
              shouldEmitTaskPlan = true;
            } else if (toolUse.name === "TaskUpdate") {
              const input = toolUse.input as Parameters<typeof applyTaskUpdate>[1];
              const output =
                parseTaskUpdateOutput(toolUseResult, input?.taskId) ??
                parseTaskUpdateOutput(chunk.content, input?.taskId);
              // Older CLI transcripts have no structured output, so retain the
              // input-based fallback. When an output is available, only apply a
              // confirmed update for the same task.
              if (!output || (output.success && output.taskId === input?.taskId)) {
                applyTaskUpdate(taskState, input);
                shouldEmitTaskPlan = true;
              }
            } else if (toolUse.name === "TaskList") {
              const output =
                parseTaskListOutput(toolUseResult) ?? parseTaskListOutput(chunk.content);
              if (output) {
                applyTaskList(taskState, output);
                shouldEmitTaskPlan = true;
              }
            }
          }
          const entries = shouldEmitTaskPlan
            ? changedTaskPlanEntries(taskState, renderer.capabilities.air.client)
            : undefined;
          if (entries) {
            update = checklistPlanUpdate(entries, options?.clientCapabilities?.plan != null);
          }
        } else if (toolUse.name !== "TodoWrite") {
          // A command sends its output first, then the exit and the status.
          const [finalUpdate, ...rest] = renderer
            .result(toolUse, chunk as Parameters<AcpToolCallRenderer["result"]>[1], {
              structured: toolUseResult,
              nonExecution,
              cancelled: options?.cancelled,
            })
            .reverse();
          for (const outputUpdate of rest.reverse()) {
            if (options?.parentToolUseId) {
              stampParentToolUseId(outputUpdate, options.parentToolUseId);
            }
            output.push({ sessionId, update: outputUpdate });
          }
          // An approved plan of the main conversation becomes the session's
          // markdown plan, after the tool call's result. An approval that
          // clears the context ends the tool with an error result instead, and
          // the restart into the fresh context publishes that plan (see
          // ExitPlanCoordinator.restart).
          if (
            toolUse.name === "ExitPlanMode" &&
            options?.clientCapabilities?.plan &&
            !options.parentToolUseId &&
            !("is_error" in chunk && chunk.is_error)
          ) {
            const plan = approvedPlan(toolUse.input, toolUseResult);
            if (plan) {
              approvedPlanUpdate = planModeUpdate(
                plan,
                renderer.capabilities.air.client ? toolUse.id : undefined,
              );
            }
          }
          update = finalUpdate;
        }
        // The tool_use is fully resolved now — drop it so a long session doesn't
        // retain every tool call. The PostToolUse hook (Edit/Write diffs) closes
        // over the tool name and no longer reads the cache, so pruning here is
        // safe regardless of hook/result ordering.
        delete toolUseCache[chunk.tool_use_id];
        break;
      }

      case "document":
      case "search_result":
      case "redacted_thinking":
      case "input_json_delta":
      case "citations_delta":
      case "signature_delta":
      case "container_upload":
      case "compaction":
      case "compaction_delta":
      case "fallback":
      case "mcp_tool_listing":
        break;

      default:
        unreachable(chunk, logger);
        break;
    }
    if (update) {
      if (options?.parentToolUseId) stampParentToolUseId(update, options.parentToolUseId);
      applyMessageId(update, options?.messageId);
      // A tool result is final, so it may replace a pinned approval patch,
      // for example with the error text of a rejected Edit.
      if (
        !options?.toolCallFields ||
        options.toolCallFields.apply(update, {
          replacePinnedContent: finishedToolCallId !== undefined,
        })
      ) {
        output.push({ sessionId, update });
      }
    }
    if (approvedPlanUpdate) output.push({ sessionId, update: approvedPlanUpdate });
    if (finishedToolCallId !== undefined) {
      // The PostToolUse hook can still send the final diff, so the fields
      // stay tracked until its callback leaves the registry.
      options?.toolCallFields?.finishResult(
        finishedToolCallId,
        hasHookCallback(finishedToolCallId),
      );
    }
  }

  return output;
}

export function streamEventToAcpNotifications(
  message: SDKPartialAssistantMessage,
  sessionId: string,
  toolUseCache: ToolUseCache,
  client: AcpClient,
  logger: Logger,
  options?: {
    clientCapabilities?: ClientCapabilities;
    // See toAcpNotifications.
    toolCallCapabilities?: ToolCallClientCapabilities;
    cwd?: string;
    taskState?: TaskState;
    subagentChecklists?: SubagentChecklists;
    emittedToolCalls?: Set<string>;
    toolCallFields?: ToolCallFieldTracker;
    messageId?: string;
    streamedToolInputs?: StreamedToolInputCache;
  },
): SessionNotification[] {
  const event = message.event;
  const streamKey = message.parent_tool_use_id ?? "";
  const streamedToolInputs = options?.streamedToolInputs;
  const forwardedOptions = {
    clientCapabilities: options?.clientCapabilities,
    toolCallCapabilities: options?.toolCallCapabilities,
    parentToolUseId: message.parent_tool_use_id,
    cwd: options?.cwd,
    taskState: options?.taskState,
    subagentChecklists: options?.subagentChecklists,
    emittedToolCalls: options?.emittedToolCalls,
    toolCallFields: options?.toolCallFields,
    messageId: options?.messageId,
  };
  switch (event.type) {
    case "content_block_start": {
      const block = event.content_block;
      if (
        streamedToolInputs &&
        (block.type === "tool_use" ||
          block.type === "server_tool_use" ||
          block.type === "mcp_tool_use")
      ) {
        let inputsForMessage = streamedToolInputs.get(streamKey);
        if (!inputsForMessage) {
          inputsForMessage = new Map();
          streamedToolInputs.set(streamKey, inputsForMessage);
        }
        inputsForMessage.set(event.index, {
          id: block.id,
          name: block.name,
          partialJson: "",
          inString: false,
          escaped: false,
          objectDepth: 0,
          arrayDepth: 0,
          lastTopLevelComma: -1,
          emittedThroughComma: -1,
        });
      }
      // The input of a streamed tool_use starts empty and streams after this
      // event, so the tool_call waits for the complete input.
      return toAcpNotifications([block], "assistant", sessionId, toolUseCache, client, logger, {
        ...forwardedOptions,
        inputComplete: false,
      });
    }
    case "content_block_delta": {
      if (event.delta.type === "input_json_delta") {
        const streamedInput = streamedToolInputs?.get(streamKey)?.get(event.index);
        if (!streamedInput) return [];

        if (scanStreamedToolInput(streamedInput, event.delta.partial_json)) {
          // Input complete: the consolidated assistant message replays the
          // block with its full input and refines the call there; emitting
          // here too would send a duplicate identical update.
          const inputsForMessage = streamedToolInputs?.get(streamKey);
          inputsForMessage?.delete(event.index);
          if (inputsForMessage?.size === 0) streamedToolInputs?.delete(streamKey);
          return [];
        }
        if (streamedInput.lastTopLevelComma <= streamedInput.emittedThroughComma) {
          return [];
        }
        streamedInput.emittedThroughComma = streamedInput.lastTopLevelComma;
        const input = recoveredToolInput(
          streamedInput.partialJson.slice(0, streamedInput.lastTopLevelComma),
        );
        if (!input) return [];
        // TodoWrite and the Task* tools never surfaced a tool_call to refine.
        if (!shouldEmitToolCall(streamedInput.name)) return [];
        const update: SessionNotification["update"] = toolCallRenderer(options).partialRefinement(
          streamedInput,
          input,
          options?.cwd,
        );
        if (message.parent_tool_use_id) stampParentToolUseId(update, message.parent_tool_use_id);
        applyMessageId(update, options?.messageId);
        // A refinement resends only what changed: rawInput grows with every
        // field, and title, kind, and locations usually stay the same.
        if (options?.toolCallFields && !options.toolCallFields.apply(update)) return [];
        return [{ sessionId, update }];
      }
      return toAcpNotifications(
        [event.delta],
        "assistant",
        sessionId,
        toolUseCache,
        client,
        logger,
        forwardedOptions,
      );
    }
    // No content. `ping` is a Messages-API keep-alive event that the SDK's
    // `BetaRawMessageStreamEvent` union doesn't include even though the
    // wire format emits it; the `as never` cast lets us no-op it here
    // instead of letting it fall through to `unreachable`.
    case "ping" as never:
    case "message_delta":
      return [];
    // A message boundary ends every input stream on this lane: message_stop is
    // the normal end, and a message_start clears anything a prior message on
    // the lane left behind (e.g. a stream cut short mid-block).
    case "message_start":
    case "message_stop":
      streamedToolInputs?.delete(streamKey);
      return [];
    case "content_block_stop": {
      const inputsForMessage = streamedToolInputs?.get(streamKey);
      inputsForMessage?.delete(event.index);
      if (inputsForMessage?.size === 0) streamedToolInputs?.delete(streamKey);
      return [];
    }

    default:
      unreachable(event, logger);
      return [];
  }
}
