import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleCompaction, type IdleCompactionHost } from "../idle-compaction.js";

const MIN = 60_000;
const ONE_HOUR = {
  cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 },
};
const FIVE_MIN = {
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 1000 },
};
const NOTHING_WRITTEN = {
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
};

function setup(
  options: {
    env?: Record<string, string | undefined>;
    tokens?: number;
    settings?: ReturnType<IdleCompactionHost["settings"]>;
    setTimeout?: (callback: () => void, ms: number) => unknown;
  } = {},
) {
  const state = {
    busy: false,
    tokens: options.tokens ?? 200_000,
    settings: options.settings ?? {},
  };
  const host = {
    isBusy: vi.fn(() => state.busy),
    contextTokens: vi.fn(() => state.tokens),
    settings: vi.fn(() => state.settings),
    compact: vi.fn(async (): Promise<unknown> => undefined),
    log: vi.fn(),
  };
  const idle = new IdleCompaction(host, { env: options.env ?? {}, setTimeout: options.setTimeout });
  return { idle, host, state };
}

/** Records a 1h-cache request and goes idle. */
function requestAndIdle(idle: IdleCompaction, usage: unknown = ONE_HOUR) {
  idle.noteRequest(usage);
  idle.onIdle();
}

describe("IdleCompaction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A failed compaction is logged and must not re-arm from the same request, or it loops until the user prompts. */
  it("does not arm again for a request it already compacted for", async () => {
    const { idle, host } = setup();
    host.compact.mockRejectedValue(new Error("boom"));
    requestAndIdle(idle);
    await vi.advanceTimersByTimeAsync(54 * MIN);
    expect(host.compact).toHaveBeenCalledTimes(1);
    expect(host.log).toHaveBeenCalledWith(expect.stringContaining("boom"));

    idle.onIdle();
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
    expect(host.compact).toHaveBeenCalledTimes(1);

    requestAndIdle(idle);
    await vi.advanceTimersByTimeAsync(54 * MIN);
    expect(host.compact).toHaveBeenCalledTimes(2);
  });

  /** `/clear` replaces the conversation: what was recorded no longer describes it. */
  it("does not arm after reset until a new request", async () => {
    const { idle, host } = setup();
    requestAndIdle(idle);
    idle.reset();
    idle.onIdle();
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
    expect(host.compact).not.toHaveBeenCalled();

    requestAndIdle(idle);
    await vi.advanceTimersByTimeAsync(54 * MIN);
    expect(host.compact).toHaveBeenCalledTimes(1);
  });

  /** A reported failure is logged only while the adapter's own compaction runs. */
  it("logs a reported compaction failure only during its own compaction", async () => {
    const { idle, host } = setup();
    const running = Promise.withResolvers<void>();
    host.compact.mockReturnValue(running.promise);
    requestAndIdle(idle);

    idle.noteCompactionFailed("too short");
    expect(host.log).not.toHaveBeenCalledWith(expect.stringContaining("compaction failed"));
    await vi.advanceTimersByTimeAsync(54 * MIN);
    idle.noteCompactionFailed("too short");
    expect(host.log).toHaveBeenCalledWith("[idle-compaction] compaction failed: too short");
  });

  /** `isCompacting` is true exactly while the compaction it started runs. */
  it("reports isCompacting while its compaction runs", async () => {
    const { idle, host } = setup();
    const running = Promise.withResolvers<void>();
    host.compact.mockReturnValue(running.promise);
    requestAndIdle(idle);

    expect(idle.isCompacting).toBe(false);
    await vi.advanceTimersByTimeAsync(54 * MIN);
    expect(idle.isCompacting).toBe(true);
    running.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(idle.isCompacting).toBe(false);
  });

  /** A 1h-cache request with 200k context compacts at 54 minutes, not before. */
  it("arms and compacts at 54 minutes", async () => {
    const { idle, host } = setup();
    requestAndIdle(idle);

    await vi.advanceTimersByTimeAsync(54 * MIN - 1);
    expect(host.compact).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(host.compact).toHaveBeenCalledTimes(1);
  });

  /** The deadline counts from the request, not from when the session went idle. */
  it("measures the deadline from the request time", async () => {
    const { idle, host } = setup();
    idle.noteRequest(ONE_HOUR);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    idle.onIdle();

    await vi.advanceTimersByTimeAsync(44 * MIN);
    expect(host.compact).toHaveBeenCalledTimes(1);
  });

  /** A cache whose deadline passed more than 60 s ago is cold: a timer that fires that late (the machine slept) compacts nothing. */
  it.each([
    ["the timer fires 61 s late", 61_000, false],
    ["the timer fires 60 s late", 60_000, true],
  ])("when %s, compacts: %s", async (_name, lateMs, compacts) => {
    const { idle, host } = setup();
    requestAndIdle(idle);
    vi.setSystemTime(Date.now() + lateMs);
    await vi.advanceTimersByTimeAsync(54 * MIN);

    expect(host.compact).toHaveBeenCalledTimes(compacts ? 1 : 0);
  });

  /** Going idle after the deadline is more than 60 s past arms nothing. */
  it("does not arm when the deadline passed more than 60 s ago", async () => {
    const { idle, host } = setup();
    idle.noteRequest(ONE_HOUR);
    await vi.advanceTimersByTimeAsync(54 * MIN + 61_000);
    idle.onIdle();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.compact).not.toHaveBeenCalled();
    expect(host.log).toHaveBeenCalledWith(expect.stringContaining("lapsed"));
  });

  /** The rate limit status is the last one reported: a reset or a malformed event keeps `rejected`, a later `allowed` clears it. */
  it("keeps the rate limit status across a reset and a malformed event until an allowed one", async () => {
    const { idle, host } = setup();
    idle.noteRateLimit({ status: "rejected" });
    idle.noteRateLimit(null);
    idle.reset();
    requestAndIdle(idle);
    expect(vi.getTimerCount()).toBe(0);

    idle.noteRateLimit({ status: "allowed" });
    idle.onIdle();
    await vi.advanceTimersByTimeAsync(54 * MIN);
    expect(host.compact).toHaveBeenCalledTimes(1);
  });

  /** Later blocks of one response (same message id) keep the deadline from its first sighting; a new id moves it. */
  it.each([
    ["the same message id", "msg_1", 54 * MIN],
    ["a new message id", "msg_2", 54 * MIN + 7 * MIN],
  ])("a request with %s: the deadline stays or moves", async (_name, id, firesAt) => {
    const { idle, host } = setup();
    idle.noteRequest(ONE_HOUR, "msg_1");
    await vi.advanceTimersByTimeAsync(7 * MIN);
    idle.noteRequest(ONE_HOUR, id);
    idle.onIdle();

    await vi.advanceTimersByTimeAsync(firesAt - 7 * MIN - 1);
    expect(host.compact).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(host.compact).toHaveBeenCalledTimes(1);
  });

  /** A deadline already in the past fires immediately. */
  it("fires right away when the deadline has passed", async () => {
    const { idle, host } = setup();
    idle.noteRequest(ONE_HOUR);
    await vi.advanceTimersByTimeAsync(55 * MIN);
    idle.onIdle();

    await vi.advanceTimersByTimeAsync(0);
    expect(host.compact).toHaveBeenCalledTimes(1);
  });

  /** Each condition that fails R2 leaves no timer armed. */
  it.each([
    ["5m TTL", { usage: FIVE_MIN }],
    ["unknown TTL", { usage: {} }],
    ["malformed usage", { usage: null }],
    ["context below the minimum", { tokens: 199_999 }],
    ["idleCompaction: false", { settings: { idleCompaction: false } }],
    ["autoCompactEnabled: false", { settings: { autoCompactEnabled: false } }],
    ["DISABLE_COMPACT", { env: { DISABLE_COMPACT: "1" } }],
    ["DISABLE_AUTO_COMPACT", { env: { DISABLE_AUTO_COMPACT: "true" } }],
    // Claude Code also reads these from the `env` block of settings.json.
    [
      "DISABLE_AUTO_COMPACT in the settings env",
      { settings: { env: { DISABLE_AUTO_COMPACT: "1" } } },
    ],
    ["rate limit status allowed_warning", { rateLimit: "allowed_warning" }],
    ["rate limit status rejected", { rateLimit: "rejected" }],
    [
      "CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS in the settings env",
      { tokens: 250_000, settings: { env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: "500000" } } },
    ],
    [
      "CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS in the settings env over the launch env",
      {
        tokens: 250_000,
        env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: "100000" },
        settings: { env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: "500000" } },
      },
    ],
  ])("does not arm: %s", async (_name, options0: Record<string, any>) => {
    const { usage, rateLimit, ...options } = options0;
    const { idle, host } = setup(options);
    if (rateLimit) idle.noteRateLimit({ status: rateLimit });
    requestAndIdle(idle, "usage" in options0 ? usage : ONE_HOUR);

    await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
    expect(host.compact).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(host.log).toHaveBeenCalledWith(expect.stringContaining("skip"));
  });

  /** A falsy value is not an opt-out, and the settings env is applied after the launch env, so its value wins, not an OR of the two. */
  it.each([
    ["DISABLE_COMPACT=0 in the launch env", { env: { DISABLE_COMPACT: "0" } }],
    [
      "DISABLE_AUTO_COMPACT=0 in the settings env over =1 in the launch env",
      {
        env: { DISABLE_AUTO_COMPACT: "1" },
        settings: { env: { DISABLE_AUTO_COMPACT: "0" } },
      },
    ],
  ])("arms: %s", async (_name, options) => {
    const { idle, host } = setup(options);
    requestAndIdle(idle);

    await vi.advanceTimersByTimeAsync(54 * MIN);
    expect(host.compact).toHaveBeenCalledTimes(1);
  });

  /** Idle without any request in this instance (resumed session) arms nothing. */
  it("does not arm before the first request", () => {
    const { idle, host } = setup();
    idle.onIdle();

    expect(vi.getTimerCount()).toBe(0);
    expect(host.log).toHaveBeenCalledWith(expect.stringContaining("no request recorded"));
  });

  /** A request that writes no cache keeps the previous request's TTL. */
  it("keeps the previous TTL when the request writes nothing", async () => {
    const { idle, host } = setup();
    idle.noteRequest(ONE_HOUR);
    requestAndIdle(idle, NOTHING_WRITTEN);

    await vi.advanceTimersByTimeAsync(54 * MIN);
    expect(host.compact).toHaveBeenCalledTimes(1);
  });

  /** A 5m request after a 1h one switches the TTL, so nothing arms. */
  it("switches to 5m when a later request writes a 5m cache", () => {
    const { idle } = setup();
    idle.noteRequest(ONE_HOUR);
    requestAndIdle(idle, FIVE_MIN);

    expect(vi.getTimerCount()).toBe(0);
  });

  /** The min-tokens env raises the threshold and is clamped to 100k from below. */
  it.each([
    ["300000", 299_999, false],
    ["300000", 300_000, true],
    ["50000", 99_999, false],
    ["50000", 100_000, true],
    ["abc", 200_000, true],
    ["abc", 199_999, false],
  ])("CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS=%s with %i tokens arms: %s", (min, tokens, arms) => {
    const { idle } = setup({ env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: min }, tokens });
    requestAndIdle(idle);

    expect(vi.getTimerCount()).toBe(arms ? 1 : 0);
  });

  /** The delay env overrides the 54 minute default; invalid values fall back and are logged once. */
  it.each([
    ["1000", 1000, false],
    ["0", 0, false],
    ["-5", 54 * MIN, true],
    ["soon", 54 * MIN, true],
    ["2147483648", 54 * MIN, true],
  ])("CLAUDE_AGENT_ACP_IDLE_COMPACT_DELAY_MS=%s fires after %ims", async (value, ms, invalid) => {
    const { idle, host } = setup({ env: { CLAUDE_AGENT_ACP_IDLE_COMPACT_DELAY_MS: value } });
    requestAndIdle(idle);

    await vi.advanceTimersByTimeAsync(ms - 1 < 0 ? 0 : ms - 1);
    if (ms > 0) expect(host.compact).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(host.compact).toHaveBeenCalledTimes(1);
    const warnings = host.log.mock.calls.filter(([m]) => String(m).includes("invalid"));
    expect(warnings).toHaveLength(invalid ? 1 : 0);
  });

  /** A new request drops the armed timer, so the deadline cannot fire for the old one; disarm and dispose drop it too. */
  it.each([
    ["noteRequest", (idle: IdleCompaction) => idle.noteRequest(ONE_HOUR)],
    ["disarm", (idle: IdleCompaction) => idle.disarm("prompt")],
    ["dispose", (idle: IdleCompaction) => idle.dispose()],
  ])("%s drops the timer", async (_name, drop) => {
    const { idle, host } = setup();
    requestAndIdle(idle);
    drop(idle);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(host.compact).not.toHaveBeenCalled();
  });

  /** After dispose, requests and idle notifications do nothing. */
  it("ignores calls after dispose", () => {
    const { idle } = setup();
    idle.dispose();
    requestAndIdle(idle);

    expect(vi.getTimerCount()).toBe(0);
  });

  /** A change after arming (busy, context shrunk, rate limit reached) is re-checked at the deadline: nothing is compacted and nothing re-arms. */
  it.each([
    ["the session became busy", "busy", (ctx: ReturnType<typeof setup>) => (ctx.state.busy = true)],
    [
      "the context shrank below the minimum",
      "below the",
      (ctx: ReturnType<typeof setup>) => (ctx.state.tokens = 50_000),
    ],
    [
      "the rate limit status became rejected",
      "rate limit",
      (ctx: ReturnType<typeof setup>) => ctx.idle.noteRateLimit({ status: "rejected" }),
    ],
  ])("does not compact at the deadline when %s", async (_name, logged, change) => {
    const ctx = setup();
    requestAndIdle(ctx.idle);
    change(ctx);

    await vi.advanceTimersByTimeAsync(54 * MIN);
    expect(ctx.host.compact).not.toHaveBeenCalled();
    expect(ctx.host.log).toHaveBeenCalledWith(expect.stringContaining(logged));
  });

  /** Going idle while busy arms nothing. */
  it("does not arm while busy", () => {
    const { idle, state } = setup();
    state.busy = true;
    requestAndIdle(idle);

    expect(vi.getTimerCount()).toBe(0);
  });

  /** Arming twice leaves a single timer, so only one compaction runs. */
  it("rearming replaces the timer", async () => {
    const { idle, host } = setup();
    requestAndIdle(idle);
    idle.onIdle();

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(54 * MIN);
    expect(host.compact).toHaveBeenCalledTimes(1);
  });

  /** While a compaction runs, an idle notification does not arm another. */
  it("does not arm while a compaction is in flight", async () => {
    const { idle, host } = setup();
    let finish!: () => void;
    host.compact.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    requestAndIdle(idle);
    await vi.advanceTimersByTimeAsync(54 * MIN);

    idle.onIdle();
    expect(vi.getTimerCount()).toBe(0);
    finish();
  });

  /** The timer handle is unref'd so it never keeps the process alive. */
  it("unrefs the timer", () => {
    const unref = vi.fn();
    const setTimeoutSpy = vi.fn(() => ({ unref }));
    const { idle } = setup({ setTimeout: setTimeoutSpy });
    requestAndIdle(idle);

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
