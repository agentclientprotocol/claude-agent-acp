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

To try changes that have landed on `main` but are not released yet, install from the
`preview` channel — every push to `main` publishes one. See
[`docs/RELEASES.md`](docs/RELEASES.md#preview-releases).

```sh
npm install @agentclientprotocol/claude-agent-acp@preview
```

### Subagent sessions

Subagents are exposed only after bilateral capability negotiation. Until the released ACP SDKs
preserve the draft `clientCapabilities.subagents` field, a supporting client may advertise
`nativeSubagentSessions` in `_meta.jetbrains.air.capabilities`; the adapter mirrors the capability
in its initialize response. The canonical field remains supported and takes precedence once it is
available. Without either client signal, Agent/Task lifecycle keeps its legacy ordinary ACP
tool-call representation and child interactions stay on the root session. Clients that use the
historical `_meta["subagent-transcript"]` capability or `forwardSubagentText` session option retain
the flattened child transcript behavior.

## Contribution Policy

This project does not require a Contributor License Agreement (CLA). Instead, contributions are accepted under the following terms:

> By contributing to this project, you agree that your contributions will be licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0). You affirm that you have the legal right to submit your work, that you are not including code you do not have rights to, and that you understand contributions are made without requiring a Contributor License Agreement (CLA).
