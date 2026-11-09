/**
 * Session options that come from the agent's environment, shared by the v1
 * core and the native v2 core.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Options, Settings, ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";

/** Translate the legacy `MAX_THINKING_TOKENS` env var, plus the optional
 *  `CLAUDE_CODE_THINKING_DISPLAY` env var, into the SDK's `thinking` option.
 *  The `maxThinkingTokens` option it used to feed is deprecated and reduced
 *  to on/off on current models, so map the value to explicit thinking config
 *  instead: unset → `undefined` (SDK default, adaptive on models that support
 *  it) unless a display mode is requested, in which case it becomes explicit
 *  `adaptive`; `0` → disabled; a positive integer → a fixed token budget.
 *  Anything else is ignored with a warning. `CLAUDE_CODE_THINKING_DISPLAY`
 *  must be `summarized` or `omitted`; it has no effect when thinking is
 *  disabled. */
export function resolveThinkingConfig(
  rawTokens: string | undefined,
  rawDisplay: string | undefined,
  logger: { error: (...args: unknown[]) => void },
): ThinkingConfig | undefined {
  let display: "summarized" | "omitted" | undefined;
  if (rawDisplay !== undefined) {
    if (rawDisplay === "summarized" || rawDisplay === "omitted") {
      display = rawDisplay;
    } else {
      logger.error(
        `Ignoring CLAUDE_CODE_THINKING_DISPLAY: expected 'summarized' or 'omitted', got '${rawDisplay}'.`,
      );
    }
  }

  if (rawTokens === undefined) {
    return display ? { type: "adaptive", display } : undefined;
  }
  const parsed = Number.parseInt(rawTokens, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    logger.error(
      `Ignoring MAX_THINKING_TOKENS: expected a non-negative integer, got '${rawTokens}'.`,
    );
    return display ? { type: "adaptive", display } : undefined;
  }
  return parsed === 0
    ? { type: "disabled" }
    : { type: "enabled", budgetTokens: parsed, ...(display && { display }) };
}

export function parseModelConfig(
  raw: string | undefined,
): { modelOverrides?: Record<string, string>; availableModels?: string[] } | undefined {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CLAUDE_MODEL_CONFIG must be a JSON object");
  }
  const result: { modelOverrides?: Record<string, string>; availableModels?: string[] } = {};
  if (parsed.modelOverrides !== undefined) result.modelOverrides = parsed.modelOverrides;
  if (parsed.availableModels !== undefined) result.availableModels = parsed.availableModels;
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * The programmatic settings of a session, before the provider routing: the
 * models of `modelConfig` (`CLAUDE_MODEL_CONFIG`), then the client's
 * `settings` option, an object or a file path relative to `cwd`.
 */
export async function configuredSettings(
  provided: Options["settings"],
  cwd: string,
  modelConfig: ReturnType<typeof parseModelConfig>,
): Promise<Settings | undefined> {
  const object =
    typeof provided === "string"
      ? (JSON.parse(await fs.readFile(path.resolve(cwd, provided), "utf8")) as Settings)
      : (provided as Settings | undefined);
  return modelConfig ? { ...modelConfig, ...object } : object;
}
