import * as os from "node:os";
import * as path from "node:path";

/** The Claude configuration directory: `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

/** `<config>/projects`, normalized like the SDK does. */
export function projectsRoot(): string {
  return path.join(claudeConfigDir(), "projects").normalize("NFC");
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is a Claude session id (a UUID). Only such ids name a
 *  transcript, and only such ids are safe to use as a file name. */
export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}
