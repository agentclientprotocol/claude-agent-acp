/** One content block of a reply. Only these fields are read. */
type Block = { type?: unknown; id?: unknown; tool_use_id?: unknown };

/** The state of one conversation: the main one, or a subagent's. */
type Stream = {
  /** The id of the reply streaming now, from its `message_start`. */
  replyId?: string;
  /** Server tool calls without a result yet: call id -> id of the reply that made the call. */
  unanswered: Map<string, string>;
};

/**
 * Finds server tool calls, such as the advisor's, that will never get a
 * result, so the caller can close them.
 *
 * The API runs a server tool itself and puts the result in Claude's reply:
 * right after the call or, if the reply ended first, at the start of the next
 * reply. So once a later reply starts with anything other than that result,
 * the call will never get one. This happens when Claude Code gives up on a
 * reply, for example after its stream idle timeout, and asks again.
 *
 * Example: reply msg_1 makes call srvtoolu_1 and goes silent. Reply msg_2
 * starts with a text block, so `observe` returns ["srvtoolu_1"].
 *
 * Each conversation is tracked on its own: the main one, and each subagent's.
 */
export class UnansweredServerToolCalls {
  private readonly streams = new Map<string, Stream>();

  /** Records that the reply `replyId` started streaming in the conversation
   *  of `parentToolUseId` (null for the main one). */
  replyStarted(parentToolUseId: string | null, replyId: string | undefined): void {
    this.streamOf(parentToolUseId).replyId = replyId;
  }

  /**
   * Records one block of a reply and returns the server tool calls it shows
   * will never get a result:
   * - a result block marks its call answered;
   * - any other block ends the calls made in earlier replies, which are
   *   returned and forgotten;
   * - a `server_tool_use` block starts tracking its call.
   *
   * `replyId` is the block's message id. Without it, the block belongs to the
   * reply that `replyStarted` last reported. If neither is known, only a
   * result block has an effect.
   */
  observe(parentToolUseId: string | null, block: unknown, replyId?: string): string[] {
    const stream = this.streamOf(parentToolUseId);
    const reply = replyId ?? stream.replyId;
    const { type, id, tool_use_id } = (block ?? {}) as Block;
    if (typeof type !== "string") return [];
    if (typeof tool_use_id === "string" && type.endsWith("tool_result")) {
      stream.unanswered.delete(tool_use_id);
      return [];
    }
    const ended =
      reply === undefined
        ? []
        : [...stream.unanswered].filter(([, madeIn]) => madeIn !== reply).map(([call]) => call);
    for (const call of ended) stream.unanswered.delete(call);
    if (type === "server_tool_use" && typeof id === "string" && reply !== undefined) {
      if (!stream.unanswered.has(id)) stream.unanswered.set(id, reply);
    }
    return ended;
  }

  /** Forgets the conversation of a subagent that ended. */
  forget(parentToolUseId: string): void {
    this.streams.delete(parentToolUseId);
  }

  private streamOf(parentToolUseId: string | null): Stream {
    const key = parentToolUseId ?? "";
    let stream = this.streams.get(key);
    if (!stream) this.streams.set(key, (stream = { unanswered: new Map() }));
    return stream;
  }
}
