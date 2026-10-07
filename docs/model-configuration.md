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

## Custom model gateway (`ACP_GATEWAY_AUTH`)

For deployments that route Claude Code's API traffic through a custom LLM gateway speaking the standard Anthropic protocol, where the credentials live outside the agent — typically `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` in the user's `~/.claude/settings.json`, with the gateway injecting the real credential upstream. There is no Anthropic subscription or API key on the machine, so every sign-in prompt a client offers cannot be completed.

```jsonc
// ~/.claude/settings.json — the single source of truth for routing and auth
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://gateway.internal.example",
    "ANTHROPIC_AUTH_TOKEN": "<gateway token>",
  },
}
```

```bash
ACP_GATEWAY_AUTH=1 node dist/index.js
```

**This is a status signal, not a routing switch.** The adapter does not rewrite the session environment in this mode: traffic flows exactly where `~/.claude/settings.json` (or the process environment) points it, which Claude Code reads natively. What the flag changes is the identity the agent reports to the ACP client — `kind: "gateway"`, "Custom model gateway" — instead of a "not logged in" verdict that would trigger sign-in prompts. The adapter also skips `claude auth status` entirely in this mode, and `auth/logout` reports keep the gateway identity (logout clears only the CLI credential store, which is not the credential in use).

- Any non-empty value enables it, matching the `CLAUDE_CODE_USE_BEDROCK` truthiness convention; set `1`.
- Do not combine with `CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX`: those switch the wire protocol away from the Anthropic API format a gateway speaks. If both are set, the CLI follows the Bedrock/Vertex switches while the agent reports the gateway identity.
- A client-managed route (`providers/set`) wins over the flag: it bakes routing into the session env and zeroes `ACP_GATEWAY_AUTH` there.
- **Not Claude Code's `CLAUDE_CODE_USE_GATEWAY`.** Claude Code itself has an undocumented env var of that name; its error strings describe a _Cloud gateway_ sign-in flow with a credential hand-off file and instructions to `unset CLAUDE_CODE_USE_GATEWAY`. This adapter flag is deliberately named differently and is a pure status signal: it never routes traffic, never spawns sign-in, and never touches the CLI credential store.

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
