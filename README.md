# ACP adapter for the Claude Agent SDK

[![npm](https://img.shields.io/npm/v/%40agentclientprotocol%2Fclaude-agent-acp)](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp)

Use [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview#branding-guidelines) from [ACP-compatible](https://agentclientprotocol.com) clients!

This tool implements an ACP agent by using the official [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview), supporting:

- Context @-mentions
- Images
- Tool calls (with permission requests)
- Following
- Edit review
- TODO lists
- Nested subagent transcripts
- Interactive (and background) terminals
- Custom [Slash commands](https://docs.anthropic.com/en/docs/claude-code/slash-commands)
- Client MCP servers
- Session-scoped long-running goals through the provider-neutral [goal extension](docs/goal-extension.md)
- Structured errors, recovery, and warnings through the opt-in [session failure extension](docs/session-failure-extension.md)
- Tool permission presentation, editable choices, and durable effects through the [permission extension](docs/permission-extension.md)

Learn more about the [Agent Client Protocol](https://agentclientprotocol.com/).

### Nested subagent transcripts

ACP 1.2 has no standard subagent tool kind or nested-message relationship. Clients that can render
nested transcripts can opt in with `clientCapabilities._meta["subagent-transcript"] = true`.
The agent then forwards subagent text, thinking, and tool calls, relating nested updates to the
launching Agent/Task call through `_meta.claudeCode.parentToolUseId`. Agent/Task calls are marked
with `_meta.claudeCode.subagent = true`.

Clients that do not advertise the capability retain the legacy flattened behavior. In both modes,
the normal Agent/Task tool result is preserved as the protocol-compatible fallback.

## Contribution Policy

This project does not require a Contributor License Agreement (CLA). Instead, contributions are accepted under the following terms:

> By contributing to this project, you agree that your contributions will be licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0). You affirm that you have the legal right to submit your work, that you are not including code you do not have rights to, and that you understand contributions are made without requiring a Contributor License Agreement (CLA).
