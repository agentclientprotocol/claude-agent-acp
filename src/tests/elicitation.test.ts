import { describe, it, expect } from "vitest";
import type { CreateElicitationRequest, CreateElicitationResponse } from "@agentclientprotocol/sdk";
import type { ElicitationRequest } from "@anthropic-ai/claude-agent-sdk";
import {
  applyAskElicitationResponse,
  askUserQuestionsToCreateRequest,
  AskUserQuestion,
  createElicitationResponseToElicitResult,
  extractAskUserQuestions,
  mcpElicitationToCreateRequest,
} from "../elicitation.js";

const SESSION_ID = "session-1";

/**
 * Build a question matching the SDK's (strict) AskUserQuestion schema while
 * keeping test sites terse. Option descriptions default to "" (the tool always
 * provides one); pass a description to exercise the "label — description" title.
 */
function mkQuestion(
  question: string,
  options: Array<{ label: string; description?: string }>,
  opts: { header?: string; multiSelect?: boolean } = {},
): AskUserQuestion {
  return {
    question,
    header: opts.header ?? "",
    multiSelect: opts.multiSelect ?? false,
    options: options.map((o) => ({ label: o.label, description: o.description ?? "" })),
  } as AskUserQuestion;
}

describe("mcpElicitationToCreateRequest", () => {
  it("maps a form-mode request, defaulting the schema type to object", () => {
    const request: ElicitationRequest = {
      serverName: "server",
      message: "Need your name",
      mode: "form",
      requestedSchema: { properties: { name: { type: "string" } } },
    };

    const result = mcpElicitationToCreateRequest(request, SESSION_ID);

    expect(result).toEqual({
      mode: "form",
      sessionId: SESSION_ID,
      message: "Need your name",
      requestedSchema: { type: "object", properties: { name: { type: "string" } } },
    });
  });

  it("maps a url-mode request and preserves the elicitation id", () => {
    const request: ElicitationRequest = {
      serverName: "server",
      message: "Authorize",
      mode: "url",
      url: "https://example.com/auth",
      elicitationId: "el-123",
    };

    expect(mcpElicitationToCreateRequest(request, SESSION_ID)).toEqual({
      mode: "url",
      sessionId: SESSION_ID,
      message: "Authorize",
      url: "https://example.com/auth",
      elicitationId: "el-123",
    });
  });

  it("generates an elicitation id when a url request omits one", () => {
    const request: ElicitationRequest = {
      serverName: "server",
      message: "Authorize",
      mode: "url",
      url: "https://example.com/auth",
    };

    const result = mcpElicitationToCreateRequest(request, SESSION_ID);
    expect(result?.mode).toBe("url");
    expect((result as { elicitationId: string }).elicitationId).toMatch(/.+/);
  });

  it("returns null for a url request with no url", () => {
    const request: ElicitationRequest = {
      serverName: "server",
      message: "Authorize",
      mode: "url",
    };

    expect(mcpElicitationToCreateRequest(request, SESSION_ID)).toBeNull();
  });
});

describe("createElicitationResponseToElicitResult", () => {
  it("maps accept with content", () => {
    const response = { action: "accept", content: { name: "Ada" } } as CreateElicitationResponse;
    expect(createElicitationResponseToElicitResult(response)).toEqual({
      action: "accept",
      content: { name: "Ada" },
    });
  });

  it("defaults accept content to an empty object", () => {
    const response = { action: "accept" } as CreateElicitationResponse;
    expect(createElicitationResponseToElicitResult(response)).toEqual({
      action: "accept",
      content: {},
    });
  });

  it("maps decline and cancel", () => {
    expect(
      createElicitationResponseToElicitResult({ action: "decline" } as CreateElicitationResponse),
    ).toEqual({ action: "decline" });
    expect(
      createElicitationResponseToElicitResult({ action: "cancel" } as CreateElicitationResponse),
    ).toEqual({ action: "cancel" });
  });
});

describe("extractAskUserQuestions", () => {
  const question = mkQuestion("Which?", [{ label: "A" }, { label: "B" }]);

  it("reads questions off the tool input", () => {
    expect(extractAskUserQuestions({ questions: [question] })).toEqual([question]);
  });

  it("returns null when there are no questions", () => {
    expect(extractAskUserQuestions({})).toBeNull();
    expect(extractAskUserQuestions({ questions: [] })).toBeNull();
  });

  it("filters out malformed questions (missing options, empty options, bad question)", () => {
    const input = {
      questions: [
        question,
        { question: "missing options" },
        { options: [] },
        { options: [], question: "empty" },
      ],
    } as unknown as Record<string, unknown>;
    expect(extractAskUserQuestions(input)).toEqual([question]);
  });

  it("returns null when every question is filtered out", () => {
    const input = {
      questions: [{ question: "no options" }, { options: [{ label: "A" }] }],
    } as unknown as Record<string, unknown>;
    expect(extractAskUserQuestions(input)).toBeNull();
  });
});

