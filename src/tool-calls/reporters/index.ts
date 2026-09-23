import type { ToolReporter } from "../facts.js";
import { AgentReporter } from "./agent.js";
import { BashReporter } from "./bash.js";
import { EditReporter, NotebookEditReporter, WriteReporter } from "./file-edit.js";
import {
  AskUserQuestionReporter,
  ExitPlanModeReporter,
  GenericReporter,
  PlanToolReporter,
  ReportFindingsReporter,
  SkillReporter,
} from "./interaction.js";
import { ReadReporter } from "./read.js";
import { GlobReporter, GrepReporter } from "./search.js";
import { WebFetchReporter, WebSearchReporter } from "./web.js";

const bash = new BashReporter();
const reporters: Record<string, ToolReporter> = {
  Agent: new AgentReporter(),
  Task: new AgentReporter(),
  Bash: bash,
  PowerShell: bash,
  Read: new ReadReporter(),
  Write: new WriteReporter(),
  Edit: new EditReporter(),
  NotebookEdit: new NotebookEditReporter(),
  Glob: new GlobReporter(),
  Grep: new GrepReporter(),
  WebFetch: new WebFetchReporter(),
  WebSearch: new WebSearchReporter(),
  TodoWrite: new PlanToolReporter("TodoWrite"),
  TaskCreate: new PlanToolReporter("TaskCreate"),
  TaskUpdate: new PlanToolReporter("TaskUpdate"),
  TaskList: new PlanToolReporter("TaskList"),
  TaskGet: new PlanToolReporter("TaskGet"),
  ReportFindings: new ReportFindingsReporter(),
  ExitPlanMode: new ExitPlanModeReporter(),
  AskUserQuestion: new AskUserQuestionReporter(),
  Skill: new SkillReporter(),
};

/** The reporter of a tool. MCP tools and unknown tools get the generic reporter. */
export function reporterFor(toolName: string): ToolReporter {
  return Object.hasOwn(reporters, toolName) ? reporters[toolName] : new GenericReporter(toolName);
}
