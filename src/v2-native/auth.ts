/**
 * The connection's auth and LLM routing on the native core: the `authStatus`
 * extension (`_meta.authStatus` and `_auth/status_update`), the gateway logins
 * of `auth/login`, `auth/logout`, and `providers/list|set|disable`.
 *
 * The state and its rules are the v1 core's (`AuthStatusReporter`,
 * `providers.ts`). The identity is read at the same moments as there: after
 * `initialize`, from each session's account, after a login or a logout, and at
 * the start of each prompt (see `auth-status.ts`).
 *
 * A gateway login or provider change routes the sessions started after it.
 * Unlike the bridge, it does not recreate the queries of live sessions: they
 * keep their route until they are closed and resumed.
 */
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { AccountInfo, ModelInfo, Settings } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../acp-agent.js";
import { terminalAuthMethods } from "../auth-methods.js";
import {
  AUTH_STATUS_UPDATE_METHOD,
  authStatusCapability,
  gatewayAuthStatus,
  notLoggedInAuthStatus,
} from "../auth-status.js";
import { AuthStatusReporter, cliLogout, type AuthStatusSettings } from "../auth-status-reporter.js";
import {
  createEnvForProvider,
  defaultProviderConfig,
  type GatewayAuthRequest,
  gatewayAuthMethods,
  gatewayRequestToProviderConfig,
  isGatewayAuthMethod,
  listProvidersResponse,
  PROVIDER_ID,
  type ProviderConfig,
  providerConfigFromSetRequest,
  validatedGatewayAuthRequest,
  withListedModels,
} from "../providers.js";
import { narrowToGatewayModels } from "../session-model.js";
import { v2AuthMethod } from "../v2/initialize.js";

/** The route of a session that starts now. */
export interface SessionRouting {
  /** Added to the query's env. Empty without a gateway login or a provider. */
  env: Record<string, string>;
  /**
   * The programmatic settings of the query, with the route's env too: Claude
   * Code applies the env of settings.json after the process env, so user or
   * project settings could restore another `ANTHROPIC_BASE_URL` otherwise.
   */
  settings?: Settings;
  /** The models the session offers: those the provider's gateway listed. */
  models(models: ModelInfo[]): ModelInfo[];
}

export class NativeAuth {
  private gatewayLogin?: GatewayAuthRequest;
  private provider?: ProviderConfig;
  /** Runs `providers/set` and `providers/disable` one at a time, in arrival order. */
  private providerUpdate: Promise<unknown> = Promise.resolve();
  /** The settings of each live session, for the probe at the start of its prompts. */
  private readonly sessionSettings = new Map<string, AuthStatusSettings>();
  private readonly status: AuthStatusReporter;

  constructor(
    ctx: v2.AgentContext,
    private readonly logger: Logger,
  ) {
    this.status = new AuthStatusReporter({
      push: (authStatus) => ctx.notify(AUTH_STATUS_UPDATE_METHOD, { authStatus }),
      logger,
      gatewayLogin: () => this.gatewayLogin !== undefined,
      providerOverride: () => this.provider !== undefined,
    });
  }

  /**
   * The auth fields of the `initialize` response. It starts the probe, which
   * nothing waits for: its push goes out after the response.
   */
  initialize(capabilities: v2.ClientCapabilities | null | undefined): {
    authMethods: v2.AuthMethod[];
    _meta: { authStatus: Record<string, never> };
  } {
    void this.status.probe();
    return {
      authMethods: [
        // v2 advertises terminal logins only to a client with `auth.terminal`.
        ...(capabilities?.auth?.terminal != null
          ? terminalAuthMethods({ terminal: true, metaTerminal: false })
          : []),
        // Only offered when the client advertises `auth._meta.gateway`.
        ...(capabilities?.auth?._meta?.gateway === true ? gatewayAuthMethods() : []),
      ].map(v2AuthMethod),
      // The `authStatus` marker: this agent pushes its identity.
      _meta: { authStatus: authStatusCapability() },
    };
  }

