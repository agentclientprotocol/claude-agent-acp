import type { NewSessionRequest } from "@agentclientprotocol/sdk";
import type { EffortLevel, Options } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_AGENT_ID, DEFAULT_MODEL_ID } from "./session-config-ids.js";

/** What a restart reads off the session it replaces. A projection, so the
 *  helper stays independent from the agent's much larger Session record. */
export type RestartableSession = {
  cwd: string;
  creationParams?: NewSessionRequest;
  models: { currentModelId: string };
  currentAgent: string;
  effortPinnedLevel?: string;
};

/**
 * The `session/new` request that recreates a session as it is now, rather than
 * as it was created: the model, the agent and the effort the user has since
 * chosen replace the ones the original request carried.
 *
 * Every restart under the same client-visible id goes through this — a cleared
 * context, a rewind — because the client sees one session either way, and a
 * restart that silently returns it to its spawn-time model would read as the
 * agent changing the model on its own.
 */
export function restartParams(session: RestartableSession): NewSessionRequest {
  const originalParams = session.creationParams ?? { cwd: session.cwd, mcpServers: [] };
  const originalMeta = originalParams._meta as
    ({ claudeCode?: { options?: Options } } & Record<string, unknown>) | undefined;
  const originalOptions = originalMeta?.claudeCode?.options;
  const unmanagedOptions = { ...(originalOptions ?? {}) };
  delete unmanagedOptions.model;
  delete unmanagedOptions.agent;
  delete unmanagedOptions.effort;

  return {
    ...originalParams,
    _meta: {
      ...(originalMeta ?? {}),
      claudeCode: {
        ...(originalMeta?.claudeCode ?? {}),
        options: {
          ...unmanagedOptions,
          ...(session.models.currentModelId !== DEFAULT_MODEL_ID
            ? { model: session.models.currentModelId }
            : {}),
          ...(session.currentAgent !== DEFAULT_AGENT_ID ? { agent: session.currentAgent } : {}),
          ...(session.effortPinnedLevel !== undefined
            ? { effort: session.effortPinnedLevel as EffortLevel }
            : {}),
        },
      },
    },
  };
}
