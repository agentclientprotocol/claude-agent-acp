import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  resolveModelPreference,
  applyAvailableModelsAllowlist,
  matchResumedModel,
} from "../acp-agent.js";

// Mirrors a real `supportedModels()` response: alias rows carry
// `resolvedModel`, and "Sonnet 5" has no `major.minor` dot unlike older
// "claude-opus-4-6"-style ids.
const LIVE_SHAPED_MODELS: ModelInfo[] = [
  {
    value: "default",
    resolvedModel: "claude-opus-4-8[1m]",
    displayName: "Default (recommended)",
    description: "Use the default model (currently Opus 4.8 (1M context))",
  },
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-4-8[1m]",
    displayName: "Opus",
    description: "Opus 4.8 with 1M context · Best for everyday, complex tasks",
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet",
    description: "Sonnet 5 · Efficient for routine tasks",
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
];

describe("resolveModelPreference - resolvedModel matching", () => {
  it("matches a preference that equals an alias's resolvedModel exactly", () => {
    expect(resolveModelPreference(LIVE_SHAPED_MODELS, "claude-sonnet-5")?.value).toBe("sonnet");
    expect(resolveModelPreference(LIVE_SHAPED_MODELS, "claude-opus-4-8[1m]")?.value).toBe(
      "opus[1m]",
    );
    expect(resolveModelPreference(LIVE_SHAPED_MODELS, "claude-haiku-4-5-20251001")?.value).toBe(
      "haiku",
    );
  });

  it("is case-insensitive", () => {
    expect(resolveModelPreference(LIVE_SHAPED_MODELS, "CLAUDE-SONNET-5")?.value).toBe("sonnet");
  });

  it("still resolves plain aliases via the direct-match tier", () => {
    expect(resolveModelPreference(LIVE_SHAPED_MODELS, "sonnet")?.value).toBe("sonnet");
    expect(resolveModelPreference(LIVE_SHAPED_MODELS, "opus[1m]")?.value).toBe("opus[1m]");
  });

  it("does not let a retired dated id drift onto a same-family alias of a different generation", () => {
    expect(resolveModelPreference(LIVE_SHAPED_MODELS, "claude-sonnet-4-6")).toBeNull();
  });

  // "opus[1m]"'s `value` has no dotted version, just the context-hint digit
  // in "[1m]" — unstripped, that reads as version "1" and blocks the match
  // before the matcher reaches the description's real "4.8".
  it("does not mistake an alias's context-hint suffix for its version", () => {
    expect(resolveModelPreference(LIVE_SHAPED_MODELS, "claude-opus-4-8")?.value).toBe("opus[1m]");
  });

  it("returns null for a preference that matches nothing", () => {
    expect(resolveModelPreference(LIVE_SHAPED_MODELS, "claude-gpt-99")).toBeNull();
  });

  it("matches a '-1m' id-suffix preference against a '[1m]'-spelled resolvedModel", () => {
    // Without hint canonicalization the exact tier misses and the substring
    // tier lands on the bare 200k sibling, silently downgrading a 1M pin.
    const models: ModelInfo[] = [
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        displayName: "Sonnet",
        description: "Sonnet 5 · Efficient for routine tasks",
      },
      {
        value: "sonnet[1m]",
        resolvedModel: "claude-sonnet-5[1m]",
        displayName: "Sonnet",
        description: "Sonnet 5 with 1M context",
      },
    ];
    expect(resolveModelPreference(models, "claude-sonnet-5-1m")?.value).toBe("sonnet[1m]");
  });

  it("matches a '-1m'-suffix alias directly against a '[1m]'-spelled value", () => {
    expect(resolveModelPreference(LIVE_SHAPED_MODELS, "opus-1m")?.value).toBe("opus[1m]");
  });

  // Rows without resolvedModel (older SDKs, allowlist-synthesized entries,
  // option-derived lists) can't use the exact resolved tier, so the hinted
  // preference must not be absorbed by the bare sibling in the substring
  // tier — the tokenized tier scores the hinted row correctly instead.
  it("does not let a bare sibling absorb a hinted preference when resolvedModel is absent", () => {
    const models: ModelInfo[] = [
      { value: "sonnet", displayName: "Sonnet", description: "" },
      { value: "sonnet[1m]", displayName: "Sonnet", description: "" },
    ];
    expect(resolveModelPreference(models, "claude-sonnet-5[1m]")?.value).toBe("sonnet[1m]");
    expect(resolveModelPreference(models, "claude-sonnet-5-1m")?.value).toBe("sonnet[1m]");
    // Bare preferences still land on the bare row via the substring tier.
    expect(resolveModelPreference(models, "claude-sonnet-5")?.value).toBe("sonnet");
  });
});

