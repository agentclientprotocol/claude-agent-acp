/**
 * The commands of a session that went to the background, for a client that
 * renders terminals from the terminal extension and is not AIR (AIR shows a
 * command through its async tasks): the display terminal of each command
 * runs from its Bash tool result until its task ends.
 */
import type { AcpSessionNotification } from "../acp-subagents.js";
import { type BackgroundOutput, type TaskOutput, TaskOutputPoll } from "../background-output.js";

/** The display terminal of a command that went to the background. */
export interface BackgroundTerminal {
  /** The Bash tool call, whose id names the terminal. */
  toolCallId: string;
  /** The subagent tool call that ran the command, if any. */
  parentToolUseId?: string;
}

/** The terminals of the commands that one root session, and its subagents, run in the background. */
export class SessionBackgroundWork {
  /** The terminals of the commands that went to the background, by task id. */
  private readonly terminals = new Map<string, BackgroundTerminal>();
  /** The output polls of the commands that run in the foreground, by Bash tool call id. */
  private readonly foreground = new Map<string, TaskOutputPoll>();

  constructor(private readonly sessionId: string) {}

  /**
   * Keeps the display terminal of the command `taskId` running after its Bash
   * result, until its task ends (see `withRunningTerminal`).
   */
  terminalStarted(taskId: string, terminal: BackgroundTerminal): void {
    this.terminals.set(taskId, terminal);
  }

  /**
   * Starts reading the output of a command that runs in the foreground into
   * its terminal `terminal`, with `read` (see {@link TaskOutputPoll}), until
   * {@link finishForeground}. `send` sends an update of the terminal's tool
   * call, routed as the call's other updates.
   */
  followForeground(
    terminal: BackgroundTerminal,
    read: () => Promise<TaskOutput>,
    send: Send,
  ): void {
    if (this.foreground.has(terminal.toolCallId)) return;
    this.foreground.set(
      terminal.toolCallId,
      new TaskOutputPoll(read, (output) =>
        send(terminalOutputUpdate(this.sessionId, terminal, output)),
      ),
    );
  }

  /**
   * Stops reading the output of the foreground command of the Bash tool call
   * `toolCallId`: its result came. Returns whether its terminal got output.
   */
  async finishForeground(toolCallId: string): Promise<boolean> {
    const poll = this.foreground.get(toolCallId);
    if (!poll) return false;
    this.foreground.delete(toolCallId);
    return poll.finish();
  }

  /** Stops every foreground output poll: the session's query closed. */
  queryClosed(): void {
    for (const poll of this.foreground.values()) poll.stop();
    this.foreground.clear();
  }

  /**
   * The task `taskId` ended: exits its command's terminal, with no exit code.
   * Claude Code reports no exit code for a command.
   */
  async taskEnded(taskId: string, send: Send): Promise<void> {
    const terminal = this.terminals.get(taskId);
    if (!terminal) return;
    this.terminals.delete(taskId);
    await send(terminalExit(this.sessionId, terminal));
  }
}

type Send = (notification: AcpSessionNotification) => Promise<void>;

/**
 * The display terminal of the foreground command that the task `started`
 * runs, or undefined when it runs none that the client shows: a task that is
 * not a foreground `local_bash` one, one of a tool call that the client was
 * not sent, or one of a subagent whose Agent call is not known. Claude Code
 * starts the task of a foreground command only once the command has run for
 * a few seconds (about 3 s with CLI 2.1.321); a faster command ends with its
 * output in the tool result, as before.
 */
export function foregroundBashTerminal(
  owner: {
    liveBackgroundTasks: ReadonlyMap<string, { parentToolUseId?: string }>;
    toolUseCache: Record<string, { name: string } | undefined>;
    emittedToolCalls: ReadonlySet<string>;
  },
  started: {
    task_type?: string;
    is_backgrounded?: boolean;
    tool_use_id?: string;
    parent_task_id?: string;
  },
): BackgroundTerminal | undefined {
  const toolCallId = started.tool_use_id;
  if (
    started.task_type !== "local_bash" ||
    started.is_backgrounded !== false ||
    toolCallId === undefined ||
    !owner.emittedToolCalls.has(toolCallId) ||
    owner.toolUseCache[toolCallId]?.name !== "Bash"
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
