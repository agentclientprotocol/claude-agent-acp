import type {
  ClientCapabilities as AcpClientCapabilities,
  RequestPermissionRequest,
  SessionNotification,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
} from "@agentclientprotocol/sdk/unstable";
import {
  AIR_COMMAND_TITLE_KEY,
  AIR_MCP_KEY,
  AIR_SKILL_KEY,
  AIR_SUBAGENT_KEY,
  withAirMeta,
} from "../air-extension.js";
import { exitPlanModeRawOutput } from "../exit-plan.js";
import { isAbortedToolResult, type ToolResultMeta } from "../tool-result-meta.js";
import { ClientCapabilities } from "./client-capabilities.js";
import { resultText, textContent, toAcpContentUpdate, toolResponseMarkers } from "./content.js";
import type { ToolResultContext, ToolResultFacts, ToolUse, ToolUseFacts } from "./facts.js";
import { reporterFor } from "./reporters/index.js";
import { resolveSkillPath } from "./reporters/interaction.js";
import { shellDescription } from "./reporters/bash.js";
import { grepPath } from "./reporters/search.js";

export type ToolCallUpdate = SessionNotification["update"];

/** The id suffix of the call that clears the plan file of an approved plan for AIR. */
const PLAN_FILE_CLEAR_SUFFIX = ":plan-file-clear";

/**
 * ACP v2's `cancelled` tool call status. v1's statuses have no such value, and
 * the agent builds its reports in v1 types, so it travels as a v1 status. Only
 * a v2 client gets it, and the v2 surface sends it as it is
 * (`src/v2/tool-call.ts`).
 */
const V2_CANCELLED = "cancelled" as unknown as ToolCallStatus;

/** Whether `status` ends a tool call: `completed`, `failed`, or, on v2, `cancelled`. */
export function isFinalToolCallStatus(status: ToolCallStatus | null | undefined): boolean {
  return status === "completed" || status === "failed" || status === V2_CANCELLED;
}

/** The `_meta` of a tool call report. */
export type ToolUpdateMeta = {
  claudeCode?: {
    /* The name of the tool that was used in Claude Code. Also carried as the
       standard ACP `name` field on the initial `tool_call`. A progress beat
       for AIR leaves it out when the adapter does not know the tool. A v2
       client gets it as `name` alone (see `V2ToolCallMeta`). */
    toolName?: string;
    /* The structured output provided by Claude Code. For an AIR or a v2
       client, a PostToolUse update carries only the `status` and `isAsync`
       markers of the tool_response: the tool output itself is in the
       tool-call content. */
    toolResponse?: unknown;
    /* For a tool call made inside a subagent: the tool_use id of the
       Agent/Task call that spawned the subagent. Mirrors the SDK's
       `parent_tool_use_id` on streamed subagent messages. */
    parentToolUseId?: string;
    /* On a "failed" tool_call_update: why the tool never actually ran, so a
       client can render the denial/cancellation distinctly from a real tool
       failure. From the SDK's `tool_result_meta` non_execution_kind:
       "user-rejected", "permission-rule", "interrupted", "cancelled", …
       (open set). Absent when the tool executed — including real failures. */
    nonExecutionKind?: string;
    /* Free-text the user supplied when rejecting the tool call, when the
       harness collected any. Only ever present alongside nonExecutionKind. */
    userFeedback?: string;
    /* The MCP server of an `mcp__*` tool, on a permission request. */
    mcpServer?: { name: string; source: string };
  };
  /* The AIR client flags of the ACP tool call contract (`docs/air-extensions.md#tool-call-contract`). */
  jetbrains?: {
    air?: {
      version?: number;
      /* The concise description of a shell command, kept out of the
         standard `title`, which clients use as the command preview. */
      commandTitle?: string;
      /* Marks Agent/Task tool calls as subagent launches. ACP has no standard
         subagent ToolKind yet. */
      subagent?: true;
      /* For Skill tool calls: the skill name, and the absolute path of its
         SKILL.md when it could be located on disk. */
      skill?: { name: string; path?: string };
      /* For MCP tool calls: the normalized server name and the tool name, so
         a client need not parse the `mcp__<server>__<tool>` title. */
      mcp?: { server: string; tool: string };
      [key: string]: unknown;
    };
  };
  /* `true` for an MCP tool call. */
  is_mcp_tool_call?: true;
  /* Terminal metadata for Bash tool execution, matching codex-acp's _meta protocol. */
  terminal_info?: {
    terminal_id: string;
  };
  terminal_output?: {
    terminal_id: string;
    data: string;
  };
  terminal_output_delta?: {
    terminal_id: string;
    data: string;
  };
  terminal_exit?: {
    terminal_id: string;
    /**
     * Null when the agent does not know the code, as in `TerminalExitStatus`.
     * AIR always gets a number.
     */
    exit_code: number | null;
    signal: string | null;
  };
};

