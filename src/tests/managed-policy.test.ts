import { afterEach, describe, expect, it, vi } from "vitest";
import type { resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import { applyManagedPolicyEnv } from "../managed-policy.js";

type ResolveSettings = typeof resolveSettings;

/** The SDK's return type is large and @alpha; a test only needs `effective.env`. */
function resolverReturning(policy: unknown): ResolveSettings {
  return (async () => policy) as unknown as ResolveSettings;
}

function resolverThrowing(error: unknown): ResolveSettings {
  return (async () => {
    throw error;
  }) as unknown as ResolveSettings;
}

describe("applyManagedPolicyEnv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("copies the managed tier's env vars into the target env", async () => {
    const env: Record<string, string | undefined> = {};
    await applyManagedPolicyEnv(
      resolverReturning({
        effective: { env: { ANTHROPIC_BASE_URL: "https://policy.test" } },
      }),
      env,
    );

    expect(env).toEqual({ ANTHROPIC_BASE_URL: "https://policy.test" });
  });

  it("resolves without applying anything when the tier has no env table", async () => {
    const env: Record<string, string | undefined> = { KEEP: "1" };
    await applyManagedPolicyEnv(resolverReturning({ effective: {} }), env);

    expect(env).toEqual({ KEEP: "1" });
  });

  it("does not reject when the tier cannot be read, and reports it on stderr", async () => {
    const env: Record<string, string | undefined> = { KEEP: "1" };
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      applyManagedPolicyEnv(resolverThrowing(new Error("EINTR")), env),
    ).resolves.toBeUndefined();

    // The point of the guard: `src/index.ts` awaits this at module scope, so a
    // rejection here would abort module evaluation and exit before any ACP
    // traffic. Startup must survive a transient read failure.
    expect(env).toEqual({ KEEP: "1" });
    expect(stderr).toHaveBeenCalledWith(
      "Failed to resolve managed policy settings:",
      expect.any(Error),
    );
  });

  it("asks the SDK for the managed tier only", async () => {
    const seen: unknown[] = [];
    const resolve = (async (options: unknown) => {
      seen.push(options);
      return { effective: {} };
    }) as unknown as ResolveSettings;

    await applyManagedPolicyEnv(resolve, {});

    expect(seen).toEqual([{ settingSources: [] }]);
  });
});