describe("matchResumedModel", () => {
  // Environment shape from issue #845: the default resolves to Sonnet, the
  // session was explicitly switched to Opus before the process restart.
  const SONNET_DEFAULT_MODELS: ModelInfo[] = [
    {
      value: "default",
      resolvedModel: "claude-sonnet-5",
      displayName: "Default (recommended)",
      description: "Use the default model (currently Sonnet 5)",
    },
    {
      value: "opus",
      resolvedModel: "claude-opus-4-6[1m]",
      displayName: "Opus",
      description: "Opus 4.6 · Most capable for complex work",
    },
    {
      value: "sonnet",
      resolvedModel: "claude-sonnet-5",
      displayName: "Sonnet",
      description: "Sonnet 5 · Efficient for routine tasks",
    },
    {
      value: "sonnet[1m]",
      resolvedModel: "claude-sonnet-5[1m]",
      displayName: "Sonnet",
      description: "Sonnet 5 with 1M context",
    },
  ];

  it("maps an explicitly-switched session's live model to its picker alias", () => {
    expect(matchResumedModel(SONNET_DEFAULT_MODELS, "claude-opus-4-6").value).toBe("opus");
    expect(matchResumedModel(SONNET_DEFAULT_MODELS, "claude-opus-4-6[1m]").value).toBe("opus");
  });

  it("keeps Default selected when the live model is what Default resolves to", () => {
    expect(matchResumedModel(SONNET_DEFAULT_MODELS, "claude-sonnet-5").value).toBe("default");
  });

  it("prefers an exact named-row resolvedModel match over the hint-stripped Default tier", () => {
    // "claude-sonnet-5[1m]" differs from Default's "claude-sonnet-5" only by
    // the context hint; stripping both would misreport the explicit 1M row as
    // Default (and infer the wrong context window downstream). Both hint
    // spellings must land on the row regardless of which one it uses.
    expect(matchResumedModel(SONNET_DEFAULT_MODELS, "claude-sonnet-5[1m]").value).toBe(
      "sonnet[1m]",
    );
    expect(matchResumedModel(SONNET_DEFAULT_MODELS, "claude-sonnet-5-1m").value).toBe("sonnet[1m]");
  });

  it("normalizes the '-1m' id-suffix hint form and casing against Default's resolution", () => {
    expect(matchResumedModel(LIVE_SHAPED_MODELS, "claude-opus-4-8-1m").value).toBe("default");
    expect(matchResumedModel(LIVE_SHAPED_MODELS, "Claude-Opus-4-8[1M]").value).toBe("default");
  });

  it("prefers Default over a named row sharing the identical resolvedModel", () => {
    // "opus[1m]" carries the same resolvedModel as Default; the live id can't
    // tell the two apart, so a never-customized session stays on Default.
    expect(matchResumedModel(LIVE_SHAPED_MODELS, "claude-opus-4-8[1m]").value).toBe("default");
  });

  it("ignores '[1m]' context hints when comparing against Default's resolution", () => {
    // The transcript-restored model drops the "[1m]" context hint, so a
    // session that never left the 1M-context default resumes as the bare id.
    expect(matchResumedModel(LIVE_SHAPED_MODELS, "claude-opus-4-8").value).toBe("default");
  });

  it("still resolves non-default live models against the picker entries", () => {
    expect(matchResumedModel(LIVE_SHAPED_MODELS, "claude-sonnet-5").value).toBe("sonnet");
    expect(matchResumedModel(LIVE_SHAPED_MODELS, "claude-haiku-4-5-20251001").value).toBe("haiku");
  });

  it("tracks a live model with no picker counterpart verbatim", () => {
    const result = matchResumedModel(LIVE_SHAPED_MODELS, "claude-gpt-99");
    expect(result.value).toBe("claude-gpt-99");
    expect(result.displayName).toBe("claude-gpt-99");
  });
});

