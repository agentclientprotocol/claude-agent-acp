/**
 * The experimental draft ACP v2 surface of the adapter.
 *
 * `ClaudeAcpAgent` speaks ACP v1 types. This surface translates each v2
 * request into the v1 request that the agent serves, and each v1 message that
 * the agent sends into its v2 form, so v1 and v2 share one implementation.
 */
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { ClaudeAcpAgent, type AcpClient, type Logger } from "../acp-agent.js";
import { v1InitializeRequest, v2InitializeResponse } from "./initialize.js";

/**
 * The ACP v2 surface, for one connection.
 *
 * As in `v1AgentApp`, the agent of the connection is created when the
 * connection opens, before the connection processes any inbound message.
 * `onAgent` receives it for the owner of the process (shutdown).
 */
export function v2AgentApp(
  logger: Logger | undefined,
  onAgent: (agent: ClaudeAcpAgent) => void,
): v2.AgentApp {
  let agent!: ClaudeAcpAgent;
  return v2
    .agent({ name: "claude-code-acp" })
    .onConnect((connection) => {
      agent = new ClaudeAcpAgent(new V2ClientConnection(connection.client), logger);
      onAgent(agent);
    })
    .onRequest(v2.methods.agent.initialize, async ({ params }) =>
      v2InitializeResponse(await agent.initialize(v1InitializeRequest(params))),
    )
    .onRequest(v2.methods.agent.auth.login, ({ params }) => agent.authenticate(params))
    .onRequest(v2.methods.agent.auth.logout, ({ params }) => agent.logout(params));
}

/**
 * The {@link AcpClient} of an ACP v2 connection: it sends the v1 messages of
 * the agent as v2 messages.
 *
 * The v2 surface serves no sessions yet, so only connection-level messages
 * reach it, such as the `_auth/status_update` extension notification. Every
 * session-scoped method rejects until the v2 surface serves sessions.
 */
class V2ClientConnection implements AcpClient {
  constructor(private readonly ctx: v2.AgentContext) {}

  extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    if (!isExtensionMethod(method)) {
      return Promise.reject(new Error(`${method} is not an ACP extension method`));
    }
    return this.ctx.notify(method, params);
  }

  sessionUpdate(): Promise<void> {
    return noV2Sessions("session/update");
  }

  requestPermission(): Promise<never> {
    return noV2Sessions("session/request_permission");
  }

  createElicitation(): Promise<never> {
    return noV2Sessions("elicitation/create");
  }

  completeElicitation(): Promise<void> {
    return noV2Sessions("elicitation/complete");
  }

  // v2 has no client file system. The agent never calls these on v2, because
  // `v1InitializeRequest` reports no `fs` capability.
  readTextFile(): Promise<never> {
    return Promise.reject(new Error("ACP v2 has no client file system"));
  }

  writeTextFile(): Promise<never> {
    return Promise.reject(new Error("ACP v2 has no client file system"));
  }
}

function isExtensionMethod(method: string): method is v2.ExtensionMethod {
  return method.startsWith("_");
}

function noV2Sessions(method: string): Promise<never> {
  return Promise.reject(new Error(`The ACP v2 surface does not serve sessions yet (${method})`));
}
