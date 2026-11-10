import { CreateElicitationRequest } from "@agentclientprotocol/sdk/unstable";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
  AIR_CUSTOM_ANSWER_FIELDS_KEY,
  AIR_CUSTOM_ANSWER_KEY,
  LEGACY_AIR_CUSTOM_ANSWER_KEY,
  airExtensionMeta,
  withAirMeta,
} from "../air-extension.js";

/** Copies companion keys for AIR clients whose Kotlin v2 property models omit `_meta`. */
export function v2ElicitationRequest(
  request: CreateElicitationRequest,
): v2.CreateElicitationRequest {
  if (!CreateElicitationRequest.isForm(request)) return request as v2.CreateElicitationRequest;
  const fields = Object.entries(request.requestedSchema.properties ?? {})
    .filter(([, property]) => isCustomAnswer(property._meta))
    .map(([key]) => key);
  if (fields.length === 0) return request as v2.CreateElicitationRequest;
  return {
    ...request,
    _meta: withAirMeta(request._meta, AIR_CUSTOM_ANSWER_FIELDS_KEY, fields),
  } as v2.CreateElicitationRequest;
}

function isCustomAnswer(meta: unknown): boolean {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return false;
  const marker =
    airExtensionMeta(meta)?.[AIR_CUSTOM_ANSWER_KEY] ??
    (meta as Record<string, unknown>)[LEGACY_AIR_CUSTOM_ANSWER_KEY];
  return (
    marker === true ||
    (marker !== null &&
      typeof marker === "object" &&
      !Array.isArray(marker) &&
      Object.keys(marker).length > 0)
  );
}
