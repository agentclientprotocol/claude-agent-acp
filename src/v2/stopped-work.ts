/**
 * The work of an ACP v2 session that a `session/cancel` stopped before
 * the client saw it, and the reach of the cancel's interrupt.
 *
 * A cancel answers every prompt that is not inserted yet with -32800, also
 * one that went to Claude Code already. Claude Code can still run such a
 * prompt, when it had taken it in before the interrupt arrived. The client
 * was told the prompt never ran, so that run is dropped: its output, its
 * states, and its permission requests, which are denied. So is a model cycle
 * that Claude Code had started on its own (a `status: requesting` frame came)
 * and that showed nothing yet when the cancel came while the session was
 * idle.
 *
 * The interrupt stops whatever Claude Code runs when it arrives, which can be
 * a cycle that the session reads only after the cancel. That cycle ends with
 * an aborted result, which reports `cancelled`. Only the next result can be
 * that cycle's after a cancel of an idle session, and the next two after a
 * cancel of open work (the open cycle can end before the interrupt arrives).
 * A prompt that a cancel did not abandon starting, or an idle that follows no
 * result, ends that reach sooner: a later aborted result, such as of an
 * interrupt from Claude Code's remote control, reports as it would without
 * the cancel.
 */
import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { isAbortedResult } from "../acp-agent.js";

/**
 * How long `canUseTool` waits, after a cancel, for the session to read the
 * tool use that it asks about, as on v1 (`TOOL_USE_WAIT_MS`).
 */
const TOOL_USE_WAIT_MS = 2_000;

export class StoppedWork {
  /** The prompts that a cancel answered with -32800 after they went to Claude Code. */
  private readonly abandoned = new Set<string>();
  /** Whether Claude Code runs dropped work: its output goes nowhere. */
  private dropping = false;
  /** The abandoned prompt whose run is dropped, when a prompt's run is. */
  private droppingFor: string | undefined;
  /** The prompts that Claude Code took in since the last result. */
  private readonly startedSinceResult = new Set<string>();
  /**
   * Whether the late result of a dead turn may still come: Claude Code sent
   * `cancelled` for a prompt that it had started, before any result. The v1
   * core calls such a prompt a zombie.
   */
  private deadTurnResult = false;
  /**
   * The tool uses of the main conversation that the session read since the
   * last result, each with whether it was dropped work's.
   */
  private readonly toolUses = new Map<string, boolean>();
  /** The `canUseTool` checks that wait for the session to read their tool use. */
  private readonly toolUseWaiters = new Map<string, Set<() => void>>();
  /**
   * How many of the next results a cancel's interrupt can end, until Claude
   * Code shows what it stopped: 2 after a cancel of open work, whose result
   * can come before the interrupt arrives and stops the next cycle, and 1
   * after a cancel of an idle session (the cycle that Claude Code runs when
   * it arrives).
   */
  private interruptReach = 0;
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
    this.interruptReach = foreground ? 2 : 1;
  }

  /** The interrupt failed: Claude Code stops nothing. */
  interruptFailed(): void {
    this.interruptReach = 0;
  }

  /** A `status: requesting` frame, with the prompts that the request serves. */
  requesting(prompts: readonly string[]): void {
    this.modelRequestSinceResult = true;
    const abandoned = prompts.find((uuid) => this.abandoned.has(uuid));
    if (abandoned !== undefined) this.drop(abandoned);
  }

  /**
   * Claude Code takes in the prompt `uuid` (its `started` frame or echo).
   * Returns whether it is one that a cancel abandoned, which then adds
   * nothing: its run is dropped, or, when work is open (`foreground`), Claude
   * Code folded it into the work that the cancel stops. Another prompt's run
   * is not dropped.
   */
  promptStarted(uuid: string, foreground: boolean): boolean {
    this.startedSinceResult.add(uuid);
    if (!this.abandoned.has(uuid)) {
      // Claude Code takes its prompts in order: the earlier ones ran or were
      // dropped, and a dead turn's late result came before this prompt started.
      // A prompt that a cancel did not abandon went to Claude Code after the
      // cancel's interrupt, on the same stdin: the interrupt reached no
      // further either.
      this.abandoned.clear();
      this.endDropping();
      this.deadTurnResult = false;
      this.interruptReach = 0;
      return false;
    }
    if (!foreground) this.drop(uuid);
    return true;
  }

  /**
   * Claude Code ended the prompt `uuid` (`completed`, or `cancelled` when
   * `cancelled`). Only the end of the prompt whose run is dropped ends the
   * drop: another abandoned prompt's `cancelled` frame, which the interrupt's
   * `cancelQueued` sends, does not.
   */
  promptEnded(uuid: string, cancelled = false): void {
    // `cancelled` after `started` and before a result: the turn died, and its
    // result can still come after this frame. That result ends nothing.
    if (cancelled && this.startedSinceResult.delete(uuid)) this.deadTurnResult = true;
    if (this.abandoned.delete(uuid) && this.droppingFor === uuid) this.endDropping();
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
        if (waiters.size === 0 && this.toolUseWaiters.get(toolUseId) === waiters) {
          this.toolUseWaiters.delete(toolUseId);
        }
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
   * or is the late result of a dead turn (see {@link promptEnded}), and
   * whether it ends work that the interrupt stopped (an aborted result after
   * a cancel).
   */
  result(result: SDKResultMessage): { dropped: boolean; interrupted: boolean } {
    this.modelRequestSinceResult = false;
    this.startedSinceResult.clear();
    // Claude Code asks for a tool use before the result that ends its turn.
    this.toolUses.clear();
    // An aborted result shows what the interrupt stopped. Another one uses up
    // one result of its reach (see `interruptReach`).
    const aborted = this.interruptReach > 0 && isAbortedResult(result);
    this.interruptReach = aborted ? 0 : Math.max(0, this.interruptReach - 1);
    const dropped = this.dropping || this.deadTurnResult;
    this.deadTurnResult = false;
    this.endDropping();
    return { dropped, interrupted: aborted && !dropped };
  }

  /**
   * Claude Code went idle, other than right after a result: what it ran has
   * ended, and so has the interrupt's reach.
   */
  idle(): void {
    this.interruptReach = 0;
    this.modelRequestSinceResult = false;
    // A dead turn's result comes before Claude Code goes idle, or never.
    this.deadTurnResult = false;
    this.startedSinceResult.clear();
    this.endDropping();
  }

  /** Drops the run of the abandoned prompt `uuid`. */
  private drop(uuid: string): void {
    this.dropping = true;
    this.droppingFor = uuid;
  }

  private endDropping(): void {
    this.dropping = false;
    this.droppingFor = undefined;
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
