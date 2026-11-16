/**
 * Embedded `resource` prompt blocks whose resource is a base64 `blob`, and the
 * Claude content each supported MIME type becomes.
 */
import type { BlobResourceContents } from "@agentclientprotocol/sdk/unstable";

/** Image types the Messages API accepts as a base64 `image` block. */
const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

/** Non-`text/*` types whose bytes are text, e.g. a `.json` or `.ts` file. */
const TEXT_APPLICATION_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/x-sh",
  "application/sql",
  "application/graphql",
]);

export type BlobResourceContent =
  | {
      kind: "image";
      block: {
        type: "image";
        source: { type: "base64"; media_type: ImageMimeType; data: string };
      };
    }
  | {
      kind: "document";
      block: {
        type: "document";
        source: { type: "base64"; media_type: "application/pdf"; data: string };
      };
    }
  /** The decoded text, to send like a text resource. */
  | { kind: "text"; text: string };

/**
 * The MIME type without parameters or case, e.g. `text/plain; charset=utf-8` ->
 * `text/plain`. `image/jpg`, which some clients send, becomes `image/jpeg`.
 */
function baseMimeType(mimeType: string | null | undefined): string | undefined {
  const base = mimeType?.split(";")[0].trim().toLowerCase();
  if (base === "image/jpg") return "image/jpeg";
  return base || undefined;
}

/**
 * Decodes a text blob with the `charset` parameter of its MIME type, e.g.
 * `text/csv; charset=iso-8859-1`, and UTF-8 when there is none or the label is
 * unknown. A leading byte order mark is dropped.
 */
function decodeText(blob: string, mimeType: string | null | undefined): string {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(mimeType ?? "")?.[1];
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset ?? "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(Buffer.from(blob, "base64"));
}

function isImageMimeType(mimeType: string): mimeType is ImageMimeType {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    TEXT_APPLICATION_MIME_TYPES.has(mimeType) ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml")
  );
}

/**
 * Whether {@link blobResourceToClaude} can send a blob of this MIME type. A blob
 * without a MIME type is not supported: its bytes could be anything.
 */
export function isSupportedBlobMimeType(mimeType: string | null | undefined): boolean {
  const base = baseMimeType(mimeType);
  if (!base) return false;
  return isImageMimeType(base) || base === "application/pdf" || isTextMimeType(base);
}

/**
 * The Claude content for a blob resource: an `image` block for PNG, JPEG, GIF
 * and WebP, a `document` block for PDF, and the decoded text for text
 * types such as `text/markdown` or `application/json`. Returns `undefined` for
 * any other type, e.g. `application/zip`.
 */
export function blobResourceToClaude(
  resource: BlobResourceContents,
): BlobResourceContent | undefined {
  const mimeType = baseMimeType(resource.mimeType);
  if (!mimeType) return undefined;
  if (isImageMimeType(mimeType)) {
    return {
      kind: "image",
      block: {
        type: "image",
        source: { type: "base64", media_type: mimeType, data: resource.blob },
      },
    };
  }
  if (mimeType === "application/pdf") {
    return {
      kind: "document",
      block: {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: resource.blob },
      },
    };
  }
  if (isTextMimeType(mimeType)) {
    return { kind: "text", text: decodeText(resource.blob, resource.mimeType) };
  }
  return undefined;
}
