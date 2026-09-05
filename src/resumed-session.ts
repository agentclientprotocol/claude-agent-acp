import { getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { SessionTiming } from "./session-timing.js";

type ResumeLogger = {
  log: (...args: unknown[]) => void;
};

/** Return the concrete model recorded by the last real assistant response.
 * Claude Code restores a resumed query from this same transcript field.
 * Synthetic assistant records use angle-bracket placeholders and do not
 * describe a model the resumed query can run. */
export function resumedModelFromTranscript(messages: SessionMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const entry = messages[index];
    if (entry?.type !== "assistant" || !entry.message || typeof entry.message !== "object") {
      continue;
    }
    const model = (entry.message as { model?: unknown }).model;
    if (typeof model === "string" && model.trim().length > 0 && !/^<[^>]+>$/.test(model.trim())) {
      return model.trim();
    }
  }
  return undefined;
}

/** Read the resume model from the local transcript without starting a Claude
 * control request. This is intentionally on the load critical path. */
export async function readResumedModelHint(
  sessionId: string,
  cwd: string,
  logger?: ResumeLogger,
): Promise<string | undefined> {
  const timing = new SessionTiming(logger, "models", sessionId);
  const messages = await getSessionMessages(sessionId, { dir: cwd });
  const model = resumedModelFromTranscript(messages);
  timing.phase("read-transcript", ` messages=${messages.length} model=${model ?? "unknown"}`);
  return model;
}
