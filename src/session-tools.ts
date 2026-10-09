/**
 * The adapter's own MCP server: tools through which the model acts on the ACP
 * session it runs in, rather than on the workspace. Each session gets its own
 * in-process server, since an SDK server instance serves one query.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const SESSION_TOOLS_SERVER_NAME = "acp_session";
export const RENAME_SESSION_TOOL_NAME = "rename";
export const RENAME_SESSION_WIRE_TOOL_NAME = `mcp__${SESSION_TOOLS_SERVER_NAME}__${RENAME_SESSION_TOOL_NAME}`;

/** What the session tools act through: `rename` stores and publishes a title
 *  and resolves to the title as stored. */
export type SessionToolsHost = {
  rename(title: string): Promise<string>;
};

/** The tools of the server, bound to one session's host. */
export function sessionTools(host: SessionToolsHost) {
  return [
    tool(
      RENAME_SESSION_TOOL_NAME,
      "Rename the current session: set the title the client shows for it, which it is also " +
        "listed and resumed under. Use it when the user asks to rename or title the session.",
      {
        title: z
          .string()
          .describe(
            "The new title: a short phrase. Line breaks are folded into spaces, and a title " +
              "longer than 256 characters is cut; the result names the title as stored.",
          ),
      },
      async ({ title }) => {
        try {
          const stored = await host.rename(title);
          return { content: [{ type: "text", text: `Session renamed to: ${stored}` }] };
        } catch (error) {
          return {
            content: [{ type: "text", text: `The session was not renamed: ${error}` }],
            isError: true,
          };
        }
      },
      {
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        searchHint: "rename the session, set the session title",
      },
    ),
  ];
}

export function createSessionToolsServer(host: SessionToolsHost): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: SESSION_TOOLS_SERVER_NAME,
    version: "1.0.0",
    tools: sessionTools(host),
  });
}
