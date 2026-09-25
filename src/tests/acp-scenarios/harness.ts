/**
 * A scenario harness for the outbound ACP traffic of the adapter.
 *
 * A scenario drives a real `ClaudeAcpAgent` through `initialize`, `session/new`
 * (or `session/load`), and `session/prompt`. A scripted SDK query replaces the
 * Claude Code process: it yields SDK messages and stream events, and it calls
 * the `canUseTool` callback and the hooks that the agent registered, in the
 * order that Claude Code uses. The harness records every message that the
 * agent sends to the client.
 *
 * The harness is vitest-free. The test file mocks `query` and
 * `getSessionMessages` of the SDK with {@link mockedQuery} and
 * {@link mockedSessionMessages}.
 */
import type {
  ClientCapabilities,
  CreateElicitationRequest,
  RequestPermissionRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** One message that the agent sent to the client. */
export interface Recorded {
  kind:
    | "initialize"
    | "newSession"
    | "loadSession"
    | "sessionUpdate"
    | "requestPermission"
    | "createElicitation"
    | "completeElicitation"
    | "extNotification"
    | "promptResponse";
  payload: unknown;
}

/** A client profile: the capabilities that the client declares. */
export interface Profile {
  name: "plain" | "zed" | "air";
  capabilities: ClientCapabilities;
}

/** Every AIR capability name that the adapter knows. */
export const AIR_CAPABILITY_NAMES = [
  "nativeSubagentSessions",
  "asyncTasks",
  "sessionFailure",
  "recommendedValue",
  "diffPatch",
  "rawInputRendering",
  "planFile",
  "agentFileChangeReport",
];

const baseCapabilities: ClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
  elicitation: { form: {} },
};

export const PROFILES: Record<Profile["name"], Profile> = {
  plain: { name: "plain", capabilities: { ...baseCapabilities } },
  zed: {
    name: "zed",
    capabilities: {
      ...baseCapabilities,
      auth: { terminal: true },
      _meta: { terminal_output: true, "terminal-auth": true },
    },
  },
  air: {
    name: "air",
    capabilities: {
      ...baseCapabilities,
      _meta: {
        terminal_output: true,
        terminal_output_delta: true,
        jetbrains: { air: { version: 1, capabilities: [...AIR_CAPABILITY_NAMES] } },
      },
    },
  },
};

/** The SDK options that the agent passed to `query`. */
type QueryOptions = {
  sessionId?: string;
  resume?: string;
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    extra: Record<string, unknown>,
  ) => Promise<unknown>;
  hooks?: Record<string, { hooks: ((input: any, id: string, opts: any) => Promise<unknown>)[] }[]>;
};

/** What a scenario script reads and calls. */
export interface ScriptContext {
  cwd: string;
  /** The session id that the agent passed to the SDK. */
  sessionId: string;
  options: QueryOptions;
  /** Calls `canUseTool` like Claude Code does before it runs a tool. */
  canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    toolUseID: string,
    extra?: Record<string, unknown>,
  ): Promise<unknown>;
  /** Calls every hook callback that the agent registered for the event. */
  hook(event: string, input: Record<string, unknown>, toolUseID?: string): Promise<void>;
  /** Calls the PostToolUse hooks of a tool use. */
  postToolUse(
    toolUseID: string,
    toolName: string,
    input: unknown,
    response: unknown,
  ): Promise<void>;
}

/** A scenario: the SDK side of one or more prompt turns. */
export interface Scenario {
  name: string;
  /** Capabilities that the scenario adds to the profile, for example compaction. */
  capabilities?: Partial<ClientCapabilities>;
  /** Files to create in the working directory before the session starts. */
  files?: Record<string, string>;
  /** The permission option kind that the client selects. Default: allow_once. */
  permission?: "allow_once" | "allow_always" | "reject_once";
  /** A transcript to replay with `session/load` instead of a new session. */
  transcript?: (ctx: { cwd: string; sessionId: string }) => Record<string, unknown>[];
  /** The prompt text of each turn. Default: `prompt <n>`. */
  prompts?: string[];
  /** The SDK messages of each turn after the echo of the prompt. */
  turns: ((ctx: ScriptContext) => AsyncGenerator<Record<string, unknown>>)[];
  /** Also record the initialize response and the session/new or session/load response. */
  recordSessionResponse?: boolean;
}

