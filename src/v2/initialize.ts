/**
 * The ACP v2 `initialize` handshake, expressed through the v1 handshake of
 * `ClaudeAcpAgent`.
 *
 * The agent decides its capabilities and auth methods in v1 terms. The v2
 * request becomes the v1 request that the agent reads, and the v1 response of
 * the agent becomes the v2 response, so both protocol versions advertise from
 * one source.
 */
import {
  PROTOCOL_VERSION as V1_PROTOCOL_VERSION,
  type AuthMethod,
  type InitializeRequest,
  type InitializeResponse,
} from "@agentclientprotocol/sdk/unstable";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { AIR_ASYNC_TASKS_CAPABILITY, AIR_GOAL_KEY } from "../air-extension.js";
import { SYSTEM_PROMPT_CAPABILITY } from "../client-system-prompt.js";

/** The v1 `initialize` request that a v2 client means. */
export function v1InitializeRequest(request: v2.InitializeRequest): InitializeRequest {
  const capabilities = request.capabilities;
  return {
    protocolVersion: V1_PROTOCOL_VERSION,
    clientInfo: request.info,
    clientCapabilities: {
      // v2 has no client file system and no client terminals: the agent
      // reads, writes, and runs commands itself.
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      // Every v2 client handles boolean config options, notices, and
      // compaction updates; v1 asks for a marker. With them, the agent reports
      // advisories as notices rather than as transcript messages, and a
      // compaction as a compaction entity rather than as a "Compact
      // conversation" tool call, also on replay.
      session: { configOptions: { boolean: {} }, notices: {}, compaction: {} },
      // Every v2 client takes `plan_update`, with the draft's markdown and file
      // plans, and `plan_removed`; v1 asks for the `plan` marker. With it, the
      // agent shows an approved ExitPlanMode plan as a markdown plan.
      plan: {},
      // Subagent updates are part of v2's baseline session model (the subagents
      // RFD), so every v2 client takes them; v1 asks for the `subagents`
      // capability. With it, the agent reports each Agent or Task subagent as a
      // child session.
      subagents: {},
      // v1 marks terminal auth support with a boolean, v2 with an object.
      auth: {
        terminal: capabilities?.auth?.terminal != null,
        ...(capabilities?.auth?._meta != null ? { _meta: capabilities.auth._meta } : {}),
      },
      ...(capabilities?.elicitation != null ? { elicitation: capabilities.elicitation } : {}),
      ...(capabilities?._meta != null ? { _meta: capabilities._meta } : {}),
    },
    ...(request._meta != null ? { _meta: request._meta } : {}),
  };
}

/**
 * The v2 `initialize` response for the v1 response of the agent.
 *
 * It keeps the top-level `_meta` of the v1 response, which advertises
 * `_session/steering` as `_meta.steering`: the v2 surface serves it too. It
 * does not advertise the AIR extensions the v2 surface does not serve yet, of
 * {@link withoutUnservedAirExtensions}.
 */
export function v2InitializeResponse(response: InitializeResponse): v2.InitializeResponse {
  if (!response.agentInfo) {
    throw new Error("ACP v2 requires agentInfo, and the agent reported none");
  }
  const meta = response.agentCapabilities?._meta;
  const topMeta = withoutUnservedAirExtensions({ ...(response._meta ?? {}) });
  return {
    protocolVersion: v2.PROTOCOL_VERSION,
    info: response.agentInfo,
    // v1 `auth.logout` has no v2 counterpart: a v2 agent that advertises auth
    // methods must serve `auth/logout`.
    capabilities: {
      session: V2_SESSION_CAPABILITIES,
      // `providers/list`, `set`, and `disable`, which the agent serves for
      // every client.
      providers: {},
      ...(meta != null ? { _meta: meta } : {}),
    },
    authMethods: (response.authMethods ?? []).map(v2AuthMethod),
    ...(Object.keys(topMeta).length > 0 ? { _meta: topMeta } : {}),
  };
}

/**
 * `meta` without the AIR extensions whose methods the v2 surface does not
 * register: the `asyncTasks` capability (`_session/async_task/stop`) and the
 * `goal` entry (`_session/goal`) of `_meta.jetbrains.air`.
 */
function withoutUnservedAirExtensions(meta: Record<string, unknown>): Record<string, unknown> {
  const jetbrains = asRecord(meta.jetbrains);
  const air = asRecord(jetbrains.air);
  if (Object.keys(air).length === 0) return meta;
  const served = Object.fromEntries(Object.entries(air).filter(([key]) => key !== AIR_GOAL_KEY));
  if (Array.isArray(served.capabilities)) {
    served.capabilities = served.capabilities.filter(
      (capability) => capability !== AIR_ASYNC_TASKS_CAPABILITY,
    );
  }
  return { ...meta, jetbrains: { ...jetbrains, air: served } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The session capabilities of the v2 surface, which serves each through a v1
 * method of the agent.
 *
 * - The session baseline: `session/new`, `list`, `resume` (with replay),
 *   `close`, `prompt`, `cancel`, and `update`.
 * - `session/delete`, `session/fork` (which returns a session the client can
 *   prompt at once), and `additionalDirectories`.
 * - The prompt content and MCP transports that the agent's v1 `initialize`
 *   lists: images, embedded context, and HTTP servers. Stdio servers are in the
 *   v1 baseline; v2 has no SSE transport.
 * - `systemPrompt`, in `append` and `override` mode.
 */
export const V2_SESSION_CAPABILITIES: v2.SessionCapabilities = {
  prompt: { image: {}, embeddedContext: {} },
  mcp: { stdio: {}, http: {} },
  delete: {},
  fork: {},
  additionalDirectories: {},
  systemPrompt: SYSTEM_PROMPT_CAPABILITY,
};

/** v2 names the id of a method `methodId`, requires `type`, and lists `env` as name and value pairs. */
function v2AuthMethod(method: AuthMethod): v2.AuthMethod {
  if ("type" in method && method.type === "terminal") {
    const { id, env, ...terminal } = method;
    return {
      ...terminal,
      methodId: id,
      ...(env ? { env: Object.entries(env).map(([name, value]) => ({ name, value })) } : {}),
    };
  }
  const { id, ...agent } = method;
  return { ...agent, methodId: id, type: "agent" };
}
