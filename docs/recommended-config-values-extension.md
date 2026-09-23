# Recommended config values extension

This document defines the experimental AIR `recommendedValue` session configuration extension
implemented by `claude-agent-acp`. It lets a client show concrete model and effort choices without
an ambiguous `default` row while preserving legacy config options for every client that does not
opt in.

Permission modes and all other session config options are outside this extension and remain
unchanged.

## Capability negotiation

A client opts in through the common AIR capability list in `initialize`:

```json
{
  "clientCapabilities": {
    "_meta": {
      "jetbrains": {
        "air": {
          "version": 1,
          "capabilities": ["recommendedValue"]
        }
      }
    }
  }
}
```

The adapter enables the extension only when the AIR version is a finite integer greater than or
equal to `1` and `capabilities` contains the singular `recommendedValue` capability. Otherwise it
preserves the existing `default` rows, current values, and metadata exactly. The adapter advertises
the same capability in its top-level initialize-response `_meta.jetbrains.air.capabilities` list.

## Config option metadata

For each selector transformed by the extension, the adapter writes the concrete recommendation
through the common AIR metadata envelope at `_meta.jetbrains.air.recommendedValue`:

```json
{
  "id": "model",
  "type": "select",
  "currentValue": "sonnet",
  "options": [
    { "value": "opus", "name": "Claude Opus" },
    { "value": "sonnet", "name": "Claude Sonnet" },
    { "value": "haiku", "name": "Claude Haiku" }
  ],
  "_meta": {
    "jetbrains": {
      "air": {
        "version": 1,
        "recommendedValue": "sonnet"
      }
    }
  }
}
```

`recommendedValue` always names one of that selector's advertised option values. It is independent
from `currentValue`: a user's explicit selection remains current even when the SDK recommends a
different value.

## Model behavior

The SDK's `default` model entry may carry a `resolvedModel` identifying the model currently
recommended by Claude. The adapter matches that identifier exactly to a selectable named model
(accepting equivalent `-1m` and `[1m]` suffix spellings),
removes the `default` row, and advertises the named value in
`_meta.jetbrains.air.recommendedValue`. When the session itself is still using the SDK default, the
same concrete value is presented as `currentValue`.

If the SDK recommendation cannot be mapped to an advertised named model, the adapter retains the
legacy `default` row for that selector and omits `recommendedValue`. This prevents a client from
receiving a recommendation or current value it cannot select.

Terse SDK labels that match their underlying model family include the concrete version derived
from model metadata: for example, `Sonnet` becomes `Sonnet 5`, `Fable` becomes `Fable 5.1`, and
`Claude Haiku` becomes `Claude Haiku 4.5`.
Context suffixes such as `Opus (1M context)` are omitted from the label because the context remains
in the description. Custom labels are preserved, and normalization falls back to the original
labels if two selectable entries would otherwise collide. This presentation also applies to
legacy clients.

## Effort behavior

When the current model supports effort selection, the adapter removes the `default` effort row and
advertises `medium` as the recommendation. An existing explicit or settings-derived effort remains
the `currentValue`; an absent or legacy `default` current effort is presented as `medium`.

The adapter applies the displayed effort to the SDK on session creation and model switches, so
the concrete selection reflects the effort actually used. Explicit SDK `options.effort` and ACP
picker choices remain pinned across model switches while supported. Otherwise each switch
re-reads the new model's settings before falling back to the recommendation. Switching to a
model without effort support clears the flag override. Legacy clients continue to let the SDK
resolve automatic effort.

If effort synchronization fails after the model has already switched, the adapter still reports
the new model but never presents the unapplied effort as current. It retains the last successfully
applied value when that value is selectable for the new model; otherwise it temporarily omits the
effort selector until a later successful switch can rebuild truthful state.

If a future model exposes effort choices without `medium`, the first SDK-advertised effort level is
used so both `recommendedValue` and `currentValue` remain valid option values.

## SDK upgrade check

The ordinary test suite pins the SDK version whose Opus label was verified. When updating the
SDK, first run the live contract test in an authenticated environment:

```sh
RUN_INTEGRATION_TESTS=true npx vitest run src/tests/model-presentation.test.ts
```

Review any changes to the available Opus entries and their labels before updating the version
guard and, if necessary, the normalization. The live test only initializes the SDK; it sends no
model prompt.