/** The result fields of a tool call report, before the status and the tool name. */
export interface RenderedResult {
  title?: string;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  /** Present when the reporter decided the raw output. */
  rawOutput?: unknown;
  /** The plan file that `rawInput` names. See {@link ToolResultFacts.planFilePath}. */
  planFilePath?: string;
  /** See {@link ToolResultFacts.planFileReleased}. */
  planFileReleased?: boolean;
  _meta?: Pick<
    ToolUpdateMeta,
    "terminal_info" | "terminal_output" | "terminal_output_delta" | "terminal_exit"
  >;
}

/** The SDK tool_result block that a result report reads. */
type ResultBlock = ToolResultContext["result"];

/**
 * Turns tool facts into the fields of the standard ACP tool call report, as
 * `docs/air-extensions.md#tool-call-contract` defines: each fact goes in one field.
 *
 * The {@link ToolReporter} of the tool reads the SDK data. The renderer
 * decides the fields from the facts and the {@link ClientCapabilities}. The
 * {@link ToolCallFieldTracker} runs after it and drops the fields that an
 * earlier report of the same tool call already sent.
 */
export class AcpToolCallRenderer {
  constructor(
    readonly capabilities: ClientCapabilities = new ClientCapabilities(),
    /** True when the renderer reports the history of a loaded session. */
    readonly replay = false,
  ) {}

  static for(
    capabilities: AcpClientCapabilities | null | undefined,
    replay = false,
  ): AcpToolCallRenderer {
    return new AcpToolCallRenderer(ClientCapabilities.from(capabilities), replay);
  }

  /**
   * Whether the client keeps a tool call's `_meta` across reports: AIR merges
   * its keys, and v2 stores it. Such a client gets no `toolResponse` text that
   * the tool call's content already shows, which it would otherwise keep.
   */
  private get keepsMeta(): boolean {
    return this.capabilities.air.client || this.capabilities.v2;
  }

  /**
   * Whether a tool call with these facts gets a display terminal: a command, for a client
   * that renders terminals.
   */
  private hasTerminal(facts: ToolUseFacts): boolean {
    return facts.command === true && this.capabilities.terminalOutput;
  }

  /**
   * The status of a tool result. Claude Code reports a run that it aborted in
   * one of three ways:
   * - an error result whose `nonExecution` kind says so (`interrupted`,
   *   `cancelled`);
   * - a command result that says `interrupted` (for example, a steering
   *   message landed just before the command started);
   * - any error result of the work that a `session/cancel` stopped
   *   (`run.cancelled`). The kind does not say so there: CLI 2.1.293 stamps a
   *   command that the interrupt killed `user-rejected`, as if the user had
   *   refused it.
   *
   * Such a run is `cancelled` for a v2 client, which has that status. Every
   * other client gets `failed` for the error, with the kind in
   * `_meta.claudeCode.nonExecutionKind`, and `completed` for the command.
   */
  resultStatus(
    isError: boolean,
    nonExecution: ToolResultMeta | undefined,
    run: { interrupted?: boolean; cancelled?: boolean } = {},
  ): ToolCallStatus {
    const aborted =
      run.interrupted === true ||
      (isError && (run.cancelled === true || isAbortedToolResult(nonExecution)));
    if (this.capabilities.v2 && aborted) return V2_CANCELLED;
    return isError ? "failed" : "completed";
  }

