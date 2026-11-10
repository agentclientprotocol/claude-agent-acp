import type {
  AuthStatusUpdateNotification,
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk/unstable";
import type { AcpSessionNotification } from "./acp-subagents.js";
import type { AcpPermissionRequest } from "./permissions/presentation.js";

/**
 * Client-facing surface the agent calls back into. This is the subset of ACP
 * client methods the agent actually uses, expressed as a narrow interface so
 * tests can supply lightweight mocks. In the v1 agent it is backed by
 * `ClientConnection` (`v1/acp-agent.ts`) over the SDK's typed `AgentContext`.
 * The v2 session output passes one that only takes `sessionUpdate`
 * (`v2/stream.ts`).
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
  /** Sends `auth/status_update`: the connection's auth state changed. */
  authStatusUpdate(params: AuthStatusUpdateNotification): Promise<void>;
  /** Send a custom (extension) notification, e.g. `_claude/sdkMessage`. */
  extNotification(method: string, params: Record<string, unknown>): Promise<void>;
}
