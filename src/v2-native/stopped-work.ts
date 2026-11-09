/**
 * The work of a native ACP v2 session that a `session/cancel` stopped before
 * the client saw it, and the reach of the cancel's interrupt.
 *
 * A cancel answers every prompt that is not inserted yet with -32800, also
 * one that went to Claude Code already. Claude Code can still run such a
 * prompt, when it had taken it in before the interrupt arrived. The client
 * was told the prompt never ran, so that run is dropped: its output, its
 * states, and its permission requests, which are denied. So is a model cycle
 * that Claude Code had started on its own (a `status: requesting` frame came)
 * and that showed nothing yet when the cancel came while the session was
 * idle. The bridge drops the same work.
 *
 * The interrupt stops whatever Claude Code runs when it arrives, which can be
 * a cycle that the session reads only after the cancel. That cycle ends with
 * an aborted result, which reports `cancelled`.
 */
import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { isAbortedResult } from "../acp-agent.js";

/**
 * How long `canUseTool` waits, after a cancel, for the session to read the
 * tool use that it asks about, as on the bridge.
 */
const TOOL_USE_WAIT_MS = 2_000;

export class StoppedWork {
  /** The prompts that a cancel answered with -32800 after they went to Claude Code. */
  private readonly abandoned = new Set<string>();
  /** Whether Claude Code runs dropped work: its output goes nowhere. */
  private dropping = false;
  /**
   * The tool uses of the main conversation that the session read since the
   * last result, each with whether it was dropped work's.
   */
  private readonly toolUses = new Map<string, boolean>();
  /** The `canUseTool` checks that wait for the session to read their tool use. */
  private readonly toolUseWaiters = new Map<string, Set<() => void>>();
  /** Whether a cancel's interrupt went out and Claude Code has not shown what it stopped. */
  private interruptPending = false;
  /**
   * Whether a model request started since the last result: a `status:
   * requesting` frame, which starts each one.
   */
  modelRequestSinceResult = false;

  /**
   * A cancel: `pushed` are the prompts it answered that Claude Code has, and
   * `foreground` whether the client sees work running. A cycle that Claude
   * Code started while the client saw none is dropped.
   */
  cancelled(pushed: readonly string[], foreground: boolean): void {
    for (const uuid of pushed) this.abandoned.add(uuid);
    if (!foreground && this.modelRequestSinceResult) this.dropping = true;
    this.interruptPending = true;
  }

  /** The interrupt failed: Claude Code stops nothing. */
  interruptFailed(): void {
    this.interruptPending = false;
  }

  /** A `status: requesting` frame, with the prompts that the request serves. */
  requesting(prompts: readonly string[]): void {
    this.modelRequestSinceResult = true;
    if (prompts.some((uuid) => this.abandoned.has(uuid))) this.dropping = true;
  }

  /**
   * Claude Code takes in the prompt `uuid` (its `started` frame or echo).
   * Returns whether it is one that a cancel abandoned, which then adds
   * nothing: its run is dropped, or, when work is open (`foreground`), Claude
   * Code folded it into the work that the cancel stops. Another prompt's run
   * is not dropped.
   */
  promptStarted(uuid: string, foreground: boolean): boolean {
    if (!this.abandoned.has(uuid)) {
      // Claude Code takes its prompts in order: the earlier ones ran or were dropped.
      this.abandoned.clear();
      this.endDropping();
      return false;
    }
    if (!foreground) this.dropping = true;
    return true;
  }

  /** Claude Code ended the prompt `uuid` (`completed` or `cancelled`). */
  promptEnded(uuid: string): void {
    if (this.abandoned.delete(uuid)) this.endDropping();
  }

  /**
   * Whether `message`, output of the main conversation, is dropped work's.
   * Records the tool uses it asks to run.
   */
  drops(message: { type: string; message?: unknown; event?: unknown }): boolean {
    for (const id of toolUseIds(message)) {
      this.toolUses.set(id, this.dropping);
      const waiters = this.toolUseWaiters.get(id);
      this.toolUseWaiters.delete(id);
      for (const waiter of waiters ?? []) waiter();
    }
    return this.dropping;
  }

  /**
   * Whether `canUseTool` denies the tool use `toolUseId` of the agent
   * `agentId` (undefined for the main conversation): dropped work asks to
   * run it. Claude Code asks on its control channel after it streamed the
   * tool use, and the session can read the stream later. So after a cancel,
   * while dropped work may run, this waits until the session reads the tool
   * use, for at most {@link TOOL_USE_WAIT_MS} or until `signal` aborts: the
   * stream never shows some tool uses, such as SandboxNetworkAccess's.
   */
  async dropsToolUse(
    toolUseId: string,
    agentId: string | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (agentId !== undefined) return false;
    const read = this.toolUses.get(toolUseId);
    if (read !== undefined) return read;
    if ((this.abandoned.size === 0 && !this.dropping) || signal.aborted) return false;
    await new Promise<void>((resolve) => {
      const waiters = this.toolUseWaiters.get(toolUseId) ?? new Set<() => void>();
      this.toolUseWaiters.set(toolUseId, waiters);
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, TOOL_USE_WAIT_MS);
      signal.addEventListener("abort", done, { once: true });
      waiters.add(done);
    });
    return this.toolUses.get(toolUseId) ?? this.dropping;
  }

  /**
   * A result that is not a placeholder. Returns whether it ends dropped work,
   * and whether it ends work that the interrupt stopped (an aborted result
   * after a cancel).
   */
  result(result: SDKResultMessage): { dropped: boolean; interrupted: boolean } {
    this.modelRequestSinceResult = false;
    // Claude Code asks for a tool use before the result that ends its turn.
    this.toolUses.clear();
    const interrupted = this.interruptPending && isAbortedResult(result);
    if (interrupted) this.interruptPending = false;
    const dropped = this.dropping;
    this.endDropping();
    return { dropped, interrupted };
  }

  /**
   * Claude Code went idle, other than right after a result: what it ran has
   * ended, and so has the interrupt's reach.
   */
  idle(): void {
    this.interruptPending = false;
    this.modelRequestSinceResult = false;
    this.endDropping();
  }

  private endDropping(): void {
    this.dropping = false;
  }
}

/** The ids of the tool uses in an assistant message, or in a streamed tool_use block's start. */
function toolUseIds(message: { type: string; message?: unknown; event?: unknown }): string[] {
  if (message.type === "assistant") {
    const content = (message as SDKAssistantMessage).message.content;
    return Array.isArray(content)
      ? content.flatMap((block) => (block.type === "tool_use" ? [block.id] : []))
      : [];
  }
  if (message.type === "stream_event") {
    const event = (message as SDKPartialAssistantMessage).event;
    if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
      return [event.content_block.id];
    }
  }
  return [];
}
