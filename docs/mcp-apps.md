# MCP Apps

This adapter lets an ACP client host [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) for the MCP servers that the agent connects to. The code is in `src/mcp-apps.ts`.

## Why

[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (SEP-1865) lets an MCP tool declare a
`ui://` resource in `_meta.ui.resourceUri`. A host shows that resource (an HTML page) in a
sandboxed frame next to the tool's result, and the page can call the server's tools.

In ACP the agent, not the client, connects to the MCP servers. A client that wants to show an
MCP App has three gaps:

1. It does not know that a tool call came from an app tool, or which resource goes with it.
2. It cannot read the `ui://` resource, because it has no connection to the server.
3. It cannot run the tool calls that the page makes.

This extension closes those gaps with one capability, one `_meta` key on tool calls, and two
methods. It uses only `_meta` and `_`-prefixed methods, so agents and clients that do not know it
are unaffected.

## 1. Capability

The client declares support in `initialize`:

| Protocol | Where                              |
| -------- | ---------------------------------- |
| ACP v1   | `clientCapabilities._meta.mcpApps` |
| ACP v2   | `capabilities._meta.mcpApps`       |

```json
{ "mcpApps": { "version": 1 } }
```

The agent answers with the methods it serves:

| Protocol | Where                             |
| -------- | --------------------------------- |
| ACP v1   | `agentCapabilities._meta.mcpApps` |
| ACP v2   | `capabilities._meta.mcpApps`      |

```json
{
  "mcpApps": {
    "version": 1,
    "resourcesRead": "_session/mcp/resources/read",
    "toolsCall": "_session/mcp/tools/call"
  }
}
```

An agent sends `_meta.mcpApp` (section 2) only to a client that declared a `version` of 1 or more.
The two methods work for any client.

## 2. App tool calls: `_meta.mcpApp`

When a tool that declared a `ui://` resource finishes, the agent adds `_meta.mcpApp` to a report
of that tool call. It comes in a `tool_call_update` after the call's own result. When a session
is loaded or replayed, it can come in the `tool_call` itself.

```json
{
  "sessionUpdate": "tool_call_update",
  "toolCallId": "call_1",
  "_meta": {
    "mcpApp": {
      "version": 1,
      "server": "basic",
      "tool": "get-time",
      "resourceUri": "ui://get-time/mcp-app.html",
      "toolResult": {
        "content": [{ "type": "text", "text": "2026-11-26T16:42:32.567Z" }],
        "structuredContent": { "time": "2026-11-26T16:42:32.567Z" }
      }
    }
  }
}
```

| Field         | Meaning                                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server`      | The MCP server's name, as the client passes it to the two methods.                                                                                                                 |
| `tool`        | The tool's own name on the server, without any agent prefix such as `mcp__<server>__`.                                                                                             |
| `resourceUri` | The `ui://` resource from the tool's `_meta.ui.resourceUri`. The deprecated flat `_meta["ui/resourceUri"]` is also read.                                                           |
| `toolResult`  | The server's own `CallToolResult`, including `structuredContent` and `_meta`. A failed call has `isError: true`. It is left out when its JSON is longer than 1,000,000 characters. |

The client sends `toolResult` to the page as `ui/notifications/tool-result`, and the tool call's
`rawInput.arguments` as `ui/notifications/tool-input` where it has them.

## 3. `_session/mcp/resources/read`

Reads the `ui://` resource through the agent's connection to the server. It sends no session update.

Request:

```json
{ "sessionId": "…", "server": "basic", "uri": "ui://get-time/mcp-app.html", "toolCallId": "call_1" }
```

- `uri` must start with `ui://`. Any other scheme fails with Invalid params (-32602), so the method
  cannot be used to read the server's other resources.
- `toolCallId` is optional: the app tool call that the resource is read for. An agent may use it to
  pick the right app (Codex passes it on as `originCallId`). Other agents ignore it.

Response: the MCP `ReadResourceResult` contents.

```json
{
  "contents": [
    {
      "uri": "ui://get-time/mcp-app.html",
      "mimeType": "text/html;profile=mcp-app",
      "text": "<!DOCTYPE html>…"
    }
  ]
}
```

The client reads the page's CSP and permissions from `contents[]._meta.ui`, as the MCP Apps spec says.

## 4. `_session/mcp/tools/call`

Runs a tool for the page on the session's live MCP connection. It runs between turns as well as
during one. It starts no model turn, it sends no session update, and the result goes only to the
client: the model does not see it.

Request:

```json
{
  "sessionId": "…",
  "server": "basic",
  "name": "get-time",
  "arguments": {},
  "checkPermissions": true
}
```

| Field              | Meaning                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | The tool's own name on the server.                                                                                                                                                                                                                                                                                                                                            |
| `arguments`        | An object. Optional, `{}` when left out.                                                                                                                                                                                                                                                                                                                                      |
| `checkPermissions` | Optional. When `true`, the agent decides the call as it decides the model's own call to that tool, and asks the user through `session/request_permission` where it would ask. An agent that cannot do that must refuse the request with Invalid request (-32600) rather than run the tool unchecked; the client can then ask the user itself and call again without the flag. |

Response: the server's `CallToolResult`. A tool that fails comes back as a result with
`isError: true` where the agent can tell it apart from a transport error.

## 5. Errors

| Case                                                                                                                 | Error                                                        |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Missing or empty `sessionId`, `server`, `uri` or `name`; `arguments` not an object; `checkPermissions` not a boolean | -32602 Invalid params                                        |
| `uri` is not `ui://`                                                                                                 | -32602 Invalid params                                        |
| Unknown session                                                                                                      | session not found / -32602                                   |
| The session's agent process has stopped                                                                              | -32600 Invalid request: resume the session and retry         |
| The agent cannot check permissions, or its version cannot call tools for an app                                      | -32600 Invalid request, with a message saying what to update |
| Unknown tool, server error                                                                                           | -32603 Internal error, with the server's message             |

## 6. What the client still owns

The extension carries data; the client is the MCP Apps host. It should:

- render the resource in a sandboxed frame with the CSP the resource declares;
- forward the page's `tools/call` only to the server the page came from (`mcpApp.server`);
- decide which of the page's calls need the user's consent, or pass `checkPermissions: true`;
- treat everything the page sends as untrusted input.

## 7. Claude Code

The adapter needs these Claude Code capabilities, reported
in `initialize` and `system/init`:

| Capability                                       | Needed for                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `mcp_tool_ui_meta_v1` and `mcp_read_resource_v1` | `_meta.mcpApp` (tools carry `_meta.ui`, and the resource can be read)    |
| `mcp_call_result_not_for_model_v1`               | `_session/mcp/tools/call` (the server's own result, kept from the model) |
| `mcp_call_soft_error_result_v1`                  | tool errors as `isError` results                                         |
| `mcp_call_check_permissions_v1`                  | `checkPermissions: true`                                                 |

Without them, the adapter sends no `_meta.mcpApp`, or refuses the call with a message to update
Claude Code. The `tool` is found from Claude Code's `mcp__<server>__<tool>` name through the
server status list; when two servers make the same name, no `_meta.mcpApp` is sent.

## 8. Not in version 1

- Streaming tool input to the page (`ui/notifications/tool-input-partial`).
- The page adding to the model's context (`ui/update-model-context`) or sending a message.
- Hiding app-only tools (`_meta.ui.visibility: ["app"]`) from the model: that is up to the agent.
- `resources/list` and templates for apps.
