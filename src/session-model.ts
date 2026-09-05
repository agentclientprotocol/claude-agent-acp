import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

/** The CLI only advertises the hybrid alias while it is selected. Keep it
 * selectable when both underlying aliases are available; the caller applies
 * the user's availableModels allowlist afterwards. */
export function withOpusplanModel(models: ModelInfo[]): ModelInfo[] {
  if (models.some((model) => model.value === "opusplan")) return models;
  const sonnet = models.find((model) => model.value === "sonnet");
  if (!sonnet || !models.some((model) => ["opus", "opus[1m]"].includes(model.value))) {
    return models;
  }
  return [
    ...models,
    {
      ...sonnet,
      value: "opusplan",
      displayName: "Opus Plan Mode",
      description: "Use Opus in plan mode, Sonnet otherwise",
    },
  ];
}

function selectionPath(configDir: string, sessionId: string): string {
  return path.join(
    configDir,
    "claude-agent-acp",
    "model-selections",
    `${encodeURIComponent(sessionId)}.txt`,
  );
}

/** Preserve the user's selection, including aliases and Default, rather than
 * inferring it from the concrete API model recorded in the transcript. */
export async function readModelSelection(
  configDir: string,
  sessionId: string,
): Promise<string | undefined> {
  try {
    return (await fs.readFile(selectionPath(configDir, sessionId), "utf8")).trim() || undefined;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeModelSelection(
  configDir: string,
  sessionId: string,
  model: string,
): Promise<void> {
  const file = selectionPath(configDir, sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, model);
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
