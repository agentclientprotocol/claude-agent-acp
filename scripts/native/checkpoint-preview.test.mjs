import { describe, expect, it, vi } from "vitest";
import { checkpointPreview } from "./checkpoint-preview.mjs";

const base = { sessionId: "session", dryRun: true };
describe("native checkpoint preview readiness", () => {
  it("waits for explicit busy then requires a successful preview", async () => {
    const ready = { ...base, canRewind: true, filesChanged: ["tracked.txt"] };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...base, canRewind: false, reason: "busy" })
      .mockResolvedValueOnce(ready);
    await expect(checkpointPreview(request, "session")).resolves.toEqual(ready);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ...base, canRewind: false, error: "No file checkpoint found" },
    { ...base, canRewind: false, reason: "unsupported" },
    { ...base, canRewind: false, reason: "state_changed" },
    { ...base, canRewind: "true" },
    { ...base, canRewind: true, dryRun: false },
    { ...base, canRewind: true, sessionId: "other" },
    {},
    null,
  ])("does not hide or retry invalid or unavailable checkpoints (%#)", async (reply) => {
    const request = vi.fn(async () => reply);
    await expect(checkpointPreview(request, "session")).rejects.toThrow(
      "Native checkpoint preview",
    );
    expect(request).toHaveBeenCalledOnce();
  });
  it("fails with the last busy response when idle never arrives", async () => {
    const request = vi.fn(async () => ({ ...base, canRewind: false, reason: "busy" }));
    await expect(checkpointPreview(request, "session", 0)).rejects.toThrow(
      /Timed out.*"reason":"busy"/,
    );
    expect(request).toHaveBeenCalledOnce();
  });
  it("propagates RPC failures without retry", async () => {
    const request = vi.fn(async () => {
      throw new Error("transport lost");
    });
    await expect(checkpointPreview(request, "session")).rejects.toThrow("transport lost");
    expect(request).toHaveBeenCalledOnce();
  });
});
