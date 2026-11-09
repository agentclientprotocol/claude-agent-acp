/**
 * Client-managed LLM routing, shared by the v1 core and the v2 core:
 * the `main` provider of `providers/list`, `providers/set` and
 * `providers/disable`, and the legacy gateway logins (`authenticate` or
 * `auth/login` with `gateway` or `gateway-bedrock`). Each core holds its own
 * {@link ProviderConfig} and gateway login, and builds the query env of its
 * sessions with {@link createEnvForProvider}.
 */
import {
  RequestError,
  type AuthenticateRequest,
  type AuthMethod,
  type ListProvidersResponse,
  type LlmProtocol,
  type ProviderInfo,
  type SetProviderRequest,
} from "@agentclientprotocol/sdk/unstable";
import {
  GatewayListingError,
  listBedrockModels,
  listGatewayModels,
  PROVIDER_AUTH_TOKEN_PLACEHOLDER,
  selectBedrockRegion,
} from "./gateway-models.js";

type ProviderLogger = { log: (...args: any[]) => void; error: (...args: any[]) => void };

/**
 * Extra metadata for 'gateway' authentication requests.
 */
export type GatewayAuthMeta = {
  /**
   * These parameters are mapped to environment variables to:
   * - Redirect API calls via baseUrl
   * - Inject custom headers
   * - Bypass the default Claude login requirement
   *
   * Both members are optional in the type because the payload arrives
   * unvalidated from the client. `authenticate` rejects a request that lacks a
   * usable `baseUrl`.
   */
  gateway?: {
    baseUrl?: string;
    headers?: Record<string, string>;
  };
};

export type GatewayAuthRequest = AuthenticateRequest & { _meta?: GatewayAuthMeta };

export const SUPPORTED_PROTOCOLS: LlmProtocol[] = ["anthropic", "bedrock", "vertex"];
export const PROVIDER_ID = "main";
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const DEFAULT_VERTEX_BASE_URL = "https://aiplatform.googleapis.com";

/**
 * Vertex needs project + region that the standard `providers/set` payload
 * (`apiType`/`baseUrl`/`headers`) does not model, so clients pass them through
 * `_meta.claudeCode.vertex`. Required only when `apiType === "vertex"`.
 */
export type SetProviderMeta = {
  claudeCode?: {
    vertex?: {
      projectId: string;
      region: string;
    };
  };
};

/**
 * Resolved, non-secret + secret routing config for the `main` provider. This is
 * the shared shape produced by both `providers/set` and the legacy gateway auth
 * path, and consumed by {@link createEnvForProvider}. `null` means the provider
 * is unconfigured (no client-managed routing in effect).
 */
export type ProviderConfig = {
  apiType: LlmProtocol;
  baseUrl: string;
  headers: Record<string, string>;
  /** Present only for `apiType === "vertex"`. */
  vertex?: {
    projectId: string;
    region: string;
  };
  /**
   * Model ids an `anthropic` or `bedrock` gateway listed when it was set via
   * `providers/set`; the model picker offers only these. Absent when the
   * listing failed or the config came from elsewhere (gateway `authenticate`),
   * so nothing is narrowed.
   */
  listedModels?: string[];
  /**
   * The cross-region prefix of the model ids a `bedrock` gateway
   * listed (`eu` for `eu.anthropic.claude-sonnet-5`), passed to the CLI as
   * `ANTHROPIC_BEDROCK_REGION_PREFIX` so it calls the models under that prefix.
   */
  bedrockRegionPrefix?: string;
};

/**
 * Adapt a legacy gateway `authenticate` request into the shared
 * {@link ProviderConfig} shape. Returns `null` when no gateway request is
 * present. `methodId` selects the protocol: `gateway-bedrock` → bedrock,
 * otherwise anthropic.
 */
