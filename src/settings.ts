import * as fs from "node:fs";
import * as path from "node:path";
// resolveSettings and filterEscalatingDefaultMode are marked @alpha in the
// SDK; API may shift in a future release.
import {
  filterEscalatingDefaultMode,
  type Options,
  resolveSettings,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";
import { unloadedPolicySources } from "./managed-policy.js";
import { claudeConfigDir, launchClaudeConfigDir } from "./paths.js";

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
  /** The session's env overrides, before provider routing. */
  launchEnv?: Options["env"];
}

type ModelSelectionSettings = Pick<Settings, "availableModels" | "modelOverrides">;
type AuthSourceSettings = Pick<Settings, "apiKeyHelper" | "env">;

function mergeEnvironment(...tiers: Array<Settings["env"]>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const tier of tiers) {
    for (const [name, value] of Object.entries(tier ?? {})) {
      if (value !== undefined) env[name] = value;
    }
  }
  return env;
}

/** Only the fields used to attribute a CLI auth status are read here. */
async function readAuthSourceSettings(file: string): Promise<AuthSourceSettings> {
  try {
    const text = await fs.promises.readFile(file, "utf8");
    const settings = JSON.parse(text.replace(/^\uFEFF/, "")) as {
      apiKeyHelper?: unknown;
      env?: unknown;
    } | null;
    const { apiKeyHelper, env } = settings ?? {};
    if (apiKeyHelper !== undefined && typeof apiKeyHelper !== "string") return {};
    if (env !== undefined && (env === null || typeof env !== "object" || Array.isArray(env))) {
      return {};
    }
    return {
      apiKeyHelper,
      env: Object.fromEntries(
        Object.entries(env ?? {}).map(([name, value]) => [name, String(value)]),
      ),
    };
  } catch {
    // The user settings file may be missing or unreadable, as in resolveSettings.
    return {};
  }
}

