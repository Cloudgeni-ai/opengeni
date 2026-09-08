import { describe, expect, test } from "bun:test";
import { buildPortableSkillArtifact } from "../src/skill-library";

const main = {
  path: "SKILL.md",
  content: "---\nname: text-test\ndescription: Text validation fixture\n---\n# Instructions\n",
};

describe("portable Skill text validation", () => {
  test("accepts text regardless of extension and preserves Unicode and BOM", () => {
    const files = [
      main,
      { path: "scripts/run", content: "echo 日本語\n" },
      { path: "settings.custom", content: "\ufeffexample: true\n" },
    ];
    const artifact = buildPortableSkillArtifact(files);
    expect(artifact.files).toContainEqual(files[1]);
    expect(artifact.files).toContainEqual(files[2]);
  });

  test("rejects NUL instead of failing later in Postgres", () => {
    expect(() =>
      buildPortableSkillArtifact([main, { path: "data.bin", content: "a\u0000b" }]),
    ).toThrow("NUL bytes: data.bin");
  });

  test("rejects unpaired surrogates rather than storing replacement characters", () => {
    expect(() =>
      buildPortableSkillArtifact([main, { path: "bad.txt", content: "\ud800" }]),
    ).toThrow("malformed Unicode text: bad.txt");
  });

  test("rejects file-directory conflicts in either input order", () => {
    const parent = { path: "scripts", content: "file" };
    const child = { path: "scripts/run", content: "nested" };
    for (const files of [
      [main, parent, child],
      [main, child, parent],
    ]) {
      expect(() => buildPortableSkillArtifact(files)).toThrow(
        "both a file and a directory: scripts",
      );
    }
  });
});
