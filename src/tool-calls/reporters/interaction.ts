import type {
  AskUserQuestionInput,
  ReportFindingsInput,
  TaskCreateInput,
  TaskUpdateInput,
  TodoWriteInput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exitPlanModeRawOutput } from "../../exit-plan.js";
import { textContent } from "../content.js";
import type {
  ToolReporter,
  ToolResultContext,
  ToolResultFacts,
  ToolUseContext,
  ToolUseFacts,
} from "../facts.js";

/**
 * ExitPlanMode: the plan is input that the user approves.
 *
 * Claude writes the plan to a file under `plansDirectory` while it drafts it.
 * The CLI adds the file text as `plan` and the file path as `planFilePath` to
 * the complete input. A `planFile` client gets the path and reads the plan
 * from the file. Without the file, it gets the plan text like other clients.
 */
export class ExitPlanModeReporter implements ToolReporter {
  toolUse(input: unknown, { capabilities }: ToolUseContext): ToolUseFacts {
    const plan = (input as { plan?: string } | undefined)?.plan;
    const planFilePath = capabilities.air.planFile
      ? existingPlanFile((input as { planFilePath?: unknown } | undefined)?.planFilePath)
      : undefined;
    return {
      title: "Approve Plan",
      kind: "switch_mode",
      ...(planFilePath ? { planFilePath } : plan ? { display: [textContent(plan)] } : {}),
    };
  }

  /** The approval text repeats the plan, which the input holds. */
  toolResult(context: ToolResultContext): ToolResultFacts {
    const planFilePath = resultPlanFile(context);
    return {
      title: "Exited Plan Mode",
      rawOutput: undefined,
      ...(planFilePath ? { planFilePath } : {}),
    };
  }

  /**
   * The rejection reason has no display form. Claude fences it, so unfence it.
   * A client that is not AIR gets the error text as the result to show.
   */
  errorResult(context: ToolResultContext): ToolResultFacts | undefined {
    const { toolUse, result, capabilities } = context;
    if (!capabilities.air.client) return undefined;
    const planFilePath = resultPlanFile(context);
    return {
      rawOutput: exitPlanModeRawOutput(toolUse.name, result.content),
      ...(planFilePath ? { planFilePath } : {}),
    };
  }
}

/** The plan file of a result: the path of the input, else the `filePath` of the structured result. */
function resultPlanFile({ toolUse, structured, capabilities }: ToolResultContext) {
  if (!capabilities.air.planFile) return undefined;
  return (
    existingPlanFile((toolUse.input as { planFilePath?: unknown } | undefined)?.planFilePath) ??
    existingPlanFile((structured as { filePath?: unknown } | undefined)?.filePath)
  );
}

/** The path when it is an absolute path of a regular file, else undefined. */
function existingPlanFile(value: unknown): string | undefined {
  if (typeof value !== "string" || !path.isAbsolute(value)) return undefined;
  try {
    return statSync(value).isFile() ? value : undefined;
  } catch {
    return undefined;
  }
}

/** AskUserQuestion: the questions are input that the user reads. */
export class AskUserQuestionReporter implements ToolReporter {
  /**
   * AIR gets a fixed title, because the question is input. Every other client
   * gets the question of a single question as the title, like upstream.
   */
  toolUse(input: unknown, { capabilities }: ToolUseContext): ToolUseFacts {
    const ask = input as Partial<AskUserQuestionInput> | undefined;
    const questions = Array.isArray(ask?.questions) ? ask.questions : [];
    const display = questions
      .filter((q) => typeof q?.question === "string")
      .map((q) => textContent(q.question));
    const single =
      !capabilities.air.client && questions.length === 1 && questions[0]?.question
        ? questions[0].question
        : undefined;
    return {
      title: single ?? "Asking for your input",
      kind: "other",
      ...(display.length > 0 ? { display } : {}),
    };
  }
}

/** Skill: the skill name is the label. The result is a confirmation. */
export class SkillReporter implements ToolReporter {
  toolUse(input: unknown): ToolUseFacts {
    const skill = (input as { skill?: string } | undefined)?.skill;
    return { title: skill ? `Load skill: ${skill}` : "Load skill", kind: "other" };
  }

  toolResult(): ToolResultFacts {
    return {};
  }
}

