/**
 * The connection's `authStatus` state, shared by the v1 core and the v2
 * core: the last identity it reported, the `claude auth status --json` probe,
 * the `_auth/status_update` and `auth/status_update` pushes, and the
 * `auth/status` answer (see `auth-status.ts` for when each core reads the
 * identity).
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import {
  type AccountInfo,
  filterEscalatingDefaultMode,
  type Options,
  resolveSettings,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type AcpAuthStatus,
  AUTH_STATUS_PROBE_TIMEOUT_MS,
  type AuthStatus,
  type AuthStatusKind,
  cliAuthIdentity,
  fromAccountInfo,
  mergeAuthStatus,
  parseCliAuthStatus,
  sameAuthStatus,
  sameIdentity,
  toAcpAuthStatus,
} from "./auth-status.js";
import { claudeCliPath } from "./claude-cli.js";
import {
  claudeAuthRefusal,
  isClaudeEnterprisePlan,
  shouldHideClaudeAuth,
} from "./hide-claude-auth.js";
import { launchClaudeConfigDir } from "./paths.js";
import type { SettingsManager } from "./settings.js";

const execFileAsync = promisify(execFile);

type ReporterLogger = { log: (...args: any[]) => void; error: (...args: any[]) => void };

/** The settings a probe runs under: a session's cwd, its key helper, and its launch env. */
export type AuthStatusSettings = Pick<
  SettingsManager,
  "getCwd" | "getApiKeyHelper" | "getEnvironment"
>;

/** Does a session share the credential sources this probe read? */
export type AuthProbeScope = (
  manager: AuthStatusSettings,
  override?: Settings,
  env?: Options["env"],
) => boolean;

/** Capture the selected settings before waiting on a query account read. */
export type SessionAccountReporter = (
  source: "startup" | "cached",
) => (account: AccountInfo | undefined) => void;

export interface AuthStatusReporterOptions {
  /** Sends `_auth/status_update`. */
  push: (status: AuthStatus) => Promise<void>;
  /** Sends the ACP `auth/status_update`. */
  pushAcp: (status: AcpAuthStatus) => Promise<void>;
  logger: ReporterLogger;
  /** An ACP gateway login is active: the gateway, not the CLI store, is the identity. */
  gatewayLogin: () => boolean;
  /** A `providers/set` override is active: a session account describes its route. */
  providerOverride: () => boolean;
  /** A completed probe read `kind` for the sessions in its scope. */
  onProbe?: (kind: AuthStatusKind, appliesTo: AuthProbeScope) => void;
}

export class AuthStatusReporter {
  /** Last identity reported to the client. Undefined means "not determined yet". */
  current?: AuthStatus;
  /**
   * Counts auth-affecting events (a login, a logout, a new settings context).
   * A probe records it at start and publishes only if it has not moved, so a
   * slow read can never overwrite a newer login or logout.
   */
  private epoch = 0;
  private settings?: {
    manager: AuthStatusSettings;
    override?: Settings;
    env?: Options["env"];
  };
  private helper?: string;
  private settingsEnv: Record<string, string> = {};
  /** In-flight `claude auth status --json` probe, shared by every caller so
   *  a concurrent `initialize` and start-of-prompt read never spawn two CLI
   *  processes. */
  private probing: Promise<AuthStatus | undefined> | null = null;
  /** Keeps the "session account told us nothing" note to one line per process
   *  instead of one per session. */
  private loggedUninformativeAccount = false;
  /** Same, for the "client provider override active" note. */
  private loggedOverriddenAccount = false;
  /** Same, for the "the CLI probe timed out" warning: a wedged CLI stays wedged
   *  and would otherwise warn once per probe, i.e. once per user prompt. */
  private loggedProbeTimeout = false;
  /** Numbers the probe runs in start order. */
  private probeRuns = 0;
  /** The latest-started probe that published, with the credential sources it observed. */
  private lastProbe?: {
    run: number;
    status: AuthStatus;
    refused: boolean;
    appliesTo: AuthProbeScope;
  };
  private acpStatus: AcpAuthStatus = { state: "unknown" };

  constructor(private readonly options: AuthStatusReporterOptions) {}

