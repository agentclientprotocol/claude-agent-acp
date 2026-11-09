import {
  AgentContext,
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
import { AcpSessionNotification, asSdkSessionNotification } from "./acp-subagents.js";
import { type AcpPermissionRequest } from "./permissions/presentation.js";
import { ChangedMetaFilter } from "./tool-calls/changed-meta-filter.js";

/**
 * Logger interface for customizing logging output
 */
export interface Logger {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
  /** Optional: a caller that supplies no `warn` gets its warnings on `error`. */
  warn?: (...args: any[]) => void;
}

/**
 * Client-facing surface the agent calls back into. This is the subset of ACP
 * client methods the agent actually uses, expressed as a narrow interface so
 * tests can supply lightweight mocks. In production it is backed by
 * {@link ClientConnection} over the SDK's typed `AgentContext`.
 */
export interface AcpClient {
  sessionUpdate(params: AcpSessionNotification): Promise<void>;
  /** `signal`, when aborted, sends `$/cancel_request` for the in-flight
   *  permission request so the client can dismiss its prompt, and rejects the
   *  call at once: a client that ignores the cancel never answers. */
  requestPermission(
    params: AcpPermissionRequest,
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse>;
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
  /** `signal`, when aborted, sends `$/cancel_request` for the in-flight
   *  elicitation so the client can dismiss its prompt, and rejects the call
   *  at once, as {@link requestPermission} does. */
  createElicitation(
    params: CreateElicitationRequest,
    signal?: AbortSignal,
  ): Promise<CreateElicitationResponse>;
  completeElicitation(params: CompleteElicitationNotification): Promise<void>;
  /** Send a custom (extension) notification, e.g. `_claude/sdkMessage`. */
  extNotification(method: string, params: Record<string, unknown>): Promise<void>;
}

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

  extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    return this.inner.extNotification(method, params);
  }
}
