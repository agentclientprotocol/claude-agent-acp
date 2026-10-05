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
} from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";

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
 * It does not advertise the unstable `providers` methods, which the v2
 * surface does not serve yet.
 */
export function v2InitializeResponse(response: InitializeResponse): v2.InitializeResponse {
  if (!response.agentInfo) {
    throw new Error("ACP v2 requires agentInfo, and the agent reported none");
  }
  const meta = response.agentCapabilities?._meta;
  return {
    protocolVersion: v2.PROTOCOL_VERSION,
    info: response.agentInfo,
    // v1 `auth.logout` has no v2 counterpart: a v2 agent that advertises auth
    // methods must serve `auth/logout`.
    capabilities: {
      session: V2_SESSION_CAPABILITIES,
      ...(meta != null ? { _meta: meta } : {}),
    },
    authMethods: (response.authMethods ?? []).map(v2AuthMethod),
    ...(response._meta != null ? { _meta: response._meta } : {}),
  };
}

/**
 * The session capabilities of the v2 surface, which serves each through a v1
 * method of the agent.
 *
 * - The session baseline: `session/new`, `list`, `resume` (with replay),
 *   `close`, `prompt`, `cancel`, and `update`.
 * - `session/delete` and `additionalDirectories`. Not `session/fork` yet.
 * - The prompt content and MCP transports that the agent's v1 `initialize`
 *   lists: images, embedded context, and HTTP servers. Stdio servers are in the
 *   v1 baseline; v2 has no SSE transport.
 */
const V2_SESSION_CAPABILITIES: v2.SessionCapabilities = {
  prompt: { image: {}, embeddedContext: {} },
  mcp: { stdio: {}, http: {} },
  delete: {},
  additionalDirectories: {},
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
