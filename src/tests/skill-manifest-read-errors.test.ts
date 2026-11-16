import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSkillPath } from "../tool-calls/reporters/interaction.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    closeSync: vi.fn(actual.closeSync),
  };
});

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

describe("skill manifest read errors", () => {
  let root: string;

  beforeEach(() => {
    vi.mocked(openSync).mockReset().mockImplementation(actualFs.openSync);
    vi.mocked(readSync).mockReset().mockImplementation(actualFs.readSync);
    vi.mocked(closeSync).mockReset().mockImplementation(actualFs.closeSync);
    root = mkdtempSync(path.join(os.tmpdir(), "acp-skill-read-"));
    vi.spyOn(os, "homedir").mockReturnValue(path.join(root, "home"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const writeSkill = (directory: string, content: string) => {
    const file = path.join(root, directory, "SKILL.md");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  };

  it.each(["EACCES", "ENOENT"])("rejects a manifest when opening it fails with %s", (code) => {
    writeSkill(".claude/skills/review", "---\nname: another-skill\n---\n");
    vi.mocked(openSync).mockImplementation(() => {
      throw Object.assign(new Error("Cannot open fixture manifest"), { code });
    });

    expect(resolveSkillPath("review", root)).toBeUndefined();
  });

  it("rejects a manifest when reading it fails and closes the descriptor", () => {
    writeSkill(".claude/skills/review", "---\nname: another-skill\n---\n");
    vi.mocked(readSync).mockImplementation(() => {
      throw Object.assign(new Error("Cannot read fixture manifest"), { code: "EIO" });
    });

    expect(resolveSkillPath("review", root)).toBeUndefined();
    expect(closeSync).toHaveBeenCalled();
    expect(vi.mocked(closeSync).mock.calls.length).toBe(vi.mocked(openSync).mock.calls.length);
  });

  it("retries a failed read even when the manifest's stat signature is unchanged", () => {
    const file = writeSkill(".claude/skills/review", "# Skill without a declared name\n");
    const before = statSync(file);
    vi.mocked(readSync).mockImplementation(() => {
      throw Object.assign(new Error("Temporary read failure"), { code: "EIO" });
    });

    expect(resolveSkillPath("review", root)).toBeUndefined();
    vi.mocked(readSync).mockImplementation(actualFs.readSync);
    expect(statSync(file)).toMatchObject({ mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs });
    expect(resolveSkillPath("review", root)).toBe(file);
  });

  it("continues to a readable skill declaring the requested name", () => {
    const unreadable = writeSkill(".claude/skills/review", "---\nname: another-skill\n---\n");
    const readable = writeSkill(".agents/skills/other", "---\nname: review\n---\n");
    vi.mocked(openSync).mockImplementation((file, flags, mode) => {
      if (file === unreadable) {
        throw Object.assign(new Error("Cannot open fixture manifest"), { code: "EACCES" });
      }
      return actualFs.openSync(file, flags, mode);
    });

    expect(resolveSkillPath("review", root)).toBe(readable);
  });

  it.each(["", "# Skill\n", "---\ndescription: review\n---\n", "---\nname: review\n---\n"])(
    "keeps resolving a readable manifest with content %j",
    (content) => {
      const file = writeSkill(".claude/skills/review", content);
      expect(resolveSkillPath("review", root)).toBe(file);
    },
  );
});
