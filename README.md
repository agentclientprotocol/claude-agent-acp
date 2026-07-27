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

Learn more about the [Agent Client Protocol](https://agentclientprotocol.com/).

### Nested subagent transcripts

ACP 1.2 has no standard subagent tool kind or nested-message relationship. Clients that can render
nested transcripts can opt in with `clientCapabilities._meta["subagent-transcript"] = true`.
The agent then forwards subagent text, thinking, and tool calls, relating nested updates to the
launching Agent/Task call through `_meta.claudeCode.parentToolUseId`. Agent/Task calls are marked
with `_meta.claudeCode.subagent = true`.

Clients that do not advertise the capability retain the legacy flattened behavior. In both modes,
the normal Agent/Task tool result is preserved as the protocol-compatible fallback.

## Trace context metadata

Send W3C trace context through ACP's reserved root-level `_meta` fields. String-valued `traceparent`
and `tracestate` are propagated; `baggage` is currently ignored.

**Per session (preferred).** Put the trace context on `session/new` and every prompt in the session
joins that trace:

```json
{
  "cwd": "/path/to/project",
  "mcpServers": [],
  "_meta": {
    "traceparent": "00-80e1afed08e019fc1110464cfa66635c-7a085853722dc6d2-01",
    "tracestate": "vendor=value"
  }
}
```

This is applied to the Claude Code environment at startup, so it costs no round-trip and places no
restriction on how you submit prompts.

**Per prompt.** Use this when prompts in one session genuinely belong to different traces:

```json
{
  "sessionId": "existing-session-id",
  "prompt": [{ "type": "text", "text": "Run the task" }],
  "_meta": {
    "traceparent": "00-80e1afed08e019fc1110464cfa66635c-7a085853722dc6d2-01",
    "tracestate": "vendor=value"
  }
}
```

A prompt's own trace context applies to that prompt only; the next prompt reverts to the session's
(or to none). Because Claude Code reads trace context from its environment when it picks a prompt up,
this requires that every prompt submitted before it has already started — you can queue a traced
prompt behind the running one, but submitting two at once is rejected with `invalidParams`. Prefer
per-session context if you pipeline prompts.

Trace context is best-effort: if the update cannot be applied, the prompt still runs and the failure
is logged rather than failing the turn or the session.

Claude Code parents that prompt's `claude_code.interaction` span under the supplied context, but it
only emits spans at all when tracing is switched on in the environment the agent is launched with:

```sh
CLAUDE_CODE_ENABLE_TELEMETRY=1 \
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 \
OTEL_TRACES_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

Without `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` no trace spans are exported and the metadata has no
observable effect. See the
[Claude Code monitoring docs](https://docs.claude.com/en/docs/claude-code/monitoring-usage) for the
full set of telemetry variables.

## Contribution Policy

This project does not require a Contributor License Agreement (CLA). Instead, contributions are accepted under the following terms:

> By contributing to this project, you agree that your contributions will be licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0). You affirm that you have the legal right to submit your work, that you are not including code you do not have rights to, and that you understand contributions are made without requiring a Contributor License Agreement (CLA).
