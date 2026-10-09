import {
  RUNTIME_READ_METHOD,
  RUNTIME_CONTROL_METHOD,
  parseRuntimeReadRequest,
  parseRuntimeControlRequest,
  type RuntimeReadRequest,
  type RuntimeControlRequest,
  type RuntimeResponse,
} from "../desktop-runtime.js";
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
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { ClaudeAcpAgent, type AcpClient, type Logger } from "../acp-agent.js";
import type { AcpSessionNotification } from "../acp-subagents.js";
import type { AcpPermissionRequest } from "../permissions/presentation.js";
import { v1InitializeRequest, v2InitializeResponse } from "./initialize.js";
import { v1PermissionResponse, v2PermissionRequest } from "./permission.js";
import { v2Prompt } from "./prompt.js";
import {
  v1ForkSessionRequests,
  v1NewSessionRequest,
  v1RestoreSessionRequest,
  v1SetSessionConfigOptionRequest,
  v2ConfigOptions,
  v2NewSessionResponse,
  v2ResumeSessionResponse,
} from "./session.js";
import { v2SessionUpdate } from "./session-update.js";
import { V2Terminals } from "./terminal.js";

/**
 * The ACP v2 surface, for one connection.
 *
 * As in `v1AgentApp`, the agent of the connection is created when the
 * connection opens, before the connection processes any inbound message.
 * `onAgent` receives it for the owner of the process (shutdown).
 *
 * The provider methods pass through: their types are the same in v1 and v2.
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
      agent = new ClaudeAcpAgent(client, logger, { v2: true });
      onAgent(agent);
    })
    .onRequest(v2.methods.agent.initialize, async ({ params }) =>
      v2InitializeResponse(await agent.initialize(v1InitializeRequest(params))),
    )
    .onRequest<RuntimeReadRequest, RuntimeResponse>(
      RUNTIME_READ_METHOD,
      { parse: parseRuntimeReadRequest },
      (ctx) => agent.readSessionRuntime(ctx.params, ctx.signal),
    )
    .onRequest<RuntimeControlRequest, RuntimeResponse>(
      RUNTIME_CONTROL_METHOD,
      { parse: parseRuntimeControlRequest },
      (ctx) => agent.controlSessionRuntime(ctx.params, ctx.signal),
    )
    .onRequest(v2.methods.agent.auth.login, ({ params }) => agent.authenticate(params))
    .onRequest(v2.methods.agent.auth.logout, ({ params }) => agent.logout(params))
    .onRequest(v2.methods.agent.providers.list, ({ params }) =>
      agent.unstable_listProviders(params),
    )
    .onRequest(v2.methods.agent.providers.set, ({ params }) => agent.unstable_setProvider(params))
    .onRequest(v2.methods.agent.providers.disable, ({ params }) =>
      agent.unstable_disableProvider(params),
    )
    .onRequest(v2.methods.agent.session.new, async ({ params }) =>
      v2NewSessionResponse(await agent.newSession(v1NewSessionRequest(params))),
    )
    .onRequest(v2.methods.agent.session.list, ({ params }) => agent.listSessions(params))
    .onRequest(v2.methods.agent.session.resume, async ({ params }) => {
      const restore = v1RestoreSessionRequest(params);
      return v2ResumeSessionResponse(
        restore.method === "resume"
          ? await agent.resumeSession(restore.request)
          : await client.replaying(params.sessionId, () => agent.loadSession(restore.request)),
      );
    })
    .onRequest(v2.methods.agent.session.fork, async ({ params }) => {
      const requests = v1ForkSessionRequests(params);
      const { sessionId } = await agent.unstable_forkSession(requests.fork);
      return {
        sessionId,
        ...v2ResumeSessionResponse(await agent.resumeSession(requests.resume(sessionId))),
      };
    })
    .onRequest(v2.methods.agent.session.close, async ({ params }) => {
      const response = await agent.closeSession(params);
      client.terminals.forget(params.sessionId);
      return response;
    })
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
 */
