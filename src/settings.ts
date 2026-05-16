import * as fs from "node:fs";
import * as path from "node:path";
// resolveSettings and filterEscalatingDefaultMode are marked @alpha in the
// SDK; API may shift in a future release.
import {
  filterEscalatingDefaultMode,
  resolveSettings,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CONFIG_DIR } from "./acp-agent.js";

/**
 * Permission rule format examples:
 * - "Read" - matches all Read tool calls
 * - "Read(./.env)" - matches specific path
 * - "Read(./.env.*)" - glob pattern
 * - "Read(./secrets/**)" - recursive glob
 * - "Bash(npm run lint)" - exact command prefix
 * - "Bash(npm run:*)" - command prefix with wildcard
 *
 * Docs: https://code.claude.com/docs/en/iam#tool-specific-permission-rules
 */

function getManagedSettingsPath(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/managed-settings.json";
    case "win32":
      return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
    default:
      return "/etc/claude-code/managed-settings.json";
  }
}

export interface SettingsManagerOptions {
  onChange?: () => void;
  logger?: { log: (...args: any[]) => void; error: (...args: any[]) => void };
}

/**
 * Manages Claude Code settings using the SDK's `resolveSettings` merge engine
 * so the values we see match what `query()` would observe.
 *
 * Watches the user/project/local/managed settings files for changes and
 * re-resolves through the SDK on update. Escalating `permissions.defaultMode`
 * values from repo-committed sources are filtered out via
 * `filterEscalatingDefaultMode`, matching the CLI's trust policy.
 */
export class SettingsManager {
  private cwd: string;
  private effective: Settings = {};
  private watchers: fs.FSWatcher[] = [];
  private onChange?: () => void;
  private logger: { log: (...args: any[]) => void; error: (...args: any[]) => void };
  private initialized = false;
  private disposed = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(cwd: string, options?: SettingsManagerOptions) {
    this.cwd = cwd;
    this.onChange = options?.onChange;
    this.logger = options?.logger ?? console;
  }

  /**
   * Initialize the settings manager by loading all settings and setting up file watchers
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.disposed = false;
    this.initPromise = this.loadAllSettings().then(() => {
      if (!this.disposed) {
        this.setupWatchers();
        this.initialized = true;
      }
      this.initPromise = null;
    });
    return this.initPromise;
  }

  /**
   * Paths the SDK reads when resolving settings for this cwd. Watching the
   * containing directories means we pick up file creation as well as edits.
   */
  private getWatchedPaths(): string[] {
    return [
      path.join(CLAUDE_CONFIG_DIR, "settings.json"),
      path.join(this.cwd, ".claude", "settings.json"),
      path.join(this.cwd, ".claude", "settings.local.json"),
      getManagedSettingsPath(),
    ];
  }

  /**
   * Resolves the effective settings via the SDK and applies the CLI's trust
   * filter for escalating `permissions.defaultMode` values.
   */
  private async loadAllSettings(): Promise<void> {
    try {
      const resolved = await resolveSettings({ cwd: this.cwd });
      this.effective = filterEscalatingDefaultMode(resolved);
    } catch (error) {
      this.logger.error("Failed to resolve settings:", error);
      this.effective = {};
    }
  }

  /**
   * Sets up file watchers for all settings files
   */
  private setupWatchers(): void {
    for (const filePath of this.getWatchedPaths()) {
      try {
        const dir = path.dirname(filePath);
        const filename = path.basename(filePath);

        if (fs.existsSync(dir)) {
          const watcher = fs.watch(dir, (eventType, changedFilename) => {
            if (changedFilename === filename) {
              this.handleSettingsChange();
            }
          });

          watcher.on("error", (error) => {
            this.logger.error(`Settings watcher error for ${filePath}:`, error);
          });

          this.watchers.push(watcher);
        }
      } catch (error) {
        this.logger.error(`Failed to set up watcher for ${filePath}:`, error);
      }
    }
  }

  /**
   * Handles settings file changes with debouncing to avoid rapid reloads
   */
  private handleSettingsChange(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      if (this.disposed) {
        return;
      }
      try {
        await this.loadAllSettings();
        if (!this.disposed) {
          this.onChange?.();
        }
      } catch (error) {
        this.logger.error("Failed to reload settings:", error);
      }
    }, 100);
  }

  /**
   * Returns the current merged settings
   */
  getSettings(): Settings {
    return this.effective;
  }

  /**
   * Returns the current working directory
   */
  getCwd(): string {
    return this.cwd;
  }

  /**
   * Updates the working directory and reloads project-specific settings
   */
  async setCwd(cwd: string): Promise<void> {
    if (this.cwd === cwd) {
      return;
    }

    this.dispose();
    this.cwd = cwd;
    await this.initialize();
  }

  /**
   * Disposes of file watchers and cleans up resources
   */
  dispose(): void {
    this.disposed = true;
    this.initialized = false;
    this.initPromise = null;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }
}