describe("applyAvailableModelsAllowlist - resolvedModel matching", () => {
  it("resolves an allowlist entry pinned to a canonical resolvedModel id", () => {
    const result = applyAvailableModelsAllowlist(LIVE_SHAPED_MODELS, ["claude-sonnet-5"]);
    const entry = result.find((m) => m.value === "claude-sonnet-5");
    expect(entry).toBeDefined();
    expect(entry?.displayName).toBe("Sonnet");
  });
});

describe("applyAvailableModelsAllowlist - modelOverrides", () => {
  const SDK_MODELS: ModelInfo[] = [
    { value: "default", displayName: "Default", description: "Default model" },
    {
      value: "opus",
      displayName: "Opus",
      description: "Claude Opus 4.6",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
    },
  ];

  it("surfaces the override target as the value while keeping the alias's display metadata", () => {
    // The override target is an opaque Bedrock ARN with no "opus" substring,
    // so matching against it (instead of the "claude-opus-4-6" alias) would
    // find nothing and silently drop displayName/description/supportsEffort.
    const overrides = {
      "claude-opus-4-6": "arn:aws:bedrock:us-west-2:111122223333:inference-profile/custom-7f3a",
    };
    const result = applyAvailableModelsAllowlist(SDK_MODELS, ["claude-opus-4-6"], overrides);

    const entry = result.find((m) => m.value === overrides["claude-opus-4-6"]);
    expect(entry).toEqual({
      value: overrides["claude-opus-4-6"],
      displayName: "Opus",
      description: "Claude Opus 4.6",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
    });
  });
});

// Runs against the real SDK (no mocks) so the fixture above is flagged the
// moment the SDK's actual model list shape drifts from it. Requires a usable
// ANTHROPIC_API_KEY, hence opt-in via RUN_INTEGRATION_TESTS.
describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("model resolution (real SDK)", () => {
  it("every model's resolvedModel (when present) resolves back to that same row", async () => {
    const q = query({ prompt: "hi", options: { sessionId: randomUUID() } });
    try {
      const models = await q.supportedModels();
      expect(models.length).toBeGreaterThan(0);

      for (const model of models) {
        // "default" shares a resolvedModel with the CLI's recommended named
        // alias, and resolution intentionally prefers that alias on a tie.
        if (!model.resolvedModel || model.value === "default") continue;
        const resolved = resolveModelPreference(models, model.resolvedModel);
        expect(resolved?.value).toBe(model.value);
      }
    } finally {
      q.return(undefined);
    }
  }, 30000);

  it("resolves the well-known 'sonnet' and 'opus' aliases to a model bearing their family name", async () => {
    const q = query({ prompt: "hi", options: { sessionId: randomUUID() } });
    try {
      const models = await q.supportedModels();

      const sonnet = resolveModelPreference(models, "sonnet");
      expect(sonnet?.resolvedModel?.toLowerCase()).toContain("sonnet");

      const opus = resolveModelPreference(models, "opus");
      expect(opus?.resolvedModel?.toLowerCase()).toContain("opus");
    } finally {
      q.return(undefined);
    }
  }, 30000);
});
