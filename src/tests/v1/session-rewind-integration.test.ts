import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "crypto";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "fs/promises";
import os from "os";
import path from "path";
import { ClaudeAcpAgent } from "../../v1/acp-agent.js";
import type { AcpClient } from "../../acp-client.js";
import { AIR_SESSION_REWIND_CAPABILITY } from "../../air-extension.js";

type Update = { sessionId: string; update: Record<string, any> };

/** A client that records every notification, and the agent over it. */
async function startAgent() {
  const updates: Update[] = [];
  const client = {
    sessionUpdate: async (notification: Update) => {
      updates.push(notification);
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as unknown as AcpClient;
  const agent = new ClaudeAcpAgent(client);
  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      session: { cursors: {} },
      _meta: {
        jetbrains: { air: { version: 1, capabilities: [AIR_SESSION_REWIND_CAPABILITY] } },
      },
    },
  } as any);
  return { agent, updates };
}
type Started = Awaited<ReturnType<typeof startAgent>>;

const textOf = (updates: Update[], kind: string) =>
  updates
    .filter((n) => n.update.sessionUpdate === kind && n.update.content?.type === "text")
    .map((n) => n.update.content.text as string)
    .join("");

const cursorsOf = (updates: Update[]) =>
  updates.filter((n) => n.update.sessionUpdate === "cursor_update").map((n) => n.update);

/** Finds `<sessionId>.jsonl` under the user's real Claude config (auth lives there). */
async function findTranscript(sessionId: string): Promise<string> {
  const projects = path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    "projects",
  );
  for (const dir of await readdir(projects)) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // not in this project directory
    }
  }
  throw new Error(`No transcript for ${sessionId}`);
}

/** Findings of the hook scenario go to a file when REWIND_IT_NOTES names one: vitest swallows console output here. */
const note = async (...parts: unknown[]) => {
  if (process.env.REWIND_IT_NOTES) {
    await appendFile(process.env.REWIND_IT_NOTES, parts.map(String).join(" ") + "\n");
  }
};

