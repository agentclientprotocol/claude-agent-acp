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