  /** The facts of a tool use. */
  facts(toolUse: Pick<ToolUse, "name" | "input">, cwd?: string): ToolUseFacts {
    return reporterFor(toolUse.name).toolUse(toolUse.input, {
      cwd,
      capabilities: this.capabilities,
      replay: this.replay,
    });
  }

  /** The standard fields of a tool use: the title, the kind, the content, and the locations. */
  toolInfo(
    toolUse: ToolUse,
    cwd?: string,
  ): {
    title: string;
    kind: ToolUseFacts["kind"];
    content: ToolCallContent[];
    locations?: ToolCallLocation[];
  } {
    const facts = this.facts(toolUse, cwd);
    return {
      title: facts.title,
      kind: facts.kind,
      content: this.toolUseContent(toolUse.id, facts),
      ...(facts.locations !== undefined ? { locations: facts.locations } : {}),
    };
  }

  /**
   * The first report of a tool call. `rawInput` is left out while the input
   * still streams: the consolidated message sends it once it is complete.
   */
  toolCall(
    toolUse: ToolUse,
    options: {
      cwd?: string;
      additionalDirectories?: readonly string[];
      inputComplete?: boolean;
      previewContent?: ToolCallContent[];
    } = {},
  ): ToolCallUpdate {
    const facts = this.facts(toolUse, options.cwd);
    const isMcp = toolUse.name.startsWith("mcp__");
    return {
      _meta: {
        ...this.toolUseMeta(toolUse, options.cwd, options.additionalDirectories),
        ...(this.hasTerminal(facts) ? { terminal_info: { terminal_id: toolUse.id } } : {}),
        // Only AIR gets the MCP flag. The upstream adapter does not send it.
        ...(isMcp && this.capabilities.air.client ? { is_mcp_tool_call: true } : {}),
      } satisfies ToolUpdateMeta,
      toolCallId: toolUse.id,
      sessionUpdate: "tool_call",
      name: toolUse.name,
      // AIR gets `rawInput` once it is complete. Every other client gets the
      // input as it stands, also the empty input at the stream start.
      ...(options.inputComplete === false && this.capabilities.air.client
        ? {}
        : { rawInput: this.rawInput(facts, toolUse.input) }),
      status: "pending",
      title: facts.title,
      kind: facts.kind,
      content: options.previewContent ?? this.toolUseContent(toolUse.id, facts),
      ...(facts.locations !== undefined ? { locations: facts.locations } : {}),
    };
  }

  /** The report of a tool call whose input is complete now. */
  refinement(
    toolUse: ToolUse,
    cwd?: string,
    additionalDirectories?: readonly string[],
  ): ToolCallUpdate {
    const facts = this.facts(toolUse, cwd);
    return {
      _meta: this.toolUseMeta(toolUse, cwd, additionalDirectories),
      toolCallId: toolUse.id,
      sessionUpdate: "tool_call_update",
      rawInput: this.rawInput(facts, toolUse.input),
      title: facts.title,
      kind: facts.kind,
      content: this.toolUseContent(toolUse.id, facts),
      ...(facts.locations !== undefined ? { locations: facts.locations } : {}),
    };
  }

  /**
   * The report of a tool call from the complete top-level fields of its still
   * streaming input. It carries no content: content built from partial input
   * is misleading (an Edit without its `new_string` renders as a deletion) or
   * invalid. AIR gets no `rawInput`, which goes out once it is complete. Every
   * other client gets the partial input as `rawInput`.
   */
  partialRefinement(
    toolUse: Pick<ToolUse, "id" | "name">,
    input: unknown,
    cwd?: string,
    additionalDirectories?: readonly string[],
  ) {
    const facts = this.facts({ name: toolUse.name, input }, cwd);
    return {
      _meta: this.toolUseMeta({ name: toolUse.name, input }, cwd, additionalDirectories),
      toolCallId: toolUse.id,
      sessionUpdate: "tool_call_update",
      ...(this.capabilities.air.client ? {} : { rawInput: input }),
      title: facts.title,
      kind: facts.kind,
      ...(facts.locations ? { locations: facts.locations } : {}),
    } satisfies ToolCallUpdate;
  }

