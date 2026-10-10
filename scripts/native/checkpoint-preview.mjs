import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

// ACP may settle a prompt at result before native sends its trailing idle.
// Only a read-only preview's explicit busy refusal is safe to poll here.
export async function checkpointPreview(request, sessionId, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const preview = await request();
    const diagnostic = `Native checkpoint preview: ${JSON.stringify(preview)}`;
    assert.equal(preview?.sessionId, sessionId, diagnostic);
    assert.equal(preview?.dryRun, true, diagnostic);
    if (preview.canRewind === false && preview.reason === "busy") {
      assert.ok(Date.now() < deadline, `Timed out waiting for native idle. ${diagnostic}`);
      await sleep(30);
      continue;
    }
    assert.equal(preview.canRewind, true, diagnostic);
    return preview;
  }
}
