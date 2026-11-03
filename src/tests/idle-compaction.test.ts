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
  const idle = new IdleCompaction(host, { env: options.env ?? {} });
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

  /** Claude Code also reads these from the `env` block of settings.json. */
  it("is disabled by DISABLE_AUTO_COMPACT in the settings env", async () => {
    const { idle, host } = setup({ settings: { env: { DISABLE_AUTO_COMPACT: "1" } } });
    requestAndIdle(idle);
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
    expect(host.compact).not.toHaveBeenCalled();
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
  ])("does not arm: %s", async (_name, options0: Record<string, any>) => {
    const { usage, ...options } = options0;
    const { idle, host } = setup(options);
    requestAndIdle(idle, "usage" in options0 ? usage : ONE_HOUR);

    await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
    expect(host.compact).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(host.log).toHaveBeenCalledWith(expect.stringContaining("skip"));
  });

  /** The settings env is applied after the launch env, so its value wins, not an OR of the two. */
  it("lets a falsy DISABLE_AUTO_COMPACT in the settings env override the launch env", async () => {
    const { idle, host } = setup({
      env: { DISABLE_AUTO_COMPACT: "1" },
      settings: { env: { DISABLE_AUTO_COMPACT: "0" } },
    });
    requestAndIdle(idle);
    await vi.advanceTimersByTimeAsync(54 * MIN);
    expect(host.compact).toHaveBeenCalledTimes(1);
  });

  /** A falsy DISABLE_COMPACT value does not opt out. */
  it("treats DISABLE_COMPACT=0 as not set", async () => {
    const { idle, host } = setup({ env: { DISABLE_COMPACT: "0" } });
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

  /** A new request drops the armed timer; the next idle re-arms from the new request. */
  it("noteRequest drops the timer", async () => {
    const { idle, host } = setup();
    requestAndIdle(idle);
    idle.noteRequest(ONE_HOUR);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(host.compact).not.toHaveBeenCalled();
  });

  /** disarm and dispose each drop the timer; dispose also ignores later calls. */
  it.each([
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

  /** If the session became busy while the timer ran, nothing is compacted and nothing re-arms. */
  it("does not compact when busy at the deadline", async () => {
    const { idle, host, state } = setup();
    requestAndIdle(idle);
    state.busy = true;

    await vi.advanceTimersByTimeAsync(54 * MIN);
    expect(host.compact).not.toHaveBeenCalled();
    expect(host.log).toHaveBeenCalledWith(expect.stringContaining("busy"));
  });

  /** Going idle while busy arms nothing. */
  it("does not arm while busy", () => {
    const { idle, state } = setup();
    state.busy = true;
    requestAndIdle(idle);

    expect(vi.getTimerCount()).toBe(0);
  });

  /** Context shrinking below the minimum before the deadline cancels the compaction. */
  it("re-checks the context size at the deadline", async () => {
    const { idle, host, state } = setup();
    requestAndIdle(idle);
    state.tokens = 50_000;

    await vi.advanceTimersByTimeAsync(54 * MIN);
    expect(host.compact).not.toHaveBeenCalled();
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
    const host = {
      isBusy: () => false,
      contextTokens: () => 200_000,
      settings: () => ({}),
      compact: async () => undefined,
      log: vi.fn(),
    };
    const idle = new IdleCompaction(host, { env: {}, setTimeout: setTimeoutSpy });
    requestAndIdle(idle);

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
