import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

interface PermissionModeLogger {
  error: (...args: unknown[]) => void;
}

// Bypass Permissions doesn't work if we are a root/sudo user.
const IS_ROOT = (process.geteuid?.() ?? process.getuid?.()) === 0;
export const ALLOW_BYPASS = !IS_ROOT || !!process.env.IS_SANDBOX;

const PERMISSION_MODE_ALIASES: Record<string, PermissionMode> = {
  auto: "auto",
  default: "default",
  // Claude Code 2.1.200 renamed the "default" mode to "Manual" and accepts
  // `"defaultMode": "manual"` in settings.json; honor the same alias here.
  manual: "default",
  acceptedits: "acceptEdits",
  dontask: "dontAsk",
  plan: "plan",
  bypasspermissions: "bypassPermissions",
  bypass: "bypassPermissions",
};

export function resolvePermissionMode(
  defaultMode?: unknown,
  logger: PermissionModeLogger = console,
): PermissionMode {
  if (defaultMode === undefined) {
    return "default";
  }

  if (typeof defaultMode !== "string") {
    logger.error("Ignoring permissions.defaultMode from settings: expected a string.");
    return "default";
  }

  const normalized = defaultMode.trim().toLowerCase();
  if (normalized === "") {
    logger.error("Ignoring permissions.defaultMode from settings: expected a non-empty string.");
    return "default";
  }

  const mapped = PERMISSION_MODE_ALIASES[normalized];
  if (!mapped) {
    logger.error(`Ignoring permissions.defaultMode from settings: unknown value '${defaultMode}'.`);
    return "default";
  }

  if (mapped === "bypassPermissions" && !ALLOW_BYPASS) {
    logger.error(
      "Ignoring permissions.defaultMode from settings: bypassPermissions is not available when running as root.",
    );
    return "default";
  }

  return mapped;
}