  /**
   * The tool call of a permission request: `toolCallId`, `title`, and
   * `rawInput`. The client already holds the rest. The request adds only what
   * it shows new: an exact preview patch, and a location that the tool call
   * does not have.
   */
  permissionToolCall(
    toolUse: ToolUse,
    options: {
      cwd?: string;
      title?: string;
      previewContent?: ToolCallContent[];
      extraLocations?: ToolCallLocation[];
      meta?: ToolUpdateMeta;
      /** The content of a client that is not AIR, when the tool call has none. */
      fallbackContent?: ToolCallContent[];
    } = {},
  ): RequestPermissionRequest["toolCall"] {
    const facts = this.facts(toolUse, options.cwd);
    if (!this.capabilities.air.client) {
      // The upstream shape: the whole tool call again. A v2 client also gets
      // the exact preview patch, which the tool call does not show.
      const content = options.previewContent ?? this.toolUseContent(toolUse.id, facts);
      const locations = [...(facts.locations ?? []), ...(options.extraLocations ?? [])];
      return {
        toolCallId: toolUse.id,
        name: toolUse.name,
        status: "pending",
        rawInput: toolUse.input,
        title: options.title ?? facts.title,
        kind: facts.kind,
        content:
          content.length === 0 && options.fallbackContent ? options.fallbackContent : content,
        ...(facts.locations !== undefined || options.extraLocations?.length ? { locations } : {}),
        ...(options.meta ? { _meta: options.meta } : {}),
      };
    }
    return {
      toolCallId: toolUse.id,
      title: options.title ?? facts.title,
      rawInput: this.rawInput(facts, toolUse.input),
      ...(options.previewContent ? { content: options.previewContent } : {}),
      ...(options.extraLocations?.length
        ? { locations: [...(facts.locations ?? []), ...options.extraLocations] }
        : {}),
      ...(options.meta ? { _meta: options.meta } : {}),
    };
  }

  /** The facts of a tool result. */
  resultFacts(toolUse: ToolUse, result: ResultBlock, structured?: unknown): ToolResultFacts {
    const reporter = reporterFor(toolUse.name);
    const context: ToolResultContext = {
      toolUse,
      result,
      structured,
      capabilities: this.capabilities,
    };
    const content = result.content;
    const hasErrorText =
      result.is_error === true &&
      content !== undefined &&
      content !== null &&
      (typeof content === "string" || Array.isArray(content)) &&
      content.length > 0;
    if (hasErrorText) {
      return reporter.errorResult?.(context) ?? toAcpContentUpdate(content, true);
    }
    return reporter.toolResult ? reporter.toolResult(context) : resultText(result);
  }

  /** The result fields of a tool result, before the status and the tool name. */
  resultFields(toolUse: ToolUse, result: ResultBlock, structured?: unknown): RenderedResult {
    return this.fieldsOfResult(toolUse, result, this.resultFacts(toolUse, result, structured));
  }

