import * as os from "node:os";
import * as path from "node:path";

/** The Claude configuration directory: `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}
