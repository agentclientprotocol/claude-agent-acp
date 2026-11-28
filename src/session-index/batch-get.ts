/** The negotiation and handler of `_session/batch_get`, shared by ACP v1 and v2. */
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import {
  AIR_SESSION_BATCH_GET_CAPABILITY,
  AIR_SESSION_TRANSCRIPT_TEXT_CAPABILITY,
  clientSupportsAirCapability,
} from "../air-extension.js";
import type { OwnSessionState } from "./activity.js";
import {
  SESSION_BATCH_GET_METHOD,
  type BatchGetSessionsRequest,
  type BatchGetSessionsResponse,
  type SessionIndexService,
} from "./service.js";

export class SessionBatchGetConnection {
  private clientAdvertisedTranscriptText = false;

  constructor(
    private readonly service: () => SessionIndexService | undefined,
    private readonly own: (sessionId: string) => OwnSessionState | undefined,
  ) {}

  negotiate(capabilities: unknown): void {
    this.clientAdvertisedTranscriptText = clientSupportsAirCapability(
      capabilities,
      AIR_SESSION_TRANSCRIPT_TEXT_CAPABILITY,
    );
  }

  get transcriptText(): boolean {
    return this.clientAdvertisedTranscriptText;
  }

  capabilities(): string[] {
    return this.service()
      ? [
          AIR_SESSION_BATCH_GET_CAPABILITY,
          ...(this.transcriptText ? [AIR_SESSION_TRANSCRIPT_TEXT_CAPABILITY] : []),
        ]
      : [];
  }

  batchGet(
    params: BatchGetSessionsRequest,
    signal?: AbortSignal,
  ): Promise<BatchGetSessionsResponse> {
    const service = this.service();
    if (!service) throw RequestError.methodNotFound(SESSION_BATCH_GET_METHOD);
    if (params.transcriptText && !this.transcriptText) {
      throw RequestError.invalidParams(
        undefined,
        "Declare sessionTranscriptText in initialize first",
      );
    }
    return service.batchGet(params, this.own, signal);
  }
}