export function gatewayRequestToProviderConfig(
  request?: GatewayAuthRequest,
): ProviderConfig | null {
  // `authenticate` validates the payload before it stores one, so a stored
  // request always carries a usable gateway. Re-check the shape here anyway:
  // this function decides whether a provider override is active, and the
  // `--hide-claude-auth` guard is off while one is.
  const gateway = request?._meta?.gateway;
  if (!gateway || !isValidBaseUrl(gateway.baseUrl)) {
    return null;
  }
  return {
    apiType: request?.methodId === "gateway-bedrock" ? "bedrock" : "anthropic",
    baseUrl: gateway.baseUrl,
    headers: gateway.headers ?? {},
  };
}

/**
 * Map a resolved provider config into the Claude Code env vars that redirect API
 * traffic and inject headers. Returns an empty object when routing is
 * unconfigured. The token/bypass placeholders (`" "`) are required so the CLI
 * skips its normal login/credential checks when a gateway is in use.
 */
export function createEnvForProvider(config: ProviderConfig | null): Record<string, string> {
  if (!config) {
    return {};
  }
  const resetRouting = {
    ANTHROPIC_BASE_URL: "",
    ANTHROPIC_BEDROCK_BASE_URL: "",
    ANTHROPIC_VERTEX_BASE_URL: "",
    CLAUDE_CODE_USE_BEDROCK: "0",
    CLAUDE_CODE_USE_VERTEX: "0",
    ANTHROPIC_VERTEX_PROJECT_ID: "",
    CLOUD_ML_REGION: "",
    AWS_REGION: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
  };
  const customHeaders = Object.entries(config.headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

  if (config.apiType === "bedrock") {
    return {
      ...resetRouting,
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_BEARER_TOKEN_BEDROCK: PROVIDER_AUTH_TOKEN_PLACEHOLDER, // Bypass local AWS credential checks
      ANTHROPIC_BEDROCK_BASE_URL: config.baseUrl,
      ANTHROPIC_CUSTOM_HEADERS: customHeaders,
      ...(config.bedrockRegionPrefix
        ? { ANTHROPIC_BEDROCK_REGION_PREFIX: config.bedrockRegionPrefix }
        : {}),
    };
  }

  if (config.apiType === "vertex") {
    // `config.vertex` is guaranteed present for vertex by `unstable_setProvider`
    // validation; fall back to empty strings defensively.
    // Leaving ANTHROPIC_VERTEX_BASE_URL empty for the default endpoint lets
    // Claude Code use its native Vertex endpoint/model resolution. Supplying
    // even the default host marks the session as a custom Vertex deployment and
    // can hide otherwise-valid models.
    return {
      ...resetRouting,
      CLAUDE_CODE_USE_VERTEX: "1",
      ...(config.baseUrl !== DEFAULT_VERTEX_BASE_URL
        ? { ANTHROPIC_VERTEX_BASE_URL: config.baseUrl }
        : {}),
      ANTHROPIC_VERTEX_PROJECT_ID: config.vertex?.projectId ?? "",
      CLOUD_ML_REGION: config.vertex?.region ?? "",
      ANTHROPIC_CUSTOM_HEADERS: customHeaders,
    };
  }

  return {
    ...resetRouting,
    ANTHROPIC_BASE_URL: config.baseUrl,
    ANTHROPIC_CUSTOM_HEADERS: customHeaders,
    ANTHROPIC_AUTH_TOKEN: PROVIDER_AUTH_TOKEN_PLACEHOLDER, // Bypass local Claude login checks
  };
}

function sameHeaders(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  return aKeys.length === Object.keys(b).length && aKeys.every((key) => b[key] === a[key]);
}

/**
 * A provider base URL as logs may show it: its origin only. The URL can come
 * from the env or the client and can carry credentials (`https://user:key@host`)
 * or a key in its path or query, so a log line must not print it whole.
 */
export function loggableBaseUrl(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return "native";
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "invalid";
  }
}

/**
 * Validate a provider base URL: must be a non-empty absolute http(s) URL.
 */
