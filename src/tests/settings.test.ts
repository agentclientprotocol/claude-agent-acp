import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SettingsManager } from "../settings.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("SettingsManager", () => {
  let tempDir: string;
  let settingsManager: SettingsManager;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "settings-test-"));
  });

  afterEach(async () => {
    settingsManager?.dispose();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe("settings merging", () => {
    it("should merge model setting with later sources taking precedence", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });

      // Project settings with one model
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          model: "claude-3-5-sonnet",
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      let settings = settingsManager.getSettings();
      expect(settings.model).toBe("claude-3-5-sonnet");

      // Add local settings that override the model
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.local.json"),
        JSON.stringify({
          model: "claude-3-5-haiku",
        }),
      );

      // Re-initialize to pick up local settings
      settingsManager.dispose();
      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      settings = settingsManager.getSettings();
      expect(settings.model).toBe("claude-3-5-haiku");
    });

    it("should expose availableModels from settings", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });

      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          availableModels: ["claude-haiku-4-5", "claude-opus-4-7[1m]"],
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      const settings = settingsManager.getSettings();
      expect(settings.availableModels).toEqual(["claude-haiku-4-5", "claude-opus-4-7[1m]"]);
    });

    it("should union and dedupe availableModels across sources", async () => {
      // Per Claude Code docs: "When `availableModels` is set at multiple
      // levels, such as user settings and project settings, arrays are
      // merged and deduplicated."
      // https://code.claude.com/docs/en/model-config#merge-behavior
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });

      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          availableModels: ["claude-haiku-4-5", "claude-opus-4-7[1m]"],
        }),
      );
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.local.json"),
        JSON.stringify({
          // claude-opus-4-7[1m] overlaps with project; should be deduped.
          availableModels: ["claude-opus-4-7[1m]", "claude-sonnet-4-6[1m]"],
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      const settings = settingsManager.getSettings();
      expect(settings.availableModels).toEqual([
        "claude-haiku-4-5",
        "claude-opus-4-7[1m]",
        "claude-sonnet-4-6[1m]",
      ]);
    });

    it("should merge permissions.defaultMode with later sources taking precedence", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });

      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            defaultMode: "dontAsk",
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      let settings = settingsManager.getSettings();
      expect(settings.permissions?.defaultMode).toBe("dontAsk");

      // Local settings override the mode
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.local.json"),
        JSON.stringify({
          permissions: {
            defaultMode: "plan",
          },
        }),
      );

      settingsManager.dispose();
      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      settings = settingsManager.getSettings();
      expect(settings.permissions?.defaultMode).toBe("plan");
    });
  });

  describe("escalating defaultMode trust filter", () => {
    // The SDK's filterEscalatingDefaultMode drops escalating values
    // (bypassPermissions / auto / acceptEdits) that came from a repo-committed
    // tier (.claude/settings.json), preventing a checked-in file from
    // silently escalating permissions. Local (.claude/settings.local.json)
    // and user-tier sources are not committed by convention, so escalating
    // values from those tiers are preserved.

    it.each(["bypassPermissions", "auto", "acceptEdits"] as const)(
      "drops %s when set in project-tier settings",
      async (mode) => {
        const claudeDir = path.join(tempDir, ".claude");
        await fs.promises.mkdir(claudeDir, { recursive: true });

        await fs.promises.writeFile(
          path.join(claudeDir, "settings.json"),
          JSON.stringify({ permissions: { defaultMode: mode } }),
        );

        settingsManager = new SettingsManager(tempDir);
        await settingsManager.initialize();

        expect(settingsManager.getSettings().permissions?.defaultMode).toBeUndefined();
      },
    );

    it.each(["plan", "dontAsk"] as const)(
      "preserves non-escalating %s from project-tier settings",
      async (mode) => {
        const claudeDir = path.join(tempDir, ".claude");
        await fs.promises.mkdir(claudeDir, { recursive: true });

        await fs.promises.writeFile(
          path.join(claudeDir, "settings.json"),
          JSON.stringify({ permissions: { defaultMode: mode } }),
        );

        settingsManager = new SettingsManager(tempDir);
        await settingsManager.initialize();

        expect(settingsManager.getSettings().permissions?.defaultMode).toBe(mode);
      },
    );

    it("preserves escalating defaultMode when it comes from local-tier settings", async () => {
      // settings.local.json is git-ignored by convention, so the trust
      // filter does not apply.
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });

      await fs.promises.writeFile(
        path.join(claudeDir, "settings.local.json"),
        JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      expect(settingsManager.getSettings().permissions?.defaultMode).toBe("acceptEdits");
    });
  });
});
