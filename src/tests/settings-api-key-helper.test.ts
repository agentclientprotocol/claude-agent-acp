import { describe, expect, it, vi } from "vitest";

const resolved = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  resolveSettings: async () => resolved.value,
}));

const { SettingsManager } = await import("../settings.js");

async function managerResolving(value: unknown) {
  resolved.value = value;
  const manager = new SettingsManager(process.cwd());
  await manager.initialize();
  return manager;
}

describe("SettingsManager.getApiKeyHelper", () => {
  it("prefers a managed helper over the --settings override", async () => {
    const manager = await managerResolving({
      effective: { apiKeyHelper: "managed-helper" },
      provenance: { apiKeyHelper: { source: "managed" } },
      sources: [],
    });
    expect(manager.getApiKeyHelper({ apiKeyHelper: "override-helper" })).toBe("managed-helper");
    manager.dispose();
  });

  it("prefers the --settings override over a user helper", async () => {
    const manager = await managerResolving({
      effective: { apiKeyHelper: "user-helper" },
      provenance: { apiKeyHelper: { source: "userSettings" } },
      sources: [],
    });
    expect(manager.getApiKeyHelper({ apiKeyHelper: "override-helper" })).toBe("override-helper");
    expect(manager.getApiKeyHelper()).toBe("user-helper");
    manager.dispose();
  });
});

describe("SettingsManager.getCompactionSettings", () => {
  it("ranks managed settings over the --settings override over the files, env entry by entry", async () => {
    const manager = await managerResolving({
      effective: {
        idleCompaction: true,
        autoCompactEnabled: false,
        env: {
          DISABLE_COMPACT: "1",
          DISABLE_AUTO_COMPACT: "1",
          CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: "1",
        },
      },
      provenance: {},
      sources: [
        { source: "userSettings", settings: { autoCompactEnabled: false } },
        {
          source: "managed",
          settings: { idleCompaction: true, env: { DISABLE_AUTO_COMPACT: "1" } },
        },
      ],
    });
    expect(
      manager.getCompactionSettings({
        idleCompaction: false,
        autoCompactEnabled: true,
        env: { DISABLE_COMPACT: "0", DISABLE_AUTO_COMPACT: "0" },
      }),
    ).toEqual({
      idleCompaction: true,
      autoCompactEnabled: true,
      env: {
        DISABLE_COMPACT: "0",
        DISABLE_AUTO_COMPACT: "1",
        CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: "1",
      },
    });
    manager.dispose();
  });

  it("keeps the files' value for a key the override sets to undefined", async () => {
    const manager = await managerResolving({
      effective: { idleCompaction: false, env: { DISABLE_COMPACT: "1" } },
      provenance: {},
      sources: [],
    });
    expect(
      manager.getCompactionSettings({
        idleCompaction: undefined,
        env: { DISABLE_COMPACT: undefined as unknown as string },
      }),
    ).toEqual({
      idleCompaction: false,
      autoCompactEnabled: undefined,
      env: { DISABLE_COMPACT: "1" },
    });
    manager.dispose();
  });
});
