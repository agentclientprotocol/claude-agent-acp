import { describe, expect, it, vi } from "vitest";
import type { ModelInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import {
  bedrockRegionPrefix,
  GatewayListingError,
  listBedrockModels,
  listGatewayModels,
  selectBedrockRegion,
} from "../gateway-models.js";
import { getAvailableModels, narrowToGatewayModels } from "../session-model.js";

const logger = { log: vi.fn(), error: vi.fn() };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("listGatewayModels", () => {
  it("lists /v1/models under the base URL with the chat request's auth", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ id: "claude-sonnet-5" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const ids = await listGatewayModels(
      "https://gateway.example/anthropic/",
      { Authorization: "Bearer real", "X-Route": "a" },
      logger,
    );

    expect(ids).toEqual(["claude-sonnet-5"]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, { headers: Headers }];
    expect(url.toString()).toBe("https://gateway.example/anthropic/v1/models?limit=1000");
    const headers = init.headers;
    expect(headers.get("authorization")).toBe("Bearer real");
    expect(headers.get("x-route")).toBe("a");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("sends the placeholder bearer token when the provider headers carry no Authorization", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await listGatewayModels("https://gateway.example", { "x-api-key": "key" }, logger);

    const headers = (fetchMock.mock.calls[0] as unknown as [URL, { headers: Headers }])[1].headers;
    expect(headers.get("authorization")).toBe("Bearer acp-proxy");
    expect(headers.get("x-api-key")).toBe("key");
  });

  it("follows has_more / last_id pagination", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: "a" }, { id: "b" }], has_more: true, last_id: "b" }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "c" }], has_more: false, last_id: "c" }));
    vi.stubGlobal("fetch", fetchMock);

    const ids = await listGatewayModels("https://gateway.example", {}, logger);

    expect(ids).toEqual(["a", "b", "c"]);
    expect((fetchMock.mock.calls[1][0] as URL).searchParams.get("after_id")).toBe("b");
  });

  it.each([
    ["a 5xx status", async () => jsonResponse({ error: "unavailable" }, 503)],
    ["a body without data", async () => jsonResponse({ models: [] })],
    ["a non-JSON body", async () => new Response("<html>")],
    [
      "a network error",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("throws a GatewayListingError on %s", async (_name, respond) => {
    vi.stubGlobal("fetch", vi.fn(respond));

    await expect(listGatewayModels("https://gateway.example", {}, logger)).rejects.toBeInstanceOf(
      GatewayListingError,
    );
  });
});

describe("gateways without a listing", () => {
  it.each([400, 401, 403, 404, 405, 429])("returns undefined for a %s answer", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status })),
    );

    await expect(listGatewayModels("https://gateway.example", {}, logger)).resolves.toBe(undefined);
    await expect(listBedrockModels("https://gateway.example", {}, logger)).resolves.toBe(undefined);
  });
});

