import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";

/** The machine policy sources that `machinePolicy.didNotLoad` names. */
const POLICY_SOURCES: Record<string, string> = {
  profile: "the macOS MDM profile",
  registry: "the Windows registry policy",
  file: "the managed-settings file",
};

/**
 * The machine policy sources that may be there and did not load
 * (`machinePolicy.didNotLoad`, SDK 0.3.323), named for a log line: "the macOS
 * MDM profile, the managed-settings file". The resolved settings show such a
 * source as absent, so the adapter applies nothing from it, and Claude Code
 * reads the policy itself. Undefined when every source loaded, and when the
 * SDK does not report it.
 */
export function unloadedPolicySources(
  resolved: Pick<Awaited<ReturnType<typeof resolveSettings>>, "machinePolicy">,
): string | undefined {
  const unloaded = resolved.machinePolicy?.didNotLoad;
  if (!unloaded || unloaded.length === 0) return undefined;
  return unloaded.map((kind) => POLICY_SOURCES[kind] ?? kind).join(", ");
}

/**
 * Applies the managed-policy tier's env vars to `process.env` before any SDK
 * call, so the SDK subprocess inherits them. Going through `resolveSettings`
 * rather than a raw read of `managed-settings.json` also picks up MDM sources on
 * macOS and `HKLM`/`HKCU` on Windows.
 *
 * Reading the tier is best-effort by nature: on a host with no MDM and no
 * managed policy the result is empty and the agent behaves identically. So a
 * transient failure to read it — `EINTR`, `EMFILE`, `EAGAIN` — must leave the
 * agent running with no policy env rather than stop it from starting.
 *
 * That guard matters because the caller awaits this at module scope in an ESM
 * entry point, where a rejection aborts module evaluation and the process exits
 * before serving any ACP traffic. `SettingsManager.loadAllSettings` wraps the
 * same SDK call for the same reason.
 */
export async function applyManagedPolicyEnv(
  resolve: typeof resolveSettings = resolveSettings,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  let policy: Awaited<ReturnType<typeof resolveSettings>>;
  try {
    policy = await resolve({ settingSources: [] });
  } catch (error) {
    // stderr, so the ACP stream on stdout stays clean.
    console.error("Failed to resolve managed policy settings:", error);
    return;
  }
  const unloaded = unloadedPolicySources(policy);
  if (unloaded) {
    console.error(
      `Managed settings did not load from ${unloaded}: its env vars are not applied. ` +
        "Restart the agent to read it again.",
    );
  }
  for (const [key, value] of Object.entries(policy.effective.env ?? {})) {
    env[key] = value;
  }
}