const rewindJson = async (sessionId: string) => {
  const transcript = await findTranscript(sessionId);
  try {
    return JSON.parse(
      await readFile(path.join(path.dirname(transcript), sessionId, "rewind.json"), "utf8"),
    );
  } catch {
    return undefined;
  }
};

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("session rewind against the real CLI", () => {
  const agents: Started["agent"][] = [];
  const dirs: string[] = [];
  const transcripts: string[] = [];

  afterEach(async () => {
    for (const agent of agents.splice(0)) await agent.dispose();
    for (const file of transcripts.splice(0)) {
      await rm(file, { force: true });
      await rm(file.replace(/\.jsonl$/, ""), { recursive: true, force: true });
    }
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function workDir(settings?: object) {
    const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "rewind-it-")));
    dirs.push(cwd);
    if (settings) {
      await mkdir(path.join(cwd, ".claude"));
      await writeFile(path.join(cwd, ".claude", "settings.local.json"), JSON.stringify(settings));
    }
    return cwd;
  }

  async function begin(cwd: string) {
    const started = await startAgent();
    agents.push(started.agent);
    const { sessionId } = await started.agent.newSession({ cwd, mcpServers: [] });
    await started.agent.setSessionConfigOption({ sessionId, configId: "model", value: "haiku" });
    return { ...started, sessionId, cwd };
  }

  /** Prompts, and returns the reply and the cursor that the prompt got (if any). */
  async function ask({ agent, updates, sessionId }: Started & { sessionId: string }, text: string) {
    const mark = updates.length;
    await agent.prompt({ sessionId, prompt: [{ type: "text", text }] });
    const mine = updates.slice(mark);
    const cursors = cursorsOf(mine);
    return {
      reply: textOf(mine, "agent_message_chunk"),
      cursor: cursors.at(-1) as Record<string, any> | undefined,
    };
  }

  const say = (word: string) => `Remember the word ${word}. Reply with exactly: ${word}`;
  const recall = "What were my previous messages? List them all, quoting the words.";

  /** Three turns; the cursors of turns B and C. */
  async function threeTurns(cwd: string) {
    const s = await begin(cwd);
    transcripts.push("");
    const a = await ask(s, say("ZEBRA"));
    const b = await ask(s, say("MANGO"));
    const c = await ask(s, say("COBALT"));
    transcripts[transcripts.length - 1] = await findTranscript(s.sessionId);
    return { s, a, b, c };
  }

  const rewind = (s: { agent: ClaudeAcpAgent; sessionId: string }, cursorId: string) =>
    s.agent.rewindSession({ sessionId: s.sessionId, cursorId });

  /** The text of the user messages replayed by `session/load` in a fresh agent. */
  async function reload(sessionId: string, cwd: string) {
    const fresh = await startAgent();
    agents.push(fresh.agent);
    await fresh.agent.loadSession({ sessionId, cwd, mcpServers: [] });
    return { ...fresh, sessionId, replayed: textOf(fresh.updates, "user_message_chunk") };
  }

  it("1: rewinds the last turn; the first prompt has no cursor", async () => {
    const { s, a, b, c } = await threeTurns(await workDir());
    expect(a.cursor).toBeUndefined();
    expect(b.cursor?.cursorId).toMatch(/^before:/);
    expect(c.cursor?.capabilities).toHaveProperty("rewind");

    expect(await rewind(s, c.cursor!.cursorId)).toEqual({ rewound: true });
    expect(await rewindJson(s.sessionId)).toBeDefined();

    const { reply } = await ask(s, recall);
    expect(reply).toContain("ZEBRA");
    expect(reply).toContain("MANGO");
    expect(reply).not.toContain("COBALT");
  }, 300000);

  it("2: rewinds an earlier turn", async () => {
    const { s, b } = await threeTurns(await workDir());
    expect(await rewind(s, b.cursor!.cursorId)).toEqual({ rewound: true });

    const { reply } = await ask(s, recall);
    expect(reply).toContain("ZEBRA");
    expect(reply).not.toContain("MANGO");
    expect(reply).not.toContain("COBALT");
  }, 300000);

  it("3a: two rewinds in a row without a prompt", async () => {
    const { s, b, c } = await threeTurns(await workDir());
    expect(await rewind(s, c.cursor!.cursorId)).toEqual({ rewound: true });
    expect(await rewind(s, b.cursor!.cursorId)).toEqual({ rewound: true });

    const { reply } = await ask(s, recall);
    expect(reply).toContain("ZEBRA");
    expect(reply).not.toContain("MANGO");
    expect(reply).not.toContain("COBALT");
  }, 300000);

  it("3b: two rewinds with a prompt in between", async () => {
    const { s, b, c } = await threeTurns(await workDir());
    expect(await rewind(s, c.cursor!.cursorId)).toEqual({ rewound: true });
    const d = await ask(s, say("PAPAYA"));
    expect(await rewind(s, b.cursor!.cursorId)).toEqual({ rewound: true });

    const { reply } = await ask(s, recall);
    expect(reply).toContain("ZEBRA");
    expect(reply).not.toContain("MANGO");
    expect(reply).not.toContain("COBALT");
    expect(reply).not.toContain("PAPAYA");
    expect(d.cursor).toBeDefined();
  }, 300000);

  describe("4: persistence", () => {
    it.each([
      ["with a new prompt after the rewind", true],
      ["with no prompt after the rewind", false],
    ])(
      "%s",
      async (_, prompted) => {
        const cwd = await workDir();
        const { s, c } = await threeTurns(cwd);
        expect(await rewind(s, c.cursor!.cursorId)).toEqual({ rewound: true });
        if (prompted) await ask(s, say("PAPAYA"));
        await s.agent.closeSession({ sessionId: s.sessionId });

        const loaded = await reload(s.sessionId, cwd);
        expect(loaded.replayed).toContain("ZEBRA");
        expect(loaded.replayed).toContain("MANGO");
        expect(loaded.replayed).not.toContain("COBALT");
        if (prompted) expect(loaded.replayed).toContain("PAPAYA");

        const { reply } = await ask(loaded, recall);
        expect(reply).toContain("ZEBRA");
        expect(reply).toContain("MANGO");
        expect(reply).not.toContain("COBALT");
      },
      300000,
    );
  });

  it("5: unknown cursor is -32602, a running prompt is busy", async () => {
    const { s, c } = await threeTurns(await workDir());
    await expect(rewind(s, `before:${randomUUID()}`)).rejects.toMatchObject({ code: -32602 });

    const mark = s.updates.length;
    const running = s.agent.prompt({
      sessionId: s.sessionId,
      prompt: [
        { type: "text", text: "Write the numbers from 1 to 600, one per line, nothing else." },
      ],
    });
    while (!textOf(s.updates.slice(mark), "agent_message_chunk")) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await rewind(s, c.cursor!.cursorId)).toEqual({ rewound: false, reason: "busy" });
    await running;
  }, 300000);

  it("6: SessionStart hook, rewind with no prompt, then reload", async () => {
    const hook = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The secret code word is KIWI."}}'`,
              },
            ],
          },
        ],
      },
    };
    const cwd = await workDir(hook);
    const { s, c } = await threeTurns(cwd);
    expect(await rewind(s, c.cursor!.cursorId)).toEqual({ rewound: true });
    await s.agent.closeSession({ sessionId: s.sessionId });

    const lines = (await readFile(transcripts.at(-1)!, "utf8")).trimEnd().split("\n");
    await note(
      "TRANSCRIPT TAIL (hook, after rewind):\n" +
        lines
          .slice(-8)
          .map((line) => line.slice(0, 600))
          .join("\n"),
    );
    await note(
      "PARENTLESS NON-USER LINES:",
      lines
        .map((line) => JSON.parse(line))
        .filter((l) => l.parentUuid == null && l.type !== "user" && l.type !== "last-prompt")
        .map((l) => `${l.type}/${l.subtype ?? l.attachment?.type ?? ""}`),
    );
    await note(
      "LINE TYPES:",
      lines
        .map((line, index) => {
          const l = JSON.parse(line);
          return `${index}:${l.type}/${l.subtype ?? l.attachment?.type ?? l.operation ?? ""}${l.parentUuid == null ? "(root)" : ""}`;
        })
        .join(" "),
    );
    await note("rewind.json:", JSON.stringify(await rewindJson(s.sessionId)));

    const loaded = await reload(s.sessionId, cwd);
    expect(loaded.replayed).toContain("MANGO");
    expect(loaded.replayed).not.toContain("COBALT");
    const { reply } = await ask(loaded, recall);
    expect(reply).toContain("MANGO");
    expect(reply).not.toContain("COBALT");
  }, 300000);
});
