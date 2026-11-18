/**
 * The display terminals of a session's commands, for a client that renders
 * terminals from the terminal extension and is not AIR (AIR shows a command
 * through its async tasks):
 *
 * - A command that went to the background: its terminal runs from its Bash
 *   tool result until its task ends.
 * - A command that runs in the foreground: its terminal gets the command's
 *   output as it runs, for a client that appends chunks
 *   (`terminal_output_delta`).
 */
import type { AcpSessionNotification } from "../acp-subagents.js";
import {
  type BackgroundOutput,
  foregroundCommandToolCall,
  isCommandTool,
  supportsTaskOutput,
  TaskOutputPoll,
} from "../background-output.js";
import type { Logger } from "../logger.js";
import { type StreamedTerminals, streamedTerminals } from "../tool-calls/background.js";
import type { ClientCapabilities } from "../tool-calls/client-capabilities.js";

/** The display terminal of a command. */
export interface BackgroundTerminal {
  /** The command's tool call, whose id names the terminal. */
  toolCallId: string;
  /** The subagent tool call that ran the command, if any. */
  parentToolUseId?: string;
}

/** The session's part of what {@link SessionBackgroundWork.followForeground} reads. */
export interface ForegroundCommandOwner {
  /** The session's query, which reads a task's output when it has `getTaskOutput`. */
  query: object;
  liveBackgroundTasks: ReadonlyMap<string, { parentToolUseId?: string }>;
  toolUseCache: Record<string, { name: string } | undefined>;
  emittedToolCalls: ReadonlySet<string>;
}

/** The terminals of the commands that one root session, and its subagents, run. */
export class SessionBackgroundWork {
  /** The terminals of the commands that went to the background, by task id. */
  private readonly terminals = new Map<string, BackgroundTerminal>();
  /**
   * The output polls of the commands that run in the foreground, by tool call
   * id, each with its task. A poll stays here after its task ended, stopped,
   * until the command's tool result asks whether its terminal got output.
   */
  private readonly foreground = new Map<string, { taskId: string; poll: TaskOutputPoll }>();

  constructor(private readonly sessionId: string) {}

  /**
   * Keeps the display terminal of the command `taskId` running after its Bash
   * result, until its task ends (see `withRunningTerminal`).
   */
  terminalStarted(taskId: string, terminal: BackgroundTerminal): void {
    this.terminals.set(taskId, terminal);
  }

  /**
   * The task `started` began. When it runs a command in the foreground whose
   * terminal the client shows (see {@link foregroundBashTerminal}), reads the
   * command's output into that terminal as it runs (see
   * {@link TaskOutputPoll}), until its tool result ({@link finishForeground})
   * or the end of its task ({@link taskEnded}).
   *
   * Only for a client that appends chunks (`terminal_output_delta`) and is not
   * AIR. A client that declared only `terminal_output`, and AIR, get the
   * output with the tool result. A query without `getTaskOutput` reads none.
   *
   * `send` sends an update of the terminal's tool call, routed as the call's
   * other updates. A chunk that cannot be sent is logged: the tool result
   * carries the whole output.
   */
  followForeground(
    started: { task_id: string } & Parameters<typeof foregroundBashTerminal>[1],
    {
      owner,
      capabilities,
      send,
      logger,
    }: {
      owner: ForegroundCommandOwner;
      capabilities: ClientCapabilities;
      send: Send;
      logger: Logger;
    },
  ): void {
    if (!capabilities.terminalOutputDelta || capabilities.air.client) return;
    const query = owner.query;
    const terminal = foregroundBashTerminal(owner, started);
    if (!terminal || !supportsTaskOutput(query) || this.foreground.has(terminal.toolCallId)) {
      return;
    }
    const taskId = started.task_id;
    this.foreground.set(terminal.toolCallId, {
      taskId,
      poll: new TaskOutputPoll(
        () => query.getTaskOutput(taskId),
        (output) =>
          send(terminalOutputUpdate(this.sessionId, terminal, output)).catch((error) => {
            logger.error("Failed to send command output:", error);
          }),
      ),
    });
  }

