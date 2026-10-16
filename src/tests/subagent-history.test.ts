import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { subagentLineage } from "../subagent-history.js";

const sessionId = "33333333-3333-4333-8333-333333333333";
const base = {
  sessionId,
  cwd: "/tmp/proj",
  version: "2.0.0",
  userType: "external",
  isSidechain: false,
  timestamp: "2026-10-13T00:00:00.000Z",
};
const user = (uuid: string, text: string) => ({
  ...base,
  type: "user",
  uuid,
  message: { role: "user", content: text },
});
/** An assistant message that launches an agent with the Agent call `launchId`. */
const launch = (uuid: string, launchId: string) => ({
  ...base,
  type: "assistant",
  uuid,
  message: {
    id: `m-${uuid}`,
    role: "assistant",
    model: "claude-opus-5",
    content: [
      {
        type: "tool_use",
        id: launchId,
        name: "Agent",
        input: { description: "Work", prompt: "Work" },
      },
    ],
  },
});
const meta = (toolUseId: string, name: string) => ({
  agentType: "general-purpose",
  description: "Work",
  name,
  toolUseId,
});

describe("subagentLineage", () => {
  let configDir: string;
  let originalConfigDir: string | undefined;
  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), "claude-acp-lineage-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });
  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    await rm(configDir, { recursive: true, force: true });
  });

  /** Writes the session's transcript and, for each agent, its transcript and metadata. */
  async function writeSession(
    root: object[],
    agents: Record<string, { meta: object; records: object[] }>,
  ): Promise<void> {
    const directory = path.join(configDir, "projects", "-tmp-proj");
    await mkdir(path.join(directory, sessionId, "subagents"), { recursive: true });
    const lines = (records: object[]) => {
      let parentUuid: string | null = null;
      return records
        .map((record) => {
          const linked = "parentUuid" in record ? record : { ...record, parentUuid };
          parentUuid = (record as { uuid: string }).uuid;
          return JSON.stringify(linked);
        })
        .join("\n")
        .concat("\n");
    };
    await writeFile(path.join(directory, `${sessionId}.jsonl`), lines(root));
    for (const [agentId, agent] of Object.entries(agents)) {
      const sidechain = agent.records.map((record) => ({ ...record, isSidechain: true, agentId }));
      await writeFile(
        path.join(directory, sessionId, "subagents", `agent-${agentId}.jsonl`),
        lines(sidechain),
      );
      await writeFile(
        path.join(directory, sessionId, "subagents", `agent-${agentId}.meta.json`),
        JSON.stringify(agent.meta),
      );
    }
  }
  const logger = { error: () => {} };

  it("places an agent that the session launched under the root", async () => {
    await writeSession([user("u1", "Go"), launch("a1", "launch-echoer")], {
      echoer1: { meta: meta("launch-echoer", "echoer"), records: [user("e1", "Work")] },
    });

    await expect(subagentLineage(sessionId, "echoer1", logger)).resolves.toEqual([
      {
        agentId: "echoer1",
        launchId: "launch-echoer",
        name: "echoer",
        agentType: "general-purpose",
        description: "Work",
      },
    ]);
  });

  it("places a nested agent under the agent whose transcript has its launch, root first", async () => {
    await writeSession(
      [user("u1", "Go"), launch("a1", "launch-sibling"), launch("a2", "launch-coordinator")],
      {
        sibling1: { meta: meta("launch-sibling", "sibling"), records: [user("s1", "Work")] },
        coordinator1: {
          meta: meta("launch-coordinator", "coordinator"),
          records: [user("c1", "Work"), launch("c2", "launch-worker")],
        },
        worker1: { meta: meta("launch-worker", "worker"), records: [user("w1", "Work")] },
      },
    );

    const lineage = await subagentLineage(sessionId, "worker1", logger);

    expect(
      lineage.map(({ agentId, launchId, parentAgentId }) => ({ agentId, launchId, parentAgentId })),
    ).toEqual([
      { agentId: "coordinator1", launchId: "launch-coordinator", parentAgentId: undefined },
      { agentId: "worker1", launchId: "launch-worker", parentAgentId: "coordinator1" },
    ]);
  });

  const boundary = (uuid: string) => ({
    ...base,
    type: "system",
    subtype: "compact_boundary",
    uuid,
    parentUuid: null,
    content: "Conversation compacted",
  });

  /** The root's launch comes before a compaction, which drops it from the SDK's active chain. */
  it("places an agent whose launch the root made before a compaction", async () => {
    await writeSession(
      [user("u1", "Go"), launch("a1", "launch-echoer"), boundary("b1"), user("u2", "More")],
      { echoer1: { meta: meta("launch-echoer", "echoer"), records: [user("e1", "Work")] } },
    );

    const lineage = await subagentLineage(sessionId, "echoer1", logger);

    expect(lineage.map(({ agentId, launchId }) => ({ agentId, launchId }))).toEqual([
      { agentId: "echoer1", launchId: "launch-echoer" },
    ]);
  });

  /** An agent's own launch of a nested agent comes before a compaction in that agent's transcript. */
  it("places a nested agent whose launch its parent agent made before a compaction", async () => {
    await writeSession([user("u1", "Go"), launch("a1", "launch-coordinator")], {
      coordinator1: {
        meta: meta("launch-coordinator", "coordinator"),
        records: [
          user("c1", "Work"),
          launch("c2", "launch-worker"),
          boundary("c3"),
          user("c4", "More"),
        ],
      },
      worker1: { meta: meta("launch-worker", "worker"), records: [user("w1", "Work")] },
    });

    const lineage = await subagentLineage(sessionId, "worker1", logger);

    expect(
      lineage.map(({ agentId, launchId, parentAgentId }) => ({ agentId, launchId, parentAgentId })),
    ).toEqual([
      { agentId: "coordinator1", launchId: "launch-coordinator", parentAgentId: undefined },
      { agentId: "worker1", launchId: "launch-worker", parentAgentId: "coordinator1" },
    ]);
  });

  /** A sidechain record in the root file is an agent's launch, so it does not make the root the parent. */
  it("does not take a launch in a sidechain record of the root file for the root's", async () => {
    await writeSession(
      [user("u1", "Go"), { ...launch("a1", "launch-worker"), isSidechain: true }],
      {
        worker1: { meta: meta("launch-worker", "worker"), records: [user("w1", "Work")] },
      },
    );

    await expect(subagentLineage(sessionId, "worker1", logger)).resolves.toEqual([]);
  });

  it("is empty for an agent whose launch no transcript has, since its parent is unknown", async () => {
    await writeSession([user("u1", "Go")], {
      lost1: { meta: meta("launch-lost", "lost"), records: [user("l1", "Work")] },
    });

    await expect(subagentLineage(sessionId, "lost1", logger)).resolves.toEqual([]);
  });

  it("is empty for a nested agent when an ancestor's launch is in no transcript", async () => {
    // The worker's launch is in the coordinator's transcript, but the
    // coordinator's own launch is in none, so the chain has no root.
    await writeSession([user("u1", "Go")], {
      coordinator1: {
        meta: meta("launch-coordinator", "coordinator"),
        records: [user("c1", "Work"), launch("c2", "launch-worker")],
      },
      worker1: { meta: meta("launch-worker", "worker"), records: [user("w1", "Work")] },
    });

    await expect(subagentLineage(sessionId, "worker1", logger)).resolves.toEqual([]);
  });

  it("is empty for an agent without metadata", async () => {
    await writeSession([user("u1", "Go"), launch("a1", "launch-echoer")], {
      echoer1: { meta: meta("launch-echoer", "echoer"), records: [user("e1", "Work")] },
    });

    await expect(subagentLineage(sessionId, "other1", logger)).resolves.toEqual([]);
  });
});
