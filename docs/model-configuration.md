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

When an ACP caller provides `settings` via `_meta.claudeCode.options.settings` in the `session/new` request, `CLAUDE_MODEL_CONFIG` is ignored entirely. The env var is a deployment-level fallback for cases where the caller does not configure model settings itself.

| Source                                       | Priority                                              |
| -------------------------------------------- | ----------------------------------------------------- |
| `_meta.claudeCode.options.settings` (caller) | Highest — used if present                             |
| `CLAUDE_MODEL_CONFIG` (env var)              | Fallback — used only when caller provides no settings |

## Per-session authentication

Claude Code applies `env` values from `settings.json` after the ACP server process environment. As a result, setting `ANTHROPIC_AUTH_TOKEN` only in an ACP server launch configuration can be overridden by a token in the user's Claude Code settings.

An ACP caller that needs a session-specific credential should supply it through the higher-precedence `_meta.claudeCode.options.settings` object in its `session/new` request. This requires the object form of `settings`:

```json
{
  "cwd": "/workspace/project",
  "_meta": {
    "claudeCode": {
      "options": {
        "settings": {
          "env": {
            "ANTHROPIC_AUTH_TOKEN": "${SESSION_TOKEN}"
          }
        }
      }
    }
  }
}
```

Resolve `${SESSION_TOKEN}` in the client before it sends the request: claude-agent-acp does not interpolate `${SESSION_TOKEN}`. Obtain the real value from secure credential storage and do not commit it to an ACP configuration file or repository. In sessions without managed provider routing, this object is forwarded to the Claude Agent SDK's programmatic settings tier, so its `env` values take precedence over user and project `settings.json` values. Managed provider routing remains authoritative for the environment variables it owns.

## Format details

- The value must be valid JSON. Invalid JSON will cause session creation to fail with a parse error.
- Only `modelOverrides` and `availableModels` keys are read from `CLAUDE_MODEL_CONFIG`; caller-provided settings map directly to the Claude Agent SDK's `Settings` type.
