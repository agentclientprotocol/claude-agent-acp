import type { McpServerStatus, Query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  claudeMcpToolName,
  clientSupportsMcpApps,
  findMcpTool,
  mcpAppResourceUri,
  McpAppsSession,
  mcpCallToolResult,
  mcpToolResults,
  parseMcpResourcesReadRequest,
  parseMcpToolsCallRequest,
} from "../mcp-apps.js";

const ALL_CAPABILITIES = [
  "mcp_tool_ui_meta_v1",
  "mcp_read_resource_v1",
  "mcp_call_result_not_for_model_v1",
  "mcp_call_soft_error_result_v1",
  "mcp_call_check_permissions_v1",
];

const status = (name: string, tools: McpServerStatus["tools"]): McpServerStatus =>
  ({ name, status: "connected", tools }) as McpServerStatus;

const appServer = status("basic", [
  { name: "get-time", _meta: { ui: { resourceUri: "ui://get-time/app.html" } } },
  { name: "plain" },
] as McpServerStatus["tools"]);

function fakeQuery(overrides: Record<string, unknown> = {}): Query & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    mcpServerStatus: async () => [appServer],
    readMcpResource: async (server: string, uri: string) => ({
      contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: `<html>${server}</html>` }],
    }),
    request: async (request: unknown) => {
      sent.push(request);
      return { response: { content: [{ type: "text", text: "12:00" }], structuredContent: {} } };
    },
    ...overrides,
  } as unknown as Query & { sent: unknown[] };
}

const signal = new AbortController().signal;
const noLog = () => {};

describe("client capability", () => {
  it("needs a version of at least 1", () => {
    expect(clientSupportsMcpApps({ _meta: { mcpApps: { version: 1 } } })).toBe(true);
    expect(clientSupportsMcpApps({ _meta: { mcpApps: { version: 0 } } })).toBe(false);
    expect(clientSupportsMcpApps({ _meta: { mcpApps: true } })).toBe(false);
    expect(clientSupportsMcpApps({})).toBe(false);
    expect(clientSupportsMcpApps(undefined)).toBe(false);
  });
});

describe("request parsing", () => {
  it("reads only ui:// resources", () => {
    expect(parseMcpResourcesReadRequest({ sessionId: "s", server: "a", uri: "ui://x" })).toEqual({
      sessionId: "s",
      server: "a",
      uri: "ui://x",
    });
    expect(() =>
      parseMcpResourcesReadRequest({ sessionId: "s", server: "a", uri: "file:///etc/hosts" }),
    ).toThrow();
    expect(() => parseMcpResourcesReadRequest({ sessionId: "s", uri: "ui://x" })).toThrow();
  });

  it("checks tool call arguments", () => {
    expect(
      parseMcpToolsCallRequest({ sessionId: "s", server: "a", name: "t", checkPermissions: true }),
    ).toEqual({ sessionId: "s", server: "a", name: "t", checkPermissions: true });
    expect(() =>
      parseMcpToolsCallRequest({ sessionId: "s", server: "a", name: "t", arguments: [] }),
    ).toThrow();
    expect(() =>
      parseMcpToolsCallRequest({ sessionId: "s", server: "a", name: "t", checkPermissions: "y" }),
    ).toThrow();
  });
});

describe("tool lookup", () => {
  it("names tools as Claude Code does", () => {
    expect(claudeMcpToolName("my server.v2", "get")).toBe("mcp__my_server_v2__get");
  });

  it("finds the tool, and nothing when two servers make the same name", () => {
    expect(findMcpTool([appServer], "mcp__basic__get-time")?.server).toBe("basic");
    const a = status("a", [{ name: "b__c" }] as McpServerStatus["tools"]);
    const ab = status("a__b", [{ name: "c" }] as McpServerStatus["tools"]);
    expect(findMcpTool([a, ab], "mcp__a__b__c")).toBeUndefined();
  });

  it("reads the nested and the deprecated flat resource key", () => {
    expect(mcpAppResourceUri({ ui: { resourceUri: "ui://a" } })).toBe("ui://a");
    expect(mcpAppResourceUri({ "ui/resourceUri": "ui://b" })).toBe("ui://b");
    expect(mcpAppResourceUri({ ui: { resourceUri: "https://a" } })).toBeUndefined();
  });

  it("names only MCP tool results", () => {
    const cache = { t1: { name: "mcp__basic__get-time" }, t2: { name: "Bash" } };
    const content = [
      { type: "tool_result", tool_use_id: "t1" },
      { type: "tool_result", tool_use_id: "t2" },
      { type: "text", text: "x" },
    ];
    expect(mcpToolResults(content, cache)).toEqual([
      { toolCallId: "t1", toolName: "mcp__basic__get-time" },
    ]);
  });
});