  /** `auth/login`: a gateway login. The terminal logins are the client's to run. */
  login(params: v2.LoginAuthRequest): v2.LoginAuthResponse {
    if (!isGatewayAuthMethod(params.methodId)) {
      const terminal = terminalAuthMethods({ terminal: true, metaTerminal: false });
      if (terminal.some((method) => method.id === params.methodId)) {
        throw RequestError.invalidParams(
          { methodId: params.methodId },
          `${params.methodId} is a terminal login: run it in a terminal, then retry the request`,
        );
      }
      throw RequestError.invalidParams(
        { methodId: params.methodId },
        `Unsupported authentication method: ${params.methodId}`,
      );
    }
    this.gatewayLogin = validatedGatewayAuthRequest(params);
    // The gateway holds the credentials from here on. A probe that started
    // before this login is stale.
    this.status.changed();
    this.status.set(gatewayAuthStatus(gatewayRequestToProviderConfig(this.gatewayLogin)?.baseUrl));
    return {};
  }

  /**
   * `auth/logout`: drops the gateway login and the provider, runs `claude auth
   * logout`, and reports the identity that remains (an API key from the env
   * survives it).
   */
  async logout(): Promise<v2.LogoutAuthResponse> {
    this.gatewayLogin = undefined;
    this.status.changed();
    // After a `providers/set` that is still listing, which would set it again.
    await this.updateProvider(async () => {
      this.provider = undefined;
    });
    await cliLogout();
    // The read starts after the credentials were cleared, so it does not join
    // a probe in flight. If it cannot read them, the logout still happened.
    if (!(await this.status.probe({ fresh: true }))) {
      this.status.set(notLoggedInAuthStatus());
    }
    return {};
  }

  listProviders(): v2.ListProvidersResponse {
    return listProvidersResponse(this.provider ?? defaultProviderConfig(this.gatewayLogin));
  }

  async setProvider(params: v2.SetProviderRequest): Promise<v2.SetProviderResponse> {
    const config = providerConfigFromSetRequest(params);
    await this.updateProvider(async () => {
      this.provider = await withListedModels(config, this.provider, this.logger);
    });
    return {};
  }

  async disableProvider(params: v2.DisableProviderRequest): Promise<v2.DisableProviderResponse> {
    // An unknown provider: idempotent success.
    if (params.providerId === PROVIDER_ID) {
      await this.updateProvider(async () => {
        this.provider = undefined;
      });
    }
    return {};
  }

  /** The route of a session that starts now: the provider, else the gateway login. */
  routing(): SessionRouting {
    const config = this.provider ?? gatewayRequestToProviderConfig(this.gatewayLogin);
    const env = createEnvForProvider(config);
    return {
      env,
      ...(config ? { settings: { apiKeyHelper: "", env } } : {}),
      models: (models) =>
        config?.listedModels
          ? narrowToGatewayModels(models, config.listedModels, config.bedrockRegionPrefix)
          : models,
    };
  }

  /**
   * A session starts under `settings`: probes run in them from now on. Call
   * the result with the session's account once Claude Code reports it. It
   * reports nothing when a login or a logout came in between.
   */
  sessionStarting(
    settings: AuthStatusSettings,
  ): (sessionId: string, account: AccountInfo | undefined) => void {
    this.status.useSettings(settings);
    const epoch = this.status.epoch;
    return (sessionId, account) => {
      this.sessionSettings.set(sessionId, settings);
      if (epoch === this.status.epoch) {
        this.status.publishSessionAccount(account, settings.getApiKeyHelper());
      }
    };
  }

  /**
   * A prompt of `sessionId` starts: reads the identity again, without waiting.
   * This finds a login or a logout done in another terminal.
   */
  promptStarted(sessionId: string): void {
    const settings = this.sessionSettings.get(sessionId);
    if (settings) this.status.useSettings(settings);
    void this.status.probe();
  }

  sessionEnded(sessionId: string): void {
    this.sessionSettings.delete(sessionId);
  }

  private updateProvider(update: () => Promise<void>): Promise<void> {
    const next = this.providerUpdate.catch(() => undefined).then(update);
    this.providerUpdate = next;
    return next;
  }
}
