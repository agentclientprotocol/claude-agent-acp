import { describe, expect, it, vi } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import {
  RemoteControlAtStartup,
  type RemoteControlCommand,
  startsWithRemoteControl,
} from "../remote-control.js";

type EnableRemoteControl = (enabled: boolean) => Promise<{ session_url?: string }>;

/** A session for `RemoteControlAtStartup.connect` whose query serves
 *  `enableRemoteControl` when it is given. */
function startupSession(
  enableRemoteControl: EnableRemoteControl | undefined,
  { working = false, closed = false } = {},
) {
  const query = (enableRemoteControl ? { enableRemoteControl } : {}) as unknown as Query;
  return {
    sessionId: "session-1",
    logger: { log: vi.fn(), error: vi.fn() },
    query: () => (closed ? undefined : query),
    working: () => working,
  };
}

const connects = () => vi.fn(async () => ({ session_url: "https://claude.ai/code/session_123" }));

describe("startsWithRemoteControl", () => {
  /** The Remote Control fields of the `initialize` result of Claude Code
   *  2.1.303 with `remoteControlAtStartup: true` in the user settings. */
  const reported = {
    remote_control_auto_enable: true,
    remote_control_auto_connect_default: false,
    remote_control_available: true,
    remote_control_auto_on_by_default: false,
  };

  it.each([
    [true, "asks for it", reported],
    [
      false,
      "does not ask for it",
      { ...reported, remote_control_auto_enable: false, remote_control_auto_on_by_default: true },
    ],
    [false, "predates the field", {}],
  ])("is %s when Claude Code %s", (expected, _case, fields) => {
    expect(startsWithRemoteControl({ models: [], ...fields } as any)).toBe(expected);
  });
});

describe("RemoteControlAtStartup", () => {
  it.each([
    [
      { session_url: "https://claude.ai/code/session_123" },
      "Continue this session from claude.ai/code or the Claude mobile app: https://claude.ai/code/session_123\nRun /remote-control off to disconnect.",
    ],
    [{}, "Claude Code did not return a session URL.\nRun /remote-control off to disconnect."],
  ])("connects once and resolves a notice of %j", async (result, description) => {
    const enableRemoteControl = vi.fn(async () => result);
    const session = startupSession(enableRemoteControl);
    const startup = new RemoteControlAtStartup(true);

    const notice = await startup.connect(session);
    const again = startup.connect(session);

    expect(notice).toEqual({ severity: "info", title: "Remote Control connected", description });
    expect(again).toBeUndefined();
    expect(enableRemoteControl).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("resolves a refusal as a warning", async () => {
    const session = startupSession(async () => {
      throw new Error("Remote Control is disabled by policy");
    });

    const notice = await new RemoteControlAtStartup(true).connect(session);

    expect(notice).toEqual({
      severity: "warning",
      title: "Could not start Remote Control",
      description: "Remote Control is disabled by policy",
    });
    expect(session.logger.error).toHaveBeenCalledExactlyOnceWith(
      "Failed to enable Remote Control: Error: Remote Control is disabled by policy",
    );
  });

  it.each([
    ["Claude Code did not ask for it", false, { supported: true, closed: false }],
    ["the query has no Remote Control", true, { supported: false, closed: false }],
    ["the query is closed", true, { supported: true, closed: true }],
  ])("starts nothing when %s", (_case, asked, { supported, closed }) => {
    const enableRemoteControl = connects();
    const session = startupSession(supported ? enableRemoteControl : undefined, { closed });

    const notice = new RemoteControlAtStartup(asked).connect(session);

    expect(notice).toBeUndefined();
    expect(enableRemoteControl).not.toHaveBeenCalled();
  });

  it("starts nothing while the session is busy, and says so in the log", () => {
    const enableRemoteControl = connects();
    const session = startupSession(enableRemoteControl, { working: true });

    const notice = new RemoteControlAtStartup(true).connect(session);

    expect(notice).toBeUndefined();
    expect(enableRemoteControl).not.toHaveBeenCalled();
    expect(session.logger.log).toHaveBeenCalledExactlyOnceWith(
      "Session session-1 is busy, so Remote Control does not start with it. /remote-control starts it.",
    );
  });

  it.each<[string, RemoteControlCommand[], number]>([
    ["no /remote-control", [], 1],
    ["/remote-control off", [{ action: "disconnect" }], 0],
    [
      "/remote-control off, then /remote-control",
      [{ action: "disconnect" }, { action: "connect" }],
      1,
    ],
  ])(
    "after %s on the old query, a restart's query connects %i times",
    async (_case, commands, calls) => {
      const previous = new RemoteControlAtStartup(true);
      commands.forEach((command) => previous.commandRan(command));
      const enableRemoteControl = connects();
      const restarted = new RemoteControlAtStartup(true);

      restarted.restartedFrom(previous);
      await restarted.connect(startupSession(enableRemoteControl));

      expect(enableRemoteControl).toHaveBeenCalledTimes(calls);
    },
  );

  it("keeps Remote Control off through a second restart", async () => {
    const first = new RemoteControlAtStartup(true);
    first.commandRan({ action: "disconnect" });
    const second = new RemoteControlAtStartup(true);
    second.restartedFrom(first);
    const enableRemoteControl = connects();
    const third = new RemoteControlAtStartup(true);

    third.restartedFrom(second);
    await third.connect(startupSession(enableRemoteControl));

    expect(enableRemoteControl).not.toHaveBeenCalled();
  });
});
