export type PromptCacheTtl = "5m" | "1h";

export type IdleCompactionHost = {
  /** Claude is working (`startTurn`'s check) or a permission request / user input is pending. */
  isBusy(): boolean;
  /** Context size after the last main-thread request, or undefined if unknown. */
  contextTokens(): number | undefined;
  /** Current merged Claude Code settings. */
  settings(): {
    idleCompaction?: boolean;
    autoCompactEnabled?: boolean;
    env?: Record<string, string | undefined>;
  };
  /** Runs `/compact` as an adapter-originated turn; settles with that turn. */
  compact(): Promise<unknown>;
  /** Debug-level log. */
  log(message: string): void;
};

export type IdleCompactionOptions = {
  env?: Record<string, string | undefined>;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

/** The longest delay `setTimeout` takes; a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;
const HOUR_MS = 3_600_000;
const DEFAULT_MIN_TOKENS = 200_000;
const MIN_TOKENS_FLOOR = 100_000;
// 54 min for a 1h cache: leaves a margin for the gap between the provider
// writing the cache and the adapter receiving the response.
const DEFAULT_DELAY_MS = 0.9 * HOUR_MS;
// The values Claude Code reads as "on" for env flags such as DISABLE_COMPACT
// (case-insensitive, trimmed).
const TRUTHY_ENV = new Set(["1", "true", "yes", "on"]);

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && TRUTHY_ENV.has(value.trim().toLowerCase());
}

function parseCacheTtl(usage: unknown): PromptCacheTtl | undefined {
  const creation = (usage as { cache_creation?: unknown } | null | undefined)?.cache_creation;
  if (typeof creation !== "object" || creation === null) return undefined;
  const { ephemeral_1h_input_tokens: hour, ephemeral_5m_input_tokens: fiveMin } = creation as {
    ephemeral_1h_input_tokens?: unknown;
    ephemeral_5m_input_tokens?: unknown;
  };
  if (typeof hour === "number" && hour > 0) return "1h";
  if (typeof fiveMin === "number" && fiveMin > 0) return "5m";
  return undefined;
}

/**
 * Compacts a session shortly before its one-hour prompt cache expires, so the
 * next prompt writes a short summary instead of the whole context. Claude Code
 * has this feature but arms it only for "attended" sessions, which SDK sessions
 * are not. One instance per session.
 */
export class IdleCompaction {
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private ttl: PromptCacheTtl | undefined;
  private lastRequestAt: number | undefined;
  /** Set when `/compact` was sent, cleared by the next request: a compaction that failed,
   *  or left the context large, would otherwise re-arm at once and loop until the user prompts. */
  private compactedSinceLastRequest = false;
  private timer: unknown;
  private compacting = false;
  private disposed = false;
  private warnedInvalidDelay = false;

  constructor(
    private readonly host: IdleCompactionHost,
    options: IdleCompactionOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer =
      options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Whether an idle compaction it started is still running. `acp-agent.ts` reports
   *  `trigger: "idle"` while it is true. A client's `/compact` queued behind is read
   *  only after the adapter's turn's `result`, which clears `compacting`; this relies
   *  on the CLI emitting that compaction's `compact_boundary` after the previous
   *  result, which nothing here enforces. */
  get isCompacting(): boolean {
    return this.compacting;
  }

  /** A main-thread assistant message arrived. Records its time and cache TTL, and drops any armed timer.
   *  The CLI sends one `assistant` message per content block of a response, so this can run
   *  several times for one request. That is harmless: the usage is the same, and each call
   *  only re-records the time. */
  noteRequest(usage: unknown): void {
    if (this.disposed) return;
    this.ttl = parseCacheTtl(usage) ?? this.ttl;
    this.lastRequestAt = this.now();
    this.compactedSinceLastRequest = false;
    this.disarm("new request");
  }

  /** The session became idle. Arms the timer if every condition holds, else logs why not. */
  onIdle(): void {
    if (this.disposed) return;
    const skip = this.skipReason();
    if (skip) {
      this.host.log(`[idle-compaction] skip: ${skip}`);
      return;
    }
    this.disarm("rearm");
    const deadline = this.lastRequestAt! + this.delayMs();
    this.timer = this.setTimer(() => void this.fire(), Math.max(0, deadline - this.now()));
    (this.timer as { unref?: () => void } | undefined)?.unref?.();
    this.host.log(`[idle-compaction] armed deadline=${new Date(deadline).toISOString()}`);
  }

  /** Claude Code reported its compaction as failed. Its turn still ends normally, so `compact()` does not reject. */
  noteCompactionFailed(error: string | undefined): void {
    if (!this.compacting) return;
    this.host.log(`[idle-compaction] compaction failed: ${error ?? "no reason given"}`);
  }

  /** The conversation was replaced (`/clear`): forgets the recorded request and TTL, and drops any armed timer. */
  reset(): void {
    this.ttl = undefined;
    this.lastRequestAt = undefined;
    this.compactedSinceLastRequest = false;
    this.disarm("conversation reset");
  }

  /** Drops the armed timer, if any. `reason` is only logged. */
  disarm(reason: string): void {
    if (this.timer === undefined) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
    this.host.log(`[idle-compaction] disarmed: ${reason}`);
  }

  /** Disarms and ignores every later call. */
  dispose(): void {
    this.disarm("disposed");
    this.disposed = true;
  }

  private async fire(): Promise<void> {
    this.timer = undefined;
    if (this.disposed) return;
    const skip = this.skipReason();
    if (skip) {
      this.host.log(`[idle-compaction] skip at fire: ${skip}`);
      return;
    }
    this.host.log("[idle-compaction] firing /compact");
    this.compacting = true;
    this.compactedSinceLastRequest = true;
    try {
      await this.host.compact();
    } catch (error) {
      this.host.log(`[idle-compaction] compaction failed: ${error}`);
    } finally {
      this.compacting = false;
    }
  }

  /** Why no compaction should be scheduled right now, or undefined if all conditions hold. */
  private skipReason(): string | undefined {
    if (this.compacting) return "compaction already running";
    const disabled = this.disabledBy();
    if (disabled) return `disabled by ${disabled}`;
    if (this.lastRequestAt === undefined) return "no request recorded in this process";
    if (this.compactedSinceLastRequest) return "already compacted for this request";
    if (this.ttl !== "1h") return `cache TTL is ${this.ttl ?? "unknown"}, not 1h`;
    const tokens = this.host.contextTokens();
    const min = this.minTokens();
    if (tokens === undefined || tokens < min) {
      return `context ${tokens ?? "unknown"} tokens is below the ${min} minimum`;
    }
    if (this.host.isBusy()) return "session is busy";
    return undefined;
  }

  private disabledBy(): string | undefined {
    const settings = this.host.settings();
    if (settings.idleCompaction === false) return "idleCompaction setting";
    if (settings.autoCompactEnabled === false) return "autoCompactEnabled setting";
    for (const name of ["DISABLE_COMPACT", "DISABLE_AUTO_COMPACT"]) {
      // The CLI applies the settings `env` block after the launch env, so it wins.
      if (isTruthyEnv(settings.env?.[name] ?? this.env[name])) return name;
    }
    return undefined;
  }

  /** `0` and invalid values fall back to 200,000, as in the CLI, which declares the variable
   *  with `min: 1` and computes `Math.max(100000, env ?? 200000)`. */
  private minTokens(): number {
    const raw = this.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS;
    const parsed = raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : 0;
    return Math.max(MIN_TOKENS_FLOOR, parsed > 0 ? parsed : DEFAULT_MIN_TOKENS);
  }

  private delayMs(): number {
    const raw = this.env.CLAUDE_AGENT_ACP_IDLE_COMPACT_DELAY_MS;
    if (raw === undefined) return DEFAULT_DELAY_MS;
    if (/^\d+$/.test(raw.trim()) && Number(raw.trim()) <= MAX_TIMER_MS) return Number(raw.trim());
    if (!this.warnedInvalidDelay) {
      this.warnedInvalidDelay = true;
      this.host.log(
        `[idle-compaction] ignoring invalid CLAUDE_AGENT_ACP_IDLE_COMPACT_DELAY_MS=${raw}`,
      );
    }
    return DEFAULT_DELAY_MS;
  }
}