  /**
   * The tool results in `content` came: stops reading the output of each
   * foreground command among them. Returns how the result of each command
   * whose terminal got output as it ran reaches that terminal (see
   * `streamedTerminals`, for `withStreamedTerminal`): `backgrounded` is the
   * command that went to the background, and `toolResultMeta` the
   * `tool_result_meta` of the results' message.
   */
  async finishForeground(
    content: unknown,
    { backgrounded, toolResultMeta }: { backgrounded?: string; toolResultMeta?: unknown } = {},
  ): Promise<StreamedTerminals> {
    const shown: string[] = [];
    for (const block of Array.isArray(content) ? content : []) {
      const toolCallId: unknown = block?.type === "tool_result" ? block.tool_use_id : undefined;
      const followed = typeof toolCallId === "string" ? this.foreground.get(toolCallId) : undefined;
      if (!followed || typeof toolCallId !== "string") continue;
      this.foreground.delete(toolCallId);
      if (await followed.poll.finish()) shown.push(toolCallId);
    }
    return streamedTerminals(shown, backgrounded, toolResultMeta);
  }

  /** Stops every foreground output poll: the session's query closed. */
  queryClosed(): void {
    for (const { poll } of this.foreground.values()) poll.stop();
    this.foreground.clear();
  }

  /**
   * The task `taskId` ended. Its command's output is read no more: a tool call
   * that gets no result, such as one of a reply that Claude Code took back,
   * would otherwise be read until the query closes. The terminal of a command
   * that went to the background exits, with no exit code: Claude Code reports
   * none for a command.
   */
  async taskEnded(taskId: string, send: Send): Promise<void> {
    for (const followed of this.foreground.values()) {
      if (followed.taskId === taskId) followed.poll.stop();
    }
    const terminal = this.terminals.get(taskId);
    if (!terminal) return;
    this.terminals.delete(taskId);
    await send(terminalExit(this.sessionId, terminal));
  }
}

type Send = (notification: AcpSessionNotification) => Promise<void>;

/**
 * The display terminal of the foreground command that the task `started`
 * runs (see `foregroundCommandToolCall`), or undefined when it runs none that
 * the client shows: a task of another kind, one of a tool call that the client
 * was not sent, or one of a subagent whose Agent call is not known.
 */
export function foregroundBashTerminal(
  owner: Omit<ForegroundCommandOwner, "query">,
  started: {
    task_type?: string;
    is_backgrounded?: boolean;
    tool_use_id?: string;
    parent_task_id?: string;
  },
): BackgroundTerminal | undefined {
  const toolCallId = foregroundCommandToolCall(started);
  if (
    toolCallId === undefined ||
    !owner.emittedToolCalls.has(toolCallId) ||
    !isCommandTool(owner.toolUseCache[toolCallId]?.name)
  ) {
    return undefined;
  }
  if (started.parent_task_id === undefined) return { toolCallId };
  // A subagent's command: its updates go under the subagent's Agent call.
  const parentToolUseId = owner.liveBackgroundTasks.get(started.parent_task_id)?.parentToolUseId;
  return parentToolUseId ? { toolCallId, parentToolUseId } : undefined;
}

/** The update that gives the terminal of `terminal` the text `output`. */
function terminalOutputUpdate(
  sessionId: string,
  terminal: BackgroundTerminal,
  output: BackgroundOutput,
): AcpSessionNotification {
  const data = { terminal_id: terminal.toolCallId, data: output.text };
  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: terminal.toolCallId,
      _meta: {
        ...(terminal.parentToolUseId
          ? { claudeCode: { parentToolUseId: terminal.parentToolUseId } }
          : {}),
        ...(output.replaces ? { terminal_output: data } : { terminal_output_delta: data }),
      },
    },
  };
}

/** The update that exits the terminal of `terminal`, with no exit code. */
function terminalExit(sessionId: string, terminal: BackgroundTerminal): AcpSessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: terminal.toolCallId,
      _meta: {
        ...(terminal.parentToolUseId
          ? { claudeCode: { parentToolUseId: terminal.parentToolUseId } }
          : {}),
        terminal_exit: { terminal_id: terminal.toolCallId, exit_code: null, signal: null },
      },
    },
  };
}