describe("askUserQuestionsToCreateRequest", () => {
  it("keys a single-select question by a stable id and carries the prompt in message only", () => {
    const questions = [
      mkQuestion(
        "Which library?",
        [{ label: "date-fns", description: "Lightweight" }, { label: "luxon" }],
        {
          header: "Library",
        },
      ),
    ];

    const result = askUserQuestionsToCreateRequest(questions, SESSION_ID, "tool-1");

    expect(result).toMatchObject({
      mode: "form",
      sessionId: SESSION_ID,
      toolCallId: "tool-1",
      message: "Which library?",
    });
    const schema = (result as Extract<CreateElicitationRequest, { mode: "form" }>).requestedSchema;
    // Nothing is required; the user can pick, type a custom answer, or skip.
    expect(schema.required).toBeUndefined();
    // Single question → no duplicated description (prompt is in `message`).
    expect(schema.properties?.["question_0"]).toEqual({
      type: "string",
      title: "Library",
      description: undefined,
      oneOf: [
        { const: "date-fns", title: "date-fns — Lightweight" },
        { const: "luxon", title: "luxon" },
      ],
    });
    // The full question text is not used as a property key.
    expect(schema.properties?.["Which library?"]).toBeUndefined();
  });

  it("includes an optional free-text custom-answer field", () => {
    const questions = [mkQuestion("Which?", [{ label: "A" }, { label: "B" }])];
    const schema = (
      askUserQuestionsToCreateRequest(questions, SESSION_ID, undefined) as Extract<
        CreateElicitationRequest,
        { mode: "form" }
      >
    ).requestedSchema;

    expect(schema.properties?.["customAnswer"]).toMatchObject({ type: "string", title: "Other" });
  });

  it("builds an array property for multi-select questions and includes per-field question text", () => {
    const questions = [
      mkQuestion("Pick one?", [{ label: "A" }, { label: "B" }]),
      mkQuestion("Which features?", [{ label: "auth" }, { label: "logging" }], {
        multiSelect: true,
      }),
    ];

    const result = askUserQuestionsToCreateRequest(questions, SESSION_ID, undefined);
    const schema = (result as Extract<CreateElicitationRequest, { mode: "form" }>).requestedSchema;

    expect(result).not.toHaveProperty("toolCallId");
    // Multiple questions → generic message, each field carries its own question.
    expect(result.message).toBe("Please answer the following questions.");
    expect(schema.properties?.["question_1"]).toEqual({
      type: "array",
      title: undefined,
      description: "Which features?",
      items: {
        anyOf: [
          { const: "auth", title: "auth" },
          { const: "logging", title: "logging" },
        ],
      },
    });
  });
});

describe("applyAskElicitationResponse", () => {
  const questions = [
    mkQuestion("Single?", [{ label: "A" }, { label: "B" }]),
    mkQuestion("Multi?", [{ label: "X" }, { label: "Y" }], { multiSelect: true }),
  ];
  const toolInput = { questions, metadata: { source: "test" } };

  it("writes selected labels (keyed by indexed fields) into updatedInput on accept", () => {
    const response = {
      action: "accept",
      content: { question_0: "A", question_1: ["X", "Y"] },
    } as CreateElicitationResponse;

    expect(applyAskElicitationResponse(response, toolInput, questions)).toEqual({
      action: "answered",
      updatedInput: {
        questions,
        metadata: { source: "test" },
        answers: { "Single?": "A", "Multi?": "X, Y" },
      },
    });
  });

  it("maps the free-text custom-answer field to the tool's response", () => {
    const response = {
      action: "accept",
      content: { question_0: "A", customAnswer: "something else entirely" },
    } as CreateElicitationResponse;

    expect(applyAskElicitationResponse(response, toolInput, questions)).toEqual({
      action: "answered",
      updatedInput: {
        questions,
        metadata: { source: "test" },
        answers: { "Single?": "A" },
        response: "something else entirely",
      },
    });
  });

  it("ignores empty selections and blank custom answers", () => {
    const response = {
      action: "accept",
      content: { question_1: [], customAnswer: "   " },
    } as CreateElicitationResponse;

    expect(applyAskElicitationResponse(response, toolInput, questions)).toEqual({
      action: "answered",
      updatedInput: { questions, metadata: { source: "test" }, answers: {} },
    });
  });

  it("treats decline as answered with no answers", () => {
    const response = { action: "decline" } as CreateElicitationResponse;
    expect(applyAskElicitationResponse(response, toolInput, questions)).toEqual({
      action: "answered",
      updatedInput: { questions, metadata: { source: "test" }, answers: {} },
    });
  });

  it("returns cancel on cancel", () => {
    const response = { action: "cancel" } as CreateElicitationResponse;
    expect(applyAskElicitationResponse(response, toolInput, questions)).toEqual({
      action: "cancel",
    });
  });

  it("omits answers for questions the user left unanswered", () => {
    const response = {
      action: "accept",
      content: { question_0: "B" },
    } as CreateElicitationResponse;

    const result = applyAskElicitationResponse(response, toolInput, questions);
    expect(result.action).toBe("answered");
    expect((result as Extract<typeof result, { action: "answered" }>).updatedInput.answers).toEqual(
      { "Single?": "B" },
    );
  });
});
