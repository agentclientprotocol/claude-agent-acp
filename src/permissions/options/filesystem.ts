import type { PermissionOption } from "@agentclientprotocol/sdk";
import os from "node:os";
import path from "node:path";
import type { DurablePermissionChangeSet } from "../normalization.js";
import { plainString, type PermissionOptionContext, withOptionalUpdate } from "./shared.js";

function isFileSessionChangeSet(
  changeSet: DurablePermissionChangeSet | undefined,
  operation: "read" | "write",
): boolean {
  return (
    !!changeSet &&
    changeSet.updates.every((update) => {
      if (update.destination !== "session") return false;
      if (update.type === "setMode") {
        return operation === "write" && update.mode === "acceptEdits";
      }
      if (update.type === "addDirectories") return operation === "write";
      if (update.type !== "addRules" || update.behavior !== "allow") return false;
      return update.rules.every((rule) =>
        operation === "read" ? rule.toolName === "Read" : rule.toolName === "Edit",
      );
    })
  );
}

function inputPath(context: PermissionOptionContext, key: string): string | undefined {
  return plainString(context.input[key]);
}

function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function hasSessionAllowRuleFor(
  changeSet: DurablePermissionChangeSet | undefined,
  toolName: string,
): boolean {
  return !!changeSet?.updates.some(
    (update) =>
      update.type === "addRules" &&
      update.destination === "session" &&
      update.behavior === "allow" &&
      update.rules.some((rule) => rule.toolName === toolName),
  );
}

function hasBroadSessionAllowRuleFor(
  changeSet: DurablePermissionChangeSet,
  toolName: string,
): boolean {
  return changeSet.updates.some(
    (update) =>
      update.type === "addRules" &&
      update.destination === "session" &&
      update.behavior === "allow" &&
      update.rules.some((rule) => rule.toolName === toolName && rule.ruleContent === undefined),
  );
}

function hasAcceptEditsMode(changeSet: DurablePermissionChangeSet): boolean {
  return changeSet.updates.some(
    (update) =>
      update.type === "setMode" &&
      update.destination === "session" &&
      update.mode === "acceptEdits",
  );
}

function permissionPath(ruleContent: string | undefined): string | undefined {
  const value = plainString(ruleContent);
  if (!value) return undefined;
  return value.replace(/[/\\]\*\*$/, "");
}

function effectCoversFilePath(
  changeSet: DurablePermissionChangeSet,
  filePath: string,
  operation: "read" | "write",
  cwd: string,
): boolean {
  const directory = path.dirname(filePath);
  const comparable = (candidate: string): boolean => {
    const resolved = path.resolve(cwd, candidate);
    return resolved === directory || isInside(resolved, filePath);
  };
  const paths = changeSet.updates.flatMap((update) => {
    if (update.type === "addDirectories") return update.directories;
    if (update.type !== "addRules" || update.behavior !== "allow") return [];
    return update.rules
      .filter((rule) =>
        operation === "read" ? rule.toolName === "Read" : rule.toolName === "Edit",
      )
      .map((rule) => permissionPath(rule.ruleContent))
      .filter((value): value is string => value !== undefined);
  });
  return paths.some(comparable);
}

function fileSessionLabel(
  context: PermissionOptionContext,
  filePath: string | undefined,
  operation: "read" | "write",
): string | undefined {
  if (!isFileSessionChangeSet(context.durableChangeSet, operation)) return undefined;
  const resolvedFilePath = filePath ? path.resolve(context.cwd, filePath) : undefined;
  const isClaudePath =
    operation === "write" &&
    !!resolvedFilePath &&
    (isInside(path.join(context.cwd, ".claude"), resolvedFilePath) ||
      isInside(path.join(os.homedir(), ".claude"), resolvedFilePath));
  const broadRule = hasBroadSessionAllowRuleFor(
    context.durableChangeSet!,
    operation === "read" ? "Read" : "Edit",
  );
  if (resolvedFilePath) {
    const coversCurrentPath =
      effectCoversFilePath(context.durableChangeSet!, resolvedFilePath, operation, context.cwd) ||
      broadRule ||
      (operation === "write" && !isClaudePath && hasAcceptEditsMode(context.durableChangeSet!));
    if (!coversCurrentPath) return undefined;
  } else if (
    !broadRule &&
    !(operation === "write" && hasAcceptEditsMode(context.durableChangeSet!))
  ) {
    return undefined;
  }
  if (
    operation === "write" &&
    resolvedFilePath &&
    isClaudePath &&
    hasSessionAllowRuleFor(context.durableChangeSet, "Edit")
  ) {
    return "Yes, and allow Claude to edit its own settings for this session";
  }
  if (!resolvedFilePath || isInside(context.cwd, resolvedFilePath)) {
    return operation === "read"
      ? "Yes, during this session"
      : "Yes, allow all edits during this session";
  }
  const directory = path.dirname(resolvedFilePath);
  const directoryName = path.basename(directory) || "this directory";
  return operation === "read"
    ? `Yes, allow reading from ${directoryName}${path.sep} during this session`
    : `Yes, allow all edits in ${directoryName}${path.sep} during this session`;
}

function buildFilePermissionOptions(
  context: PermissionOptionContext,
  filePath: string | undefined,
  operation: "read" | "write",
): PermissionOption[] {
  return withOptionalUpdate(
    context.durableChangeSet,
    fileSessionLabel(context, filePath, operation),
    "Yes",
    "No",
  );
}

export function buildReadPermissionOptions(context: PermissionOptionContext): PermissionOption[] {
  return buildFilePermissionOptions(context, inputPath(context, "file_path"), "read");
}

export function buildGlobPermissionOptions(context: PermissionOptionContext): PermissionOption[] {
  return buildFilePermissionOptions(context, inputPath(context, "path") ?? context.cwd, "read");
}

export function buildGrepPermissionOptions(context: PermissionOptionContext): PermissionOption[] {
  return buildFilePermissionOptions(context, inputPath(context, "path") ?? context.cwd, "read");
}

export function buildEditPermissionOptions(context: PermissionOptionContext): PermissionOption[] {
  return buildFilePermissionOptions(context, inputPath(context, "file_path"), "write");
}

export function buildWritePermissionOptions(context: PermissionOptionContext): PermissionOption[] {
  return buildFilePermissionOptions(context, inputPath(context, "file_path"), "write");
}

export function buildNotebookEditPermissionOptions(
  context: PermissionOptionContext,
): PermissionOption[] {
  return buildFilePermissionOptions(context, inputPath(context, "notebook_path"), "write");
}
