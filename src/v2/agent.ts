/**
 * The experimental draft ACP v2 surface of the adapter.
 *
 * `ClaudeAcpAgent` speaks ACP v1 types. This surface translates each v2
 * request into the v1 request that the agent serves, and each v1 message that
 * the agent sends into its v2 form, so v1 and v2 share one implementation.
 * Where the versions differ, it maps the agent's own types instead: a prompt
 * is served through the agent's turn events (see `prompt.ts`).
 */
import type {
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
} from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { ClaudeAcpAgent, type AcpClient, type Logger } from "../acp-agent.js";
import type { AcpSessionNotification } from "../acp-subagents.js";
import { v1InitializeRequest, v2InitializeResponse } from "./initialize.js";
import { v2Prompt } from "./prompt.js";
import {
  v1NewSessionRequest,
  v1ResumeSessionRequest,
  v1SetSessionConfigOptionRequest,
  v2ConfigOptions,
  v2NewSessionResponse,
  v2ResumeSessionResponse,
} from "./session.js";
import { v2SessionUpdate } from "./session-update.js";

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
  let client!: V2ClientConnection;
  return v2
    .agent({ name: "claude-code-acp" })
    .onConnect((connection) => {
      client = new V2ClientConnection(connection.client, logger ?? console);
      agent = new ClaudeAcpAgent(client, logger);
      onAgent(agent);
    })
    .onRequest(v2.methods.agent.initialize, async ({ params }) =>
      v2InitializeResponse(await agent.initialize(v1InitializeRequest(params))),
    )
    .onRequest(v2.methods.agent.auth.login, ({ params }) => agent.authenticate(params))
    .onRequest(v2.methods.agent.auth.logout, ({ params }) => agent.logout(params))
    .onRequest(v2.methods.agent.session.new, async ({ params }) =>
      v2NewSessionResponse(await agent.newSession(v1NewSessionRequest(params))),
    )
    .onRequest(v2.methods.agent.session.list, ({ params }) => agent.listSessions(params))
    .onRequest(v2.methods.agent.session.resume, async ({ params }) =>
      v2ResumeSessionResponse(await agent.resumeSession(v1ResumeSessionRequest(params))),
    )
    .onRequest(v2.methods.agent.session.close, ({ params }) => agent.closeSession(params))
    .onRequest(v2.methods.agent.session.delete, ({ params }) => agent.deleteSession(params))
    .onRequest(v2.methods.agent.session.setConfigOption, async ({ params }) => {
      const { configOptions, ...response } = await agent.setSessionConfigOption(
        v1SetSessionConfigOptionRequest(params),
      );
      return { ...response, configOptions: v2ConfigOptions(configOptions) };
    })
    .onRequest(v2.methods.agent.session.prompt, ({ params }) =>
      v2Prompt(agent, params, (update) => {
        void client.send({ sessionId: params.sessionId, update });
      }),
    )
    .onNotification(v2.methods.agent.session.cancel, ({ params }) => agent.cancel(params));
}

/**
 * The {@link AcpClient} of an ACP v2 connection: it sends the v1 messages of
 * the agent as v2 messages.
 *
 * Permission requests still reject until the v2 surface translates them.
 */
class V2ClientConnection implements AcpClient {
  constructor(
    private readonly ctx: v2.AgentContext,
    private readonly logger: Logger,
  ) {}

  /**
   * Sends a v2 session update, and logs rather than rejects when that fails.
   * It and {@link sessionUpdate} hand updates to the connection synchronously,
   * so they go out in the order of the calls. The agent's consumer awaits each
   * of its updates before it reports the next turn event, so a turn's state
   * follows the output that came before it. (An update the consumer is still
   * routing can be overtaken by an event from elsewhere, such as a permission
   * request opening.)
   */
  send(notification: v2.UpdateSessionNotification): Promise<void> {
    return this.ctx.notify(v2.methods.client.session.update, notification).catch((error) => {
      this.logger.error(`Failed to send a ${notification.update.sessionUpdate} update:`, error);
    });
  }

  extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    if (!isExtensionMethod(method)) {
      return Promise.reject(new Error(`${method} is not an ACP extension method`));
    }
    return this.ctx.notify(method, params);
  }

  async sessionUpdate({ update, ...notification }: AcpSessionNotification): Promise<void> {
    const v2Update = v2SessionUpdate(update);
    if (v2Update) {
      await this.ctx.notify(v2.methods.client.session.update, {
        ...notification,
        update: v2Update,
      });
    }
  }

  requestPermission(): Promise<never> {
    return Promise.reject(
      new Error("The ACP v2 surface does not serve session/request_permission yet"),
    );
  }

  // Elicitation is the same in v1 and v2.
  createElicitation(
    params: CreateElicitationRequest,
    signal?: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    return this.ctx.request(
      v2.methods.client.elicitation.create,
      // The v1 types accept a property schema with any tag; the v2 types accept
      // one only in a received value. As on v1, an MCP server's schema is
      // relayed here unchanged, so this cast does not check it.
      params as v2.CreateElicitationRequest,
      { cancellationSignal: signal },
    );
  }

  completeElicitation(params: CompleteElicitationNotification): Promise<void> {
    return this.ctx.notify(v2.methods.client.elicitation.complete, params);
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
