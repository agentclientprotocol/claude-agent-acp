/**
 * Model discovery for a gateway set via `providers/set`.
 *
 * An organization can restrict which models its gateway serves, and the
 * gateway's listing returns only those: `GET /v1/models` for an `anthropic`
 * gateway, `GET /foundation-models` (Bedrock `ListFoundationModels`) for a
 * `bedrock` one. The adapter lists them once when the provider is set, and the
 * model picker then offers only the SDK models the gateway listed (see
 * `narrowToGatewayModels` in `session-model.ts`). A listing that fails fails
 * `providers/set` with a {@link GatewayListingError}.
 */

const LISTING_TIMEOUT_MS = 10_000;
const ANTHROPIC_PAGE_LIMIT = "1000";
const MAX_LISTING_PAGES = 20;
const MAX_LOGGED_BODY_CHARS = 500;
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * The bearer token `createEnvForProvider` sets as `ANTHROPIC_AUTH_TOKEN` and
 * `AWS_BEARER_TOKEN_BEDROCK`, so the CLI sends `Authorization: Bearer acp-proxy`
 * unless the provider headers replace it. The listing sends the same, so the
 * gateway sees the same auth as on chat requests.
 */
export const PROVIDER_AUTH_TOKEN_PLACEHOLDER = "acp-proxy";

/**
 * The cross-region inference profile prefixes the CLI knows:
 * `eu.anthropic.claude-sonnet-5`. `ANTHROPIC_BEDROCK_REGION_PREFIX` accepts all
 * of them but `us-gov`, which the CLI takes only from a `us-gov-*` AWS region;
 * a gateway listing only `us-gov.*` ids would then get an empty picker. That
 * case is theoretical, so it is left as is.
 */
const BEDROCK_REGION_PREFIXES = ["us", "eu", "apac", "jp", "au", "us-gov", "global"];

type ListingLogger = { log: (...args: any[]) => void; error: (...args: any[]) => void };

type ListingPage = { ids: string[]; nextQuery?: Record<string, string> };

/**
 * A gateway listing that failed: a network error, a status other than 2xx or
 * 4xx, a body that is not the expected listing, or the 10 s timeout. The
 * message names the request path and the reason, never a header value.
 */
export class GatewayListingError extends Error {
  override name = "GatewayListingError";
}

/**
 * Lists the model ids an `anthropic` gateway at `baseUrl` serves, following
 * `has_more` / `last_id` pagination. Returns `undefined` when the gateway
 * answers 4xx: it has no listing, and nothing is narrowed. Throws a
 * {@link GatewayListingError} when the listing fails. Header values are never
 * logged.
 */
export async function listGatewayModels(
  baseUrl: string,
  providerHeaders: Record<string, string>,
  logger: ListingLogger,
): Promise<string[] | undefined> {
  return listPages(
    `${baseUrl.replace(/\/+$/, "")}/v1/models`,
    { limit: ANTHROPIC_PAGE_LIMIT },
    listingHeaders(providerHeaders, { "anthropic-version": ANTHROPIC_VERSION }),
    logger,
    (body) => {
      const page = body as { data?: unknown; has_more?: unknown; last_id?: unknown };
      if (!Array.isArray(page.data)) return undefined;
      return {
        ids: stringField(page.data, "id"),
        nextQuery:
          page.has_more === true && typeof page.last_id === "string"
            ? { limit: ANTHROPIC_PAGE_LIMIT, after_id: page.last_id }
            : undefined,
      };
    },
  );
}

/**
 * Lists the Anthropic models a `bedrock` gateway at `baseUrl` serves
 * (`GET /foundation-models`, Bedrock `ListFoundationModels`, one page), the
 * listing AI Router answers on its Bedrock route. Returns the listed ids, such
 * as `global.anthropic.claude-sonnet-5-5`; `undefined` and the errors are
 * those of {@link listGatewayModels}.
 */
export async function listBedrockModels(
  baseUrl: string,
  providerHeaders: Record<string, string>,
  logger: ListingLogger,
): Promise<string[] | undefined> {
  const ids = await listPages(
    `${baseUrl.replace(/\/+$/, "")}/foundation-models`,
    {},
    listingHeaders(providerHeaders, {}),
    logger,
    (body) => {
      const page = body as { modelSummaries?: unknown };
      if (!Array.isArray(page.modelSummaries)) return undefined;
      return { ids: stringField(page.modelSummaries, "modelId") };
    },
  );
  return ids?.filter((id) => id.includes("anthropic."));
}

