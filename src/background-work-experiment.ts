/** Opt-in wire prototype for RFD 2452 over the installed native task adapters. */
type Json = Record<string, unknown>;
type Task = {
  id: string;
  toolCallId?: string;
  canStop: boolean;
  final: boolean;
  supported: boolean;
};
type Session = {
  state: string;
  known: boolean;
  level?: Set<string>;
  tasks: Map<string, Task>;
  tools: Set<string>;
  finalTools: Set<string>;
  children: Set<string>;
};
function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

export class BackgroundWorkExperiment {
  private sessions = new Map<string, Session>();
  private requests = new Map<unknown, { method: string; sessionId?: string }>();
  private cancellations = new Set<unknown>();
  private protocol = 1;
  private session(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        state: "idle",
        known: false,
        tasks: new Map(),
        tools: new Set(),
        finalTools: new Set(),
        children: new Set(),
      };
      this.sessions.set(id, session);
    }
    return session;
  }
  private notification(sessionId: string, update: Json): Json {
    return {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    };
  }
  snapshot(sessionId: string): Json {
    const session = this.session(sessionId);
    const live = [...session.tasks.values()].filter(
      (task) => !task.final && session.level?.has(task.id),
    );
    const complete =
      session.known &&
      session.children.size === 0 &&
      [...(session.level ?? [])].every((id) => {
        const task = session.tasks.get(id);
        return (
          task &&
          task.supported &&
          !task.final &&
          task.toolCallId !== undefined &&
          session.tools.has(task.toolCallId) &&
          !session.finalTools.has(task.toolCallId)
        );
      });
    return this.notification(sessionId, {
      sessionUpdate: "state_update",
      state: session.state,
      background: complete
        ? live.map((task) => ({
            type: "tool_call",
            toolCallId: task.toolCallId,
          }))
        : null,
    });
  }
  inbound(message: Json): { forward?: Json; send: Json[] } {
    const params = object(message["params"]);
    const sessionId = typeof params["sessionId"] === "string" ? params["sessionId"] : undefined;
    const send: Json[] = [];
    if (message["method"] === "initialize") {
      this.protocol = typeof params["protocolVersion"] === "number" ? params["protocolVersion"] : 1;
      const capabilities = object(params["clientCapabilities"]),
        meta = object(capabilities["_meta"]);
      const jetbrains = object(meta["jetbrains"]),
        air = object(jetbrains["air"]);
      const old = Array.isArray(air["capabilities"]) ? air["capabilities"] : [];
      // The native task adapters already implement these private capabilities.
      message = {
        ...message,
        params: {
          ...params,
          clientCapabilities: {
            ...capabilities,
            _meta: {
              ...meta,
              jetbrains: {
                ...jetbrains,
                air: {
                  ...air,
                  version: 1,
                  capabilities: [...new Set([...old, "asyncTasks", "backgroundSubagents"])],
                },
              },
            },
          },
        },
      };
    }
    if (["session/resume", "session/load"].includes(String(message["method"])) && sessionId) {
      const session = this.session(sessionId);
      session.known = false;
      delete session.level;
      session.tools.clear();
    }
    if (message["method"] === "tool_call/cancel") {
      const session = sessionId ? this.session(sessionId) : undefined;
      const task =
        session &&
        [...session.tasks.values()].find(
          (task) =>
            !task.final &&
            task.supported &&
            task.canStop &&
            task.toolCallId === params["toolCallId"] &&
            task.toolCallId !== undefined &&
            session.tools.has(task.toolCallId) &&
            !session.finalTools.has(task.toolCallId),
        );
      if (!task)
        return {
          send: [
            {
              jsonrpc: "2.0",
              id: message["id"],
              error: {
                code: -32602,
                message: "Tool call is not cancellable background work",
              },
            },
          ],
        };
      this.cancellations.add(message["id"]);
      return {
        forward: {
          ...message,
          method: "_session/async_task/stop",
          params: { sessionId, asyncTaskId: task.id },
        },
        send,
      };
    }
    if (message["id"] !== undefined && typeof message["method"] === "string")
      this.requests.set(message["id"], {
        method: message["method"],
        sessionId,
      });
    if (message["method"] === "session/prompt" && sessionId && this.protocol < 2) {
      this.session(sessionId).state = "running";
      send.push(this.snapshot(sessionId));
    }
    return { forward: message, send };
  }
  outbound(message: Json): Json[] {
    if (!message["method"] && this.cancellations.delete(message["id"])) {
      if (message["error"]) return [message];
      return object(message["result"])["stopped"] === true
        ? [{ ...message, result: {} }]
        : [
            {
              jsonrpc: "2.0",
              id: message["id"],
              error: {
                code: -32602,
                message: "Native cancellation was not accepted",
              },
            },
          ];
    }
    const request = !message["method"] ? this.requests.get(message["id"]) : undefined;
    if (request) {
      this.requests.delete(message["id"]);
      const result = object(message["result"]);
      const id = typeof result["sessionId"] === "string" ? result["sessionId"] : request.sessionId;
      if (id && !message["error"]) {
        if (request.method === "session/new" || request.method === "session/fork") {
          if (request.method === "session/fork") {
            this.session(id).known = true;
            this.session(id).level = new Set();
          }
          return [message, this.snapshot(id)];
        }
        if (request.method === "session/resume" || request.method === "session/load")
          return [this.snapshot(id), message];
        if (request.method === "session/close") this.sessions.delete(id);
      }
      if (id && request.method === "session/prompt" && this.protocol < 2) {
        this.session(id).state = "idle";
        return [this.snapshot(id), message];
      }
    }
    const params = object(message["params"]),
      update = object(params["update"]);
    const sessionId = typeof params["sessionId"] === "string" ? params["sessionId"] : undefined;
    if (message["method"] !== "session/update" || !sessionId) return [message];
    const session = this.session(sessionId);
    const marker = object(object(update["_meta"])["backgroundWorkExperiment"]);
    if (update["sessionUpdate"] === "session_info_update" && "taskIds" in marker) {
      if (
        !Array.isArray(marker["taskIds"]) ||
        !marker["taskIds"].every((id) => typeof id === "string" && id.length > 0)
      ) {
        session.known = false;
      } else {
        session.level = new Set(marker["taskIds"] as string[]);
        session.known = true;
      }
      return [this.snapshot(sessionId)];
    }
    if (update["sessionUpdate"] === "state_update") {
      if (typeof update["state"] === "string") session.state = update["state"];
      return [
        {
          ...message,
          params: {
            ...params,
            update: {
              ...update,
              background: object(object(this.snapshot(sessionId)["params"])["update"])[
                "background"
              ],
            },
          },
        },
      ];
    }
    if (
      ["subagent_update", "_subagent_update", "subagent_spawned", "subagent_state_update"].includes(
        String(update["sessionUpdate"]),
      )
    ) {
      const id = String(update["sessionId"] ?? update["subagentSessionId"] ?? "unknown");
      const state =
        typeof update["state"] === "string" ? update["state"] : object(update["state"])["state"];
      if (["completed", "failed", "cancelled"].includes(String(state))) session.children.delete(id);
      else session.children.add(id);
      return [message, this.snapshot(sessionId)];
    }
    if (update["sessionUpdate"] === "tool_call" || update["sessionUpdate"] === "tool_call_update") {
      const id = typeof update["toolCallId"] === "string" ? update["toolCallId"] : "";
      if (id && (this.protocol >= 2 || update["sessionUpdate"] === "tool_call"))
        session.tools.add(id);
      const task = [...session.tasks.values()].find(
        (task) =>
          !task.final && task.supported && task.toolCallId === id && !session.finalTools.has(id),
      );
      if (!task && ["completed", "failed", "cancelled"].includes(String(update["status"])))
        session.finalTools.add(id);
      return task
        ? [
            {
              ...message,
              params: {
                ...params,
                update: {
                  ...update,
                  status: "in_progress",
                  capabilities: task.canStop ? { cancel: {} } : {},
                },
              },
            },
          ]
        : [message];
    }
    if (
      typeof update["sessionUpdate"] !== "string" ||
      !update["sessionUpdate"].replace(/^_/, "").startsWith("async_task_")
    )
      return [message];
    const id = typeof update["asyncTaskId"] === "string" ? update["asyncTaskId"] : undefined;
    if (!id) {
      session.known = false;
      return [message, this.snapshot(sessionId)];
    }
    let task = session.tasks.get(id);
    if (!task) {
      task = { id, canStop: false, final: false, supported: false };
      session.tasks.set(id, task);
    }
    if (String(update["sessionUpdate"]).replace(/^_/, "") === "async_task_spawned")
      task.supported = update["taskType"] === "shell";
    if (typeof update["toolCallId"] === "string") task.toolCallId = update["toolCallId"];
    if (update["canStop"] === true) task.canStop = true;
    const terminal = ["completed", "failed", "stopped"].includes(String(update["state"]));
    if (!terminal && session.level && !session.level.has(id)) session.known = false;
    const wasFinal = task.final;
    if (terminal) {
      task.final = true;
      session.level?.delete(id);
    }
    if (wasFinal) return [this.snapshot(sessionId)];
    if (
      !task.supported ||
      !task.toolCallId ||
      !session.tools.has(task.toolCallId) ||
      session.finalTools.has(task.toolCallId)
    )
      return [message, this.snapshot(sessionId)];
    const updates: Json[] = [];
    if (!wasFinal)
      updates.push(
        this.notification(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: task.toolCallId,
          status: terminal
            ? update["state"] === "stopped"
              ? this.protocol < 2
                ? "failed"
                : "cancelled"
              : update["state"]
            : "in_progress",
          capabilities: terminal ? null : task.canStop ? { cancel: {} } : {},
        }),
      );
    if (terminal) session.finalTools.add(task.toolCallId);
    return [...updates, this.snapshot(sessionId)];
  }
}

/** Draft messages are added at the stream boundary, outside the installed SDK schema. */
export function backgroundWorkStream<T>(stream: {
  readable: ReadableStream<T>;
  writable: WritableStream<T>;
}): typeof stream {
  if (process.env["ACP_BACKGROUND_WORK_EXPERIMENT"] !== "1") return stream;
  const experiment = new BackgroundWorkExperiment(),
    writer = stream.writable.getWriter();
  const send = async (messages: Json[]) => {
    for (const message of messages) await writer.write(message as T);
  };
  return {
    readable: stream.readable.pipeThrough(
      new TransformStream<T, T>({
        async transform(message, controller) {
          const result = experiment.inbound(object(message));
          await send(result["send"]);
          if (result["forward"]) controller.enqueue(result["forward"] as T);
        },
      }),
    ),
    writable: new WritableStream<T>({
      write: (message) => send(experiment.outbound(object(message))),
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    }),
  };
}
