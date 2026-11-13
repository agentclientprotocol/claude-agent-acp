import { describe, expect, it } from "vitest";
import { UnansweredServerToolCalls } from "../server-tool-calls.js";

const text = { type: "text", text: "Next." };
const advisorCall = (id: string) => ({ type: "server_tool_use", id, name: "advisor", input: {} });
const advisorResult = (id: string) => ({
  type: "advisor_tool_result",
  tool_use_id: id,
  content: { type: "advisor_result", text: "Check the edge case." },
});
const bashCall = (id: string) => ({ type: "tool_use", id, name: "Bash", input: {} });

describe("UnansweredServerToolCalls", () => {
  it("never ends a call that its own reply answers", () => {
    const calls = new UnansweredServerToolCalls();
    calls.replyStarted(null, "msg_1");
    expect(calls.take(null, advisorCall("srvtoolu_1"))).toEqual([]);
    expect(calls.take(null, advisorResult("srvtoolu_1"))).toEqual([]);
    expect(calls.take(null, text)).toEqual([]);
    calls.replyStarted(null, "msg_2");
    expect(calls.take(null, text)).toEqual([]);
  });

  it("waits for the next reply to start with the result of a call its reply left pending", () => {
    const calls = new UnansweredServerToolCalls();
    calls.replyStarted(null, "msg_1");
    calls.take(null, bashCall("toolu_1"));
    calls.take(null, advisorCall("srvtoolu_1"));
    calls.replyStarted(null, "msg_2");
    expect(calls.take(null, advisorResult("srvtoolu_1"))).toEqual([]);
    expect(calls.take(null, text)).toEqual([]);
  });

  it("ends a call still waiting once a later reply starts any other block, and only once", () => {
    const calls = new UnansweredServerToolCalls();
    calls.replyStarted(null, "msg_cut_off");
    calls.take(null, advisorCall("srvtoolu_1"));
    calls.replyStarted(null, "msg_asked_again");
    expect(calls.take(null, { type: "thinking", thinking: "" })).toEqual(["srvtoolu_1"]);
    expect(calls.take(null, text)).toEqual([]);
  });

  it("ends the earlier call at a later reply's own server tool use, which then waits in turn", () => {
    const calls = new UnansweredServerToolCalls();
    calls.replyStarted(null, "msg_cut_off");
    calls.take(null, advisorCall("srvtoolu_1"));
    calls.replyStarted(null, "msg_asked_again");
    expect(calls.take(null, advisorCall("srvtoolu_2"))).toEqual(["srvtoolu_1"]);
    expect(calls.take(null, text)).toEqual([]);
    calls.replyStarted(null, "msg_3");
    expect(calls.take(null, text)).toEqual(["srvtoolu_2"]);
  });

  it("takes a consolidated message's blocks as its own reply's, by the id it carries", () => {
    const calls = new UnansweredServerToolCalls();
    calls.replyStarted(null, "msg_1");
    calls.take(null, advisorCall("srvtoolu_1"));
    expect(calls.take(null, advisorCall("srvtoolu_1"), "msg_1")).toEqual([]);
    expect(calls.take(null, text, "msg_1")).toEqual([]);
    expect(calls.take(null, text, "msg_2")).toEqual(["srvtoolu_1"]);
  });

  it("follows calls of a reply that was not streamed, by its consolidated messages", () => {
    const calls = new UnansweredServerToolCalls();
    expect(calls.take(null, advisorCall("srvtoolu_1"), "msg_1")).toEqual([]);
    expect(calls.take(null, text, "msg_2")).toEqual(["srvtoolu_1"]);
  });

  it("keeps each stream's calls to that stream", () => {
    const calls = new UnansweredServerToolCalls();
    calls.replyStarted(null, "msg_main");
    calls.take(null, advisorCall("srvtoolu_main"));
    calls.replyStarted("toolu_agent", "msg_sub_1");
    calls.take("toolu_agent", advisorCall("srvtoolu_sub"));
    calls.replyStarted("toolu_agent", "msg_sub_2");
    expect(calls.take("toolu_agent", text)).toEqual(["srvtoolu_sub"]);
    calls.replyStarted(null, "msg_main_2");
    expect(calls.take(null, text)).toEqual(["srvtoolu_main"]);
  });

  it("does not follow the calls of a reply of unknown id", () => {
    const calls = new UnansweredServerToolCalls();
    calls.replyStarted(null, undefined);
    calls.take(null, advisorCall("srvtoolu_1"));
    expect(calls.take(null, text)).toEqual([]);
    calls.replyStarted(null, "msg_2");
    expect(calls.take(null, text)).toEqual([]);
  });

  it("forgets the calls of a subagent that ended", () => {
    const calls = new UnansweredServerToolCalls();
    calls.replyStarted("toolu_agent", "msg_sub_1");
    calls.take("toolu_agent", advisorCall("srvtoolu_sub"));
    calls.forget("toolu_agent");
    calls.replyStarted("toolu_agent", "msg_sub_2");
    expect(calls.take("toolu_agent", text)).toEqual([]);
  });
});
