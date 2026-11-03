import { describe, expect, it, vi } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { SessionNotice } from "../../session-notices.js";
import { type RemoteControlHost, SessionRemoteControl } from "../../v2/remote-control.js";

/** A session's Remote Control whose query serves `enableRemoteControl` when
 *  it is given, and whose session is working when `working` is set. */
function createRemoteControl(
  enableRemoteControl: ((enabled: boolean) => Promise<{ session_url?: string }>) | undefined,
  working = false,
) {
  const notices: SessionNotice[] = [];
  const logger = { log: vi.fn(), error: vi.fn() };
  const query = (enableRemoteControl ? { enableRemoteControl } : {}) as unknown as Query;
  const host: RemoteControlHost = {
    logger,
    sessionId: "session-1",
    query: () => query,
    terminalCommands: () => undefined,
    idle: async () => true,
    begin: () => {},
    end: () => {},
    working: () => working,
    notice: (notice) => notices.push(notice),
  };
  return { remoteControl: new SessionRemoteControl(host), notices, logger };
}

describe("Remote Control at the start of a v2 query", () => {
  it("connects once and reports it in a notice", async () => {
    const enableRemoteControl = vi.fn(async () => ({
      session_url: "https://claude.ai/code/session_123",
    }));
    const { remoteControl, notices } = createRemoteControl(enableRemoteControl);
    remoteControl.atStartup = true;

    await remoteControl.connectAtStartup();
    await remoteControl.connectAtStartup();

    expect(enableRemoteControl).toHaveBeenCalledExactlyOnceWith(true);
    expect(notices).toEqual([
      {
        severity: "info",
        title: "Remote Control connected",
        description:
          "Continue this session from claude.ai/code or the Claude mobile app: https://claude.ai/code/session_123\nRun /remote-control off to disconnect.",
      },
    ]);
  });

  it("reports a refusal in a warning", async () => {
    const { remoteControl, notices } = createRemoteControl(async () => {
      throw new Error("Remote Control is disabled by policy");
    });
    remoteControl.atStartup = true;

    await remoteControl.connectAtStartup();

    expect(notices).toEqual([
      {
        severity: "warning",
        title: "Could not start Remote Control",
        description: "Remote Control is disabled by policy",
      },
    ]);
  });

  it.each([
    ["Claude Code did not ask for it", false, true],
    ["the query has no Remote Control", true, false],
  ])("starts nothing when %s", async (_case, asked, supported) => {
    const enableRemoteControl = vi.fn(async () => ({ session_url: "https://claude.ai/code/s" }));
    const { remoteControl, notices } = createRemoteControl(
      supported ? enableRemoteControl : undefined,
    );
    remoteControl.atStartup = asked;

    await remoteControl.connectAtStartup();

    expect(enableRemoteControl).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it("starts nothing while Claude is working, and says so in the log", async () => {
    const enableRemoteControl = vi.fn(async () => ({ session_url: "https://claude.ai/code/s" }));
    const { remoteControl, notices, logger } = createRemoteControl(enableRemoteControl, true);
    remoteControl.atStartup = true;

    await remoteControl.connectAtStartup();

    expect(enableRemoteControl).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
    expect(logger.log).toHaveBeenCalledExactlyOnceWith(
      "Session session-1: Claude is working, so Remote Control does not start with the session. /remote-control starts it.",
    );
  });
});
