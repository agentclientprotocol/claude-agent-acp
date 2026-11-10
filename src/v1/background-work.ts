/**
 * The commands of a session that went to the background, for a client that
 * renders terminals from the terminal extension and is not AIR (AIR shows a
 * command through its async tasks): the display terminal of each command
 * runs from its Bash tool result until its task ends.
 */
import type { AcpSessionNotification } from "../acp-subagents.js";

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

  constructor(private readonly sessionId: string) {}

  /**
   * Keeps the display terminal of the command `taskId` running after its Bash
   * result, until its task ends (see `withRunningTerminal`).
   */
  terminalStarted(taskId: string, terminal: BackgroundTerminal): void {
    this.terminals.set(taskId, terminal);
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