  private fieldsOfResult(
    toolUse: ToolUse,
    result: ResultBlock,
    facts: ToolResultFacts,
  ): RenderedResult {
    const { command, ...fields } = facts;
    if (!command) return fields;
    // The terminal was announced under the tool_use id (see `toolCall`), so the
    // output keys off that id. A non-string id is no id at all.
    const idOf = (id: unknown) => (typeof id === "string" && id.length > 0 ? id : undefined);
    const terminalId = idOf(toolUse.id) ?? idOf(result.tool_use_id);
    // Without a terminal id nothing can match the output. A client that
    // buffers output for an unknown terminal would hold it forever, so the
    // output becomes a code block instead.
    if (this.capabilities.terminalOutput && terminalId !== undefined) {
      const output = { terminal_id: terminalId, data: command.output };
      return {
        ...fields,
        // A client that is not AIR gets the terminal content again, like
        // upstream: it replaces a denial text that an earlier update showed.
        ...(this.capabilities.air.client
          ? {}
          : { content: [{ type: "terminal" as const, terminalId }] }),
        _meta: {
          terminal_info: { terminal_id: terminalId },
          ...(this.capabilities.terminalOutputDelta
            ? { terminal_output_delta: output }
            : { terminal_output: output }),
          terminal_exit: {
            terminal_id: terminalId,
            // AIR keeps the numbers it always got: 1 for a failed or
            // interrupted command, else the exit code, or 0 when unknown.
            exit_code: this.capabilities.air.client
              ? result.is_error === true || command.interrupted
                ? 1
                : (command.exitCode ?? 0)
              : (command.exitCode ?? null),
            signal: null,
          },
        },
      };
    }
    return command.output.trim()
      ? {
          ...fields,
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: `\`\`\`console\n${command.output.trimEnd()}\n\`\`\``,
              },
            },
          ],
        }
      : fields;
  }

  /**
   * The reports of a tool result. A command sends its output as a separate
   * report first, like codex-acp: the output, then the exit and the status.
   * The output travels once: the raw tool_result goes to `rawOutput` only
   * when no other field carries the result.
   */
  result(
    toolUse: ToolUse,
    result: ResultBlock,
    options: { structured?: unknown; nonExecution?: ToolResultMeta; cancelled?: boolean } = {},
  ): ToolCallUpdate[] {
    const facts = this.resultFacts(toolUse, result, options.structured);
    const { _meta: resultMeta, ...fields } = this.fieldsOfResult(toolUse, result, facts);
    // AIR shows a read or a search that names a path as the list of viewed
    // files. That view does not show the text of the result, so it stays out.
    const viewedFiles =
      this.capabilities.air.client && result.is_error !== true && this.namesViewedFile(toolUse);
    if (viewedFiles) {
      const content = fields.content?.filter(
        (item) => !(item.type === "content" && item.content.type === "text"),
      );
      if (content?.length) fields.content = content;
      else delete fields.content;
    }
    const updates: ToolCallUpdate[] = [];
    const terminalOutput = resultMeta?.terminal_output_delta ?? resultMeta?.terminal_output;
    if (terminalOutput) {
      updates.push({
        _meta: resultMeta?.terminal_output_delta
          ? { terminal_output_delta: terminalOutput }
          : { terminal_output: terminalOutput },
        toolCallId: toolUse.id,
        sessionUpdate: "tool_call_update",
      });
    }
    // AIR gets the raw tool_result only when no other field carries the
    // result. Every other client gets it unless the terminal carried it.
    const rawOutput = !this.capabilities.air.client
      ? terminalOutput
        ? undefined
        : exitPlanModeRawOutput(toolUse.name, result.content)
      : "rawOutput" in fields
        ? fields.rawOutput
        : viewedFiles || terminalOutput || fields.content !== undefined
          ? undefined
          : result.content;
    delete fields.rawOutput;
    // A plan file that the result names goes out also when the input did not
    // name it. The field tracker drops a path that the client holds.
    const planFilePath = fields.planFilePath;
    delete fields.planFilePath;
    const planFileReleased = fields.planFileReleased === true;
    delete fields.planFileReleased;
    updates.push({
      _meta: {
        claudeCode: { toolName: toolUse.name, ...(options.nonExecution ?? {}) },
        ...(resultMeta?.terminal_exit ? { terminal_exit: resultMeta.terminal_exit } : {}),
      } satisfies ToolUpdateMeta,
      toolCallId: toolUse.id,
      sessionUpdate: "tool_call_update",
      status: this.resultStatus(result.is_error === true, options.nonExecution, {
        interrupted: facts.command?.interrupted === true,
        cancelled: options.cancelled,
      }),
      ...(rawOutput !== undefined ? { rawOutput } : {}),
      ...(planFilePath ? { rawInput: planFileInput(toolUse.input, planFilePath) } : {}),
      ...fields,
    });
    // AIR keeps the plan file button while the last reported path names a
    // file, and a blank path is its clear signal. The clear goes as a call of
    // its own, so the plan card of this call keeps its file.
    if (planFilePath && planFileReleased && result.is_error !== true) {
      updates.push({
        toolCallId: `${toolUse.id}${PLAN_FILE_CLEAR_SUFFIX}`,
        sessionUpdate: "tool_call",
        title: "Exited Plan Mode",
        kind: "switch_mode",
        status: "completed",
        rawInput: { planFilePath: "" },
        content: [],
      });
    }
    return updates;
  }

  /**
   * Whether AIR shows [toolUse] as the list of viewed files: a read or a
   * search with a path in its locations or in the `path` of its input (Grep
   * also takes `file_path`, see {@link grepPath}).
   */
  private namesViewedFile(toolUse: ToolUse): boolean {
    const facts = this.facts(toolUse);
    if (facts.kind !== "read" && facts.kind !== "search") return false;
    if (facts.locations?.some((location) => location.path)) return true;
    const path =
      toolUse.name === "Grep"
        ? grepPath(toolUse.input)
        : (toolUse.input as { path?: unknown } | undefined)?.path;
    return typeof path === "string" && path.length > 0;
  }

  /**
   * The report of a PostToolUse hook: the final change of an edit tool, and
   * the `status` and `isAsync` markers of the `tool_response`. The rest of the
   * `tool_response` repeats output that the content already carries, such as
   * the whole text of a written file.
   */
  async hookResult(
    toolUse: Pick<ToolUse, "id" | "name">,
    toolResponse: unknown,
    cwd?: string,
  ): Promise<ToolCallUpdate | undefined> {
    const reporter = reporterFor(toolUse.name);
    const change = reporter.hookResult
      ? await reporter.hookResult(toolResponse, { cwd, capabilities: this.capabilities })
      : {};
    if (!this.keepsMeta) {
      // The upstream shape: the whole tool_response, on every hook.
      return {
        _meta: { claudeCode: { toolResponse, toolName: toolUse.name } } satisfies ToolUpdateMeta,
        toolCallId: toolUse.id,
        sessionUpdate: "tool_call_update",
        ...(change.content ? { content: change.content } : {}),
        ...(change.locations ? { locations: change.locations } : {}),
      };
    }
    const markers = toolResponseMarkers(toolResponse);
    if (!markers && !change.content && !change.locations) return undefined;
    return {
      _meta: {
        claudeCode: { ...(markers ? { toolResponse: markers } : {}), toolName: toolUse.name },
      } satisfies ToolUpdateMeta,
      toolCallId: toolUse.id,
      sessionUpdate: "tool_call_update",
      ...(change.content ? { content: change.content } : {}),
      ...(change.locations ? { locations: change.locations } : {}),
    };
  }

  /**
   * The report of a memory recall: a completed read tool call. A synthesis
   * shows the recalled text, a plain recall shows the memory files.
   */
  memoryRecall(recall: {
    uuid: string;
    mode: string;
    memories: { path: string; content?: string }[];
  }): ToolCallUpdate {
    const isSynthesis = recall.mode === "synthesize";
    const locations = isSynthesis ? [] : recall.memories.map((memory) => ({ path: memory.path }));
    const content = isSynthesis
      ? recall.memories.flatMap((memory) =>
          typeof memory.content === "string" ? [textContent(memory.content)] : [],
        )
      : [];
    const count = recall.memories.length;
    return {
      sessionUpdate: "tool_call",
      toolCallId: recall.uuid,
      title: isSynthesis
        ? "Recalled synthesized memory"
        : `Recalled ${count} ${count === 1 ? "memory" : "memories"}`,
      kind: "read",
      status: "completed",
      ...(locations.length > 0 && { locations }),
      ...(content.length > 0 && { content }),
      _meta: {
        claudeCode: { toolName: "memory_recall", toolResponse: { mode: recall.mode } },
      } satisfies ToolUpdateMeta,
    };
  }

  /**
   * The report of a tool call that a rule, the classifier, or a mode denied
   * before it ran. The reason is the result to show, so `toolResponse` keeps
   * only the reason type, and the SDK message when it differs from the reason.
   */
  permissionDenied(denial: {
    toolCallId: string;
    toolName: string;
    parentToolUseId?: string;
    decisionReasonType?: string;
    decisionReason?: string;
    message?: string;
  }): ToolCallUpdate {
    const reason = denial.decisionReason ?? denial.message;
    // AIR and v2 get the SDK message only when it differs from the reason,
    // which the content shows. Every other client gets the upstream
    // toolResponse.
    const extraMessage = !this.keepsMeta
      ? { decisionReason: denial.decisionReason, message: denial.message }
      : denial.decisionReason !== undefined &&
          denial.message !== undefined &&
          denial.message !== denial.decisionReason
        ? { message: denial.message }
        : {};
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: denial.toolCallId,
      status: "failed",
      content: [textContent(`Permission denied: ${reason}`)],
      _meta: {
        claudeCode: {
          toolName: denial.toolName,
          ...(denial.parentToolUseId ? { parentToolUseId: denial.parentToolUseId } : {}),
          toolResponse: { decisionReasonType: denial.decisionReasonType, ...extraMessage },
        },
      } satisfies ToolUpdateMeta,
    };
  }

  /**
   * The report that closes a tool call when the turn ends without its result.
   * If Claude dropped it before it ran (`ran` is false: its tool_use never
   * reached a complete assistant message, for example because Claude switched
   * to a steering message), a v2 client gets `cancelled` and every other
   * client `failed`, since v1 has no `cancelled`. If Claude Code ran it but
   * returned no result, it failed, unless a `session/cancel` ended the turn
   * (`cancelled`): the cancel stopped the run, so a v2 client gets `cancelled`
   * for it too. The report does not end the call's terminal: see {@link terminalExit}.
   */
  unfinished(call: { toolCallId: string; ran: boolean; cancelled?: boolean }): ToolCallUpdate {
    const stopped = !call.ran || call.cancelled === true;
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: call.toolCallId,
      status: stopped && this.capabilities.v2 ? V2_CANCELLED : "failed",
      content: [
        textContent(
          !call.ran
            ? "Claude stopped this tool call before it ran."
            : call.cancelled
              ? "The turn was cancelled before this tool call returned a result."
              : "Claude ended the turn without returning a result for this tool.",
        ),
      ],
    };
  }

  /**
   * The `_meta` that ends the display terminal of a command whose tool call gets no result, to
   * add to the report from {@link unfinished}. Undefined when the tool call has no terminal
   * (see {@link toolCall}). The exit code is unknown, since the command ended without a result:
   * null, or 1 for AIR, which always gets a number and reads 1 for a command that did not
   * succeed.
   */
  terminalExit(toolUse: ToolUse): Pick<ToolUpdateMeta, "terminal_exit"> | undefined {
    if (!this.hasTerminal(this.facts(toolUse))) return undefined;
    return {
      terminal_exit: {
        terminal_id: toolUse.id,
        exit_code: this.capabilities.air.client ? 1 : null,
        signal: null,
      },
    };
  }

  /**
   * The report of a tool progress beat. The field tracker sends the
   * `in_progress` status once, so a later beat carries only the progress.
   */
  progress(beat: {
    toolCallId: string;
    toolName?: string;
    parentToolUseId?: string;
    elapsedTimeSeconds: number;
    subagentType?: string;
    subagentRetry?: unknown;
  }): ToolCallUpdate {
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: beat.toolCallId,
      status: "in_progress",
      _meta: {
        claudeCode: {
          ...(beat.toolName !== undefined ? { toolName: beat.toolName } : {}),
          ...(beat.parentToolUseId ? { parentToolUseId: beat.parentToolUseId } : {}),
          toolResponse: {
            elapsedTimeSeconds: beat.elapsedTimeSeconds,
            // For Agent/Task calls: the subagent type, and the SDK retry
            // counters while the subagent waits out an API rate limit, so a
            // client can show why a spawn looks stalled.
            ...(beat.subagentType !== undefined && { subagentType: beat.subagentType }),
            ...(beat.subagentRetry !== undefined && { subagentRetry: beat.subagentRetry }),
          },
        },
      } satisfies ToolUpdateMeta,
    };
  }

  /**
   * `rawInput`. For AIR, without the file text that a diff holds, and with
   * the path of the plan file in place of the plan text.
   */
  rawInput(facts: ToolUseFacts, rawInput: unknown): unknown {
    if (facts.planFilePath) return planFileInput(rawInput, facts.planFilePath);
    if (
      !this.capabilities.air.client ||
      !facts.fileTextKeys ||
      !rawInput ||
      typeof rawInput !== "object" ||
      Array.isArray(rawInput)
    ) {
      return rawInput;
    }
    const input = { ...(rawInput as Record<string, unknown>) };
    for (const key of facts.fileTextKeys) delete input[key];
    return input;
  }

  /**
   * The content of a tool use. A command shows the terminal marker. An edit
   * shows its change. A display copy of the input goes only to a client that
   * does not render `rawInput` itself, and never next to a terminal.
   */
  toolUseContent(toolCallId: string, facts: ToolUseFacts): ToolCallContent[] {
    const terminal = this.hasTerminal(facts);
    return [
      ...(terminal ? [{ type: "terminal" as const, terminalId: toolCallId }] : []),
      ...(facts.change ?? []),
      ...(!terminal && !this.capabilities.air.rawInputRendering ? (facts.display ?? []) : []),
    ];
  }

  /**
   * The `_meta` of a tool use report: the tool name, and for AIR the tool
   * flags under `_meta.jetbrains.air`. A shell description stays out of the
   * standard `title`, which clients use as the command preview. Every other
   * client gets only the upstream tool name. [additionalDirectories] are the
   * session's `--add-dir` roots, where a Skill tool's SKILL.md can also be.
   */
  toolUseMeta(
    toolUse: { name: string; input?: unknown },
    cwd?: string,
    additionalDirectories?: readonly string[],
  ): ToolUpdateMeta {
    const input =
      toolUse.input !== null && typeof toolUse.input === "object"
        ? (toolUse.input as Record<string, unknown>)
        : {};
    const description =
      toolUse.name === "Bash" || toolUse.name === "PowerShell"
        ? shellDescription(input)
        : undefined;
    const skillName =
      toolUse.name === "Skill" && typeof input.skill === "string" ? input.skill : undefined;
    const subagent = toolUse.name === "Agent" || toolUse.name === "Task";
    if (!this.capabilities.air.client) return { claudeCode: { toolName: toolUse.name } };
    let meta: Record<string, unknown> = { claudeCode: { toolName: toolUse.name } };
    if (description) meta = withAirMeta(meta, AIR_COMMAND_TITLE_KEY, description);
    if (subagent) meta = withAirMeta(meta, AIR_SUBAGENT_KEY, true);
    if (skillName) {
      const skillPath = resolveSkillPath(skillName, cwd, undefined, additionalDirectories);
      meta = withAirMeta(meta, AIR_SKILL_KEY, {
        name: skillName,
        ...(skillPath ? { path: skillPath } : {}),
      });
    }
    const mcp = mcpToolName(toolUse.name);
    if (mcp) meta = withAirMeta(meta, AIR_MCP_KEY, mcp);
    return meta as ToolUpdateMeta;
  }
}

/**
 * Splits `mcp__<server>__<tool>` the way Claude Code does: the server is the
 * segment up to the next `__`, the tool is the whole rest. `server` is the
 * normalized name, not the config key.
 */
export function mcpToolName(name: string): { server: string; tool: string } | undefined {
  const prefix = "mcp__";
  if (!name.startsWith(prefix)) return undefined;
  const rest = name.slice(prefix.length);
  const separator = rest.indexOf("__");
  if (separator <= 0) return undefined;
  const tool = rest.slice(separator + 2);
  if (!tool) return undefined;
  return { server: rest.slice(0, separator), tool };
}

/** The input with the path of the plan file in place of the plan text. */
function planFileInput(rawInput: unknown, planFilePath: string): Record<string, unknown> {
  const input =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? { ...(rawInput as Record<string, unknown>) }
      : {};
  delete input.plan;
  return { ...input, planFilePath };
}
