import type { ClientCapabilities, SessionNotification } from "@agentclientprotocol/sdk";
import {
  getSessionMessages,
  type SDKAssistantMessageError,
  USAGE_LIMIT_ERROR_PREFIXES,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";

const JETBRAINS_META_KEY = "jetbrains";
const AIR_META_KEY = "air";
const AIR_EXTENSION_VERSION_KEY = "version";
const AIR_EXTENSION_CAPABILITIES_KEY = "capabilities";
const AIR_SESSION_FAILURE_KEY = "sessionFailure";
const AIR_EXTENSION_VERSION = 1;

export function airSessionFailureCapabilityMeta() {
  return {
    [JETBRAINS_META_KEY]: {
      [AIR_META_KEY]: {
        [AIR_EXTENSION_VERSION_KEY]: AIR_EXTENSION_VERSION,
        [AIR_EXTENSION_CAPABILITIES_KEY]: [AIR_SESSION_FAILURE_KEY],
      },
    },
  };
}

export type ClaudeFailureKind =
  | "advisory"
  | "auth_required"
  | "bad_request"
  | "budget_exhausted"
  | "context_exhausted"
  | "internal_error"
  | "overloaded"
  | "provider_error"
  | "quota_exhausted"
  | "rate_limited"
  | "transport_lost"
  | "worker_shutdown";

type AirSessionFailureCategory =
  "connection" | "access" | "limit" | "request" | "service" | "unknown";

type AirSessionFailureSeverity = "warning" | "error";
type AirSessionFailureAction = "retry" | "login" | "new_session";

type SessionFailureRecoveryPolicy =
  "never" | "next_attempt" | "real_model_success" | "auth_status" | "runtime_rebind";

export type PublishedSessionFailure = {
  id: string;
  revision: number;
  kind: ClaudeFailureKind;
  category: AirSessionFailureCategory;
  turnId?: string;
  severity: AirSessionFailureSeverity;
  title: string;
  details?: string;
  actions: AirSessionFailureAction[];
  recoveryPolicy: SessionFailureRecoveryPolicy;
};

export type SessionFailureState = {
  epoch: string;
  revisions: Map<string, number>;
  active: Map<string, PublishedSessionFailure>;
  nextIncident?: number;
  lastNotice?: { title: string; id: string };
};

type Logger = {
  error: (...args: unknown[]) => void;
};

export function createSessionFailureState(): SessionFailureState {
  return {
    epoch: randomUUID(),
    revisions: new Map(),
    active: new Map(),
  };
}

const AIR_FAILURE_POLICY: Record<
  ClaudeFailureKind,
  {
    category: AirSessionFailureCategory;
    actions: AirSessionFailureAction[];
    fallbackTitle: string;
  }
> = {
  advisory: {
    category: "unknown",
    actions: [],
    fallbackTitle: "Claude reported a notice.",
  },
  auth_required: {
    category: "access",
    actions: ["login"],
    fallbackTitle: "Sign in to continue using Claude.",
  },
  bad_request: {
    category: "request",
    actions: [],
    fallbackTitle: "Claude could not process this request.",
  },
  budget_exhausted: {
    category: "limit",
    actions: ["new_session"],
    fallbackTitle: "This Claude session reached its configured budget.",
  },
  context_exhausted: {
    category: "limit",
    actions: ["new_session"],
    fallbackTitle: "This Claude turn reached its configured limit.",
  },
  internal_error: {
    category: "service",
    actions: ["retry", "new_session"],
    fallbackTitle: "Claude Agent encountered an internal error.",
  },
  overloaded: {
    category: "service",
    actions: ["retry"],
    fallbackTitle: "Claude is temporarily overloaded.",
  },
  provider_error: {
    category: "service",
    actions: ["retry"],
    fallbackTitle: "The model provider reported an error.",
  },
  quota_exhausted: {
    category: "limit",
    actions: [],
    fallbackTitle: "The Claude account has no available quota.",
  },
  rate_limited: {
    category: "limit",
    actions: ["retry"],
    fallbackTitle: "Claude is temporarily rate limited.",
  },
  transport_lost: {
    category: "connection",
    actions: ["new_session"],
    fallbackTitle: "The connection to Claude was lost.",
  },
  worker_shutdown: {
    category: "connection",
    actions: ["new_session"],
    fallbackTitle: "The Claude worker is shutting down.",
  },
};

export function sessionFailureMeta(failure: PublishedSessionFailure) {
  return {
    [JETBRAINS_META_KEY]: {
      [AIR_META_KEY]: {
        [AIR_EXTENSION_VERSION_KEY]: AIR_EXTENSION_VERSION,
        [AIR_SESSION_FAILURE_KEY]: {
          id: failure.id,
          revision: failure.revision,
          category: failure.category,
          severity: failure.severity,
          title: failure.title,
          ...(failure.details ? { details: failure.details } : {}),
          actions: failure.actions,
        },
      },
    },
  };
}

/** `getSessionMessages` deliberately exposes only the API message and strips
 *  transcript-level `error` / `isApiErrorMessage` fields. The SDK exports the
 *  exact stable prefixes used by its synthetic usage-limit errors, so replay
 *  can recover this one typed failure without matching arbitrary model prose. */
export function assistantMessageText(apiMessage: unknown): string | undefined {
  if (!apiMessage || typeof apiMessage !== "object") return undefined;
  const { content } = apiMessage as { content?: unknown };
  if (typeof content === "string") return content || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) =>
      block &&
      typeof block === "object" &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("");
  return text || undefined;
}