export function isValidBaseUrl(baseUrl: string | undefined): baseUrl is string {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/** The gateway login methods, advertised to a client with `auth._meta.gateway`. */
export function gatewayAuthMethods(): AuthMethod[] {
  return (["anthropic", "bedrock"] as const).map((protocol) => ({
    id: protocol === "anthropic" ? "gateway" : "gateway-bedrock",
    name: "Custom model gateway",
    description: "Use a custom gateway to authenticate and access models",
    _meta: { gateway: { protocol } },
  }));
}

export function isGatewayAuthMethod(methodId: string): boolean {
  return methodId === "gateway" || methodId === "gateway-bedrock";
}

/**
 * The gateway login `params` asks for, once its payload is usable: the same
 * base URL rule as `providers/set`. An unchecked payload either throws a
 * `TypeError` deep in session creation, or installs an empty base URL that
 * silently turns the `--hide-claude-auth` subscription guard off.
 *
 * A request that carries no gateway payload at all keeps its historical
 * meaning: it installs no override and succeeds. A client that probes the
 * method this way must keep working. Only a payload that IS present has to be
 * usable.
 */
export function validatedGatewayAuthRequest(params: AuthenticateRequest): GatewayAuthRequest {
  const gateway = (params as GatewayAuthRequest)._meta?.gateway;
  if (gateway !== undefined && gateway !== null) {
    if (typeof gateway !== "object" || !isValidBaseUrl(gateway.baseUrl)) {
      throw RequestError.invalidParams(
        { baseUrl: (gateway as { baseUrl?: unknown }).baseUrl },
        "`_meta.gateway.baseUrl` must be a non-empty absolute http(s) URL.",
      );
    }
    if (gateway.headers !== undefined && typeof gateway.headers !== "object") {
      throw RequestError.invalidParams(
        undefined,
        "`_meta.gateway.headers` must be an object of header names to values.",
      );
    }
  }
  return params as GatewayAuthRequest;
}

/** The native routing of the agent: a gateway login, else the process env. */
export function defaultProviderConfig(gatewayAuthRequest?: GatewayAuthRequest): ProviderConfig {
  const gatewayConfig = gatewayRequestToProviderConfig(gatewayAuthRequest);
  if (gatewayConfig) {
    return gatewayConfig;
  }
  if (process.env.CLAUDE_CODE_USE_BEDROCK) {
    return {
      apiType: "bedrock",
      baseUrl: process.env.ANTHROPIC_BEDROCK_BASE_URL ?? "https://bedrock-runtime.amazonaws.com",
      headers: {},
    };
  }
  if (process.env.CLAUDE_CODE_USE_VERTEX) {
    return {
      apiType: "vertex",
      baseUrl: process.env.ANTHROPIC_VERTEX_BASE_URL ?? DEFAULT_VERTEX_BASE_URL,
      headers: {},
    };
  }
  return {
    apiType: "anthropic",
    baseUrl: process.env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL,
    headers: {},
  };
}

/** The `providers/list` response for the `main` provider routed by `config`. */
export function listProvidersResponse(config: ProviderConfig): ListProvidersResponse {
  const provider: ProviderInfo = {
    providerId: PROVIDER_ID,
    supported: SUPPORTED_PROTOCOLS,
    required: false,
    current: { apiType: config.apiType, baseUrl: config.baseUrl },
  };
  return { providers: [provider] };
}

/**
 * The configuration a `providers/set` request asks for. Rejects unknown IDs,
 * unsupported protocols, empty or invalid base URLs, and a `vertex` request
 * without its project and region, with `invalid_params`.
 */
export function providerConfigFromSetRequest(params: SetProviderRequest): ProviderConfig {
  if (params.providerId !== PROVIDER_ID) {
    throw RequestError.invalidParams(
      { providerId: params.providerId },
      `Unknown provider ID "${params.providerId}"; expected "${PROVIDER_ID}".`,
    );
  }
  if (!SUPPORTED_PROTOCOLS.includes(params.apiType)) {
    throw RequestError.invalidParams(
      { apiType: params.apiType, supported: SUPPORTED_PROTOCOLS },
      `Unsupported apiType "${params.apiType}" for provider "${PROVIDER_ID}".`,
    );
  }
  if (!isValidBaseUrl(params.baseUrl)) {
    throw RequestError.invalidParams(
      { baseUrl: params.baseUrl },
      "baseUrl must be a non-empty absolute http(s) URL.",
    );
  }

  const config: ProviderConfig = {
    apiType: params.apiType,
    baseUrl: params.baseUrl,
    headers: params.headers ?? {},
  };

  // Vertex requires project + region, which the standard payload cannot
  // carry, so they arrive via `_meta.claudeCode.vertex`.
  if (params.apiType === "vertex") {
    const vertex = (params._meta as SetProviderMeta | undefined)?.claudeCode?.vertex;
    if (
      !vertex ||
      typeof vertex.projectId !== "string" ||
      vertex.projectId.trim() === "" ||
      typeof vertex.region !== "string" ||
      vertex.region.trim() === ""
    ) {
      throw RequestError.invalidParams(
        undefined,
        "vertex apiType requires non-empty `_meta.claudeCode.vertex.projectId` and `_meta.claudeCode.vertex.region`.",
      );
    }
    config.vertex = { projectId: vertex.projectId, region: vertex.region };
  }
  return config;
}

/**
 * Adds to `config` the model ids its gateway lists, and for `bedrock` the
 * region prefix picked from them, so the sessions it routes offer only those.
 * Setting the same gateway as `current` again reuses its listing. `vertex`
 * gateways are not listed. A failed listing throws an `internal_error`.
 */
export async function withListedModels(
  config: ProviderConfig,
  current: ProviderConfig | undefined,
  logger: ProviderLogger,
): Promise<ProviderConfig> {
  try {
    Object.assign(config, await listProviderModels(config, current, logger));
  } catch (error) {
    if (error instanceof GatewayListingError) {
      throw RequestError.internalError(
        { providerId: PROVIDER_ID, apiType: config.apiType, baseUrl: config.baseUrl },
        `Model discovery for provider "${PROVIDER_ID}" failed: ${error.message}`,
      );
    }
    throw error;
  }
  logger.log(
    `[providers/set] listedModels=${config.listedModels?.length ?? "none"} bedrockRegionPrefix=${config.bedrockRegionPrefix ?? "none"}`,
  );
  return config;
}

async function listProviderModels(
  config: ProviderConfig,
  current: ProviderConfig | undefined,
  logger: ProviderLogger,
): Promise<Pick<ProviderConfig, "listedModels" | "bedrockRegionPrefix">> {
  // Reuse needs the very same headers, so a rotated token lists again, and a
  // failed listing then fails that `providers/set`. Deliberate: AIR keeps its
  // proxy key for the IDE's lifetime and does not rotate it.
  if (
    current?.listedModels &&
    current.apiType === config.apiType &&
    current.baseUrl === config.baseUrl &&
    sameHeaders(current.headers, config.headers)
  ) {
    return {
      listedModels: current.listedModels,
      bedrockRegionPrefix: current.bedrockRegionPrefix,
    };
  }
  if (config.apiType === "anthropic") {
    return { listedModels: await listGatewayModels(config.baseUrl, config.headers, logger) };
  }
  if (config.apiType === "bedrock") {
    const modelIds = await listBedrockModels(config.baseUrl, config.headers, logger);
    if (!modelIds) return {};
    const region = selectBedrockRegion(modelIds);
    if (region.modelIds.length < modelIds.length) {
      logger.log(
        `[providers/set] Bedrock models span several region prefixes; using ${region.regionPrefix} and dropping ${modelIds.length - region.modelIds.length} id(s) of other prefixes`,
      );
    }
    return { listedModels: region.modelIds, bedrockRegionPrefix: region.regionPrefix };
  }
  return {};
}
