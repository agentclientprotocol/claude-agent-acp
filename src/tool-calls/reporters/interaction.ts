import type {
  AskUserQuestionInput,
  ReportFindingsInput,
  TaskCreateInput,
  TaskUpdateInput,
  TodoWriteInput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  type Stats,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { exitPlanModeRawOutput } from "../../exit-plan.js";
import { textContent, toAcpContentUpdate } from "../content.js";
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
      ...(planFilePath ? { planFilePath, planFileReleased: true } : {}),
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

/**
 * An agent control tool (SendMessage, TaskStop, ListAgents, Monitor). AIR
 * shows the result in its own frame and parses the JSON result of SendMessage
 * and TaskStop. So AIR gets the error text as plain text, without a fence.
 * A client that is not AIR gets the fenced error text.
 */
export class AgentControlReporter extends GenericReporter {
  errorResult({ result, capabilities }: ToolResultContext): ToolResultFacts | undefined {
    return capabilities.air.client ? toAcpContentUpdate(result.content, false) : undefined;
  }
}

/** Roots a skill's directory may sit under, relative to the directory the scope resolves to. */
const SKILL_CONTAINER_DIRS = [".claude/skills", ".agents/skills"] as const;

/** Bytes of a `SKILL.md` that are read. A frontmatter block is far shorter, and the body is of no interest. */
const MAX_FRONTMATTER_BYTES = 8192;

/** `SKILL.md` files whose declared name is remembered. The cap keeps a long-lived adapter from growing forever. */
const MAX_CACHED_SKILLS = 1024;

/** The head of [file], up to [MAX_FRONTMATTER_BYTES], cut back to its last complete line. */
function frontmatterHead(file: string): string | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.allocUnsafe(MAX_FRONTMATTER_BYTES);
    const read = readSync(descriptor, buffer, 0, MAX_FRONTMATTER_BYTES, 0);
    const head = buffer.toString("utf8", 0, read);
    if (read < MAX_FRONTMATTER_BYTES) {
      return head;
    }
    // The last line of a head that filled the buffer may be cut in half, and half a name is the wrong name.
    const lastBreak = head.lastIndexOf("\n");
    return lastBreak < 0 ? "" : head.slice(0, lastBreak);
  } catch {
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * The value [raw] carries, with its quotes resolved and a trailing comment dropped.
 *
 * This is the plain-scalar and single-line-quoted part of YAML, which is all a `name:` ever is. An unterminated
 * quote keeps what it opened, as the frontmatter of a broken file is still worth a guess.
 */
function frontmatterScalar(raw: string): string {
  const quote = raw[0];
  if (quote !== '"' && quote !== "'") {
    // A `#` only starts a comment at the start of the value or after a space, so `a#b` is one scalar.
    const comment = raw.search(/(?:^|[ \t])#/);
    return (comment < 0 ? raw : raw.slice(0, comment)).trim();
  }
  let value = "";
  for (let index = 1; index < raw.length; index++) {
    const character = raw[index];
    if (character === quote) {
      if (quote === "'" && raw[index + 1] === "'") {
        value += "'";
        index++;
        continue;
      }
      return value;
    }
    if (quote === '"' && character === "\\" && index + 1 < raw.length) {
      value += raw[++index];
      continue;
    }
    value += character;
  }
  return value;
}

/**
 * The `name:` that the frontmatter of [skillMdPath] declares, or `undefined` when it declares none.
 *
 * Only the frontmatter block is parsed, so a `name:` further down the body is not a name.
 */
function declaredSkillName(skillMdPath: string): string | undefined {
  const head = frontmatterHead(skillMdPath);
  if (head === undefined) {
    return undefined;
  }
  const lines = head.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return undefined;
  }
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (trimmed === "---" || trimmed === "...") {
      break;
    }
    // A key at column 0, so a `name:` nested under another key is not the skill's name. A value needs a space
    // after the colon, as `name:value` is a plain scalar in YAML rather than a mapping.
    const match = /^name[ \t]*:(?:[ \t]+(.*))?$/.exec(line);
    if (match) {
      return frontmatterScalar(match[1]?.trim() ?? "") || undefined;
    }
  }
  return undefined;
}

/** What one read of a `SKILL.md` found, and the state of the file it found it in. */
type ScannedSkill = { signature: string; declaredName: string | undefined };

const scannedSkills = new Map<string, ScannedSkill>();

/**
 * The declared name of a `SKILL.md` whose [stats] are already known, read at most once per state of the file.
 *
 * The signature carries the inode change time next to the modification time, because a write that restores the
 * old modification time — `git checkout`, `cp -p`, a filesystem whose times have a one-second resolution —
 * still moves the change time, and a name that silently stayed behind resolves to the wrong skill forever.
 */
function cachedDeclaredName(skillMdPath: string, stats: Stats): string | undefined {
  const signature = `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}:${stats.ino}:${stats.dev}`;
  const cached = scannedSkills.get(skillMdPath);
  if (cached?.signature === signature) {
    return cached.declaredName;
  }
  const declaredName = declaredSkillName(skillMdPath);
  if (scannedSkills.size >= MAX_CACHED_SKILLS) {
    scannedSkills.clear();
  }
  scannedSkills.set(skillMdPath, { signature, declaredName });
  return declaredName;
}