  /**
   * Stores `next` and pushes it to the client, as `_auth/status_update` and
   * as the ACP `auth/status_update`.
   *
   * A push goes out only when the payload changed. The identity is read on many
   * occasions — each session create, each guarded turn, the start of each user
   * prompt — and almost all of them see the same login. Clients replace their
   * whole state on each update and tolerate duplicates, so a repeat is
   * harmless, but it is also pure noise; {@link sameAuthStatus} drops it.
   *
   * What the agent owes is truth — a stale or uninformative source must not
   * reach here at all (see the epoch check in the probe and the guards at
   * session create).
   */
  set(next: AuthStatus | undefined, refused = false): void {
    if (!next) {
      return;
    }
    if (!sameAuthStatus(this.current, next)) {
      this.current = next;
      // Older clients still get the actual identity, including one the guard refused.
      void Promise.resolve()
        .then(() => this.options.push(next))
        .catch((error) => {
          this.options.logger.error("Failed to send _auth/status_update:", error);
        });
    }
    const acp = toAcpAuthStatus(next, refused);
    if (JSON.stringify(acp) === JSON.stringify(this.acpStatus)) {
      return;
    }
    this.acpStatus = acp;
    void Promise.resolve()
      .then(() => this.options.pushAcp(acp))
      .catch((error) => {
        this.options.logger.error("Failed to send auth/status_update:", error);
      });
  }

  /**
   * The `auth/status` answer: the identity the connection holds, which is
   * also what the last `auth/status_update` said.
   *
   * - No identity yet: it waits for a probe, joining the one `initialize`
   *   started, so a query right after `initialize` gets the identity. The
   *   probe is bounded by {@link AUTH_STATUS_PROBE_TIMEOUT_MS}. The answer is
   *   `unknown` when that probe publishes nothing: the CLI failed, printed
   *   no JSON, or timed out, or a login or logout overtook the read.
   * - An identity is known: it answers at once and starts a new probe that
   *   nothing waits for. A login or logout made outside the client then
   *   arrives as `auth/status_update`.
   *
   * The probe is an ordinary one: it runs under the settings of the session
   * that last started or prompted, pushes a change, and reports its kind to
   * `onProbe`. Under an ACP gateway login it reads nothing.
   */
  async status(): Promise<AcpAuthStatus> {
    if (this.current) {
      void this.probe({ fresh: true });
    } else {
      await this.probe();
    }
    return this.acpStatus;
  }

  /** A login or a logout: any probe already running read the world before it. */
  changed(): void {
    this.epoch += 1;
  }

  /**
   * Probes run under these settings from now on. A new context (cwd, key
   * helper, or launch env) starts a fresh probe in it.
   */
  useSettings(
    manager: AuthStatusSettings,
    settingsOverride?: Settings,
    launchEnv?: Options["env"],
  ) {
    const helper = manager.getApiKeyHelper(settingsOverride);
    const settingsEnv = manager.getEnvironment(settingsOverride);
    const changed =
      manager.getCwd() !== (this.settings?.manager.getCwd() ?? process.cwd()) ||
      helper !== this.helper ||
      JSON.stringify(settingsEnv) !== JSON.stringify(this.settingsEnv) ||
      JSON.stringify(launchEnv) !== JSON.stringify(this.settings?.env);
    this.settings = { manager, override: settingsOverride, env: launchEnv };
    this.helper = helper;
    this.settingsEnv = settingsEnv;
    if (changed) {
      // The epoch bump discards any probe that read the old context, and the
      // session account may carry no identity signal (an apiKeyHelper), so
      // only a probe in the new context can classify it.
      this.epoch += 1;
      void this.probe({ fresh: true });
    }
  }

  /**
   * Bind display updates to a query at launch. Later accountInfo() calls
   * return the account cached at launch, so a probe started after launch can
   * supersede them within the same credential scope.
   */
  sessionAccountReporter(
    manager: AuthStatusSettings,
    override?: Settings,
    env?: Options["env"],
  ): SessionAccountReporter {
    const launchRun = this.probeRuns;
    return (source) => {
      const epoch = this.epoch;
      return (account) => {
        if (epoch !== this.epoch) return;
        const probe = this.lastProbe;
        this.publishSessionAccount(
          account,
          manager.getApiKeyHelper(override),
          source === "cached" &&
            probe &&
            probe.run > launchRun &&
            probe.appliesTo(manager, override, env)
            ? probe
            : undefined,
        );
      };
    };
  }

