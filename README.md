# ACP adapter for the Claude Agent SDK

[![npm](https://img.shields.io/npm/v/%40agentclientprotocol%2Fclaude-agent-acp)](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp)

Use [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview#branding-guidelines) from [ACP-compatible](https://agentclientprotocol.com) clients!

This tool implements an ACP agent by using the official [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview), supporting:

- Context @-mentions
- Images
- Tool calls (with permission requests)
- Compact file changes through the negotiated [AIR diff patch extension](docs/air-extensions.md#diff-patch)
- Following
- Edit review
- TODO lists
- Nested subagent transcripts
- Interactive (and background) terminals
- Custom [Slash commands](https://docs.anthropic.com/en/docs/claude-code/slash-commands)
- Client MCP servers
- An Ultracode session config option, which turns on Claude Code's dynamic workflows for every task. It appears when dynamic workflows are enabled and the model supports ultracode (any model with `xhigh` effort)
- `/mcp` in the chat: the MCP server status as a list. The adapter runs `/mcp reconnect`, `/mcp enable`, and `/mcp disable` through the SDK control API, because Claude Code refuses them in SDK mode. A reconnect of an ACP server that needs authentication starts MCP OAuth through URL elicitation
- Session-scoped long-running goals for AIR through the [goal extension](docs/air-extensions.md#goal) under `_meta.jetbrains.air.goal`
- Structured errors, recovery, and warnings through the opt-in [session failure extension](docs/air-extensions.md#session-failure)
- Concrete model and effort defaults through the opt-in [recommended config value extension](docs/air-extensions.md#recommended-config-values)
- Tool permission presentation, editable choices, and durable effects through the [permission extension](docs/air-extensions.md#permission-presentation)
- One fact per field in every tool call report, as the [ACP tool call contract](docs/air-extensions.md#tool-call-contract) defines
- All AIR extensions, capabilities, and `_meta` keys: [AIR extensions](docs/air-extensions.md)

Learn more about the [Agent Client Protocol](https://agentclientprotocol.com/).

To try changes that have landed on `main` but are not released yet, install from the
`preview` channel — every push to `main` publishes one. See
[`docs/RELEASES.md`](docs/RELEASES.md#preview-releases).

```sh
npm install @agentclientprotocol/claude-agent-acp@preview
```

### Standalone executables

Each release attaches archives for Linux (glibc and musl), macOS and Windows, on
x64 and arm64, to its [GitHub release](https://github.com/agentclientprotocol/claude-agent-acp/releases).
They need no Node.js install. Each holds two files: `claude-agent-acp`, and the
Claude CLI (`claude`) it runs. Keep them in the same directory; a symlink to
`claude-agent-acp` elsewhere works. To use a Claude CLI you already have
instead, set `CLAUDE_CODE_EXECUTABLE`. On Alpine, install `libgcc` and
`libstdc++` first.

To build one for your machine (needs [Bun](https://bun.sh)) and check it:

```sh
npm run build:binary
npm run smoke:binary            # add `-- --full` to drive a real session; needs a Claude login
```

### Experimental ACP v2

The adapter also serves the [draft ACP v2](https://agentclientprotocol.com/protocol/v2/overview):
a client that asks for protocol version 2 or later in `initialize` gets v2, and every other client
gets v1. The draft can still change, and this surface changes with it.

`CLAUDE_AGENT_ACP_PROTOCOL` limits the adapter to one version. With `v1`, a client that asks
for v2 is negotiated down to v1. With `v2`, the adapter rejects the `initialize` of a v1 client.
`auto`, the default, serves both.

On v2 the adapter serves the session baseline (`session/new`, `session/list`, `session/resume`
with replay, `session/close`, `session/prompt`, `session/cancel`), `session/delete`,
`session/fork`, `session/status`, `session/options` (with initial `configOptions` on `session/new` and
`session/resume`), `session/set_title`, additional directories, config options (the mode is one), plans, notices,
compaction, display terminals for commands, permission requests, elicitation, providers, auth, and
[subagents](docs/subagent-sessions.md). Steering is v1 only for now.

v2 is served by the v2 agent in `src/v2/`, which runs straight on Claude
Code instead of translating to v1. A v2 client that declares JetBrains AIR
(`_meta.jetbrains.air`) also gets the AIR extensions that ACP v2 does not cover.

## Contribution Policy

This project does not require a Contributor License Agreement (CLA). Instead, contributions are accepted under the following terms:

> By contributing to this project, you agree that your contributions will be licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0). You affirm that you have the legal right to submit your work, that you are not including code you do not have rights to, and that you understand contributions are made without requiring a Contributor License Agreement (CLA).
