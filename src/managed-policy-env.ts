import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";

/**
 * Apply managed-policy environment variables before starting the ACP runtime.
 *
 * A managed-settings lookup is a startup convenience, not a hard requirement for
 * accepting the ACP connection. If the SDK cannot read policy settings because
 * of a transient filesystem/registry failure, continue with the current process
 * environment instead of exiting before initialization.
 */
export async function applyManagedPolicyEnv(
  logError: (message: string, error: unknown) => void = console.error,
): Promise<void> {
  try {
    const policy = await resolveSettings({ settingSources: [] });
    for (const [key, value] of Object.entries(policy.effective.env ?? {})) {
      if (typeof value === "string") {
        process.env[key] = value;
      }
    }
  } catch (error) {
    logError(
      "Unable to resolve managed Claude settings; continuing without managed policy environment.",
      error,
    );
  }
}
