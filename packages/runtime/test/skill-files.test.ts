import { describe, expect, test } from "bun:test";
import {
  applySkillFileChanges,
  assertSkillRelativePath,
  readSkillFiles,
  SKILL_READ_MAX_OUTPUT_BYTES,
} from "../src/skill-files";

const folder = [
  { path: "SKILL.md", content: "# Deploy\nRead references/deploy.md." },
  { path: "references/deploy.md", content: "Run the deployment script." },
  { path: "scripts/deploy", content: "echo deploy\n" },
];

describe("sandbox-independent Skill reads", () => {
  test("defaults only omitted paths to SKILL.md", () => {
    expect(readSkillFiles(folder)).toEqual({ files: [folder[0]] });
    expect(() => readSkillFiles(folder, [])).toThrow("between 1 and");
  });

  test("returns exactly explicit paths in requested order", () => {
    expect(readSkillFiles(folder, ["scripts/deploy", "references/deploy.md"])).toEqual({
      files: [folder[2], folder[1]],
    });
  });

  test("does not present missing or duplicate files as successful partial reads", () => {
    expect(() => readSkillFiles(folder, ["SKILL.md", "missing.md"])).toThrow("missing.md");
    expect(() => readSkillFiles(folder, ["SKILL.md", "SKILL.md"])).toThrow("Duplicate requested");
    expect(() => readSkillFiles([...folder, folder[0]!])).toThrow("Duplicate stored");
  });

  test("bounds serialized UTF-8 output without silently truncating content", () => {
    expect(() =>
      readSkillFiles([{ path: "SKILL.md", content: "é".repeat(SKILL_READ_MAX_OUTPUT_BYTES / 2) }]),
    ).toThrow("output limit");
    expect(() =>
      readSkillFiles([{ path: "SKILL.md", content: "\n".repeat(SKILL_READ_MAX_OUTPUT_BYTES / 2) }]),
    ).toThrow("output limit");
    expect(readSkillFiles([{ path: "SKILL.md", content: "" }])).toEqual({
      files: [{ path: "SKILL.md", content: "" }],
    });
  });

  test("rejects traversal and platform-specific absolute paths", () => {
    for (const path of [
      "../secret",
      "/etc/passwd",
      "a/../b",
      "a//b",
      "./SKILL.md",
      "C:/file",
      "a\\b",
      "a\0b",
    ]) {
      expect(() => assertSkillRelativePath(path)).toThrow("safe relative");
    }
    for (const path of [
      "SKILL.md",
      "scripts/run",
      "references/日本語.md",
      "templates/file with spaces.txt",
    ]) {
      expect(() => assertSkillRelativePath(path)).not.toThrow();
    }
  });
});

describe("partial Skill saves", () => {
  test("preserves omitted files and does not mutate source objects", () => {
    const updated = applySkillFileChanges(folder, [
      { path: "references/deploy.md", content: "Updated" },
    ]);
    expect(updated).toContainEqual(folder[0]);
    expect(updated).toContainEqual(folder[2]);
    expect(updated).toContainEqual({ path: "references/deploy.md", content: "Updated" });
    expect(folder[1]!.content).toBe("Run the deployment script.");
  });

  test("supports explicit deletions and text-file additions", () => {
    const updated = applySkillFileChanges(
      folder,
      [{ path: "settings.yaml", content: "enabled: true" }],
      ["scripts/deploy"],
    );
    expect(updated.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/deploy.md",
      "settings.yaml",
    ]);
  });

  test("requires the entry point and rejects conflicting edits", () => {
    expect(() => applySkillFileChanges(folder, [], ["SKILL.md"])).toThrow("must contain SKILL.md");
    expect(() => applySkillFileChanges([], [])).toThrow("must contain SKILL.md");
    expect(applySkillFileChanges([], [folder[0]!])).toEqual([folder[0]!]);
    expect(() => applySkillFileChanges(folder, [folder[0]!], ["SKILL.md"])).toThrow("Conflicting");
    expect(() => applySkillFileChanges(folder, [folder[0]!, folder[0]!])).toThrow("Conflicting");
    expect(() => applySkillFileChanges(folder, [], ["missing"])).toThrow("missing");
  });
});
