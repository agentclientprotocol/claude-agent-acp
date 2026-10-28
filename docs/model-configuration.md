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

An ACP caller can provide `settings` via `_meta.claudeCode.options.settings` in `session/new` or `session/load`, as an object or a path to a settings file. The adapter merges `CLAUDE_MODEL_CONFIG` into those settings, so a caller that only adds hooks keeps the model settings. When both set the same key, the caller wins; the merge is shallow, so a caller's `modelOverrides` replaces the env var's map.

| Source                                       | Priority                                       |
| -------------------------------------------- | ---------------------------------------------- |
| `_meta.claudeCode.options.settings` (caller) | Highest — wins for each key it sets            |
| `CLAUDE_MODEL_CONFIG` (env var)              | Used for the keys that the caller does not set |

## Format details

- The value must be valid JSON. Invalid JSON will cause session creation to fail with a parse error.
- Only `modelOverrides` and `availableModels` keys are read; other keys in the JSON are ignored.
- Both fields map directly to the Claude Agent SDK's `Settings` type.

## Models of a `providers/set` gateway

When an ACP client routes the agent through a gateway with `providers/set`, the adapter lists the gateway's models before `providers/set` returns, with the provider headers:

- `anthropic`: `GET {baseUrl}/v1/models`, paginated by `has_more`/`last_id`.
- `bedrock`: `GET {baseUrl}/foundation-models` (Bedrock `ListFoundationModels`, `modelSummaries[].modelId`). Only `anthropic.` ids count. The cross-region prefix `global` when listed, else that of the first listed id with one (`eu` for `eu.anthropic.claude-sonnet-5`), becomes the session's `ANTHROPIC_BEDROCK_REGION_PREFIX`, and ids with other prefixes, or without one, are dropped.

The model picker then offers only the SDK models whose resolved model the gateway lists, matched without dates, version suffixes (`-v1:0`), `-fast`, `@` suffixes, context hints (`[1m]`) and provider prefixes, after the `availableModels` allowlist above. On Bedrock, a model the CLI resolved to another region prefix is dropped as well. When the gateway does not list the model a session runs, that is the default model or a resumed session's last model, the session switches to the first remaining picker row.

A 4xx answer means the gateway has no listing: `providers/set` succeeds and nothing is narrowed. A failed listing (network error, a status other than 2xx or 4xx, unexpected body, the 10 s timeout, an invalid header, or a base URL with credentials) fails `providers/set` with a JSON-RPC internal error, and the previous provider stays in effect. A listing that matches no SDK model leaves the session with no model to offer: there is no model config option. Gateways set through `authenticate`, `vertex` providers, and native routing are not listed. Setting the same gateway again (the same protocol, base URL and headers) reuses its listing, unless it answered 4xx; `providers/set` and `providers/disable` apply in the order they arrive, and logout clears the routing after `claude auth logout`, including a `providers/set` still listing; `providers/disable` and logout drop it.
