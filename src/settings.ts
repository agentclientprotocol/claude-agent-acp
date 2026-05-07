import * as fs from "node:fs";
import * as path from "node:path";
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

export interface PermissionSettings {
  defaultMode?: string;
}

export interface ClaudeCodeSettings {
  permissions?: PermissionSettings;
  env?: Record<string, string>;
  model?: string;
  effortLevel?: string;
  availableModels?: string[];
}

/**
 * Reads and parses a JSON settings file, returning an empty object if not found or invalid.
 * Silently ignores missing files (ENOENT) but logs warnings for other errors
 * (malformed JSON, permission errors, etc.) to aid debugging.
 */
async function loadSettingsFile(
  filePath: string | null,
  logger?: { error: (...args: any[]) => void },
): Promise<ClaudeCodeSettings> {
  if (!filePath) {
    return {};
  }

  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(content) as ClaudeCodeSettings;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    logger?.error(`Failed to load settings from ${filePath}:`, error);
    return {};
  }
}

/**
 * Gets the enterprise settings path based on the current platform
 */
export function getManagedSettingsPath(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/managed-settings.json";
    case "linux":
      return "/etc/claude-code/managed-settings.json";
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
 * Manages Claude Code settings from multiple sources with proper precedence.
 *
 * Settings are loaded from (in order of increasing precedence):
 * 1. User settings (~/.claude/settings.json)
 * 2. Project settings (<cwd>/.claude/settings.json)
 * 3. Local project settings (<cwd>/.claude/settings.local.json)
 * 4. Enterprise managed settings (platform-specific path)
 *
 * The manager watches all settings files for changes and automatically reloads.
 */
export class SettingsManager {
  private cwd: string;
  private userSettings: ClaudeCodeSettings = {};
  private projectSettings: ClaudeCodeSettings = {};
  private localSettings: ClaudeCodeSettings = {};
  private enterpriseSettings: ClaudeCodeSettings = {};
  private mergedSettings: ClaudeCodeSettings = {};
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
   * Returns the path to the user settings file
   */
  private getUserSettingsPath(): string {
    return path.join(CLAUDE_CONFIG_DIR, "settings.json");
  }

  /**
   * Returns the path to the project settings file
   */
  private getProjectSettingsPath(): string {
    return path.join(this.cwd, ".claude", "settings.json");
  }

  /**
   * Returns the path to the local project settings file
   */
  private getLocalSettingsPath(): string {
    return path.join(this.cwd, ".claude", "settings.local.json");
  }

  /**
   * Loads settings from all sources
   */
  private async loadAllSettings(): Promise<void> {
    const [userSettings, projectSettings, localSettings, enterpriseSettings] = await Promise.all([
      loadSettingsFile(this.getUserSettingsPath(), this.logger),
      loadSettingsFile(this.getProjectSettingsPath(), this.logger),
      loadSettingsFile(this.getLocalSettingsPath(), this.logger),
      loadSettingsFile(getManagedSettingsPath(), this.logger),
    ]);

    this.userSettings = userSettings;
    this.projectSettings = projectSettings;
    this.localSettings = localSettings;
    this.enterpriseSettings = enterpriseSettings;

    this.mergeSettings();
  }

  /**
   * Merges all settings sources with proper precedence.
   * For permissions, rules from all sources are combined.
   * Deny rules always take precedence during permission checks.
   */
  private mergeSettings(): void {
    const allSettings = [
      this.userSettings,
      this.projectSettings,
      this.localSettings,
      this.enterpriseSettings,
    ];

    const merged: ClaudeCodeSettings = {};

    for (const settings of allSettings) {
      if (settings.env) {
        merged.env = { ...merged.env, ...settings.env };
      }

      if (settings.model) {
        merged.model = settings.model;
      }

      if (settings.effortLevel !== undefined) {
        merged.effortLevel = settings.effortLevel;
      }

      if (settings.availableModels !== undefined) {
        // Per Claude Code docs: "When `availableModels` is set at multiple
        // levels, such as user settings and project settings, arrays are
        // merged and deduplicated."
        // https://code.claude.com/docs/en/model-config#merge-behavior
        const combined = [...(merged.availableModels ?? []), ...settings.availableModels];
        merged.availableModels = Array.from(new Set(combined));
      }

      if (settings.permissions?.defaultMode !== undefined) {
        merged.permissions = {
          ...merged.permissions,
          defaultMode: settings.permissions.defaultMode,
        };
      }
    }

    this.mergedSettings = merged;
  }

  /**
   * Sets up file watchers for all settings files
   */
  private setupWatchers(): void {
    const paths = [
      this.getUserSettingsPath(),
      this.getProjectSettingsPath(),
      this.getLocalSettingsPath(),
      getManagedSettingsPath(),
    ];

    for (const filePath of paths) {
      if (!filePath) continue;

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
  getSettings(): ClaudeCodeSettings {
    return this.mergedSettings;
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