describe("listing request guards", () => {
  it("names an invalid provider header without its value", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const listing = listGatewayModels(
      "https://gateway.example",
      { authorization: "Bearer sk-SECRET\r\nx: y" },
      logger,
    );

    await expect(listing).rejects.toThrow(
      'Model listing cannot send the invalid header "authorization"',
    );
    await expect(listing).rejects.not.toThrow("sk-SECRET");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a base URL with credentials without repeating them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const listing = listGatewayModels("https://user:secret@gateway.example", {}, logger);

    await expect(listing).rejects.toThrow(
      "Model listing GET /v1/models cannot be sent: the base URL carries credentials",
    );
    await expect(listing).rejects.not.toThrow("secret");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("listBedrockModels", () => {
  it("lists the Anthropic ids of /foundation-models under the base URL", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        modelSummaries: [
          { modelId: "global.anthropic.claude-sonnet-5-5" },
          { modelId: "global.meta.llama3-3-70b-instruct-v1:0" },
          { modelId: "global.anthropic.claude-opus-5-5" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ids = await listBedrockModels("https://gateway.example/bedrock/", {}, logger);

    expect(ids).toEqual(["global.anthropic.claude-sonnet-5-5", "global.anthropic.claude-opus-5-5"]);
    expect((fetchMock.mock.calls[0] as unknown as [URL])[0].toString()).toBe(
      "https://gateway.example/bedrock/foundation-models",
    );
  });

  it("throws a GatewayListingError on a body without modelSummaries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [] })),
    );

    await expect(listBedrockModels("https://gateway.example", {}, logger)).rejects.toThrow(
      "Model listing GET /foundation-models returned an unexpected body",
    );
  });
});

describe("selectBedrockRegion", () => {
  it("reads the prefix of an id or an inference-profile ARN", () => {
    expect(bedrockRegionPrefix("eu.anthropic.claude-sonnet-5")).toBe("eu");
    expect(bedrockRegionPrefix("us-gov.anthropic.claude-sonnet-5")).toBe("us-gov");
    expect(
      bedrockRegionPrefix(
        "arn:aws:bedrock:eu-west-1:123456789012:inference-profile/global.anthropic.claude-opus-5",
      ),
    ).toBe("global");
    expect(bedrockRegionPrefix("anthropic.claude-sonnet-5")).toBe(undefined);
    expect(bedrockRegionPrefix("claude-sonnet-5")).toBe(undefined);
  });

  it("prefers global over a prefix listed before it", () => {
    expect(
      selectBedrockRegion([
        "eu.anthropic.claude-sonnet-5",
        "global.anthropic.claude-sonnet-5",
        "us.anthropic.claude-opus-5",
      ]),
    ).toEqual({ regionPrefix: "global", modelIds: ["global.anthropic.claude-sonnet-5"] });
  });

  it("keeps the ids of the first listed prefix without global", () => {
    expect(
      selectBedrockRegion(["eu.anthropic.claude-sonnet-5", "us.anthropic.claude-opus-5"]),
    ).toEqual({ regionPrefix: "eu", modelIds: ["eu.anthropic.claude-sonnet-5"] });
  });

  it("keeps the ids of global when listed", () => {
    expect(
      selectBedrockRegion([
        "anthropic.claude-haiku-4-5",
        "global.anthropic.claude-opus-5",
        "eu.anthropic.claude-sonnet-5",
        "global.anthropic.claude-sonnet-5",
      ]),
    ).toEqual({
      regionPrefix: "global",
      modelIds: ["global.anthropic.claude-opus-5", "global.anthropic.claude-sonnet-5"],
    });
  });

  it("keeps every id when none has a prefix", () => {
    expect(selectBedrockRegion(["anthropic.claude-sonnet-5"])).toEqual({
      modelIds: ["anthropic.claude-sonnet-5"],
    });
  });
});

describe("narrowToGatewayModels", () => {
  const MODELS: ModelInfo[] = [
    {
      value: "default",
      resolvedModel: "claude-opus-5[1m]",
      displayName: "Default",
      description: "",
    },
    { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "" },
    {
      value: "sonnet[1m]",
      resolvedModel: "claude-sonnet-5[1m]",
      displayName: "Sonnet (1M context)",
      description: "",
    },
    {
      value: "haiku",
      resolvedModel: "claude-haiku-4-5-20251001",
      displayName: "Haiku",
      description: "",
    },
  ];

  it("keeps the rows whose resolved model is listed in any spelling", () => {
    const narrowed = narrowToGatewayModels(MODELS, [
      "claude-sonnet-5-20260101",
      "claude-haiku-4-5",
    ]);

    expect(narrowed.map((m) => m.value)).toEqual(["sonnet", "sonnet[1m]", "haiku"]);
  });

  it("keeps a default row without resolvedModel and checks a bare family alias by family", () => {
    const models: ModelInfo[] = [
      { value: "default", displayName: "Default", description: "" },
      { value: "opus", displayName: "Opus", description: "" },
      { value: "haiku", displayName: "Haiku", description: "" },
      { value: "claude-sonnet-5", displayName: "Sonnet 5", description: "" },
    ];

    const narrowed = narrowToGatewayModels(models, ["claude-opus-5", "claude-sonnet-5"]);

    expect(narrowed.map((m) => m.value)).toEqual(["default", "opus", "claude-sonnet-5"]);
  });

  it("drops rows resolved to another Bedrock region prefix", () => {
    const models: ModelInfo[] = [
      {
        value: "sonnet",
        resolvedModel: "eu.anthropic.claude-sonnet-5",
        displayName: "Sonnet",
        description: "",
      },
      {
        value: "opus",
        resolvedModel: "us.anthropic.claude-opus-5",
        displayName: "Opus",
        description: "",
      },
    ];

    const narrowed = narrowToGatewayModels(
      models,
      ["eu.anthropic.claude-sonnet-5", "eu.anthropic.claude-opus-5"],
      "eu",
    );

    expect(narrowed.map((m) => m.value)).toEqual(["sonnet"]);
  });

  it("matches OpenRouter ids: vendor prefix, dotted version and :variant suffix", () => {
    const models: ModelInfo[] = [
      {
        value: "default",
        resolvedModel: "claude-opus-5-5[1m]",
        displayName: "Default",
        description: "",
      },
      { value: "opus", displayName: "Opus", description: "" },
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5-5",
        displayName: "Sonnet",
        description: "",
      },
      { value: "haiku", resolvedModel: "claude-haiku-4-5", displayName: "Haiku", description: "" },
      { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "" },
    ];

    const narrowed = narrowToGatewayModels(models, [
      "anthropic/claude-opus-5.5:batch[1m]",
      "anthropic/claude-opus-5.5[1m]",
      "anthropic/claude-sonnet-5.5[1m]",
      "anthropic/openai/gpt-6.1-sol:batch[1m]",
      "anthropic/google/gemini-4-argon[1m]",
    ]);

    expect(narrowed.map((m) => m.value)).toEqual(["default", "opus", "sonnet"]);
  });

  it("matches a model OpenRouter lists only as a :variant", () => {
    const narrowed = narrowToGatewayModels(MODELS, ["anthropic/claude-sonnet-5:batch[1m]"]);

    expect(narrowed.map((m) => m.value)).toEqual(["sonnet", "sonnet[1m]"]);
  });

  it("leaves no model when the listing matches none", () => {
    expect(narrowToGatewayModels(MODELS, ["gpt-5", "gemini-3-pro"])).toEqual([]);
    expect(narrowToGatewayModels(MODELS, [])).toEqual([]);
    expect(narrowToGatewayModels(MODELS, ["anthropic/openai/gpt-5"])).toEqual([]);
    // A default row without resolvedModel is not a match on its own.
    expect(
      narrowToGatewayModels(
        [{ value: "default", displayName: "Default", description: "" }, ...MODELS.slice(1)],
        ["gpt-5"],
      ),
    ).toEqual([]);
  });
});

describe("getAvailableModels under a gateway listing", () => {
  const SDK_MODELS: ModelInfo[] = [
    { value: "default", resolvedModel: "claude-opus-5", displayName: "Default", description: "" },
    { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "" },
    { value: "haiku", resolvedModel: "claude-haiku-4-5", displayName: "Haiku", description: "" },
  ];
  const LISTED = narrowToGatewayModels(SDK_MODELS, ["claude-sonnet-5", "claude-haiku-4-5"]);

  function available(
    setModel: ReturnType<typeof vi.fn>,
    isResumedSession: boolean,
    resumedModelHint?: string,
    narrowedByGateway = true,
  ) {
    return getAvailableModels(
      { setModel } as unknown as Query,
      LISTED,
      SDK_MODELS,
      { getSettings: () => ({}) },
      { log: vi.fn(), error: vi.fn() },
      isResumedSession,
      "gateway-test",
      resumedModelHint,
      narrowedByGateway,
    );
  }

  it("switches a resumed session off a transcript model the gateway does not list", async () => {
    const setModel = vi.fn();

    const state = await available(setModel, true, "claude-opus-5");

    expect(state.currentModelId).toBe("sonnet");
    expect(setModel).toHaveBeenCalledWith("sonnet");
  });

  it("switches a resumed session without a transcript off the dropped default", async () => {
    const setModel = vi.fn();

    const state = await available(setModel, true);

    expect(state.currentModelId).toBe("sonnet");
    expect(setModel).toHaveBeenCalledWith("sonnet");
  });

  it("keeps a resumed session on a listed transcript model", async () => {
    const setModel = vi.fn();

    const state = await available(setModel, true, "claude-haiku-4-5");

    expect(state.currentModelId).toBe("haiku");
    expect(setModel).not.toHaveBeenCalled();
  });

  it("keeps a resumed transcript model outside an allowlist when no gateway narrowed the list", async () => {
    const setModel = vi.fn();

    const state = await available(setModel, true, "claude-opus-5", false);

    expect(state.currentModelId).toBe("claude-opus-5");
    expect(setModel).not.toHaveBeenCalled();
  });

  it("reports the SDK default when a PreModelSwitch hook vetoes the switch", async () => {
    const setModel = vi
      .fn()
      .mockRejectedValue(new Error("Model switch blocked by a PreModelSwitch hook: no"));

    const state = await available(setModel, false);

    expect(state.currentModelId).toBe("default");
  });

  it("reports the SDK default when the switch onto a listed model fails", async () => {
    const setModel = vi.fn().mockRejectedValue(new Error("boom"));

    const state = await available(setModel, false);

    expect(state.currentModelId).toBe("default");
  });

  it("switches a resumed session whose transcript model only loosely matches a listed row", async () => {
    const setModel = vi.fn();

    const state = await available(setModel, true, "claude-sonnet-4-5-20250929");

    expect(state.currentModelId).toBe("sonnet");
    expect(setModel).toHaveBeenCalledWith("sonnet");
  });

  it("keeps a default row the gateway lists by its resolved model", () => {
    expect(narrowToGatewayModels(SDK_MODELS, ["claude-opus-5"]).map((m) => m.value)).toEqual([
      "default",
    ]);
  });
});
