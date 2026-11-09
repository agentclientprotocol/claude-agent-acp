/**
 * Session setup of the native v2 core, on the v1 core's rules: the query
 * options that `_meta.claudeCode.options` and the agent's environment add,
 * the models a session offers, and the updates that a `session/resume`
 * sends before its response.
 */
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
  type HookCallbackMatcher,
  type HookEvent,
  type ModelInfo,
  type Options,
  type Query,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger, NewSessionMeta } from "../acp-agent.js";
import {
  AIR_LOAD_REPLAY_END_CAPABILITY,
  AIR_LOAD_REPLAY_END_KEY,
  clientSupportsAirCapability,
  withAirMeta,
} from "../air-extension.js";
import {
  configuredSettings as sharedConfiguredSettings,
  parseModelConfig,
} from "../session-env.js";
import {
  applyAvailableModelsAllowlist,
  getAvailableModels,
  type SessionModelState,
} from "../session-model.js";
import type { SettingsManager } from "../settings.js";

/** The SDK options a client passes in `_meta.claudeCode.options`. */
export function clientOptions(meta: unknown): Options | undefined {
  return (meta as NewSessionMeta | undefined)?.claudeCode?.options;
}

/**
 * The programmatic settings of a session, before the provider routing: the
 * models of `CLAUDE_MODEL_CONFIG`, then the client's `settings` option, an
 * object or a file path relative to `cwd`.
 */
export function configuredSettings(
  client: Options | undefined,
  cwd: string,
): Promise<Settings | undefined> {
  return sharedConfiguredSettings(
    client?.settings,
    cwd,
    parseModelConfig(process.env.CLAUDE_MODEL_CONFIG),
  );
}

/** The core's hooks, after the client's own hooks of the same event. */
export function withClientHooks(
  client: Options["hooks"],
  own: Partial<Record<HookEvent, HookCallbackMatcher[]>>,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const hooks = { ...client };
  for (const [event, matchers] of Object.entries(own) as [HookEvent, HookCallbackMatcher[]][]) {
    hooks[event] = [...(client?.[event] ?? []), ...matchers];
  }
  return hooks;
}

/**
 * The models of a session, as the v1 core picks them: the SDK's models
 * narrowed by the settings' `availableModels` allowlist and then by the
 * provider (`narrow`), with the current model from `ANTHROPIC_MODEL`, the
 * settings' `model`, or the transcript of a resumed session
 * (`getAvailableModels`, which sets it on the query when needed).
 */
export async function sessionModels(
  query: Query,
  sdkModels: ModelInfo[],
  settings: SettingsManager,
  narrow: (models: ModelInfo[]) => ModelInfo[],
  narrowedByProvider: boolean,
  resumed: { model?: string } | undefined,
  sessionId: string,
  logger: Logger,
): Promise<{ models: SessionModelState; modelInfos: ModelInfo[] }> {
  const { availableModels, modelOverrides } = settings.getSettings();
  const allowed = Array.isArray(availableModels)
    ? applyAvailableModelsAllowlist(
        sdkModels,
        availableModels,
        modelOverrides,
        settings.getManagedDeniedModels(),
      )
    : sdkModels;
  const modelInfos = narrow(allowed);
  const models = await getAvailableModels(
    query,
    modelInfos,
    sdkModels,
    settings,
    logger,
    resumed !== undefined,
    sessionId,
    resumed?.model,
    narrowedByProvider,
  );
  return { models, modelInfos };
}

/**
 * The update that ends a replay, for a client that declares AIR's
 * `loadReplayEnd` capability, as the bridge sends it.
 */
export function replayEndUpdate(
  capabilities: v2.ClientCapabilities | null | undefined,
): v2.SessionUpdate | undefined {
  if (!clientSupportsAirCapability(capabilities, AIR_LOAD_REPLAY_END_CAPABILITY)) return undefined;
  // No `title` and no `updatedAt`: `null` would clear them.
  return {
    sessionUpdate: "session_info_update",
    _meta: withAirMeta(undefined, AIR_LOAD_REPLAY_END_KEY, true),
  };
}