/** The settings that decide whether Claude Code compacts (see `idle-compaction.ts`). */
export type CompactionSettings = {
  idleCompaction?: boolean;
  autoCompactEnabled?: boolean;
  env?: Record<string, string>;
};

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
  private authSourceSettings: AuthSourceSettings = {};
  private readonly launchEnv?: Options["env"];
  private managedDeniedModels: string[] = [];
  private managedModelSettings: ModelSelectionSettings = {};
  private managedApiKeyHelper?: string;
  private managedCompactionSettings: CompactionSettings = {};
  private managedShowClearContextOnPlanAccept?: boolean;
  /** The policy sources last logged as not loaded (see {@link unloadedPolicySources}). */
  private unloadedPolicy?: string;
  private watchers: fs.FSWatcher[] = [];
  private onChange?: () => void;
  private logger: { log: (...args: any[]) => void; error: (...args: any[]) => void };
  private initialized = false;
  private disposed = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(cwd: string, options?: SettingsManagerOptions) {
    this.cwd = cwd;
    this.launchEnv = options?.launchEnv;
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

  private authUserSettingsPath(): string {
    const configDir = launchClaudeConfigDir(this.cwd, { ...process.env, ...this.launchEnv });
    return path.join(configDir, "settings.json");
  }

  /**
   * Paths the SDK reads when resolving settings for this cwd. Watching the
   * containing directories means we pick up file creation as well as edits.
   */
  private getWatchedPaths(): string[] {
    return [
      ...new Set([
        path.resolve(claudeConfigDir(), "settings.json"),
        this.authUserSettingsPath(),
        path.join(this.cwd, ".claude", "settings.json"),
        path.join(this.cwd, ".claude", "settings.local.json"),
        getManagedSettingsPath(),
      ]),
    ];
  }

  /**
   * Resolves the effective settings via the SDK and applies the CLI's trust
   * filter for escalating `permissions.defaultMode` values.
   */
  private async loadAllSettings(): Promise<void> {
    try {
      const resolved = await resolveSettings({ cwd: this.cwd });
      // Once per change: a reload after each settings file edit would repeat it.
      const unloaded = unloadedPolicySources(resolved);
      if (unloaded !== this.unloadedPolicy) {
        this.unloadedPolicy = unloaded;
        if (unloaded) {
          this.logger.error(
            `Managed settings did not load from ${unloaded}: the session's settings ` +
              "and model list do not reflect it. Claude Code reads the policy itself.",
          );
        }
      }
      this.effective = filterEscalatingDefaultMode(resolved);
      const authUserPath = this.authUserSettingsPath();
      if (authUserPath === path.resolve(claudeConfigDir(), "settings.json")) {
        this.authSourceSettings = this.effective;
      } else {
        // resolveSettings uses the adapter's env. Substitute the launched CLI's
        // user tier for auth attribution while retaining the SDK's other tiers.
        const tiers = [
          await readAuthSourceSettings(authUserPath),
          ...resolved.sources
            .filter((entry) => entry.source !== "user")
            .map((entry) => entry.settings),
        ];
        this.authSourceSettings = {
          apiKeyHelper: tiers.findLast((tier) => tier.apiKeyHelper !== undefined)?.apiKeyHelper,
          env: mergeEnvironment(...tiers.map((tier) => tier.env)),
        };
      }
      // The CLI reads `deniedModels` from managed settings only.
      this.managedDeniedModels = resolved.sources
        .filter((entry) => entry.source === "managed")
        .flatMap((entry) => entry.settings.deniedModels ?? []);
      this.managedModelSettings = Object.assign(
        {},
        ...resolved.sources
          .filter((entry) => entry.source === "managed")
          .map((entry) => ({
            availableModels: entry.settings.availableModels,
            modelOverrides: entry.settings.modelOverrides,
          })),
      );
      this.managedApiKeyHelper =
        resolved.provenance.apiKeyHelper?.source === "managed"
          ? resolved.effective.apiKeyHelper
          : undefined;
      const managed = resolved.sources
        .filter((entry) => entry.source === "managed")
        .map((entry) => entry.settings);
      this.managedCompactionSettings = {
        idleCompaction: managed.findLast((tier) => tier.idleCompaction !== undefined)
          ?.idleCompaction,
        autoCompactEnabled: managed.findLast((tier) => tier.autoCompactEnabled !== undefined)
          ?.autoCompactEnabled,
        env: Object.assign({}, ...managed.map((tier) => tier.env)),
      };
      this.managedShowClearContextOnPlanAccept = managed.findLast(
        (tier) => tier.showClearContextOnPlanAccept !== undefined,
      )?.showClearContextOnPlanAccept;
    } catch (error) {
      this.logger.error("Failed to resolve settings:", error);
      this.effective = {};
      this.authSourceSettings = {};
      this.managedDeniedModels = [];
      this.managedModelSettings = {};
      this.managedApiKeyHelper = undefined;
      this.managedCompactionSettings = {};
      this.managedShowClearContextOnPlanAccept = undefined;
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
   * The `apiKeyHelper` the CLI runs: managed settings outrank the `--settings`
   * override, which outranks the user/project/local files.
   */
  getApiKeyHelper(settingsOverride?: Settings): string | undefined {
    return (
      this.managedApiKeyHelper ??
      settingsOverride?.apiKeyHelper ??
      this.authSourceSettings.apiKeyHelper
    );
  }

  /** Model selection settings including the inline SDK settings tier. */
  getModelSelectionSettings(override?: Settings): ModelSelectionSettings {
    // The SDK unions non-managed allowlists, but a managed list owns the
    // whole allowlist. Keep that policy when adding
    // models the SDK did not include in its initialization result.
    const lists = [this.effective.availableModels, override?.availableModels].filter(
      (list): list is string[] => Array.isArray(list),
    );
    const managed = this.managedModelSettings;
    return {
      availableModels:
        managed.availableModels ?? (lists.length > 0 ? [...new Set(lists.flat())] : undefined),
      modelOverrides: {
        ...this.effective.modelOverrides,
        ...override?.modelOverrides,
        ...managed.modelOverrides,
      },
    };
  }

  /** The auth probe's settings env: files, then `--settings`, then managed policy. */
  getEnvironment(settingsOverride?: Settings): Record<string, string> {
    return mergeEnvironment(
      this.authSourceSettings.env,
      settingsOverride?.env,
      this.managedCompactionSettings.env,
    );
  }

  /** `idleCompaction`, `autoCompactEnabled` and `env` as the CLI resolves them:
   *  managed settings outrank `--settings`, then user/project/local files. */
  getCompactionSettings(settingsOverride?: Settings): CompactionSettings {
    const managed = this.managedCompactionSettings;
    return {
      idleCompaction:
        managed.idleCompaction ?? settingsOverride?.idleCompaction ?? this.effective.idleCompaction,
      autoCompactEnabled:
        managed.autoCompactEnabled ??
        settingsOverride?.autoCompactEnabled ??
        this.effective.autoCompactEnabled,
      env: mergeEnvironment(this.effective.env, settingsOverride?.env, managed.env),
    };
  }

  /**
   * Whether an approved plan may be continued in a fresh context, as the CLI
   * resolves `showClearContextOnPlanAccept`: managed settings outrank the
   * `--settings` override, which outranks the user/project/local files. Off
   * unless one of them sets it, like the CLI.
   */
  getShowClearContextOnPlanAccept(settingsOverride?: Settings): boolean {
    return (
      this.managedShowClearContextOnPlanAccept ??
      settingsOverride?.showClearContextOnPlanAccept ??
      this.effective.showClearContextOnPlanAccept ??
      false
    );
  }

  /**
   * `deniedModels` entries from the managed tier, the only tier the CLI
   * honors them from.
   */
  getManagedDeniedModels(): string[] {
    return this.managedDeniedModels;
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