  /**
   * Report the identity behind a session's `AccountInfo`.
   *
   * `AccountInfo` describes what the live query authenticates with, but lacks
   * the CLI's plan tier. The v1 core calls it before the
   * `--hide-claude-auth` guard may refuse the session or the turn: that flag
   * blocks the *use* of a subscription, it does not make the state secret, and
   * a refusal is when the client most needs to know the account it was
   * refused for.
   *
   * Two cases skip it:
   *
   * - ACP gateway *authentication*: the gateway, not this account, is the
   *   agent-owned identity — already reported as `kind: "gateway"` by the login.
   * - A client-driven provider override (`providers/set`): the session then
   *   routes through the client's endpoint and `AccountInfo` describes that
   *   route (e.g. `apiProvider: "gateway"`), which is NOT agent-owned state.
   *   `authStatus` reports the agent's own login only, so the CLI probe —
   *   which reads the credential store the override never touches — stays
   *   authoritative.
   *
   * An account with no identity signal (e.g. `{apiProvider: "firstParty"}`
   * under an apiKeyHelper) means "nothing to add", not "logged out" — keep
   * what the CLI probe already established instead of overwriting it.
   */
  private publishSessionAccount(
    account: AccountInfo | undefined,
    apiKeyHelper: string | undefined,
    probe?: { status: AuthStatus; refused: boolean },
  ): void {
    if (this.options.providerOverride()) {
      if (!this.loggedOverriddenAccount) {
        this.loggedOverriddenAccount = true;
        this.options.logger.log(
          "[authStatus] client provider override active; keeping agent-owned probe state",
        );
      }
      return;
    }
    if (this.options.gatewayLogin()) {
      return;
    }
    const fromSession = fromAccountInfo(account, apiKeyHelper);
    if (account && fromSession) {
      if (probe) {
        if (sameIdentity(probe.status, fromSession)) {
          // An older account can fill gaps in the probe for the same identity.
          this.set(mergeAuthStatus(fromSession, probe.status, "cli"), probe.refused);
        }
        return;
      }
      this.set(
        mergeAuthStatus(this.current, fromSession, "session"),
        shouldHideClaudeAuth() && claudeAuthRefusal(account) !== undefined,
      );
    } else if (!this.loggedUninformativeAccount) {
      this.loggedUninformativeAccount = true;
      this.options.logger.log(
        "[authStatus] session account carries no identity signal; keeping probe",
      );
    }
  }

  /** Shares one in-flight `claude auth status --json` run between callers. The
   *  promise is released once settled so a later call re-probes instead of
   *  replaying a stale verdict. `fresh` forces a new run even when one is in
   *  flight — `logout` needs a read that started after the credentials were
   *  cleared. */
  probe(options?: { fresh?: boolean }): Promise<AuthStatus | undefined> {
    if (!options?.fresh && this.probing) {
      return this.probing;
    }
    const probe = this.runProbe();
    this.probing = probe;
    void probe.finally(() => {
      if (this.probing === probe) {
        this.probing = null;
      }
    });
    return probe;
  }

