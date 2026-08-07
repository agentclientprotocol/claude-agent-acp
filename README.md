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

Learn more about the [Agent Client Protocol](https://agentclientprotocol.com/).

### Nested subagent transcripts

ACP 1.2 has no standard subagent tool kind or nested-message relationship. Clients that can render
nested transcripts can opt in with `clientCapabilities._meta["subagent-transcript"] = true`.
The agent then forwards subagent text, thinking, and tool calls, relating nested updates to the
launching Agent/Task call through `_meta.claudeCode.parentToolUseId`. Agent/Task calls are marked
with `_meta.claudeCode.subagent = true`.

Clients that do not advertise the capability retain the legacy flattened behavior. In both modes,
the normal Agent/Task tool result is preserved as the protocol-compatible fallback.

### Result token accounting

ACP Hosts can opt in to provider-level token accounting by advertising version 1 during
initialization:

```json
{
  "clientCapabilities": {
    "_meta": {
      "claudeCode": {
        "accountingUsage": { "version": 1 }
      }
    }
  }
}
```

For each unique Claude SDK result, the agent sends a `_claude/accountingUsage` extension
notification. The additive token counts are derived from consecutive cumulative SDK
`modelUsage` snapshots, so they include model work that is not represented by a successful user
turn, such as failed results and autonomous or subagent work.

```json
{
  "jsonrpc": "2.0",
  "method": "_claude/accountingUsage",
  "params": {
    "sessionId": "...",
    "version": 1,
    "resultId": "...",
    "resultSubtype": "success",
    "isError": false,
    "scope": "user_turn",
    "source": "model_usage_delta",
    "snapshotReset": false,
    "usage": {
      "inputTokens": 10,
      "outputTokens": 5,
      "cachedReadTokens": 20,
      "cachedWriteTokens": 3,
      "totalTokens": 38
    },
    "resultUsage": {
      "inputTokens": 7,
      "outputTokens": 4,
      "cachedReadTokens": 2,
      "cachedWriteTokens": 1,
      "totalTokens": 14
    },
    "modelUsage": {
      "claude-sonnet-4-6": {
        "inputTokens": 10,
        "outputTokens": 5,
        "cacheReadInputTokens": 20,
        "cacheCreationInputTokens": 3,
        "webSearchRequests": 0,
        "costUSD": 0.01,
        "contextWindow": 200000,
        "maxOutputTokens": 64000
      }
    },
    "modelUsageSemantics": "sdk_session_cumulative_snapshot"
  }
}
```

Accounting consumers must follow these rules:

- Deduplicate notifications by `resultId` and add only `params.usage`.
- Do not add `PromptResponse.usage`; it remains user-turn completion metadata and can overlap
  with the accounting notification.
- Do not add `resultUsage`; it is the normalized top-level SDK result usage retained for audit.
- Do not add `modelUsage`; it is a cumulative SDK snapshot retained for audit.
- Do not reconstruct accounting from transcript history; compaction can prune model-call records
  while the cumulative SDK snapshot continues to advance.
- Treat `source: "result_usage_fallback"` as incomplete for hidden auxiliary or subagent calls.
- When `snapshotReset` is `true`, the SDK cumulative counter restarted and the current snapshot
  begins a new accounting epoch.

Hosts that do not advertise the exact numeric version `1` receive no accounting extension
notifications. Standard `usage_update` and `PromptResponse.usage` behavior is unchanged.

## Contribution Policy

This project does not require a Contributor License Agreement (CLA). Instead, contributions are accepted under the following terms:

> By contributing to this project, you agree that your contributions will be licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0). You affirm that you have the legal right to submit your work, that you are not including code you do not have rights to, and that you understand contributions are made without requiring a Contributor License Agreement (CLA).
