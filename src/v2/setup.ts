/**
 * Session setup of the v2 core, on the v1 core's rules: the query
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
import type { Logger } from "../logger.js";
import type { NewSessionMeta } from "../new-session-meta.js";
import {
  AIR_LOAD_REPLAY_END_CAPABILITY,
  AIR_LOAD_REPLAY_END_KEY,
  clientSupportsAirCapability,
  withAirMeta,
} from "../air-extension.js";
import {
  aliasResumedModelRow,
  applyAvailableModelsAllowlist,
  getAvailableModels,
  type SessionModelState,
  withCurrentModelInfo,
} from "../session-model.js";
import type { SettingsManager } from "../settings.js";
import type { SetupParams } from "./restarts.js";
import type { V2Session } from "./session.js";

/** The SDK options a client passes in `_meta.claudeCode.options`. */
export function clientOptions(meta: unknown): Options | undefined {
  return (meta as NewSessionMeta | undefined)?.claudeCode?.options;
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
 * The models of a session, as the v1 core picks them: the SDK's models, with
 * a resumed session's model row under its family alias (`aliasResumedModelRow`),
 * narrowed by the settings' `availableModels` allowlist and then by the
 * provider (`narrow`), with the current model from `ANTHROPIC_MODEL`, the
 * settings' `model`, or the transcript of a resumed session
 * (`getAvailableModels`, which sets it on the query when needed), and the
 * current model's capabilities, also for a resumed model outside the
 * allowlist (`withCurrentModelInfo`).
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
  configuredSettings?: Settings,
): Promise<{
  models: SessionModelState;
  modelInfos: ModelInfo[];
  currentModelInfo: ModelInfo | undefined;
  allowlistedModelInfo: ModelInfo | undefined;
}> {
  const { availableModels, modelOverrides } =
    settings.getModelSelectionSettings(configuredSettings);
  // A resumed Fable 5.2 session lists Fable 5.2 as `fable`, as a new session does.
  const listed = aliasResumedModelRow(sdkModels, resumed?.model);
  const allowed = Array.isArray(availableModels)
    ? await applyAvailableModelsAllowlist(
        listed,
        availableModels,
        modelOverrides,
        settings.getManagedDeniedModels(),
      )
    : listed;
  const narrowed = narrow(allowed);
  const models = await getAvailableModels(
    query,
    narrowed,
    sdkModels,
    settings,
    logger,
    resumed !== undefined,
    sessionId,
    resumed?.model,
    narrowedByProvider,
  );
  return { models, ...withCurrentModelInfo(narrowed, listed, models.currentModelId) };
}

/**
 * The update that ends a replay, for a client that declares AIR's
 * `loadReplayEnd` capability, as v1 sends it.
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

/**
 * Starts OAuth for the setup request's MCP servers that need it, and Remote
 * Control for a query that Claude Code asked to start with it, once the setup
 * response is sent: v2 asks for no elicitation before it, and the Remote
 * Control notice belongs after it. The handler returns the response right
 * after this call, and the SDK writes it before a timer runs. Nothing else
 * orders the two. A restart calls it on the new query too: closing the old
 * one withdrew the old one's OAuth runs and ended its Remote Control.
 */
export function afterSetupResponse(session: V2Session, params: SetupParams): void {
  setTimeout(() => session.connectRemoteControlAtStartup(), 0);
  // The setup already rejected servers of an unknown transport.
  const names = (params.mcpServers ?? []).flatMap((server) =>
    typeof server.name === "string" ? [server.name] : [],
  );
  if (names.length === 0) return;
  setTimeout(() => session.elicitations.authenticateMcpServers(names), 0);
}
