import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";

import { applyManagedPolicyEnv } from "../managed-policy-env.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...actual,
    resolveSettings: vi.fn(),
  };
});

describe("applyManagedPolicyEnv", () => {
  afterEach(() => {
    vi.mocked(resolveSettings).mockReset();
    delete process.env.CLAUDE_AGENT_ACP_POLICY_TEST;
  });

  it("applies managed policy environment variables", async () => {
    vi.mocked(resolveSettings).mockResolvedValue({
      effective: { env: { CLAUDE_AGENT_ACP_POLICY_TEST: "from-policy" } },
    } as unknown as Awaited<ReturnType<typeof resolveSettings>>);

    await applyManagedPolicyEnv();

    expect(process.env.CLAUDE_AGENT_ACP_POLICY_TEST).toBe("from-policy");
    expect(resolveSettings).toHaveBeenCalledWith({ settingSources: [] });
  });

  it("continues startup when managed settings cannot be resolved", async () => {
    const error = new Error("transient settings read failure");
    const logError = vi.fn();
    vi.mocked(resolveSettings).mockRejectedValue(error);

    await expect(applyManagedPolicyEnv(logError)).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledWith(
      "Unable to resolve managed Claude settings; continuing without managed policy environment.",
      error,
    );
    expect(process.env.CLAUDE_AGENT_ACP_POLICY_TEST).toBeUndefined();
  });
});
