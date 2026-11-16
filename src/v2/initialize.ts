/**
 * What the ACP v2 `initialize` response advertises: the session capabilities,
 * and the v2 form of the auth methods, which the shared auth modules build in
 * v1 terms (`auth-methods.ts`).
 */
import type { AuthMethod } from "@agentclientprotocol/sdk/unstable";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { SYSTEM_PROMPT_CAPABILITY } from "../client-system-prompt.js";
import { SESSION_OPTIONS_CAPABILITY } from "../initial-config-options.js";
import { SESSION_STATUS_CAPABILITY } from "../session-status.js";

/**
 * The session capabilities that the v2 core serves.
 *
 * - The session baseline: `session/new`, `list`, `resume` (with replay),
 *   `close`, `prompt`, `cancel`, and `update`.
 * - `session/delete`, `session/fork` (which returns a session the client can
 *   prompt at once), and `additionalDirectories`.
 * - The prompt content and MCP transports that the v1 `initialize` lists too:
 *   images, embedded context, and HTTP servers. v2 has no SSE transport.
 * - `systemPrompt`, in `append` and `override` mode.
 * - `session/status` (unstable), with the foreground state of an open session.
 * - `session/options` (unstable), and `configOptions` on `session/new` and
 *   `session/resume`.
 */
export const V2_SESSION_CAPABILITIES: v2.SessionCapabilities = {
  prompt: { image: {}, embeddedContext: {} },
  mcp: { stdio: {}, http: {} },
  delete: {},
  fork: {},
  additionalDirectories: {},
  systemPrompt: SYSTEM_PROMPT_CAPABILITY,
  status: SESSION_STATUS_CAPABILITY,
  options: SESSION_OPTIONS_CAPABILITY,
  // `session/set_title`.
  title: {},
};

/** v2 names the id of a method `methodId`, requires `type`, and lists `env` as name and value pairs. */
export function v2AuthMethod(method: AuthMethod): v2.AuthMethod {
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