/** The fixed session id of every `session/load` scenario, so that the recordings compare. */
export const SESSION_ID = "11111111-2222-4333-8444-555555555555";

/**
 * The session id of the active SDK query. Claude Code writes the session id
 * that the agent passed in `options.sessionId` (or `options.resume`) into
 * every SDK message, so the mock does the same.
 */
let sdkSessionId: string | undefined;

/** The session id that the SDK messages of the active query carry. */
export function activeSdkSessionId(): string {
  if (!sdkSessionId) throw new Error("no active SDK query");
  return sdkSessionId;
}

let activeScript:
  | {
      scenario: Scenario;
      cwd: string;
      transcript: Record<string, unknown>[];
    }
  | undefined;

/** The `query` of the SDK mock: a scripted query of the active scenario. */
export function mockedQuery(args: { prompt: AsyncIterable<any>; options: QueryOptions }) {
  if (!activeScript) throw new Error("no active scenario");
  const script = activeScript;
  const options = args.options;
  // Claude Code uses `sessionId` for a new or forked session and `resume` for
  // a continued one. A query without either gets a random id, which no
  // scenario expects.
  const sessionId = options.sessionId ?? options.resume;
  if (!sessionId) throw new Error("the agent passed no session id to the SDK");
  sdkSessionId = sessionId;
  const ctx: ScriptContext = {
    cwd: script.cwd,
    sessionId,
    options,
    canUseTool: (toolName, input, toolUseID, extra = {}) =>
      options.canUseTool!(toolName, input, {
        signal: new AbortController().signal,
        suggestions: [],
        toolUseID,
        ...extra,
      }),
    async hook(event, input, toolUseID) {
      for (const matcher of options.hooks?.[event] ?? []) {
        for (const callback of matcher.hooks) {
          await callback(
            { hook_event_name: event, session_id: sessionId, cwd: script.cwd, ...input },
            toolUseID ?? "",
            { signal: new AbortController().signal },
          );
        }
      }
    },
    postToolUse(toolUseID, toolName, input, response) {
      return ctx.hook(
        "PostToolUse",
        { tool_name: toolName, tool_input: input, tool_response: response, tool_use_id: toolUseID },
        toolUseID,
      );
    },
  };
  async function* run() {
    const iterator = args.prompt[Symbol.asyncIterator]();
    for (const turn of script.scenario.turns) {
      const next = await iterator.next();
      if (next.done) return;
      const user = next.value;
      yield {
        type: "user",
        message: user.message,
        parent_tool_use_id: null,
        uuid: user.uuid,
        session_id: sessionId,
        isReplay: true,
      };
      yield* turn(ctx);
    }
    // Stay open like a live Claude Code process.
    await iterator.next();
  }
  const generator = run();
  return Object.assign(generator, {
    initializationResult: async () => ({
      models: [
        {
          value: "claude-sonnet-4-6",
          displayName: "Claude Sonnet",
          description: "Fast",
          supportsAutoMode: true,
        },
      ],
      commands: [],
    }),
    setModel: async () => {},
    setPermissionMode: async () => {},
    supportedCommands: async () => [],
    supportedAgents: async () => [],
    mcpServerStatus: async () => [],
    getContextUsage: async () => ({ totalTokens: 0, rawMaxTokens: 200000 }),
    close: () => {},
    interrupt: async () => undefined,
    stopTask: async () => undefined,
  });
}

/** The `getSessionMessages` of the SDK mock: the transcript of the active scenario. */
export async function mockedSessionMessages(): Promise<Record<string, unknown>[]> {
  return activeScript?.transcript ?? [];
}

type AgentClass = new (client: any, logger?: any) => any;

