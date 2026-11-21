import { describe, expect, it } from "vitest";
import { AnnouncedChildren, type AcpSessionNotification } from "../acp-subagents.js";

describe("AnnouncedChildren", () => {
  const announce = (children: AnnouncedChildren, parent: string, child: string) =>
    children.sending({
      sessionId: parent,
      update: { sessionUpdate: "subagent_update", sessionId: child },
    });

  it("knows a child from its subagent_update, under the root of its parent", () => {
    const children = new AnnouncedChildren();
    announce(children, "root", "coordinator");
    announce(children, "coordinator", "worker");

    expect(["root", "coordinator", "worker"].map((id) => children.rootOf(id))).toEqual([
      undefined,
      "root",
      "root",
    ]);
    expect(["root", "coordinator", "worker"].map((id) => children.has(id))).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("takes no child from the subagent_spawned of AIR's draft", () => {
    const children = new AnnouncedChildren();
    const spawned: AcpSessionNotification = {
      sessionId: "root",
      update: {
        sessionUpdate: "subagent_spawned",
        subagentSessionId: "spawned",
        name: "Explore",
        task: "Look around",
        capabilities: {},
      },
    };
    children.sending(spawned);

    expect(children.has("spawned")).toBe(false);
  });

  it("forgets the children of a closed root, also the nested ones, and no other root's", () => {
    const children = new AnnouncedChildren();
    announce(children, "root", "coordinator");
    announce(children, "coordinator", "worker");
    announce(children, "other-root", "other-child");

    children.rootClosed("root");

    expect(["coordinator", "worker", "other-child"].map((id) => children.has(id))).toEqual([
      false,
      false,
      true,
    ]);
  });
});
