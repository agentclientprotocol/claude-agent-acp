import { afterEach, describe, expect, it, vi } from "vitest";
import type { resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import { applyManagedPolicyEnv, unloadedPolicySources } from "../managed-policy.js";

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

  it("reports a policy source that did not load on stderr, and still applies the rest", async () => {
    const env: Record<string, string | undefined> = {};
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    await applyManagedPolicyEnv(
      resolverReturning({
        effective: { env: { FROM_FILE: "1" } },
        machinePolicy: { didNotLoad: ["profile"] },
      }),
      env,
    );

    expect(env).toEqual({ FROM_FILE: "1" });
    expect(stderr).toHaveBeenCalledWith(
      "Managed settings did not load from the macOS MDM profile: its env vars are not applied. " +
        "Restart the agent to read it again.",
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

describe("unloadedPolicySources", () => {
  it.each([
    // What the SDK reports when every source loaded.
    [{ machinePolicy: { didNotLoad: false as const } }, undefined],
    // An SDK before 0.3.323 leaves the member out.
    [{}, undefined],
    [
      { machinePolicy: { didNotLoad: ["registry" as const, "file" as const] } },
      "the Windows registry policy, the managed-settings file",
    ],
  ])("names the sources of %j", (resolved, expected) => {
    expect(unloadedPolicySources(resolved)).toBe(expected);
  });
});