/** The outbound messages of one scenario run. */
export interface ScenarioRun {
  /** The ACP session id of the run. */
  sessionId: string;
  /** The messages as the agent sent them. */
  raw: Recorded[];
  /** The messages with the run-specific values replaced (see {@link normalize}). */
  normalized: Recorded[];
}

/** Runs one scenario for one profile and records every outbound message. */
export async function runScenario(
  Agent: AgentClass,
  profile: Profile,
  scenario: Scenario,
): Promise<ScenarioRun> {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acp-scenario-")));
  for (const [file, text] of Object.entries(scenario.files ?? {})) {
    const target = path.join(cwd, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  const recorded: Recorded[] = [];
  const record = (kind: Recorded["kind"], payload: unknown) =>
    recorded.push({ kind, payload: structuredClone(payload) });
  const client = {
    async sessionUpdate(notification: SessionNotification) {
      record("sessionUpdate", notification);
    },
    async requestPermission(request: RequestPermissionRequest) {
      record("requestPermission", request);
      const wanted = scenario.permission ?? "allow_once";
      const option =
        request.options.find((o) => o.kind === wanted) ??
        request.options.find((o) => o.kind.startsWith(wanted.split("_")[0])) ??
        request.options[0];
      return { outcome: { outcome: "selected", optionId: option.optionId } };
    },
    async createElicitation(request: CreateElicitationRequest) {
      record("createElicitation", request);
      const schema = (request as any).requestedSchema as
        { properties?: Record<string, any> } | undefined;
      const content: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(schema?.properties ?? {})) {
        const values = property.enum ?? property.oneOf?.map((o: any) => o.const);
        if (Array.isArray(values) && values.length > 0) content[key] = values[0];
      }
      return { action: "accept", content };
    },
    async completeElicitation(params: unknown) {
      record("completeElicitation", params);
    },
    async extNotification(method: string, params: unknown) {
      record("extNotification", { method, params });
    },
    async readTextFile() {
      return { content: "" };
    },
    async writeTextFile() {
      return {};
    },
  };
  // The `_meta` of the scenario adds to the `_meta` of the profile, so AIR stays AIR.
  const capabilities: ClientCapabilities = {
    ...profile.capabilities,
    ...scenario.capabilities,
    ...(profile.capabilities._meta || scenario.capabilities?._meta
      ? { _meta: { ...profile.capabilities._meta, ...scenario.capabilities?._meta } }
      : {}),
  };
  generatedIds.clear();
  activeScript = {
    scenario,
    cwd,
    transcript: scenario.transcript?.({ cwd, sessionId: SESSION_ID }) ?? [],
  };
  const logger = { log: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
  const agent = new Agent(client, logger);
  let sessionId: string | undefined;
  try {
    const initialized = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: capabilities,
    });
    if (scenario.recordSessionResponse) record("initialize", initialized);
    const opened = scenario.transcript
      ? await agent.loadSession({ sessionId: SESSION_ID, cwd, mcpServers: [] })
      : await agent.newSession({ cwd, mcpServers: [] });
    if (scenario.recordSessionResponse) {
      record(scenario.transcript ? "loadSession" : "newSession", opened);
    }
    const acpSessionId: string = scenario.transcript ? SESSION_ID : opened.sessionId;
    sessionId = acpSessionId;
    await settle();
    for (let turn = 0; turn < scenario.turns.length; turn++) {
      const response = await agent.prompt({
        sessionId: acpSessionId,
        prompt: [{ type: "text", text: scenario.prompts?.[turn] ?? `prompt ${turn + 1}` }],
      });
      record("promptResponse", response);
      await settle();
    }
    const raw = [...recorded];
    return {
      sessionId: acpSessionId,
      raw,
      normalized: normalize(raw, cwd, acpSessionId, generatedIds) as Recorded[],
    };
  } finally {
    activeScript = undefined;
    sdkSessionId = undefined;
    try {
      if (sessionId) await agent.unstable_closeSession?.({ sessionId });
    } catch {
      // The session is already gone.
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 2));
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The version of this adapter in `package.json`, which `agentInfo` reports. */
const PACKAGE_VERSION: string = JSON.parse(
  fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
).version;

/** The ids that `randomUUID` of `node:crypto` generated during the active run. */
const generatedIds = new Set<string>();

/**
 * Records an id that `randomUUID` generated. The test file wraps `randomUUID`
 * of `node:crypto` with this function, so that {@link normalize} replaces only
 * the ids that the run generated.
 */
export function noteGeneratedId(id: string): void {
  generatedIds.add(id);
}

/**
 * Replaces the values that change from run to run. Each rule replaces only an
 * exact known value, so a recording shows every other value:
 *
 * - the temporary working directory of the run and `os.homedir()`;
 * - `process.execPath` in a `command` key;
 * - the exact prefix `process.argv.slice(1)` of an `args` array;
 * - the version of this adapter in a `version` key;
 * - the session id, and the ids in `generated` (the ids that `randomUUID`
 *   generated during the run). Each id gets a name in the order of its first
 *   appearance, so a message that names a wrong id still differs.
 *
 * A UUID that the scenario scripted (an SDK message uuid, a tool use id) is
 * the same in each run and stays in the recording.
 */
export function normalize(
  value: unknown,
  cwd: string,
  sessionId: string,
  generated: ReadonlySet<string> = new Set(),
): unknown {
  const ids = new Map<string, string>([[sessionId, "<session>"]]);
  const home = os.homedir();
  const argv = process.argv.slice(1);
  const visit = (node: unknown, key?: string): unknown => {
    if (typeof node === "string") {
      // A terminal-auth command reruns this Node binary, whose path depends on
      // the machine. Any other command stays as it is, so a recording shows it.
      if (key === "command" && node === process.execPath) return "<executable>";
      if (key === "version" && node === PACKAGE_VERSION) return "<version>";
      const text = node.split(cwd).join("<cwd>").split(home).join("<home>");
      return text.replace(UUID, (id) => {
        if (!ids.has(id)) {
          if (!generated.has(id)) return id;
          ids.set(id, `<id-${ids.size}>`);
        }
        return ids.get(id)!;
      });
    }
    if (Array.isArray(node)) {
      // A terminal-auth command reruns this process with its own argv, which
      // depends on the test runner. Only that exact prefix is replaced.
      if (key === "args" && startsWith(node, argv)) {
        return ["<argv>", ...node.slice(argv.length).map((item) => visit(item))];
      }
      return node.map((item) => visit(item));
    }
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, visit(v, k)]),
      );
    }
    return node;
  };
  return visit(value);
}

