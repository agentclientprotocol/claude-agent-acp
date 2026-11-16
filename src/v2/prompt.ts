/**
 * The v1 form of a v2 `session/prompt` and of its content, which the shared
 * prompt conversion (`promptToClaude`) and the system prompt take.
 */
import {
  RequestError,
  type Annotations,
  type ContentBlock,
  type PromptRequest,
  type Role,
} from "@agentclientprotocol/sdk/unstable";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { isSupportedBlobMimeType } from "../blob-resources.js";

/**
 * A v2 prompt may hold content blocks that the agent does not take: audio,
 * which it does not advertise and Claude cannot read, a custom one, or one
 * from a newer ACP version. Clients send only the kinds the agent advertised,
 * so such a block fails the request with invalid params (-32602) rather than
 * being dropped from the prompt. The same goes for an embedded blob that
 * Claude cannot read, e.g. an `application/zip` resource: `promptToClaude`
 * would drop it. An empty `prompt` fails the same way: v2 requires at least
 * one content block.
 */
export function v1PromptRequest({ prompt, ...request }: v2.PromptRequest): PromptRequest {
  if (prompt.length === 0) {
    throw RequestError.invalidParams({ prompt }, "`prompt` must hold at least one content block");
  }
  return {
    ...request,
    prompt: prompt.map((block) => {
      if (
        v2.ContentBlock.isResource(block) &&
        "blob" in block.resource &&
        !isSupportedBlobMimeType(block.resource.mimeType)
      ) {
        const mimeType = block.resource.mimeType ?? null;
        throw RequestError.invalidParams(
          { uri: block.resource.uri, mimeType },
          `Embedded blob resources of type ${mimeType ?? "unknown"} are not supported`,
        );
      }
      return v1ContentBlock(block);
    }),
  };
}

export function v1ContentBlock(block: v2.ContentBlock): ContentBlock {
  if (
    v2.ContentBlock.isText(block) ||
    v2.ContentBlock.isImage(block) ||
    v2.ContentBlock.isResourceLink(block) ||
    v2.ContentBlock.isResource(block)
  ) {
    const { annotations, ...rest } = block;
    return annotations != null ? { ...rest, annotations: v1Annotations(annotations) } : rest;
  }
  throw RequestError.invalidParams(
    { type: block.type },
    `Content blocks of type ${block.type} are not supported`,
  );
}

/**
 * v2 also accepts audiences of a newer ACP version; v1 knows two. An audience
 * of only unknown roles is dropped rather than narrowed to nobody.
 */
function v1Annotations({ audience, ...annotations }: v2.Annotations): Annotations {
  if (audience == null) return annotations;
  const known = audience.filter(isV1Role);
  return known.length > 0 || audience.length === 0
    ? { ...annotations, audience: known }
    : annotations;
}

function isV1Role(role: string): role is Role {
  return role === "assistant" || role === "user";
}