describe("tool results", () => {
  it("turns Claude Code's result shapes into a CallToolResult", () => {
    expect(mcpCallToolResult("hi")).toEqual({ content: [{ type: "text", text: "hi" }] });
    expect(mcpCallToolResult({ content: "hi", structuredContent: { a: 1 } })).toEqual({
      content: [{ type: "text", text: "hi" }],
      structuredContent: { a: 1 },
    });
    expect(mcpCallToolResult({ content: [], isError: true })).toEqual({
      content: [],
      isError: true,
    });
    expect(mcpCallToolResult(42)).toBeUndefined();
  });
});

describe("McpAppsSession", () => {
  it("gives _meta.mcpApp for an app tool's result", async () => {
    const session = new McpAppsSession(ALL_CAPABILITIES);
    const updates = await session.toolCallUpdates(
      fakeQuery(),
      [{ toolCallId: "t1", toolName: "mcp__basic__get-time" }],
      { content: "12:00" },
      signal,
      noLog,
    );
    expect(updates).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        _meta: {
          mcpApp: {
            version: 1,
            server: "basic",
            tool: "get-time",
            resourceUri: "ui://get-time/app.html",
            toolResult: { content: [{ type: "text", text: "12:00" }] },
          },
        },
      },
    ]);
  });

  it("gives nothing for a tool without a resource, or a Claude Code that cannot read one", async () => {
    const full = new McpAppsSession(ALL_CAPABILITIES);
    expect(
      await full.toolCallMeta(fakeQuery(), "mcp__basic__plain", undefined, signal, noLog),
    ).toBeUndefined();
    const old = new McpAppsSession(["mcp_tool_ui_meta_v1"]);
    expect(
      await old.toolCallMeta(fakeQuery(), "mcp__basic__get-time", undefined, signal, noLog),
    ).toBeUndefined();
  });

  it("gives nothing when the status read fails", async () => {
    const errors: string[] = [];
    const session = new McpAppsSession(ALL_CAPABILITIES);
    const query = fakeQuery({
      mcpServerStatus: async () => {
        throw new Error("gone");
      },
    });
    expect(
      await session.toolCallMeta(query, "mcp__basic__get-time", undefined, signal, (e) =>
        errors.push(e),
      ),
    ).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("reads a resource through Claude Code", async () => {
    const session = new McpAppsSession(ALL_CAPABILITIES);
    const { contents } = await session.readResource(fakeQuery(), {
      sessionId: "s",
      server: "basic",
      uri: "ui://get-time/app.html",
    });
    expect(contents[0]).toMatchObject({
      uri: "ui://get-time/app.html",
      text: "<html>basic</html>",
    });
  });

  it("calls a tool with its result kept from the model", async () => {
    const session = new McpAppsSession(ALL_CAPABILITIES);
    const query = fakeQuery();
    const result = await session.callTool(query, {
      sessionId: "s",
      server: "basic",
      name: "get-time",
      checkPermissions: true,
    });
    expect(result).toEqual({ content: [{ type: "text", text: "12:00" }], structuredContent: {} });
    expect(query.sent).toEqual([
      {
        subtype: "mcp_call",
        tool: "mcp__basic__get-time",
        arguments: {},
        result_not_for_model: true,
        soft_error_result: true,
        check_permissions: true,
      },
    ]);
  });

  it("refuses a call that this Claude Code cannot make safely", async () => {
    const none = new McpAppsSession([]);
    await expect(
      none.callTool(fakeQuery(), { sessionId: "s", server: "basic", name: "get-time" }),
    ).rejects.toThrow(/Update Claude Code/);
    const unchecked = new McpAppsSession(["mcp_call_result_not_for_model_v1"]);
    await expect(
      unchecked.callTool(fakeQuery(), {
        sessionId: "s",
        server: "basic",
        name: "get-time",
        checkPermissions: true,
      }),
    ).rejects.toThrow(/permissions/);
  });
});
