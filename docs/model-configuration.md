# Model Configuration

When using claude-agent-acp with alternative providers (e.g. AWS Bedrock), model IDs differ from the direct Anthropic API. The `CLAUDE_MODEL_CONFIG` environment variable lets you configure model overrides and availability at the deployment level.

## `CLAUDE_MODEL_CONFIG`

A JSON string with two optional fields:

| Field             | Type                     | Description                                                                                                   |
| ----------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `modelOverrides`  | `Record<string, string>` | Maps Anthropic model IDs to provider-specific model IDs (e.g. Bedrock model IDs or ARNs)                      |
| `availableModels` | `string[]`               | Restricts which models are offered to users. Accepts aliases (`"opus"`), prefixes (`"opus-4-5"`), or full IDs |

### Examples

**Bedrock model overrides:**

```bash
CLAUDE_MODEL_CONFIG='{"modelOverrides":{"claude-opus-4-6":"us.anthropic.claude-opus-4-6-v1","claude-sonnet-4-5":"us.anthropic.claude-sonnet-4-5-v1"}}'
```

**Restrict available models:**

```bash
CLAUDE_MODEL_CONFIG='{"availableModels":["opus","sonnet"]}'
```

**Both together:**

```bash
CLAUDE_MODEL_CONFIG='{"modelOverrides":{"claude-opus-4-6":"us.anthropic.claude-opus-4-6-v1","claude-sonnet-4-5":"us.anthropic.claude-sonnet-4-5-v1"},"availableModels":["opus","sonnet"]}'
```

**Full Bedrock example:**

```bash
CLAUDE_CODE_USE_BEDROCK=1 \
AWS_REGION=us-west-2 \
CLAUDE_MODEL_CONFIG='{"modelOverrides":{"claude-opus-4-6":"us.anthropic.claude-opus-4-6-v1"}}' \
node dist/index.js
```

## Precedence

When an ACP caller provides `settings` via `_meta.claudeCode.options.settings` in the `sessions/create` request, `CLAUDE_MODEL_CONFIG` is ignored entirely. The env var is a deployment-level fallback for cases where the caller does not configure model settings itself.

| Source                                       | Priority                                              |
| -------------------------------------------- | ----------------------------------------------------- |
| `_meta.claudeCode.options.settings` (caller) | Highest — used if present                             |
| `CLAUDE_MODEL_CONFIG` (env var)              | Fallback — used only when caller provides no settings |

## Format details

- The value must be valid JSON. Invalid JSON will cause session creation to fail with a parse error.
- Only `modelOverrides` and `availableModels` keys are read; other keys in the JSON are ignored.
- Both fields map directly to the Claude Agent SDK's `Settings` type.

## Manual `opusplan` selections

The model picker includes `opusplan` when the SDK exposes both Opus and Sonnet aliases, subject to the configured `availableModels` allowlist. A successful manual selection is remembered per session under `$CLAUDE_CONFIG_DIR/claude-agent-acp/model-selections` (by default, `~/.claude/claude-agent-acp/model-selections`), because the transcript only records the concrete model used for a turn. Switching to another model clears this record; forks inherit it.

On resume, an explicit caller model or an environment/settings model configuration takes precedence over the saved selection. Removing `opusplan` from `availableModels` prevents a saved selection from restoring it. Sessions created before this persistence support need to select `opusplan` once to save their choice.
