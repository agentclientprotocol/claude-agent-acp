/**
 * The text and thinking of an assistant message that streamed live as
 * deltas, and what its consolidated message adds to them. Shared by the v1
 * core and the native v2 core.
 */
import type { SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";

/** Text or thinking that streamed live as deltas, accumulated per block. */
export type StreamedBlock = { index: number; type: "text" | "thinking"; text: string };

/**
 * Records the text or thinking that `event` streamed in `streamedBlocks`.
 * Contiguous deltas of the same block (same index and type) extend the
 * current entry; anything else opens a new one. Other events change nothing.
 */
export function recordStreamedDelta(
  streamedBlocks: StreamedBlock[],
  event: SDKPartialAssistantMessage["event"],
): void {
  if (event.type !== "content_block_delta") return;
  const delta = event.delta;
  const chunk =
    delta.type === "text_delta"
      ? { type: "text" as const, text: delta.text }
      : delta.type === "thinking_delta"
        ? { type: "thinking" as const, text: delta.thinking }
        : undefined;
  // Skip empty deltas (some gateways emit empty thinking chunks — #793):
  // appending "" is a no-op, but pushing a "" entry would create a block the
  // `text.length > 0` guard of `unstreamedRemainder` can never consume,
  // stalling the diff cursor and re-emitting the next block as a duplicate.
  if (!chunk?.text) return;
  const last = streamedBlocks[streamedBlocks.length - 1];
  if (last && last.index === event.index && last.type === chunk.type) {
    last.text += chunk.text;
  } else {
    streamedBlocks.push({ index: event.index, type: chunk.type, text: chunk.text });
  }
}

/**
 * The blocks of a consolidated assistant message without the text that
 * already streamed as deltas.
 *
 * Each assembled text/thinking block is diffed against the streamed blocks in
 * document order: nothing is left if it streamed in full (the common case),
 * the whole block if it never streamed (a non-streaming gateway), and just the
 * tail if the stream was cut short mid-block. Matching on content rather than
 * the message id keeps the dedupe robust for gateways without a stable id.
 * Tool-use and other blocks pass through untouched.
 */
export function unstreamedRemainder<Block extends { type: string }>(
  blocks: Block[],
  streamedBlocks: StreamedBlock[],
): Block[] {
  const kept: Block[] = [];
  let streamPos = 0;
  for (const item of blocks) {
    if (item.type !== "text" && item.type !== "thinking") {
      kept.push(item);
      continue;
    }
    const block = item as Block & { text?: string; thinking?: string };
    const full = (item.type === "text" ? block.text : block.thinking) ?? "";
    // Empty assembled blocks carry nothing: drop them.
    if (full.length === 0) continue;
    // A streamed block of the same type whose text is a prefix of this one
    // was already delivered, at least partly. A non-empty streamed text is
    // required so an empty or aborted streamed block does not swallow it.
    const streamed = streamedBlocks[streamPos];
    if (
      streamed &&
      streamed.type === item.type &&
      streamed.text.length > 0 &&
      full.startsWith(streamed.text)
    ) {
      streamPos++;
      const remainder = full.slice(streamed.text.length);
      if (remainder.length === 0) continue;
      kept.push({ ...item, [item.type === "text" ? "text" : "thinking"]: remainder });
      continue;
    }
    kept.push(item);
  }
  return kept;
}
