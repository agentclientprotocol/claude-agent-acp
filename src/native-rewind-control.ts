import type { Query } from "@anthropic-ai/claude-agent-sdk";

export type NativeRewindResult = {
  rewound: boolean;
  reason?: string;
  targetMessageUuid?: string;
  prefillText?: string | null;
};

export class NativeRewindUnsupported extends Error {}
export class NativeRewindUncertain extends Error {}

/** SDK 0.3.293 has no typed conversation-rewind method. Keep this private
 * protocol dependency in one place; never fall back to a fork or a file edit. */
export async function nativeRewind(
  query: Query,
  target: string,
  lastSeen: string,
  timeoutMs = 15_000,
): Promise<NativeRewindResult> {
  const bridge = query as unknown as {
    request?: (request: Record<string, unknown>) => Promise<{ response?: unknown }>;
  };
  if (typeof bridge.request !== "function") {
    throw new NativeRewindUnsupported("This SDK does not expose the native control transport");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      bridge.request({
        subtype: "rewind_conversation",
        target_message_uuid: target,
        last_seen_user_message_uuid: lastSeen,
        interrupt_if_running: false,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new NativeRewindUncertain("Native rewind acknowledgement timed out")),
          timeoutMs,
        );
      }),
    ]);
    const result = reply.response;
    if (
      !result ||
      typeof result !== "object" ||
      !("rewound" in result) ||
      typeof result.rewound !== "boolean"
    ) {
      throw new NativeRewindUncertain("Invalid native rewind acknowledgement");
    }
    return result as NativeRewindResult;
  } catch (error) {
    if (error instanceof NativeRewindUncertain) throw error;
    if (
      error instanceof Error &&
      /Unsupported control request subtype.*rewind_conversation/.test(error.message)
    ) {
      throw new NativeRewindUnsupported(error.message);
    }
    throw new NativeRewindUncertain("Native rewind failed; reload the session before sending", {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}