export function isSyntheticUsageLimitMessage(apiMessage: unknown): boolean {
  if (!apiMessage || typeof apiMessage !== "object") return false;
  const { model } = apiMessage as { model?: unknown };
  if (model !== "<synthetic>") return false;
  const text = assistantMessageText(apiMessage);
  if (!text) return false;
  return USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export function activeUsageLimitMessage(
  messages: Awaited<ReturnType<typeof getSessionMessages>>,
): { uuid: string; title: string } | undefined {
  let active: { uuid: string; title: string } | undefined;
  for (const message of messages) {
    if (message.type !== "assistant" || message.parent_tool_use_id !== null) continue;
    if (isSyntheticUsageLimitMessage(message.message)) {
      const title = assistantMessageText(message.message);
      if (title) active = { uuid: message.uuid, title };
      continue;
    }
    const model =
      message.message && typeof message.message === "object" && "model" in message.message
        ? message.message.model
        : undefined;
    // A later real model answer proves the account recovered. Synthetic
    // local-command/interruption messages do not: they can be appended while
    // the provider remains unavailable.
    if (model !== undefined && model !== "<synthetic>") active = undefined;
  }
  return active;
}

export function supportsAirSessionFailures(capabilities?: ClientCapabilities): boolean {
  const jetbrains = capabilities?._meta?.[JETBRAINS_META_KEY] as
    Record<string, unknown> | undefined;
  const air = jetbrains?.[AIR_META_KEY] as Record<string, unknown> | undefined;
  const version = air?.[AIR_EXTENSION_VERSION_KEY];
  const advertised = air?.[AIR_EXTENSION_CAPABILITIES_KEY];
  return (
    typeof version === "number" &&
    Number.isFinite(version) &&
    Number.isInteger(version) &&
    version >= AIR_EXTENSION_VERSION &&
    Array.isArray(advertised) &&
    advertised.some((capability) => capability === AIR_SESSION_FAILURE_KEY)
  );
}

function sessionFailureRecoveryPolicy(
  kind: ClaudeFailureKind,
  turnId?: string,
): SessionFailureRecoveryPolicy {
  switch (kind) {
    case "advisory":
      return "never";
    case "auth_required":
      return "auth_status";
    case "transport_lost":
    case "worker_shutdown":
      return "runtime_rebind";
    case "quota_exhausted":
      return "real_model_success";
    default:
      return turnId ? "next_attempt" : "real_model_success";
  }
}

/** Owns the AIR failure lifecycle for both the live consumer and history replay.
 *  Published revisions become active only after delivery succeeds; recovery only
 *  removes internal active state because transcript records are historical. */
export function createSessionFailureController(options: {
  sessionId: string;
  state: SessionFailureState;
  capabilities?: ClientCapabilities;
  isCurrent: () => boolean;
  sendUpdate: (notification: SessionNotification) => Promise<void>;
  logger: Logger;
}) {
  const { sessionId, state, capabilities, isCurrent, sendUpdate, logger } = options;
  const isSupported = () => supportsAirSessionFailures(capabilities);

  const emit = async (failure: PublishedSessionFailure): Promise<boolean> => {
    if (!isCurrent()) {
      logger.error(`Session ${sessionId}: ignored AIR session failure from a stale consumer`);
      return false;
    }
    try {
      await sendUpdate({
        sessionId,
        update: {
          sessionUpdate: "session_info_update",
          _meta: sessionFailureMeta(failure),
        },
      });
      return true;
    } catch (error) {
      logger.error(`Session ${sessionId}: failed to publish AIR session failure: ${error}`);
      return false;
    }
  };

  const recordActive = (failure: PublishedSessionFailure) => {
    state.revisions.set(failure.id, failure.revision);
    state.active.set(failure.id, failure);
    state.lastNotice =
      failure.kind === "advisory" ? { title: failure.title, id: failure.id } : undefined;
  };

  const clear = async (
    shouldClear: (failure: PublishedSessionFailure) => boolean = () => true,
  ): Promise<boolean> => {
    if (!isSupported()) return true;
    state.lastNotice = undefined;
    for (const failure of [...state.active.values()]) {
      if (!shouldClear(failure)) continue;
      state.active.delete(failure.id);
    }
    return true;
  };

  const prepare = async (
    kind: ClaudeFailureKind,
    failureOptions: { turnId?: string; sessionScoped?: boolean; title?: string } = {},
  ): Promise<PublishedSessionFailure | undefined> => {
    if (!isSupported() || !isCurrent()) return undefined;
    const policy = AIR_FAILURE_POLICY[kind];
    const title = failureOptions.title || policy.fallbackTitle;
    if (kind === "advisory") {
      const id =
        state.lastNotice?.title === title
          ? state.lastNotice.id
          : `${sessionId}:notice:${state.epoch}:${state.nextIncident ?? 1}`;
      if (state.lastNotice?.title !== title) state.nextIncident = (state.nextIncident ?? 1) + 1;
      return {
        id,
        revision: (state.revisions.get(id) ?? 0) + 1,
        kind,
        category: policy.category,
        severity: "warning",
        title,
        actions: policy.actions,
        recoveryPolicy: sessionFailureRecoveryPolicy(kind),
      };
    }
    const id =
      failureOptions.turnId && !failureOptions.sessionScoped
        ? `${failureOptions.turnId}:error`
        : `${sessionId}:session-error:${state.epoch}:${state.nextIncident ?? 1}`;
    if (!failureOptions.turnId || failureOptions.sessionScoped) {
      state.nextIncident = (state.nextIncident ?? 1) + 1;
    }
    return {
      id,
      revision: (state.revisions.get(id) ?? 0) + 1,
      kind,
      category: policy.category,
      severity: "error",
      title,
      actions: policy.actions,
      recoveryPolicy: sessionFailureRecoveryPolicy(
        kind,
        failureOptions.turnId && !failureOptions.sessionScoped ? failureOptions.turnId : undefined,
      ),
      ...(failureOptions.turnId && !failureOptions.sessionScoped
        ? { turnId: failureOptions.turnId }
        : {}),
    };
  };

  const publish = async (
    kind: ClaudeFailureKind,
    failureOptions: { turnId?: string; sessionScoped?: boolean; title?: string } = {},
  ) => {
    const failure = await prepare(kind, failureOptions);
    if (!failure) return;
    if (await emit(failure)) recordActive(failure);
  };

  const restore = async (id: string, kind: ClaudeFailureKind, title: string): Promise<boolean> => {
    if (!isSupported() || !isCurrent()) return false;
    const policy = AIR_FAILURE_POLICY[kind];
    const failure: PublishedSessionFailure = {
      id,
      revision: (state.revisions.get(id) ?? 0) + 1,
      kind,
      category: policy.category,
      severity: "error",
      title,
      actions: policy.actions,
      recoveryPolicy: sessionFailureRecoveryPolicy(kind),
    };
    if (!(await emit(failure))) return false;
    recordActive(failure);
    return true;
  };

  return { clear, prepare, publish, recordActive, restore };
}

export function providerFailureCategory(
  errorKind?: SDKAssistantMessageError,
  isUsageLimit = false,
): ClaudeFailureKind {
  if (isUsageLimit) return "quota_exhausted";
  switch (errorKind) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return "auth_required";
    case "billing_error":
      return "quota_exhausted";
    case "rate_limit":
      return "rate_limited";
    case "overloaded":
      return "overloaded";
    case "invalid_request":
    case "model_not_found":
      return "bad_request";
    case "max_output_tokens":
      return "context_exhausted";
    case "server_error":
    case "unknown":
    case undefined:
      return "provider_error";
    default:
      return "provider_error";
  }
}
