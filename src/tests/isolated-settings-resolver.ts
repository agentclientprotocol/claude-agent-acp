// Test-only stand-in for the SDK's `resolveSettings`. Reads user/project/local
// settings from disk like the real one, but never touches the OS-managed
// policy tier (e.g. /Library/Application Support/ClaudeCode/managed-settings.json
// on macOS). DataDog-managed Macs pin `model: "sonnet"` there, which silently
// overrides fixture-written values and breaks fixture-driven tests.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ResolvedSettings,
  ResolveSettingsOptions,
  Settings,
  SettingSource,
} from "@anthropic-ai/claude-agent-sdk";

function readJsonOrEmpty(p: string): Settings {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Settings;
  } catch {
    return {};
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge(a: Settings, b: Settings): Settings {
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    const prev = (a as Record<string, unknown>)[k];
    if (k === "availableModels" && Array.isArray(prev) && Array.isArray(v)) {
      out[k] = Array.from(new Set([...prev, ...v]));
    } else if (isPlainObject(prev) && isPlainObject(v)) {
      out[k] = merge(prev as Settings, v as Settings);
    } else {
      out[k] = v;
    }
  }
  return out as Settings;
}

export async function isolatedResolveSettings(
  opts: ResolveSettingsOptions = {},
): Promise<ResolvedSettings> {
  const cwd = opts.cwd ?? process.cwd();
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");

  const sourceSpecs: Array<{ source: SettingSource; path: string }> = [
    { source: "user", path: path.join(configDir, "settings.json") },
    { source: "project", path: path.join(cwd, ".claude", "settings.json") },
    { source: "local", path: path.join(cwd, ".claude", "settings.local.json") },
  ];

  const sources = sourceSpecs.map(({ source, path: p }) => ({
    source,
    settings: readJsonOrEmpty(p),
    path: p,
  }));

  let effective: Settings = {};
  const provenance: Record<string, { source: SettingSource; path: string }> = {};
  for (const { source, settings, path: p } of sources) {
    for (const key of Object.keys(settings)) {
      provenance[key] = { source, path: p };
    }
    effective = merge(effective, settings);
  }

  return {
    effective,
    provenance: provenance as ResolvedSettings["provenance"],
    sources,
  };
}
