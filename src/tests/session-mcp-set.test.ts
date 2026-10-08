import { describe, expect, it, vi } from "vitest";
import {
  parseSessionMcpSetRequest,
  sessionMcpState,
  setSessionMcpServers,
  type SessionMcpState,
} from "../session-mcp-set.js";
const host = {
  name: "host",
  command: "node",
  args: ["test.mjs"],
  env: [{ name: "TOKEN", value: "secret" }],
};
function fixture() {
  const state: SessionMcpState = {
    revision: 0,
    hostServers: [host],
    protectedServers: { internal: { type: "stdio", command: "internal" } },
  };
  const query = {
    mcpServerStatus: vi.fn(async () => [
      { name: "host", status: "connected" as const, source: "dynamic" },
    ]),
    setMcpServers: vi.fn(async () => ({
      added: [],
      removed: ["host"],
      errors: {} as Record<string, string>,
    })),
  };
  return { state, query, invalidate: vi.fn() };
}
describe("live MCP replacement", () => {
  it("rejects duplicate and prototype names and invalid transport fields", () => {
    for (const mcpServers of [
      [host, host],
      [{ ...host, name: "__proto__" }],
      [{ ...host, type: "sdk" }],
    ]) {
      expect(() =>
        parseSessionMcpSetRequest({ sessionId: "s", expectedRevision: 0, mcpServers }),
      ).toThrow();
    }
  });
  it("checks revision before even reading the running servers", async () => {
    const f = fixture();
    await expect(
      setSessionMcpServers(
        f.query,
        f.state,
        { sessionId: "s", expectedRevision: 2, mcpServers: [] },
        "s",
        f.invalidate,
      ),
    ).rejects.toThrow("revision");
    expect(f.query.mcpServerStatus).not.toHaveBeenCalled();
  });
  it("preserves actual SDK servers when removing the host-managed set", async () => {
    const f = fixture();
    expect(
      await setSessionMcpServers(
        f.query,
        f.state,
        { sessionId: "s", expectedRevision: 0, mcpServers: [] },
        "s",
        f.invalidate,
      ),
    ).toMatchObject({ status: "ok", revision: 1 });
    expect(f.query.setMcpServers).toHaveBeenCalledWith(f.state.protectedServers);
    expect(f.state.hostServers).toEqual([]);
  });
  it("does not let host config take ownership of settings or plugin servers", async () => {
    const f = fixture();
    f.query.mcpServerStatus.mockResolvedValue([
      { name: "host", status: "connected", source: "plugin" },
    ]);
    await expect(
      setSessionMcpServers(
        f.query,
        f.state,
        { sessionId: "s", expectedRevision: 0, mcpServers: [host] },
        "s",
        f.invalidate,
      ),
    ).rejects.toThrow("owned");
    expect(f.query.setMcpServers).not.toHaveBeenCalled();
  });
  it("allows a recorded host server labelled sdk, but protects unknown sources", async () => {
    const f = fixture();
    f.query.mcpServerStatus.mockResolvedValue([
      { name: "host", status: "connected", source: "sdk" },
    ]);
    await expect(
      setSessionMcpServers(
        f.query,
        f.state,
        { sessionId: "s", expectedRevision: 0, mcpServers: [host] },
        "s",
        f.invalidate,
      ),
    ).resolves.toMatchObject({ status: "ok" });
    f.query.mcpServerStatus.mockResolvedValue([
      { name: "foreign", status: "connected", source: "other" },
    ]);
    await expect(
      setSessionMcpServers(
        f.query,
        f.state,
        { sessionId: "s", expectedRevision: 1, mcpServers: [{ ...host, name: "foreign" }] },
        "s",
        f.invalidate,
      ),
    ).rejects.toThrow("owned");
  });
  it("returns partial on native partial changes and never leaks diagnostic secrets", async () => {
    const f = fixture();
    f.query.setMcpServers.mockResolvedValue({
      added: [],
      removed: ["host"],
      errors: { broken: "auth secret" },
    });
    const response = await setSessionMcpServers(
      f.query,
      f.state,
      { sessionId: "s", expectedRevision: 0, mcpServers: [] },
      "s",
      f.invalidate,
    );
    expect(response).toMatchObject({
      status: "partial",
      revision: 1,
      removed: ["host"],
      failedServers: ["broken"],
    });
    expect(JSON.stringify(response)).not.toContain("secret");
  });
  it("invalidates an uncertain mutation and refuses a blind retry", async () => {
    const f = fixture();
    f.query.setMcpServers.mockRejectedValue(new Error("lost ack"));
    const request = { sessionId: "s", expectedRevision: 0, mcpServers: [] };
    await expect(
      setSessionMcpServers(f.query, f.state, request, "s", f.invalidate),
    ).rejects.toThrow("uncertain");
    expect(f.invalidate).toHaveBeenCalledOnce();
    await expect(
      setSessionMcpServers(f.query, f.state, request, "s", f.invalidate),
    ).rejects.toThrow("uncertain");
    expect(f.query.setMcpServers).toHaveBeenCalledOnce();
  });
  it("does not expose credentials in the client revision snapshot", () => {
    expect(sessionMcpState(fixture().state)).toEqual({
      version: 1,
      revision: 0,
      uncertain: false,
      servers: [{ name: "host", type: "stdio" }],
    });
  });
});
