/**
 * The scenarios of the outbound ACP traffic harness: one or more scripted
 * prompt turns per tool and per stream feature.
 */
import {
  assistant,
  assistantTurn,
  result,
  type Scenario,
  SESSION_ID,
  streamMessage,
  system,
  toolCall,
  toolResult,
} from "./harness.js";

const bashInput = { command: "ls -la", description: "List files" };

export const SCENARIOS: Scenario[] = [
  {
    name: "session-setup",
    recordSessionResponse: true,
    turns: [],
  },
  {
    name: "text-and-thinking",
    turns: [
      async function* () {
        yield* assistantTurn("msg_text", [
          { type: "thinking", thinking: "Let me think about it." },
          { type: "text", text: "Here is the answer." },
        ]);
        yield result();
      },
    ],
  },
  {
    name: "bash-foreground",
    turns: [
      async function* (ctx) {
        yield* toolCall(
          ctx,
          { id: "toolu_bash", name: "Bash", input: bashInput },
          {
            ask: true,
            content: "a.ts\nb.ts",
            structured: { stdout: "a.ts\nb.ts", stderr: "", interrupted: false, isImage: false },
            hookResponse: { stdout: "a.ts\nb.ts", stderr: "", interrupted: false, isImage: false },
          },
        );
        yield* assistantTurn("msg_done", [{ type: "text", text: "Done." }]);
        yield result();
      },
    ],
  },
  {
    name: "bash-error",
    turns: [
      async function* (ctx) {
        yield* toolCall(
          ctx,
          { id: "toolu_bash", name: "Bash", input: { command: "false", description: "Fail" } },
          { content: "Exit code 1\nboom", isError: true },
        );
        yield result();
      },
    ],
  },
  {
    name: "bash-background",
    turns: [
      async function* (ctx) {
        yield* toolCall(
          ctx,
          {
            id: "toolu_bg",
            name: "Bash",
            input: { command: "sleep 100", description: "Wait", run_in_background: true },
          },
          {
            content:
              "Command running in background with ID: bash_1. Output is being written to: /tmp/tasks/bash_1.output. You will be notified when it completes.",
            structured: {
              stdout: "",
              stderr: "",
              interrupted: false,
              isImage: false,
              backgroundTaskId: "bash_1",
            },
          },
        );
        yield system("task_started", {
          task_id: "bash_1",
          task_type: "local_bash",
          description: "sleep 100",
          tool_use_id: "toolu_bg",
          is_backgrounded: true,
        });
        yield system("task_progress", {
          task_id: "bash_1",
          description: "sleep 100",
          summary: "still running",
          usage: { total_tokens: 0, tool_uses: 0, duration_ms: 5 },
        });
        yield system("task_notification", {
          task_id: "bash_1",
          status: "completed",
          summary: "done",
          output_file: "/tmp/tasks/bash_1.output",
          tool_use_id: "toolu_bg",
        });
        yield result();
      },
    ],
  },
  {
    name: "read",
    files: { "a.ts": "const a = 1;\n" },
    turns: [
      async function* (ctx) {
        const file = `${ctx.cwd}/a.ts`;
        yield* toolCall(
          ctx,
          { id: "toolu_read", name: "Read", input: { file_path: file } },
          {
            content: "1\tconst a = 1;\n<system-reminder>x</system-reminder>",
            structured: {
              type: "text",
              file: {
                filePath: file,
                content: "const a = 1;\n",
                numLines: 1,
                startLine: 1,
                totalLines: 1,
              },
            },
            hookResponse: {
              type: "text",
              file: {
                filePath: file,
                content: "const a = 1;\n",
                numLines: 1,
                startLine: 1,
                totalLines: 1,
              },
            },
          },
        );
        yield result();
      },
    ],
  },
  {
    name: "write-new",
    turns: [
      async function* (ctx) {
        const file = `${ctx.cwd}/new.ts`;
        const input = { file_path: file, content: "export const x = 1;\n" };
        yield* toolCall(
          ctx,
          { id: "toolu_write", name: "Write", input },
          {
            ask: true,
            content: `File created successfully at: ${file}`,
            hookResponse: {
              type: "create",
              filePath: file,
              content: input.content,
              structuredPatch: [],
              originalFile: null,
            },
          },
        );
        yield result();
      },
    ],
  },
  {
    name: "write-existing",
    files: { "old.ts": "export const x = 0;\n" },
    turns: [
      async function* (ctx) {
        const file = `${ctx.cwd}/old.ts`;
        const input = { file_path: file, content: "export const x = 1;\n" };
        yield* toolCall(
          ctx,
          { id: "toolu_write", name: "Write", input },
          {
            content: `The file ${file} has been updated successfully.`,
            hookResponse: {
              type: "update",
              filePath: file,
              content: input.content,
              structuredPatch: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: ["-export const x = 0;", "+export const x = 1;"],
                },
              ],
              originalFile: "export const x = 0;\n",
            },
          },
        );
        yield result();
      },
    ],
  },
  {
    name: "edit-with-permission",
    files: { "src/app.ts": "line 1\nconst value = 1;\nline 3\n" },
    turns: [
      async function* (ctx) {
        const file = `${ctx.cwd}/src/app.ts`;
        const input = {
          file_path: file,
          old_string: "const value = 1;",
          new_string: "const value = 2;",
        };
        yield* toolCall(
          ctx,
          { id: "toolu_edit", name: "Edit", input },
          {
            ask: true,
            content: `The file ${file} has been updated successfully.`,
            hookResponse: {
              filePath: file,
              oldString: input.old_string,
              newString: input.new_string,
              originalFile: "line 1\nconst value = 1;\nline 3\n",
              structuredPatch: [
                {
                  oldStart: 1,
                  oldLines: 3,
                  newStart: 1,
                  newLines: 3,
                  lines: [" line 1", "-const value = 1;", "+const value = 2;", " line 3"],
                },
              ],
              userModified: false,
              replaceAll: false,
            },
          },
        );
        yield result();
      },
    ],
  },
  {
    name: "edit-rejected",
    permission: "reject_once",
    files: { "src/app.ts": "const value = 1;\n" },
    turns: [
      async function* (ctx) {
        const file = `${ctx.cwd}/src/app.ts`;
        yield* toolCall(
          ctx,
          {
            id: "toolu_edit",
            name: "Edit",
            input: { file_path: file, old_string: "value = 1", new_string: "value = 2" },
          },
          {
            ask: true,
            isError: true,
            content:
              "The user doesn't want to proceed with this tool use. The tool use was rejected.",
          },
        );
        yield result();
      },
    ],
  },
  {
    name: "notebook-edit",
    turns: [
      async function* (ctx) {
        const file = `${ctx.cwd}/n.ipynb`;
        yield* toolCall(
          ctx,
          {
            id: "toolu_nb",
            name: "NotebookEdit",
            input: {
              notebook_path: file,
              cell_id: "cell-1",
              new_source: "print('hi')",
              edit_mode: "replace",
            },
          },
          { ask: true, content: "Updated cell cell-1 with print('hi')" },
        );
        yield result();
      },
    ],
  },
  {
    name: "grep-and-glob",
    turns: [
      async function* (ctx) {
        yield* toolCall(
          ctx,
          {
            id: "toolu_grep",
            name: "Grep",
            input: { pattern: "value", path: "src", output_mode: "content", "-n": true },
          },
          { content: "src/app.ts:2:const value = 1;" },
        );
        yield* toolCall(
          ctx,
          { id: "toolu_glob", name: "Glob", input: { pattern: "**/*.ts" } },
          { content: "src/app.ts\nsrc/b.ts" },
        );
        yield result();
      },
    ],
  },
  {
    name: "web-fetch-and-search",
    turns: [
      async function* (ctx) {
        yield* toolCall(
          ctx,
          {
            id: "toolu_fetch",
            name: "WebFetch",
            input: { url: "https://example.com", prompt: "Summarize the page" },
          },
          { ask: true, content: "The page is an example." },
        );
        yield* toolCall(
          ctx,
          { id: "toolu_search", name: "WebSearch", input: { query: "acp protocol" } },
          {
            content: 'Web search results for query: "acp protocol"\n\nLinks: [...]',
            structured: {
              query: "acp protocol",
              results: [
                {
                  tool_use_id: "srvtoolu_1",
                  content: [{ title: "ACP", url: "https://agentclientprotocol.com" }],
                },
                "A summary.",
              ],
              durationSeconds: 1,
            },
          },
        );
        yield result();
      },
    ],
  },
  {
    name: "subagent-task-legacy",
    turns: [
      async function* (ctx) {
        const parent = "toolu_task";
        yield* assistantTurn("msg_task", [
          {
            type: "tool_use",
            id: parent,
            name: "Task",
            input: {
              description: "Explore code",
              prompt: "Find the parser",
              subagent_type: "Explore",
            },
          },
        ]);
        yield system("task_started", {
          task_id: "agent_1",
          task_type: "local_agent",
          description: "Explore code",
          subagent_type: "Explore",
          prompt: "Find the parser",
          tool_use_id: parent,
        });
        yield* assistantTurn(
          "msg_sub_1",
          [
            { type: "text", text: "Looking for the parser." },
            { type: "tool_use", id: "toolu_sub_read", name: "Read", input: { file_path: "/x.ts" } },
          ],
          parent,
        );
        yield {
          type: "tool_progress",
          tool_use_id: parent,
          tool_name: "Task",
          parent_tool_use_id: null,
          elapsed_time_seconds: 3,
          subagent_type: "Explore",
          uuid: "00000000-0000-4000-8000-00000000a001",
          session_id: SESSION_ID,
        };
        yield toolResult("toolu_sub_read", "1\tparser", { parent });
        yield* toolCall(
          ctx,
          {
            id: "toolu_sub_bash",
            name: "Bash",
            input: { command: "rg parser", description: "Search" },
          },
          { ask: true, agentID: "agent_1", parent, content: "x.ts" },
        );
        yield* toolCall(
          ctx,
          {
            id: "toolu_sub_edit",
            name: "Edit",
            input: { file_path: `${ctx.cwd}/x.ts`, old_string: "a", new_string: "b" },
          },
          {
            ask: true,
            agentID: "agent_1",
            parent,
            content: "The file has been updated.",
            hookResponse: {
              filePath: `${ctx.cwd}/x.ts`,
              oldString: "a",
              newString: "b",
              originalFile: "a\n",
              structuredPatch: [
                { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] },
              ],
              userModified: false,
              replaceAll: false,
            },
          },
        );
        yield* assistantTurn("msg_sub_2", [{ type: "text", text: "Found it." }], parent);
        yield toolResult(
          parent,
          [
            {
              type: "text",
              text: "The parser is in x.ts.\nagentId: a1 (use SendMessage to continue)",
            },
          ],
          {
            structured: {
              status: "completed",
              agentId: "a1",
              content: [{ type: "text", text: "The parser is in x.ts." }],
              totalDurationMs: 10,
              totalTokens: 5,
              totalToolUseCount: 1,
              prompt: "Find the parser",
            },
          },
        );
        await ctx.postToolUse(
          parent,
          "Task",
          {},
          {
            status: "completed",
            agentId: "a1",
            content: [{ type: "text", text: "The parser is in x.ts." }],
            totalDurationMs: 10,
            totalTokens: 5,
            totalToolUseCount: 1,
            prompt: "Find the parser",
          },
        );
        yield system("task_notification", {
          task_id: "agent_1",
          status: "completed",
          summary: "done",
          output_file: "",
          tool_use_id: parent,
        });
        yield result();
      },
    ],
  },
  {
    name: "subagent-agent-async",
    turns: [
      async function* (ctx) {
        const parent = "toolu_agent";
        const input = {
          description: "Background review",
          prompt: "Review the diff",
          subagent_type: "general-purpose",
          run_in_background: true,
        };
        yield* toolCall(
          ctx,
          { id: parent, name: "Agent", input },
          {
            content:
              "Async agent launched successfully.\nagentId: a2 (use SendMessage to continue)",
            structured: {
              status: "async_launched",
              agentId: "a2",
              description: "Background review",
              prompt: "Review the diff",
              outputFile: "/tmp/tasks/a2.output",
            },
            hookResponse: {
              status: "async_launched",
              isAsync: true,
              agentId: "a2",
              description: "Background review",
              prompt: "Review the diff",
              outputFile: "/tmp/tasks/a2.output",
            },
          },
        );
        yield system("task_started", {
          task_id: "a2",
          task_type: "local_agent",
          description: "Background review",
          subagent_type: "general-purpose",
          prompt: "Review the diff",
          tool_use_id: parent,
          is_backgrounded: true,
        });
        // The subagent streams text; only the stream carries it here.
        yield* streamMessage("msg_async_sub", [{ type: "text", text: "Reviewing now." }], parent);
        yield assistant("msg_async_sub", [{ type: "text", text: "Reviewing now." }], parent);
        yield system("task_notification", {
          task_id: "a2",
          status: "completed",
          summary: "Review done",
          output_file: "/tmp/tasks/a2.output",
          tool_use_id: parent,
        });
        yield result();
      },
    ],
  },
  {
    // With native subagent sessions, AIR gets subagent_spawned, the child tool
    // calls in the child session, and a failed subagent_state_update.
    name: "subagent-native-sessions",
    turns: [
      async function* (ctx) {
        const parent = "toolu_native";
        const input = {
          description: "Fix the build",
          prompt: "Make the build pass",
          subagent_type: "general-purpose",
        };
        yield* assistantTurn("msg_native", [
          { type: "tool_use", id: parent, name: "Agent", input },
        ]);
        yield system("task_started", {
          task_id: "agent_n",
          task_type: "local_agent",
          description: "Fix the build",
          subagent_type: "general-purpose",
          prompt: "Make the build pass",
          tool_use_id: parent,
        });
        yield* assistantTurn(
          "msg_native_sub_1",
          [
            { type: "text", text: "Running the build." },
            {
              type: "tool_use",
              id: "toolu_native_grep",
              name: "Grep",
              input: { pattern: "TODO", path: "/src" },
            },
          ],
          parent,
        );
        yield toolResult("toolu_native_grep", "src/a.ts", { parent });
        yield* toolCall(
          ctx,
          {
            id: "toolu_native_bash",
            name: "Bash",
            input: { command: "make", description: "Build" },
          },
          { ask: true, agentID: "agent_n", parent, isError: true, content: "make: *** Error 2" },
        );
        yield toolResult(parent, [{ type: "text", text: "The build still fails." }], {
          isError: true,
        });
        yield system("task_notification", {
          task_id: "agent_n",
          status: "failed",
          summary: "The build still fails.",
          output_file: "",
          tool_use_id: parent,
        });
        yield result();
      },
    ],
  },
  {
    // A subagent starts another subagent. The grandchild tool call names the
    // inner Agent tool as its parent.
    name: "subagent-nested",
    turns: [
      async function* () {
        const outer = "toolu_outer";
        const inner = "toolu_inner";
        yield* assistantTurn("msg_outer", [
          {
            type: "tool_use",
            id: outer,
            name: "Agent",
            input: {
              description: "Plan the work",
              prompt: "Plan it",
              subagent_type: "Plan",
            },
          },
        ]);
        yield system("task_started", {
          task_id: "agent_outer",
          task_type: "local_agent",
          description: "Plan the work",
          subagent_type: "Plan",
          prompt: "Plan it",
          tool_use_id: outer,
        });
        yield* assistantTurn(
          "msg_inner",
          [
            {
              type: "tool_use",
              id: inner,
              name: "Agent",
              input: {
                description: "Read the spec",
                prompt: "Read spec.md",
                subagent_type: "Explore",
              },
            },
          ],
          outer,
        );
        yield system("task_started", {
          task_id: "agent_inner",
          task_type: "local_agent",
          description: "Read the spec",
          subagent_type: "Explore",
          prompt: "Read spec.md",
          tool_use_id: inner,
        });
        yield* assistantTurn(
          "msg_grandchild",
          [
            {
              type: "tool_use",
              id: "toolu_grandchild_read",
              name: "Read",
              input: { file_path: "/spec.md" },
            },
          ],
          inner,
        );
        yield toolResult("toolu_grandchild_read", "1\tspec", { parent: inner });
        yield toolResult(inner, [{ type: "text", text: "The spec says X." }], { parent: outer });
        yield system("task_notification", {
          task_id: "agent_inner",
          status: "completed",
          summary: "The spec says X.",
          output_file: "",
          tool_use_id: inner,
        });
        yield* assistantTurn("msg_outer_text", [{ type: "text", text: "Plan: do X." }], outer);
        yield toolResult(outer, [{ type: "text", text: "Plan: do X." }]);
        yield system("task_notification", {
          task_id: "agent_outer",
          status: "completed",
          summary: "Plan: do X.",
          output_file: "",
          tool_use_id: outer,
        });
        yield result();
      },
    ],
  },
  {
    // The result and the progress of a child tool call arrive after the
    // subagent finished.
    name: "subagent-late-child-update",
    turns: [
      async function* () {
        const parent = "toolu_late";
        yield* assistantTurn("msg_late", [
          {
            type: "tool_use",
            id: parent,
            name: "Agent",
            input: {
              description: "Check the logs",
              prompt: "Check logs",
              subagent_type: "general-purpose",
            },
          },
        ]);
        yield system("task_started", {
          task_id: "agent_late",
          task_type: "local_agent",
          description: "Check the logs",
          subagent_type: "general-purpose",
          prompt: "Check logs",
          tool_use_id: parent,
        });
        yield* assistantTurn(
          "msg_late_sub",
          [
            {
              type: "tool_use",
              id: "toolu_late_read",
              name: "Read",
              input: { file_path: "/var/log/app.log" },
            },
          ],
          parent,
        );
        yield toolResult(parent, [{ type: "text", text: "The logs are clean." }]);
        yield system("task_notification", {
          task_id: "agent_late",
          status: "completed",
          summary: "The logs are clean.",
          output_file: "",
          tool_use_id: parent,
        });
        yield {
          type: "tool_progress",
          tool_use_id: "toolu_late_read",
          tool_name: "Read",
          parent_tool_use_id: parent,
          elapsed_time_seconds: 4,
          uuid: "00000000-0000-4000-8000-00000000a002",
          session_id: SESSION_ID,
        };
        yield toolResult("toolu_late_read", "1\tok", { parent });
        yield result();
      },
    ],
  },
  {
    // A client that declares the subagent-transcript extension gets the
    // complete subagent message instead of the stream.
    name: "subagent-transcript-extension",
    capabilities: { _meta: { "subagent-transcript": true } },
    turns: [
      async function* () {
        const parent = "toolu_transcript";
        yield* assistantTurn("msg_transcript", [
          {
            type: "tool_use",
            id: parent,
            name: "Task",
            input: {
              description: "Summarize",
              prompt: "Summarize the repo",
              subagent_type: "Explore",
            },
          },
        ]);
        yield system("task_started", {
          task_id: "agent_t",
          task_type: "local_agent",
          description: "Summarize",
          subagent_type: "Explore",
          prompt: "Summarize the repo",
          tool_use_id: parent,
        });
        yield* assistantTurn(
          "msg_transcript_sub",
          [
            { type: "thinking", thinking: "Look at the layout." },
            { type: "text", text: "The repo has two packages." },
            {
              type: "tool_use",
              id: "toolu_transcript_glob",
              name: "Glob",
              input: { pattern: "*" },
            },
          ],
          parent,
        );
        yield toolResult("toolu_transcript_glob", "a\nb", { parent });
        yield toolResult(parent, [{ type: "text", text: "Two packages." }]);
        yield system("task_notification", {
          task_id: "agent_t",
          status: "completed",
          summary: "Two packages.",
          output_file: "",
          tool_use_id: parent,
        });
        yield result();
      },
    ],
  },
  {
    name: "todo-write",
    turns: [
      async function* (ctx) {
        const input = {
          todos: [
            { content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
            { content: "Ship", status: "pending", activeForm: "Shipping" },
          ],
        };
        yield* toolCall(
          ctx,
          { id: "toolu_todo", name: "TodoWrite", input },
          {
            content: "Todos have been modified successfully.",
            structured: { oldTodos: [], newTodos: input.todos },
          },
        );
        yield result();
      },
    ],
  },
  {
    name: "task-create-update",
    turns: [
      async function* (ctx) {
        const create = { subject: "Write tests", description: "Cover the harness" };
        yield* assistantTurn("msg_tc", [
          { type: "tool_use", id: "toolu_tc", name: "TaskCreate", input: create },
        ]);
        await ctx.hook("TaskCreated", {
          task_id: "1",
          task_subject: "Write tests",
          task_description: "Cover the harness",
        });
        yield toolResult("toolu_tc", "Task #1 created successfully: Write tests", {
          structured: { task: { id: "1", subject: "Write tests" } },
        });
        const update = { taskId: "1", status: "in_progress" };
        yield* assistantTurn("msg_tu", [
          { type: "tool_use", id: "toolu_tu", name: "TaskUpdate", input: update },
        ]);
        yield toolResult("toolu_tu", "Updated task #1 status", {
          structured: { success: true, taskId: "1", updatedFields: ["status"] },
        });
        yield* assistantTurn("msg_tu2", [
          {
            type: "tool_use",
            id: "toolu_tu2",
            name: "TaskUpdate",
            input: { taskId: "1", status: "completed" },
          },
        ]);
        await ctx.hook("TaskCompleted", { task_id: "1", task_subject: "Write tests" });
        yield toolResult("toolu_tu2", "Updated task #1 status", {
          structured: { success: true, taskId: "1", updatedFields: ["status"] },
        });
        yield result();
      },
      // A follow-up prompt.
      async function* () {
        yield* assistantTurn("msg_follow", [{ type: "text", text: "All done." }]);
        yield result();
      },
    ],
  },
  {
    name: "goal",
    prompts: ["/goal Ship the feature"],
    turns: [
      async function* () {
        yield result();
      },
    ],
  },
  {
    name: "network-permission",
    turns: [
      async function* (ctx) {
        await ctx.canUseTool("SandboxNetworkAccess", { host: "example.com" }, "toolu_net", {
          title: "Allow network access to example.com?",
          decisionReason: "Sandbox blocks network",
        });
        yield result();
      },
    ],
  },
  {
    name: "exit-plan-approve",
    turns: [
      async function* (ctx) {
        yield* toolCall(
          ctx,
          { id: "toolu_plan", name: "ExitPlanMode", input: { plan: "# Plan\n1. Do it" } },
          {
            ask: true,
            content:
              "User has approved your plan. You can now start coding.\n\n## Approved Plan:\n# Plan\n1. Do it",
            structured: { plan: "# Plan\n1. Do it", isAgent: false },
          },
        );
        yield result();
      },
    ],
  },
  {
    name: "exit-plan-reject",
    permission: "reject_once",
    turns: [
      async function* (ctx) {
        yield* toolCall(
          ctx,
          { id: "toolu_plan", name: "ExitPlanMode", input: { plan: "# Plan\n1. Do it" } },
          {
            ask: true,
            isError: true,
            content: "```\nThe user doesn't want to proceed with this tool use.\n```",
          },
        );
        yield result();
      },
    ],
  },
  {
    name: "ask-user-question",
    turns: [
      async function* (ctx) {
        const input = {
          questions: [
            {
              question: "Which database?",
              header: "Database",
              options: [
                { label: "Postgres", description: "Relational", preview: "CREATE TABLE t ();" },
                { label: "Redis", description: "Key-value" },
              ],
              multiSelect: false,
            },
          ],
        };
        yield* toolCall(
          ctx,
          { id: "toolu_ask", name: "AskUserQuestion", input },
          {
            ask: true,
            content: 'User has answered your questions: "Which database?"="Postgres".',
            structured: { questions: input.questions, answers: { "Which database?": "Postgres" } },
          },
        );
        yield result();
      },
    ],
  },
  {
    name: "skill",
    files: { ".claude/skills/commits/SKILL.md": "# Commits\n" },
    turns: [
      async function* (ctx) {
        yield* toolCall(
          ctx,
          { id: "toolu_skill", name: "Skill", input: { skill: "commits" } },
          {
            content: "Launching skill: commits",
            structured: { success: true, commandName: "commits" },
            hookResponse: { success: true, commandName: "commits" },
          },
        );
        yield result();
      },
    ],
  },
  {
    name: "mcp-tool",
    turns: [
      async function* (ctx) {
        yield* assistantTurn("msg_mcp", [
          { type: "tool_use", id: "toolu_mcp", name: "mcp__docs__search", input: { q: "acp" } },
        ]);
        await ctx.canUseTool("mcp__docs__search", { q: "acp" }, "toolu_mcp", {
          mcpServer: { name: "docs", source: "project" },
        });
        yield toolResult("toolu_mcp", [{ type: "text", text: "Found 2 documents." }]);
        await ctx.postToolUse("toolu_mcp", "mcp__docs__search", { q: "acp" }, [
          { type: "text", text: "Found 2 documents." },
        ]);
        yield result();
      },
    ],
  },
  {
    name: "task-output-and-stop",
    turns: [
      async function* (ctx) {
        yield* toolCall(
          ctx,
          { id: "toolu_out", name: "TaskOutput", input: { task_id: "bash_1", block: true } },
          {
            content: "<retrieval_status>success</retrieval_status>\n<output>done</output>",
            structured: {
              retrieval_status: "success",
              task: { task_id: "bash_1", status: "completed", output: "done" },
            },
          },
        );
        yield* toolCall(
          ctx,
          { id: "toolu_stop", name: "TaskStop", input: { task_id: "bash_1" } },
          {
            content: "Successfully stopped task: bash_1",
            structured: { message: "Successfully stopped task: bash_1", task_id: "bash_1" },
          },
        );
        yield result();
      },
    ],
  },
  {
    name: "memory-recall",
    turns: [
      async function* () {
        yield system("memory_recall", {
          mode: "select",
          memories: [{ path: "/memory/a.md" }, { path: "/memory/b.md" }],
        });
        yield system("memory_recall", {
          mode: "synthesize",
          memories: [{ path: "/memory/c.md", content: "The user prefers tabs." }],
        });
        yield result();
      },
    ],
  },
  {
    name: "permission-denied",
    turns: [
      async function* () {
        yield* assistantTurn("msg_denied", [
          { type: "tool_use", id: "toolu_denied", name: "Bash", input: { command: "rm -rf /" } },
        ]);
        yield system("permission_denied", {
          tool_use_id: "toolu_denied",
          tool_name: "Bash",
          decision_reason_type: "rule",
          decision_reason: "Denied by rule Bash(rm:*)",
          message: "Permission to use Bash has been denied.",
        });
        yield toolResult("toolu_denied", "Permission to use Bash has been denied.", {
          isError: true,
        });
        yield result();
      },
    ],
  },
  {
    name: "tool-progress",
    turns: [
      async function* () {
        yield* assistantTurn("msg_progress", [
          { type: "tool_use", id: "toolu_slow", name: "Bash", input: { command: "make" } },
        ]);
        for (const seconds of [1, 2, 3]) {
          yield {
            type: "tool_progress",
            tool_use_id: "toolu_slow",
            tool_name: "Bash",
            parent_tool_use_id: null,
            elapsed_time_seconds: seconds,
            uuid: `00000000-0000-4000-8000-00000000b00${seconds}`,
            session_id: SESSION_ID,
          };
        }
        yield toolResult("toolu_slow", "built", {
          structured: { stdout: "built", stderr: "", interrupted: false, isImage: false },
        });
        yield result();
      },
    ],
  },
  {
    name: "rate-limit-and-origin",
    turns: [
      async function* () {
        yield* assistantTurn("msg_rate", [{ type: "text", text: "Working." }]);
        yield {
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed_warning", resetsAt: 1700000000, utilization: 0.9 },
          uuid: "00000000-0000-4000-8000-00000000e001",
          session_id: SESSION_ID,
        };
        yield result({ origin: { kind: "human" } });
      },
    ],
  },
  compactionScenario("compaction-legacy"),
  compactionScenario("compaction-update", { session: { compaction: {} } } as any),
  {
    name: "compaction-failed-legacy",
    turns: [
      async function* () {
        yield system("status", { status: "compacting" });
        yield system("status", {
          status: null,
          compact_result: "failed",
          compact_error: "Context too small",
        });
        yield result();
      },
    ],
  },
  {
    name: "session-load-replay",
    recordSessionResponse: true,
    transcript: ({ cwd, sessionId }) => {
      const file = `${cwd}/src/app.ts`;
      const entry = (
        type: string,
        message: unknown,
        uuid: string,
        parent: string | null = null,
      ) => ({
        type,
        uuid,
        session_id: sessionId,
        parent_tool_use_id: parent,
        message,
      });
      return [
        entry(
          "user",
          { role: "user", content: "Fix the bug" },
          "00000000-0000-4000-8000-00000000c001",
        ),
        entry(
          "assistant",
          {
            id: "msg_r1",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [
              { type: "thinking", thinking: "Check the file.", signature: "s" },
              { type: "text", text: "I will edit it." },
              {
                type: "tool_use",
                id: "toolu_r_bash",
                name: "Bash",
                input: { command: "ls", description: "List" },
              },
              {
                type: "tool_use",
                id: "toolu_r_edit",
                name: "Edit",
                input: { file_path: file, old_string: "a", new_string: "b" },
              },
              {
                type: "tool_use",
                id: "toolu_r_task",
                name: "Task",
                input: { description: "Explore", prompt: "Look around" },
              },
            ],
          },
          "00000000-0000-4000-8000-00000000c002",
        ),
        entry(
          "user",
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_r_bash", content: "app.ts" },
              {
                type: "tool_result",
                tool_use_id: "toolu_r_edit",
                content: `The file ${file} has been updated successfully.`,
              },
            ],
          },
          "00000000-0000-4000-8000-00000000c003",
        ),
        entry(
          "assistant",
          {
            id: "msg_r_sub",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "Subagent text." }],
          },
          "00000000-0000-4000-8000-00000000c004",
          "toolu_r_task",
        ),
        entry(
          "user",
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_r_task", content: "Report." }],
          },
          "00000000-0000-4000-8000-00000000c005",
        ),
        entry(
          "assistant",
          {
            id: "msg_r2",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "Fixed." }],
          },
          "00000000-0000-4000-8000-00000000c006",
        ),
      ];
    },
    turns: [],
  },
];

function compactionScenario(name: string, capabilities?: Scenario["capabilities"]): Scenario {
  return {
    name,
    capabilities,
    turns: [
      async function* (ctx) {
        yield system("status", { status: "compacting" });
        yield {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "compaction", content: null },
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-4000-8000-00000000d001",
          session_id: SESSION_ID,
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "compaction_delta", content: "The summary." },
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-4000-8000-00000000d002",
          session_id: SESSION_ID,
        };
        await ctx.hook("PostCompact", { trigger: "auto", compact_summary: "The summary." });
        yield system("compact_boundary", {
          compact_metadata: { trigger: "auto", pre_tokens: 1000, post_tokens: 100, duration_ms: 7 },
        });
        yield system("status", { status: null, compact_result: "success" });
        yield result();
      },
    ],
  };
}
