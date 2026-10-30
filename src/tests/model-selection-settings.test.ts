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

  it.each([{ availableModels: ["claude-haiku-4-5"] }, { availableModels: [] }])(
    "keeps the managed allowlist %j and mappings above inline settings",
    async ({ availableModels }) => {
      const managed = {
        availableModels,
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
      ).toEqual({
        availableModels: managed.availableModels,
        modelOverrides: managed.modelOverrides,
      });
      expect(manager.getManagedDeniedModels()).toEqual(managed.deniedModels);
    },
  );

  it("keeps managed override keys above inline keys without discarding other inline mappings", async () => {
    const managed = { modelOverrides: { "claude-haiku-4-5": "managed-haiku" } };
    vi.mocked(resolveSettings).mockResolvedValue({
      effective: managed,
      provenance: {},
      sources: [{ source: "managed", settings: managed }],
    });
    manager = new SettingsManager(process.cwd());
    await manager.initialize();
    expect(
      manager.getModelSelectionSettings({
        availableModels: ["claude-haiku-4-5", "claude-sonnet-4-6"],
        modelOverrides: {
          "claude-haiku-4-5": "inline-haiku",
          "claude-sonnet-4-6": "inline-sonnet",
        },
      }),
    ).toEqual({
      availableModels: ["claude-haiku-4-5", "claude-sonnet-4-6"],
      modelOverrides: { "claude-haiku-4-5": "managed-haiku", "claude-sonnet-4-6": "inline-sonnet" },
    });
  });

  it("preserves file and inline mappings when the managed allowlist supplies no mappings", async () => {
    vi.mocked(resolveSettings).mockResolvedValue({
      effective: {
        availableModels: ["claude-haiku-4-5"],
        modelOverrides: { "claude-haiku-4-5": "file-haiku" },
      },
      provenance: {},
      sources: [
        { source: "user", settings: { modelOverrides: { "claude-haiku-4-5": "file-haiku" } } },
        { source: "managed", settings: { availableModels: ["claude-haiku-4-5"] } },
      ],
    });
    manager = new SettingsManager(process.cwd());
    await manager.initialize();
    expect(manager.getModelSelectionSettings()).toEqual({
      availableModels: ["claude-haiku-4-5"],
      modelOverrides: { "claude-haiku-4-5": "file-haiku" },
    });
    expect(
      manager.getModelSelectionSettings({
        modelOverrides: { "claude-haiku-4-5": "inline-haiku" },
      }),
    ).toEqual({
      availableModels: ["claude-haiku-4-5"],
      modelOverrides: { "claude-haiku-4-5": "inline-haiku" },
    });
  });
});
