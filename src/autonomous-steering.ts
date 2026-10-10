/** Session-owned steering commands have no pending ACP prompt to settle. */
export class AutonomousSteering {
  private running = false;
  private stopped = false;
  private commands = new Map<
    string,
    { started: boolean; resultSeen: boolean; allowUnstamped: boolean; cancelled: boolean }
  >();

  get isRunning(): boolean {
    return this.running;
  }

  stateChanged(state: "idle" | "running" | "requires_action"): void {
    this.running = !this.stopped && state !== "idle";
    if (state === "idle") {
      for (const [uuid, command] of this.commands) {
        if (command.resultSeen) this.commands.delete(uuid);
      }
    }
  }

  add(uuid: string): void {
    this.commands.set(uuid, {
      started: false,
      resultSeen: false,
      allowUnstamped: true,
      cancelled: false,
    });
  }

  started(uuid: string): void {
    const command = this.commands.get(uuid);
    if (command) {
      command.started = true;
      if (!this.stopped && command.allowUnstamped && !command.resultSeen) this.running = true;
    }
  }

  promptStarted(): void {
    // Older producers omit result UUIDs. After a prompt takes over, only an
    // exact UUID can distinguish its result from a late autonomous steer.
    for (const command of this.commands.values()) command.allowUnstamped = false;
  }

  finished(uuid: string, state: string): void {
    const command = this.commands.get(uuid);
    if (!command) return;
    if (
      state === "discarded" ||
      state === "refused" ||
      (state === "cancelled" && !command.started)
    ) {
      this.commands.delete(uuid);
    } else if (state === "completed") {
      // A folded command can complete before the cycle that answers it.
      command.started = true;
      if (command.resultSeen) this.commands.delete(uuid);
    }
  }

  result(message: {
    user_message_uuid?: string;
    user_message_uuids?: string[];
  }): Map<string, { cancelled: boolean; superseded: boolean }> {
    // A result closes the observed running interval even if its idle is late.
    this.running = false;
    const uuids =
      message.user_message_uuids ??
      (message.user_message_uuid === undefined ? undefined : [message.user_message_uuid]);
    const answered = new Map<string, { cancelled: boolean; superseded: boolean }>();
    if (uuids !== undefined) {
      for (const uuid of uuids) {
        const command = this.commands.get(uuid);
        if (command) {
          answered.set(uuid, { cancelled: command.cancelled, superseded: !command.allowUnstamped });
          this.commands.delete(uuid);
        }
      }
    } else {
      for (const [uuid, command] of this.commands) {
        if (command.started && !command.resultSeen && command.allowUnstamped) {
          answered.set(uuid, { cancelled: command.cancelled, superseded: !command.allowUnstamped });
          command.resultSeen = true;
        }
      }
    }
    return answered;
  }

  cancel(): string[] {
    this.running = false;
    this.promptStarted();
    for (const command of this.commands.values()) command.cancelled = true;
    // Keep exact ownership until the result or terminal command frame arrives.
    return [...this.commands.keys()];
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
  }

  close(): void {
    this.stop();
    this.cancel();
    this.commands.clear();
  }
}