/**
 * The container scans of one resolution, so that a list of commands lists each container once.
 *
 * A list of slash commands is resolved in one synchronous pass, and nothing on disk changes within it. The cache
 * therefore lives exactly as long as that pass: every later pass sees the directories as they are.
 */
export type SkillScanCache = Map<string, Map<string, string>>;

/**
 * The `SKILL.md` paths of [containerDir], keyed by the name their frontmatter declares.
 *
 * `statSync` follows links, so a skill reached through a symlinked directory is scanned like any other. The
 * listing is sorted, so that two skills declaring one name resolve to the same file on every machine.
 */
function skillsByDeclaredName(containerDir: string, scans?: SkillScanCache): Map<string, string> {
  const scanned = scans?.get(containerDir);
  if (scanned) {
    return scanned;
  }
  const byName = new Map<string, string>();
  let entries: string[];
  try {
    entries = readdirSync(containerDir).sort();
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const file = path.join(containerDir, entry, "SKILL.md");
    let stats: Stats;
    try {
      stats = statSync(file);
    } catch {
      continue;
    }
    const name = cachedDeclaredName(file, stats);
    if (name !== undefined && !byName.has(name)) {
      byName.set(name, file);
    }
  }
  scans?.set(containerDir, byName);
  return byName;
}

/** Whether [segment] would take a join outside the directory it is joined to. */
function escapesContainer(segment: string): boolean {
  return path.isAbsolute(segment) || segment.split(/[/\\]/).includes("..");
}

/**
 * Absolute path of a skill's `SKILL.md`, or `undefined` when none of the known layouts holds one.
 *
 * The `Skill` tool reports only the skill's name, so the file has to be located by probing the layouts skills
 * actually use: project- and user-level `.claude/skills` (plus this repo's `.agents/skills` source of truth), and
 * for a `<prefix>:<name>` spelling either a plugin or a directory-scoped skill (`<prefix>/.claude/skills/<name>`),
 * which share that spelling. Only a path that exists on disk is returned, so a wrong guess costs nothing and
 * clients never render a link to a missing file.
 *
 * Claude Code advertises a skill by the `name:` of its frontmatter, which can differ from the name of the
 * directory, or of the symlink, that holds the file. A directory that carries the name therefore counts only
 * while the file in it declares that name or declares none; otherwise the same containers are scanned, in the
 * same order, for the `SKILL.md` that does declare it.
 *
 * [scans] holds the container listings of one resolution pass. Pass the same cache for every command of one
 * list, and each container is listed once instead of once per command.
 */
export function resolveSkillPath(
  skillName: string,
  cwd?: string,
  scans?: SkillScanCache,
): string | undefined {
  if (!cwd) {
    return undefined;
  }
  const colon = skillName.indexOf(":");
  const scope = colon < 0 ? undefined : skillName.slice(0, colon);
  const name = colon < 0 ? skillName : skillName.slice(colon + 1);
  // The name comes from the agent, so a separator or a `..` in it must never reach the filesystem.
  if (
    !name ||
    /[/\\]/.test(name) ||
    name === ".." ||
    (scope !== undefined && escapesContainer(scope))
  ) {
    return undefined;
  }
  const containers: string[] = [];
  const addContainers = (base: string) => {
    for (const container of SKILL_CONTAINER_DIRS) {
      containers.push(path.join(base, container));
    }
  };
  // A `<prefix>:<name>` skill is either directory-scoped or a plugin's; both spellings look identical.
  const addScopedContainers = (base: string) => {
    if (scope === undefined) {
      return;
    }
    addContainers(path.join(base, scope));
    containers.push(path.join(base, ".claude/plugins", scope, "skills"));
    // An installed plugin lives under the marketplace it came from, which its `<prefix>` does not name.
    const marketplaces = path.join(base, ".claude/plugins/marketplaces");
    let installed: string[];
    try {
      installed = readdirSync(marketplaces).sort();
    } catch {
      return;
    }
    for (const marketplace of installed) {
      containers.push(path.join(marketplaces, marketplace, "plugins", scope, "skills"));
    }
  };
  addScopedContainers(cwd);
  addScopedContainers(os.homedir());
  addContainers(cwd);
  addContainers(os.homedir());
  for (const container of containers) {
    const candidate = path.join(container, name, "SKILL.md");
    let stats: Stats;
    try {
      stats = statSync(candidate);
    } catch {
      continue;
    }
    if (!stats.isFile()) {
      continue;
    }
    const declared = cachedDeclaredName(candidate, stats);
    if (declared === undefined || declared === name) {
      return candidate;
    }
  }
  // A prompt command of `.claude/commands` is no skill, so its name must not be matched against a skill that
  // declares it somewhere else. Only the directory probe above may answer for it, by the name it carries.
  if (
    scope === undefined &&
    [cwd, os.homedir()].some((base) =>
      existsSync(path.join(base, ".claude/commands", `${name}.md`)),
    )
  ) {
    return undefined;
  }
  for (const container of containers) {
    const declared = skillsByDeclaredName(container, scans).get(name);
    if (declared) {
      return declared;
    }
  }
  return undefined;
}
