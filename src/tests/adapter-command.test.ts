import type { Query, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  adapterAvailableCommands,
  adapterCommand,
  mayBeAdapterCommand,
  type AdapterCommandContext,
} from "../adapter-command.js";

const text = (value: string) => [{ type: "text", text: value }];
const slash = (name: string): SlashCommand =>
  ({ name, description: "", argumentHint: "" }) as SlashCommand;

function fakeQuery(commands: string[], remoteControl = true): Query {
  return {
    supportedCommands: async () => commands.map(slash),
    ...(remoteControl
      ? { enableRemoteControl: async () => ({ session_url: "https://example.test/s" }) }
      : {}),
  } as unknown as Query;
}

const context = (remoteSession = false): AdapterCommandContext => ({
  cwd: "/tmp",
  env: {},
  remoteSession,
  query: () => undefined,
  logError: () => {},
});

describe("adapterCommand", () => {
  it("serves /remote-control and runs it", async () => {
    const command = await adapterCommand(
      text("/remote-control"),
      fakeQuery([]),
      undefined,
      context(),
    );

    expect(command?.name).toBe("remote-control");
    expect(command?.busyMessage).toBe(
      "Remote Control can't be changed while Claude is working. Try again when the turn ends.",
    );
    expect(command?.inFlightMessage).toBe(
      "Remote Control is already being changed. Try again in a moment.",
    );
    await expect(command!.run(new AbortController().signal)).resolves.toContain(
      "https://example.test/s",
    );
  });

  it("does not serve /remote-control without SDK support or when Claude Code offers it", async () => {
    expect(
      await adapterCommand(text("/remote-control"), fakeQuery([], false), undefined, context()),
    ).toBeNull();
    expect(
      await adapterCommand(
        text("/remote-control"),
        fakeQuery(["remote-control"]),
        undefined,
        context(),
      ),
    ).toBeNull();
  });

  it.each(["/plugin", "/plugins", "/marketplace list", "/plugin list"])(
    "serves %s",
    async (prompt) => {
      const command = await adapterCommand(text(prompt), fakeQuery([]), undefined, context());

      expect(command?.name).toBe("plugin");
      expect(command?.busyMessage).toContain("/plugin can't run while Claude is working");
    },
  );

  it.each(["plugin", "plugins", "marketplace"])(
    "does not serve /%s when Claude Code offers it",
    async (name) => {
      expect(
        await adapterCommand(text(`/${name}`), fakeQuery([name]), undefined, context()),
      ).toBeNull();
    },
  );

  it("serves /plugins when Claude Code offers only /plugin", async () => {
    expect(
      await adapterCommand(text("/plugins"), fakeQuery(["plugin"]), undefined, context()),
    ).not.toBeNull();
  });

  it("serves /plugin when Claude Code's is terminal-bound", async () => {
    expect(
      await adapterCommand(text("/plugin"), fakeQuery(["plugin"]), ["plugin"], context()),
    ).not.toBeNull();
  });

  it("does not serve /plugin for a remote session", async () => {
    expect(
      await adapterCommand(text("/plugin"), fakeQuery([]), undefined, context(true)),
    ).toBeNull();
  });

  it.each(["/review", "plugin", "/pluginx", "/remote-controls"])("passes %s on", async (prompt) => {
    expect(await adapterCommand(text(prompt), fakeQuery([]), undefined, context())).toBeNull();
  });
});

describe("mayBeAdapterCommand", () => {
  it.each<[string, boolean]>([
    ["/remote-control", true],
    ["/remote-control off", true],
    ["/plugin", true],
    ["/plugins list", true],
    ["/marketplace", true],
    ["/pluginx", false],
    ["hello /plugin", false],
    ["/review", false],
  ])("%s -> %s", (prompt, expected) => {
    expect(mayBeAdapterCommand(text(prompt))).toBe(expected);
  });

  it("is false for multi-block prompts", () => {
    expect(mayBeAdapterCommand([...text("/plugin"), ...text("x")])).toBe(false);
  });
});

describe("adapterAvailableCommands", () => {
  const names = (list: { name: string }[]) => list.map((command) => command.name);

  it("lists remote-control and plugin", () => {
    expect(
      names(adapterAvailableCommands([], undefined, fakeQuery([]), { remoteSession: false })),
    ).toEqual(["remote-control", "plugin"]);
  });

  it("omits plugin for a remote session and remote-control without support", () => {
    expect(
      names(adapterAvailableCommands([], undefined, fakeQuery([]), { remoteSession: true })),
    ).toEqual(["remote-control"]);
    expect(
      names(adapterAvailableCommands([], undefined, fakeQuery([], false), { remoteSession: true })),
    ).toEqual([]);
    expect(
      names(adapterAvailableCommands([], undefined, undefined, { remoteSession: false })),
    ).toEqual(["plugin"]);
  });

  it("agrees with dispatch on a bare /plugin", async () => {
    const cases: { offered: string[]; terminal?: string[]; remoteSession: boolean }[] = [
      { offered: [], remoteSession: false },
      { offered: ["plugin"], remoteSession: false },
      { offered: ["plugin"], terminal: ["plugin"], remoteSession: false },
      { offered: ["plugins"], remoteSession: false },
      { offered: [], remoteSession: true },
    ];
    for (const { offered, terminal, remoteSession } of cases) {
      const query = fakeQuery(offered);
      const listed = names(
        adapterAvailableCommands(offered.map(slash), terminal, query, { remoteSession }),
      ).includes("plugin");
      const served =
        (await adapterCommand(text("/plugin"), query, terminal, context(remoteSession))) !== null;
      expect(listed, JSON.stringify({ offered, terminal, remoteSession })).toBe(served);
    }
  });
});
