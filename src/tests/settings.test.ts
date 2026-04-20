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

    it("should merge availableModels with later sources taking precedence", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });

      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          availableModels: ["claude-3-5-sonnet", "claude-3-5-haiku"],
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      let settings = settingsManager.getSettings();
      expect(settings.availableModels).toEqual(["claude-3-5-sonnet", "claude-3-5-haiku"]);

      await fs.promises.writeFile(
        path.join(claudeDir, "settings.local.json"),
        JSON.stringify({
          availableModels: ["claude-3-7-sonnet"],
        }),
      );

      settingsManager.dispose();
      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      settings = settingsManager.getSettings();
      expect(settings.availableModels).toEqual(["claude-3-7-sonnet"]);
    });
  });
});