function startsWith(array: unknown[], prefix: string[]): boolean {
  return prefix.length > 0 && prefix.every((item, i) => array[i] === item);
}

// ---------------------------------------------------------------------------
// SDK message builders.

let counter = 0;
function uuid(): string {
  counter++;
  const hex = counter.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

export function resetIds() {
  counter = 0;
}

type Parent = string | null;

function streamEvent(event: Record<string, unknown>, parent: Parent) {
  return {
    type: "stream_event",
    event,
    parent_tool_use_id: parent,
    uuid: uuid(),
    session_id: activeSdkSessionId(),
  };
}

/** A streamed assistant message: message_start, the blocks, message_stop. */
export function* streamMessage(
  messageId: string,
  blocks: (
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  )[],
  parent: Parent = null,
) {
  yield streamEvent(
    {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    parent,
  );
  for (const [index, block] of blocks.entries()) {
    if (block.type === "text") {
      yield streamEvent(
        { type: "content_block_start", index, content_block: { type: "text", text: "" } },
        parent,
      );
      for (const piece of halves(block.text)) {
        yield streamEvent(
          { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } },
          parent,
        );
      }
    } else if (block.type === "thinking") {
      yield streamEvent(
        {
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        parent,
      );
      for (const piece of halves(block.thinking)) {
        yield streamEvent(
          {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking: piece },
          },
          parent,
        );
      }
    } else {
      yield streamEvent(
        {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        },
        parent,
      );
      // The input streams in pieces that end after each top-level field, so
      // the agent sees the partial input grow field by field.
      const json = JSON.stringify(block.input);
      for (const piece of jsonPieces(json)) {
        yield streamEvent(
          {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: piece },
          },
          parent,
        );
      }
    }
    yield streamEvent({ type: "content_block_stop", index }, parent);
  }
  yield streamEvent(
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    parent,
  );
  yield streamEvent({ type: "message_stop" }, parent);
}

