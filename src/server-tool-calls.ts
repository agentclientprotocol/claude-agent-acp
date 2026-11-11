/** A content block's `type` and, for a tool use or a tool result, the ids it carries. */
type Block = { type?: unknown; id?: unknown; tool_use_id?: unknown };

/** The stream of the main conversation, or of the subagent its Agent call ran. */
type Stream = { replyId?: string; unanswered: Map<string, string> };

/**
 * The server tool calls, such as the advisor's, that still wait for their
 * result, by the stream they belong to.
 *
 * The API runs a server tool right after its `server_tool_use`. A reply can
 * leave one pending, after a client tool_use or at `pause_turn`, and then the
 * next reply on the stream starts with its result block. So once a later reply
 * starts any other block, a call still waiting will get no result: Claude Code
 * gave up on the reply that made it, for example after its stream idle
 * timeout, and asked again.
 */
export class UnansweredServerToolCalls {
  private readonly streams = new Map<string, Stream>();

  /** A reply starts streaming on the stream of `parentToolUseId` (null for
   *  the main conversation). */
  replyStarted(parentToolUseId: string | null, replyId: string | undefined): void {
    this.streamOf(parentToolUseId).replyId = replyId;
  }

  /**
   * Takes a content block of a reply on the stream of `parentToolUseId`: of
   * `replyId` when the message says, else of the reply streaming there.
   * Returns the ids of the calls that it shows to have ended without their
   * result, which it forgets. A reply of unknown id tells nothing: its calls
   * are not followed.
   */
  take(parentToolUseId: string | null, block: unknown, replyId?: string): string[] {
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

  /** Forgets the stream of a subagent that ended. */
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
