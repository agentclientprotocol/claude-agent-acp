import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Pushable } from "../utils.js";
import { discoverCustomAgents, BUILTIN_AGENT_NAMES } from "../session-config-options.js";

// `discoverCustomAgents` distinguishes user/plugin-configured agents from
// Claude Code's built-in subagents by name (BUILTIN_AGENT_NAMES), since the
// SDK's `AgentInfo` carries no built-in/source flag. That hardcoded set drifts
// silently if the SDK changes its default roster: a newly added built-in would
// leak into the ACP "Agent" picker as if the user had configured it. This
// integration test runs the real SDK so the set is flagged the moment it does.
//
// Claude Code does not list every built-in in every session (issue #1670):
// `web-fetch` needs its staged rollout or `CLAUDE_CODE_WEB_FETCH_AGENT=1`, and
// `claude-code-guide` an entrypoint other than the SDK's `sdk-ts`. The test
// sets both variables, so the roster does not depend on the account or on the
// shell that runs it. A built-in behind a rollout with no variable set here
// shows up only where that rollout is on.
describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("agent discovery (SDK)", () => {
  it("BUILTIN_AGENT_NAMES exactly covers the SDK's default agent roster", async () => {
    const input = new Pushable<SDKUserMessage>();
    const q = query({
      prompt: input,
      options: {
        systemPrompt: { type: "preset", preset: "claude_code" },
        sessionId: randomUUID(),
        // No setting sources → no user/project/local custom agents are loaded,
        // so `supportedAgents()` reports exactly the intrinsic built-ins
        // regardless of what the developer has in ~/.claude/agents.
        settingSources: [],
        includePartialMessages: true,
        env: {
          ...process.env,
          CLAUDE_CODE_WEB_FETCH_AGENT: "1",
          CLAUDE_CODE_ENTRYPOINT: "agent-roster-test",
        },
      },
    });

    try {
      const reported = (await q.supportedAgents()).map((a) => a.name).sort();
      expect(reported).toEqual([...BUILTIN_AGENT_NAMES].sort());

      // With the built-ins being the only agents present, discovery surfaces
      // nothing — the ACP "Agent" picker is correctly omitted.
      expect(await discoverCustomAgents(q)).toEqual([]);
    } finally {
      input.end();
      q.return(undefined);
    }
  }, 30000);
});