function halves(text: string): string[] {
  if (text.length < 2) return [text];
  const middle = Math.floor(text.length / 2);
  return [text.slice(0, middle), text.slice(middle)];
}

/** Splits a JSON object after each top-level comma. */
function jsonPieces(json: string): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === "," && depth === 1) {
      pieces.push(json.slice(start, i + 1));
      start = i + 1;
    }
  }
  pieces.push(json.slice(start));
  return pieces;
}

/** The consolidated assistant message. */
export function assistant(
  messageId: string,
  content: Record<string, unknown>[],
  parent: Parent = null,
) {
  return {
    type: "assistant",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: parent,
    uuid: uuid(),
    session_id: activeSdkSessionId(),
  };
}

/** A streamed and then consolidated assistant message. */
export function* assistantTurn(
  messageId: string,
  blocks: Parameters<typeof streamMessage>[1],
  parent: Parent = null,
) {
  yield* streamMessage(messageId, blocks, parent);
  yield assistant(
    messageId,
    blocks.map((block) =>
      block.type === "thinking" ? { ...block, signature: "sig" } : (block as any),
    ),
    parent,
  );
}

/** A tool_result user message. */
export function toolResult(
  toolUseId: string,
  content: unknown,
  options: { isError?: boolean; structured?: unknown; parent?: Parent } = {},
) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
          ...(options.isError ? { is_error: true } : {}),
        },
      ],
    },
    parent_tool_use_id: options.parent ?? null,
    ...(options.structured !== undefined ? { tool_use_result: options.structured } : {}),
    uuid: uuid(),
    session_id: activeSdkSessionId(),
  };
}

/** A system message. */
export function system(subtype: string, fields: Record<string, unknown> = {}) {
  return { type: "system", subtype, uuid: uuid(), session_id: activeSdkSessionId(), ...fields };
}

/** The successful result of a turn. */
export function result(overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    stop_reason: "end_turn",
    is_error: false,
    result: "",
    errors: [],
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: uuid(),
    session_id: activeSdkSessionId(),
    ...overrides,
  };
}

/** A tool call that runs with permission: stream, approval, hook, and result. */
export async function* toolCall(
  ctx: ScriptContext,
  tool: { id: string; name: string; input: Record<string, unknown> },
  outcome: {
    content: unknown;
    isError?: boolean;
    structured?: unknown;
    hookResponse?: unknown;
    ask?: boolean;
    parent?: Parent;
    /** The agent id that Claude Code passes to `canUseTool` inside a subagent. */
    agentID?: string;
  },
) {
  const parent = outcome.parent ?? null;
  yield* assistantTurn(`msg_${tool.id}`, [{ type: "tool_use", ...tool }], parent);
  if (outcome.ask) {
    await ctx.canUseTool(
      tool.name,
      tool.input,
      tool.id,
      outcome.agentID ? { agentID: outcome.agentID } : {},
    );
  }
  yield toolResult(tool.id, outcome.content, {
    isError: outcome.isError,
    structured: outcome.structured,
    parent,
  });
  // The PostToolUse hook callback normally arrives after the tool_result.
  if (outcome.hookResponse !== undefined) {
    // The CLI writes the file of a Write before the hook, and the hook patch reads it.
    const written = outcome.hookResponse as { filePath?: unknown; content?: unknown };
    if (
      tool.name === "Write" &&
      typeof written.filePath === "string" &&
      typeof written.content === "string"
    ) {
      fs.writeFileSync(written.filePath, written.content);
    }
    await ctx.postToolUse(tool.id, tool.name, tool.input, outcome.hookResponse);
  }
}
