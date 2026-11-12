import {
  AgentContext,
  AuthStatusUpdateNotification,
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
  methods,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk/unstable";
import type { AcpClient } from "../acp-client.js";
import { AcpSessionNotification, asSdkSessionNotification } from "../acp-subagents.js";
import { ChangedMetaFilter } from "./tool-calls/changed-meta-filter.js";
import type { AcpPermissionRequest } from "../permissions/presentation.js";

/**
 * Bridges {@link AcpClient} to the connection-scoped {@link AgentContext}
 * exposed by `AgentApp.connect(...)` as `connection.client`. The peer handle is
 * valid for the entire connection lifetime, so it is captured once at
 * construction.
 */
export class ClientConnection implements AcpClient {
  constructor(private readonly ctx: AgentContext) {}

  sessionUpdate(params: AcpSessionNotification): Promise<void> {
    return this.ctx.notify(methods.client.session.update, asSdkSessionNotification(params));
  }

  requestPermission(
    params: RequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    return this.ctx.request(methods.client.session.requestPermission, params, {
      cancellationSignal: signal,
      stopWaitingOnCancel: true,
    });
  }

  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return this.ctx.request(methods.client.fs.readTextFile, params);
  }

  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return this.ctx.request(methods.client.fs.writeTextFile, params);
  }

  createElicitation(
    params: CreateElicitationRequest,
    signal?: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    return this.ctx.request(methods.client.elicitation.create, params, {
      cancellationSignal: signal,
      stopWaitingOnCancel: true,
    });
  }

  completeElicitation(params: CompleteElicitationNotification): Promise<void> {
    return this.ctx.notify(methods.client.elicitation.complete, params);
  }

  authStatusUpdate(params: AuthStatusUpdateNotification): Promise<void> {
    return this.ctx.notify(methods.client.auth.statusUpdate, params);
  }

  extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    return this.ctx.notify(method, params);
  }
}

/**
 * The client that the agent talks to. For an AIR client, every session update
 * passes the {@link ChangedMetaFilter} last, after the native subagent routing,
 * so a `tool_call_update` carries only the `_meta` keys that changed. ACP
 * merges only the top-level tool call fields, not the `_meta` keys. So another
 * client gets the full `_meta` on each update.
 */
export class ChangedMetaClient implements AcpClient {
  private readonly filter = new ChangedMetaFilter();

  constructor(
    private readonly inner: AcpClient,
    private readonly airClient: () => boolean,
  ) {}

  async sessionUpdate(params: AcpSessionNotification): Promise<void> {
    if (!this.airClient()) return this.inner.sessionUpdate(params);
    const update = this.filter.apply(params.update as SessionNotification["update"]);
    if (update) await this.inner.sessionUpdate({ ...params, update } as AcpSessionNotification);
  }

  requestPermission(
    params: AcpPermissionRequest,
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    return this.inner.requestPermission(params, signal);
  }

  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return this.inner.readTextFile(params);
  }

  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return this.inner.writeTextFile(params);
  }

  createElicitation(
    params: CreateElicitationRequest,
    signal?: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    return this.inner.createElicitation(params, signal);
  }

  completeElicitation(params: CompleteElicitationNotification): Promise<void> {
    return this.inner.completeElicitation(params);
  }

  authStatusUpdate(params: AuthStatusUpdateNotification): Promise<void> {
    return this.inner.authStatusUpdate(params);
  }

  extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    return this.inner.extNotification(method, params);
  }
}
