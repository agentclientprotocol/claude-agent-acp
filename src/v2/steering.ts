import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { AUTONOMOUS_RESULT_ORIGINS } from "../result-end.js";
import { combinedEnd, type TurnEnd } from "./outcome.js";

/** Tracks SDK messages within the session's existing foreground turn. */
export class SessionSteering {
  private readonly pending = new Map<string, boolean>();
  private carried: TurnEnd | undefined;

  add(uuid: string): void {
    this.pending.set(uuid, false);
  }

  /** Returns whether a lifecycle frame or echo already reported this start. */
  repeatedStart(uuid: string): boolean {
    const started = this.pending.get(uuid);
    if (started === undefined) return false;
    this.pending.set(uuid, true);
    return started;
  }

  forget(uuid: string): boolean {
    return this.pending.delete(uuid);
  }

  get outstanding(): boolean {
    return this.pending.size > 0;
  }

  queued(): string[] {
    return [...this.pending].filter(([, started]) => !started).map(([uuid]) => uuid);
  }

  /** A stamped result identifies the messages it answers. Older producers
   * echo an injected message after the pre-empted result and before its own
   * result, so for an unstamped human result the echo is the fallback. */
  observeResult(message: SDKResultMessage): void {
    if (!this.outstanding) return;
    const consumed =
      message.user_message_uuids ??
      (message.user_message_uuid !== undefined ? [message.user_message_uuid] : undefined);
    if (consumed) {
      for (const uuid of consumed) this.forget(uuid);
    } else if (!message.origin || !AUTONOMOUS_RESULT_ORIGINS.has(message.origin.kind)) {
      this.cycleEnded();
    }
  }

  /** An unstamped result or an idle with no preceding result ended the cycle. */
  cycleEnded(): void {
    for (const [uuid, started] of this.pending) {
      if (started) this.forget(uuid);
    }
  }

  carry(end: TurnEnd): void {
    this.carried = this.carried ? combinedEnd([this.carried, end]) : end;
  }

  finish(end?: TurnEnd): TurnEnd | undefined {
    const carried = this.carried;
    this.carried = undefined;
    return carried && end ? combinedEnd([carried, end]) : (end ?? carried);
  }

  clear(): void {
    this.pending.clear();
    this.carried = undefined;
  }
}