/** The cross-region prefix of a Bedrock model id or ARN, if it has one. */
export function bedrockRegionPrefix(modelId: string): string | undefined {
  const id = modelId.slice(modelId.lastIndexOf("/") + 1).toLowerCase();
  return BEDROCK_REGION_PREFIXES.find((prefix) => id.startsWith(`${prefix}.anthropic.`));
}

/**
 * Picks the region of the listed Bedrock models: `global` when the gateway
 * lists it, else the prefix of the first id that has one. A gateway that lists
 * `eu.*` and `us.*` ids gets the prefix that comes first, and the ids of the
 * other prefixes are dropped, so the picker offers only models the CLI can
 * call under that prefix. Ids without a prefix (`anthropic.claude-…`) are
 * dropped too once a prefix is picked; without any prefix every id is kept.
 */
export function selectBedrockRegion(modelIds: readonly string[]): {
  regionPrefix?: string;
  modelIds: string[];
} {
  const prefixes = modelIds.map(bedrockRegionPrefix);
  const regionPrefix = prefixes.includes("global")
    ? "global"
    : prefixes.find((prefix) => prefix !== undefined);
  if (!regionPrefix) return { modelIds: [...modelIds] };
  return {
    regionPrefix,
    modelIds: modelIds.filter((id) => bedrockRegionPrefix(id) === regionPrefix),
  };
}

// Provider headers win over the defaults, matched case-insensitively, the way
// `ANTHROPIC_CUSTOM_HEADERS` overrides the CLI's own headers.
function listingHeaders(
  providerHeaders: Record<string, string>,
  protocolHeaders: Record<string, string>,
): Headers {
  const headers = new Headers({
    authorization: `Bearer ${PROVIDER_AUTH_TOKEN_PLACEHOLDER}`,
    accept: "application/json",
    ...protocolHeaders,
  });
  for (const [name, value] of Object.entries(providerHeaders)) {
    // `Headers.set` puts an invalid value into its error message, so name only the header.
    try {
      headers.set(name, value);
    } catch {
      throw new GatewayListingError(`Model listing cannot send the invalid header "${name}"`);
    }
  }
  return headers;
}

function stringField(entries: unknown[], field: string): string[] {
  return entries.flatMap((entry) => {
    const value = (entry as Record<string, unknown> | null)?.[field];
    return typeof value === "string" && value.trim() !== "" ? [value] : [];
  });
}

/**
 * Reads `endpoint` page by page; `parse` returns `undefined` for a body it does
 * not understand. A 4xx answer on any page means the gateway has no listing:
 * the result is `undefined`, and nothing is narrowed.
 */
async function listPages(
  endpoint: string,
  firstQuery: Record<string, string>,
  headers: Headers,
  logger: ListingLogger,
  parse: (body: unknown) => ListingPage | undefined,
): Promise<string[] | undefined> {
  const { pathname: path, username, password } = new URL(endpoint);
  const failure = (reason: string): GatewayListingError => {
    const error = new GatewayListingError(`Model listing GET ${path} ${reason}`);
    logger.error(`[providers/set] ${error.message}`);
    return error;
  };
  // fetch refuses such a URL and repeats it, credentials included, in its error.
  if (username || password) throw failure("cannot be sent: the base URL carries credentials");
  const signal = AbortSignal.timeout(LISTING_TIMEOUT_MS);
  const ids: string[] = [];
  let query: Record<string, string> | undefined = firstQuery;
  for (let page = 0; page < MAX_LISTING_PAGES && query; page++) {
    const url = new URL(endpoint);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    let response: Response;
    let body: string;
    try {
      response = await fetch(url, { headers, signal });
      body = await response.text();
    } catch (error) {
      throw failure(`failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status >= 400 && response.status < 500) {
      logger.log(
        `[providers/set] Model listing GET ${path} returned ${response.status}: the gateway has no listing, models are not narrowed`,
      );
      return undefined;
    }
    if (!response.ok) {
      throw failure(`returned ${response.status}: ${body.slice(0, MAX_LOGGED_BODY_CHARS)}`);
    }
    let parsed: ListingPage | undefined;
    try {
      parsed = parse(JSON.parse(body));
    } catch {
      parsed = undefined;
    }
    if (!parsed) throw failure("returned an unexpected body");
    ids.push(...parsed.ids);
    query = parsed.nextQuery;
  }
  if (query) {
    logger.error(
      `[providers/set] Model listing GET ${path} still had more pages after ${MAX_LISTING_PAGES}; using what was read`,
    );
  }
  return ids;
}