class V2ClientConnection implements AcpClient {
  /**
   * The sessions whose history replays, each with the messages that the
   * replay has cleared so far.
   */
  private readonly replays = new Map<string, Set<string>>();

  /** The display terminals of the commands that the agent runs. */
  readonly terminals = new V2Terminals();

  constructor(
    private readonly ctx: v2.AgentContext,
    private readonly logger: Logger,
  ) {}

  /**
   * Runs `restore`, which replays the history of `sessionId`.
   *
   * The agent replays messages as chunks. A v2 client may still hold a
   * replayed message, and chunks append, so before the first replayed chunk of
   * each message the client gets the message with no content, which clears it,
   * as v2 requires of a message replayed as chunks.
   */
  async replaying<T>(sessionId: string, restore: () => Promise<T>): Promise<T> {
    this.replays.set(sessionId, new Set());
    try {
      return await restore();
    } finally {
      this.replays.delete(sessionId);
    }
  }

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
    const updates = this.v2Updates(notification.sessionId, update).flatMap((v2Update) => {
      const clear = this.replayClear(notification.sessionId, v2Update);
      return clear ? [clear, v2Update] : [v2Update];
    });
    // Every update goes to the connection before any is awaited, so an update
    // that another call sends meanwhile cannot come between them.
    await Promise.all(
      updates.map((v2Update) =>
        this.ctx.notify(v2.methods.client.session.update, { ...notification, update: v2Update }),
      ),
    );
  }

  /**
   * The v2 updates of a v1 update: for a tool call report, the updates of its
   * terminal first, then the report itself (see {@link V2Terminals}).
   */
  private v2Updates(
    sessionId: string,
    update: AcpSessionNotification["update"],
  ): v2.SessionUpdate[] {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      const v2Update = v2SessionUpdate(update);
      return v2Update ? [v2Update] : [];
    }
    const { terminal, report } = this.terminals.split(sessionId, update);
    const reportUpdate = report && v2SessionUpdate(report);
    return [...terminal, ...(reportUpdate ? [reportUpdate] : [])];
  }

  /**
   * The update that clears the message of a replayed chunk, when it is the
   * first replayed chunk of that message (see {@link replaying}).
   */
  private replayClear(sessionId: string, update: v2.SessionUpdate): v2.SessionUpdate | undefined {
    const cleared = this.replays.get(sessionId);
    if (!cleared) return undefined;
    const kind = MESSAGE_OF_CHUNK.get(update.sessionUpdate);
    if (!kind) return undefined;
    const { messageId } = update as { messageId: string };
    const key = `${kind} ${messageId}`;
    if (cleared.has(key)) return undefined;
    cleared.add(key);
    return emptyMessage(kind, messageId);
  }

  async requestPermission(
    params: AcpPermissionRequest,
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    const response = await this.ctx.request(
      v2.methods.client.session.requestPermission,
      v2PermissionRequest(params),
      { cancellationSignal: signal },
    );
    return v1PermissionResponse(response);
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

/** The message update of each message chunk. */
const MESSAGE_OF_CHUNK = new Map<string, "user_message" | "agent_message" | "agent_thought">([
  ["user_message_chunk", "user_message"],
  ["agent_message_chunk", "agent_message"],
  ["agent_thought_chunk", "agent_thought"],
]);

function emptyMessage(
  kind: "user_message" | "agent_message" | "agent_thought",
  messageId: string,
): v2.SessionUpdate {
  const message = { messageId, content: [] };
  switch (kind) {
    case "user_message":
      return { ...message, sessionUpdate: kind };
    case "agent_message":
      return { ...message, sessionUpdate: kind };
    default:
      return { ...message, sessionUpdate: kind };
  }
}

function isExtensionMethod(method: string): method is v2.ExtensionMethod {
  return method.startsWith("_");
}
