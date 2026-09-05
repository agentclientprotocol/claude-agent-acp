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

/** A transcript's concrete API model cannot distinguish opusplan from an
 * ordinary Opus or Sonnet selection. Store only this otherwise-lost intent. */
export async function readOpusplanSelection(
  configDir: string,
  sessionId: string,
): Promise<boolean> {
  try {
    return (await fs.readFile(selectionPath(configDir, sessionId), "utf8")) === "opusplan";
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

export async function writeOpusplanSelection(
  configDir: string,
  sessionId: string,
  model: string,
): Promise<void> {
  const file = selectionPath(configDir, sessionId);
  if (model === "opusplan") {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "opusplan");
  } else {
    await fs.rm(file, { force: true });
  }
}