/**
 * TodoWrite and the Task* tools. The stream reports them as a plan. Only a
 * permission request surfaces them as a tool call.
 */
export class PlanToolReporter implements ToolReporter {
  constructor(private readonly toolName: string) {}

  toolUse(input: unknown): ToolUseFacts {
    switch (this.toolName) {
      case "TodoWrite": {
        const todos = (input as TodoWriteInput | undefined)?.todos;
        return {
          title: Array.isArray(todos)
            ? `Update TODOs: ${todos.map((todo: any) => todo.content).join(", ")}`
            : "Update TODOs",
          kind: "think",
        };
      }
      case "TaskCreate": {
        const subject = (input as TaskCreateInput | undefined)?.subject;
        return { title: subject ? `Create task: ${subject}` : "Create task", kind: "think" };
      }
      case "TaskUpdate": {
        const subject = (input as TaskUpdateInput | undefined)?.subject;
        return { title: subject ? `Update task: ${subject}` : "Update task", kind: "think" };
      }
      case "TaskList":
        return { title: "List tasks", kind: "think" };
      default:
        return { title: "Get task", kind: "think" };
    }
  }
}

/** ReportFindings: the findings are input that the user reads. */
export class ReportFindingsReporter implements ToolReporter {
  toolUse(input: unknown): ToolUseFacts {
    const findings = (input as ReportFindingsInput | undefined)?.findings ?? [];
    return {
      title:
        findings.length === 0
          ? "Report findings: none found"
          : `Report ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
      kind: "think",
      ...(findings.length > 0
        ? {
            display: findings.map((finding) =>
              textContent(
                `**${finding.file}${finding.line ? `:${finding.line}` : ""}** — ${finding.summary}`,
              ),
            ),
          }
        : {}),
    };
  }
}

/** Every other tool, MCP tools too: the result text is the result to show. */
export class GenericReporter implements ToolReporter {
  constructor(private readonly toolName: string) {}

  toolUse(input: unknown): ToolUseFacts {
    if (this.toolName !== "Other") {
      return { title: this.toolName || "Unknown Tool", kind: "other" };
    }
    let json;
    try {
      json = JSON.stringify(input, null, 2);
    } catch {
      json = typeof input === "string" ? input : "{}";
    }
    return {
      title: this.toolName,
      kind: "other",
      display: [textContent(`\`\`\`json\n${json}\`\`\``)],
    };
  }
}

/** Roots a skill's directory may sit under, relative to the directory the scope resolves to. */
const SKILL_CONTAINER_DIRS = [".claude/skills", ".agents/skills"] as const;

/**
 * Absolute path of a skill's `SKILL.md`, or `undefined` when none of the known layouts holds one.
 *
 * The `Skill` tool reports only the skill's name, so the file has to be located by probing the layouts skills
 * actually use: project- and user-level `.claude/skills` (plus this repo's `.agents/skills` source of truth), and
 * for a `<prefix>:<name>` spelling either a plugin (`.claude/plugins/<prefix>/skills/<name>`) or a
 * directory-scoped skill (`<prefix>/.claude/skills/<name>`), which share that spelling. Only a path that exists
 * on disk is returned, so a wrong guess costs nothing and clients never render a link to a missing file.
 */
export function resolveSkillPath(skillName: string, cwd?: string): string | undefined {
  if (!cwd) {
    return undefined;
  }
  const colon = skillName.indexOf(":");
  const scope = colon < 0 ? undefined : skillName.slice(0, colon);
  const name = colon < 0 ? skillName : skillName.slice(colon + 1);
  if (!name) {
    return undefined;
  }
  const candidates: string[] = [];
  const addCandidates = (base: string) => {
    for (const container of SKILL_CONTAINER_DIRS) {
      candidates.push(path.join(base, container, name, "SKILL.md"));
    }
  };
  if (scope) {
    // A `<prefix>:<name>` skill is either directory-scoped or a plugin's; both spellings look identical.
    addCandidates(path.join(cwd, scope));
    candidates.push(path.join(cwd, ".claude/plugins", scope, "skills", name, "SKILL.md"));
  }
  addCandidates(cwd);
  addCandidates(os.homedir());
  return candidates.find((candidate) => existsSync(candidate));
}