  /** Never rejects: an unavailable CLI means "not reported", not an error. */
  private async runProbe(): Promise<AuthStatus | undefined> {
    const { logger } = this.options;
    // Monotonicity: a read that started before the connection's latest
    // auth-affecting event describes a world that no longer exists. Remember
    // which one this read belongs to and drop the answer if it moved on.
    const epoch = this.epoch;
    const run = ++this.probeRuns;
    const context = this.settings;
    const cwd = context?.manager.getCwd() ?? process.cwd();
    const processEnv = { ...process.env };
    const launchEnv = { ...processEnv, ...context?.env };
    let apiKeyHelper = context?.manager.getApiKeyHelper(context.override);
    let settingsEnv = context?.manager.getEnvironment(context.override) ?? {};
    // ACP gateway auth bypasses the CLI credential store entirely, so the
    // probe would report an identity that is not the one being used. A mere
    // client provider override (`providers/set`) does NOT skip the probe: it
    // reroutes traffic without touching the credential store, and the store is
    // exactly the agent-owned login `authStatus` reports.
    if (this.options.gatewayLogin()) {
      return this.current;
    }
    let stdout: string;
    let settingsDir: string | undefined;
    try {
      const cliPath = await claudeCliPath();
      const args = ["auth", "status", "--json"];
      if (context?.override) {
        // Use a private per-probe file because the settings can contain credentials.
        settingsDir = await mkdtemp(join(tmpdir(), "claude-acp-auth-"));
        const settingsPath = join(settingsDir, "settings.json");
        await writeFile(settingsPath, JSON.stringify(context.override), {
          mode: 0o600,
          flag: "wx",
        });
        // `--settings` is a global CLI option and precedes the auth subcommand.
        args.unshift("--settings", settingsPath);
      }
      ({ stdout } = await execFileAsync(cliPath, args, {
        timeout: AUTH_STATUS_PROBE_TIMEOUT_MS,
        cwd,
        env: launchEnv,
      }));
    } catch (error) {
      const failed = error as { stdout?: unknown; killed?: boolean; signal?: unknown } | null;
      // Node killed the child on the timeout. Whatever it printed so far is a
      // truncated fragment, never valid JSON: report nothing and keep the last
      // known state, so nothing regresses and no push goes out.
      if (failed?.killed === true && failed.signal) {
        if (!this.loggedProbeTimeout) {
          this.loggedProbeTimeout = true;
          logger.error(
            "claude auth status did not answer within 5 s; the identity is not refreshed",
          );
        }
        return this.current;
      }
      // The logged-out case exits 1 while still printing valid JSON, so the
      // stdout of a failed exec is parsed just like a successful one.
      if (typeof failed?.stdout !== "string" || failed.stdout.trim().length === 0) {
        // Exec errors can include the command and the CLI's stderr.
        logger.error("claude auth status failed");
        return undefined;
      }
      stdout = failed.stdout;
    } finally {
      if (settingsDir) {
        try {
          await rm(settingsDir, { recursive: true, force: true, maxRetries: 2 });
        } catch {
          logger.error("Could not remove temporary auth probe settings");
        }
      }
    }
    const cli = parseCliAuthStatus(stdout);
    if (!cli) {
      logger.error("claude auth status returned unparseable output");
      return undefined;
    }
    if (!context) {
      try {
        const resolved = await resolveSettings({ cwd });
        const settings = filterEscalatingDefaultMode(resolved);
        apiKeyHelper = settings.apiKeyHelper;
        settingsEnv = settings.env ?? {};
      } catch {
        logger.error("Could not resolve auth source settings");
      }
    }
    const effectiveEnv = { ...launchEnv, ...settingsEnv };
    const status = cliAuthIdentity(cli, apiKeyHelper, Boolean(effectiveEnv.ANTHROPIC_AUTH_TOKEN));
    if (epoch !== this.epoch) {
      // A login or logout landed while this probe was running; the newer
      // state wins and this answer is discarded, never published.
      logger.log("[authStatus] discarding a probe that predates the latest auth change");
      return this.current;
    }
    if (this.lastProbe && run < this.lastProbe.run) {
      // Probes can overlap (`fresh`) and land out of order. A read that
      // started before one already published is the older of the two.
      logger.log("[authStatus] discarding a probe that a newer one overtook");
      return this.current;
    }
    // The CLI probe can be poorer than the session `AccountInfo` for the very
    // same login (no organization, say). Keep those extra fields rather than
    // regressing the payload; a different identity replaces it wholesale.
    const merged = mergeAuthStatus(this.current, status, "cli");
    // The CLI names the effective credential, not the SDK's accountInfo tokenSource.
    // An OAuth setup token can carry a plan but, like an API key, is allowed.
    const refused =
      shouldHideClaudeAuth() &&
      status.kind === "account" &&
      cli.authMethod !== "oauth_token" &&
      !isClaudeEnterprisePlan(cli.subscriptionType);
    const configDir = launchClaudeConfigDir(cwd, launchEnv);
    const appliesTo: AuthProbeScope = (manager, override, env) => {
      // A relative key helper command can resolve differently in another cwd.
      if (apiKeyHelper !== manager.getApiKeyHelper(override)) return false;
      if (apiKeyHelper && cwd !== manager.getCwd()) return false;
      const sessionLaunchEnv = { ...processEnv, ...env };
      if (configDir !== launchClaudeConfigDir(manager.getCwd(), sessionLaunchEnv)) return false;
      const sessionEnv = { ...sessionLaunchEnv, ...manager.getEnvironment(override) };
      return (
        Object.keys(effectiveEnv).length === Object.keys(sessionEnv).length &&
        Object.entries(effectiveEnv).every(
          ([name, value]) => Object.hasOwn(sessionEnv, name) && sessionEnv[name] === value,
        )
      );
    };
    this.lastProbe = {
      run,
      status: merged,
      refused,
      appliesTo: (manager, override, env) =>
        // A watcher may have reloaded the very files this probe read.
        (manager === context?.manager &&
          cwd === manager.getCwd() &&
          override === context.override &&
          env === context.env) ||
        appliesTo(manager, override, env),
    };
    this.set(merged, refused);
    this.options.onProbe?.(status.kind, appliesTo);
    return merged;
  }
}

/**
 * Runs `claude auth logout`. The Claude and Console logins keep their
 * credentials in the CLI's store (keychain or config dir), which only the
 * binary can clear. The command is non-interactive and idempotent. Throws an
 * `internal_error` with the CLI's stderr when it fails.
 */
export async function cliLogout(): Promise<void> {
  try {
    const cliPath = await claudeCliPath();
    await execFileAsync(cliPath, ["auth", "logout"]);
  } catch (error) {
    const stderr =
      typeof error === "object" && error && "stderr" in error
        ? String((error as { stderr: unknown }).stderr).trim()
        : undefined;
    throw RequestError.internalError(
      { stderr: stderr || undefined },
      `claude auth logout failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
