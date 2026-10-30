import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import { SettingsManager } from "../settings.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  resolveSettings: vi.fn(),
}));

describe("model selection settings policy", () => {
  let manager: SettingsManager;
  afterEach(() => manager?.dispose());

  it("keeps the managed allowlist and mappings above inline settings", async () => {
    const managed = {
      availableModels: ["claude-haiku-4-5"],
      modelOverrides: { "claude-haiku-4-5": "managed-haiku" },
      deniedModels: ["claude-opus-5"],
    };
    vi.mocked(resolveSettings).mockResolvedValue({
      effective: managed,
      provenance: {},
      sources: [{ source: "managed", settings: managed }],
    });
    manager = new SettingsManager(process.cwd());
    await manager.initialize();
    expect(
      manager.getModelSelectionSettings({
        availableModels: ["claude-opus-5"],
        modelOverrides: { "claude-haiku-4-5": "inline-haiku" },
      }),
    ).toEqual({ availableModels: managed.availableModels, modelOverrides: managed.modelOverrides });
    expect(manager.getManagedDeniedModels()).toEqual(managed.deniedModels);
  });

  it("does not use an inline mapping for a managed allowlist without mappings", async () => {
    vi.mocked(resolveSettings).mockResolvedValue({
      effective: { availableModels: ["claude-haiku-4-5"] },
      provenance: {},
      sources: [{ source: "managed", settings: { availableModels: ["claude-haiku-4-5"] } }],
    });
    manager = new SettingsManager(process.cwd());
    await manager.initialize();
    expect(
      manager.getModelSelectionSettings({
        modelOverrides: { "claude-haiku-4-5": "inline-haiku" },
      }),
    ).toEqual({ availableModels: ["claude-haiku-4-5"], modelOverrides: undefined });
  });
});
