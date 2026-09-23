import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionTiming } from "../session-timing.js";

describe("SessionTiming", () => {
  afterEach(() => vi.restoreAllMocks());

  it("includes work completed before construction when given a start time", () => {
    vi.spyOn(performance, "now").mockReturnValue(175);
    const log = vi.fn();

    new SessionTiming({ log }, "create", "session-id", 100).phase("validate-cwd");

    expect(log).toHaveBeenCalledWith(
      "[session/create] sessionId=session-id phase=validate-cwd durationMs=75 totalMs=75",
    );
  });
});
