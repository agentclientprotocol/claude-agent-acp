import type { PermissionOption } from "@agentclientprotocol/sdk";
import path from "node:path";
import type { DurablePermissionChangeSet } from "../normalization.js";
import { plainString, type PermissionOptionContext, withOptionalUpdate } from "./shared.js";

function permissionRulePrefix(value: string): string {
  return value.endsWith(":*") ? value.slice(0, -2) : value;
}

function displayList(values: string[]): string {
  if (values.join(", ").length > 50) return "similar";
  if (values.length === 1) return values[0]!;
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function displayPaths(paths: string[]): string {
  const normalizedPaths = [...new Set(paths.map((value) => path.normalize(value)))];
  const segments = normalizedPaths.map((value) => value.split(path.sep).filter(Boolean));
  const suffix = (index: number, depth: number): string =>
    segments[index]!.slice(-depth).join(path.sep) || normalizedPaths[index]!;
  const names = normalizedPaths.map((value, index) => {
    const parts = segments[index]!;
    let name = path.basename(value) || value;
    for (let depth = 1; depth <= parts.length; depth++) {
      const candidate = suffix(index, depth);
      if (
        normalizedPaths.every((_, other) => other === index || suffix(other, depth) !== candidate)
      ) {
        name = candidate;
        break;
      }
      if (depth === parts.length) name = value;
    }
    return name.endsWith(path.sep) ? name : `${name}${path.sep}`;
  });
  if (names.length <= 2) return displayList(names);
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/** Plain-text port of Claude Code's generateShellSuggestionsLabel. */
function shellSuggestionsLabel(
  toolName: "Bash" | "PowerShell",
  changeSet: DurablePermissionChangeSet,
): string | undefined {
  const representable = changeSet.updates.every((update) => {
    if (update.type === "addDirectories") return update.destination === "session";
    if (update.type !== "addRules" || update.behavior !== "allow") return false;
    return update.rules.every(
      (rule) =>
        (rule.toolName === toolName || rule.toolName === "Read") &&
        plainString(rule.ruleContent) !== undefined,
    );
  });
  if (!representable) return undefined;

  const rules = changeSet.updates
    .filter((update) => update.type === "addRules")
    .flatMap((update) => update.rules);
  const readPaths = rules
    .filter((rule) => rule.toolName === "Read")
    .map((rule) => rule.ruleContent?.replace(/\/\*\*$/, ""))
    .filter((value): value is string => !!value);
  const commands = [
    ...new Set(
      rules
        .filter((rule) => rule.toolName === toolName && rule.ruleContent)
        .map((rule) => permissionRulePrefix(rule.ruleContent!)),
    ),
  ];
  const directories = changeSet.updates
    .filter((update) => update.type === "addDirectories")
    .flatMap((update) => update.directories);
  const hasPaths = readPaths.length > 0 || directories.length > 0;

  if (readPaths.length > 0 && directories.length === 0 && commands.length === 0) {
    return `Yes, allow reading from ${displayPaths(readPaths)} from this project`;
  }
  if (directories.length > 0 && readPaths.length === 0 && commands.length === 0) {
    return `Yes, and always allow access to ${displayPaths(directories)} from this project`;
  }
  if (commands.length > 0 && !hasPaths) {
    return `Yes, and don't ask again for ${displayList(commands)} commands`;
  }
  if (hasPaths && commands.length === 0) {
    return `Yes, and always allow access to ${displayPaths([...directories, ...readPaths])} from this project`;
  }
  if (hasPaths && commands.length > 0) {
    const paths = [...directories, ...readPaths];
    return paths.length === 1 && commands.length === 1
      ? `Yes, and allow access to ${displayPaths(paths)} and ${displayList(commands)} commands`
      : `Yes, and allow ${displayPaths(paths)} access and ${displayList(commands)} commands`;
  }
  return undefined;
}

function buildShellPermissionOptions(
  context: PermissionOptionContext,
  toolName: "Bash" | "PowerShell",
): PermissionOption[] {
  const name = context.durableChangeSet
    ? shellSuggestionsLabel(toolName, context.durableChangeSet)
    : undefined;
  return withOptionalUpdate(context.durableChangeSet, name, "Yes", "No");
}

export function buildBashPermissionOptions(context: PermissionOptionContext): PermissionOption[] {
  return buildShellPermissionOptions(context, "Bash");
}

export function buildPowerShellPermissionOptions(
  context: PermissionOptionContext,
): PermissionOption[] {
  return buildShellPermissionOptions(context, "PowerShell");
}
