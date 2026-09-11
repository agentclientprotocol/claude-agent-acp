# AIR diff statistics

The adapter supplies counts in each ACP diff block through `_meta.jetbrains.air.diffStats`.
This uses the same contract as the Codex adapter. No capability negotiation is required.

```json
{
  "jetbrains": {
    "air": {
      "version": 1,
      "diffStats": { "version": 1, "added": 20, "removed": 30 }
    }
  }
}
```

Both counts are nonnegative integers. They describe the operations in that block's patch.
Context lines and EOF markers do not increase the counts.
The extension carries no navigation position.

For `Edit` and `Write`, the adapter counts operations while it builds diff texts from the SDK's `structuredPatch`.
Each hunk produces one block with its own counts. The adapter does not compare or scan the full file texts for statistics.

When a patch has inconsistent line counts or unsupported prefixes, the adapter omits the statistics.
Empty patches, initial tool inputs, and history without structured patches retain their existing behavior.
They provide no statistics because the adapter has no patch operations to count.
AIR uses its existing comparison when statistics are absent.
