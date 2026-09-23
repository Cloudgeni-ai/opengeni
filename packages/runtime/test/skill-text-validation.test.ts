import { describe, expect, test } from "bun:test";
import { buildPortableSkillArtifact, parsePortableSkillFrontmatter } from "../src/skill-library";
import {
  SKILL_MAX_FILES,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_TOTAL_BYTES,
  validateSkillTextFiles,
} from "@opengeni/contracts";
import { SKILL_READ_MAX_OUTPUT_BYTES, SKILL_READ_MAX_PATHS } from "../src/skill-files";

const main = {
  path: "SKILL.md",
  content: "---\nname: text-test\ndescription: Text validation fixture\n---\n# Instructions\n",
};

describe("portable Skill text validation", () => {
  test("admits eightfold storage boundaries without increasing read output limits", () => {
    expect([SKILL_MAX_FILES, SKILL_MAX_FILE_BYTES, SKILL_MAX_TOTAL_BYTES]).toEqual([
      1024, 2097152, 8388608,
    ]);
    expect([SKILL_READ_MAX_PATHS, SKILL_READ_MAX_OUTPUT_BYTES]).toEqual([128, 524288]);
    const files = [
      main,
      ...Array.from({ length: 1023 }, (_, i) => ({ path: `refs/${i}.txt`, content: "x" })),
    ];
    expect(buildPortableSkillArtifact(files).files).toHaveLength(1024);
    expect(() => buildPortableSkillArtifact([...files, { path: "extra", content: "x" }])).toThrow();
    const full = { path: "large.json", content: "x".repeat(SKILL_MAX_FILE_BYTES) };
    expect(() => buildPortableSkillArtifact([main, full])).not.toThrow();
    expect(() =>
      buildPortableSkillArtifact([main, { ...full, content: full.content + "x" }]),
    ).toThrow();
    const total = Array.from({ length: 4 }, (_, i) => ({
      path: `${i}.txt`,
      content: full.content,
    }));
    expect(validateSkillTextFiles(total).totalBytes).toBe(SKILL_MAX_TOTAL_BYTES);
    expect(() => validateSkillTextFiles([...total, { path: "extra", content: "x" }])).toThrow();
  });
  test("requires frontmatter and derives exact metadata including long descriptions", () => {
    expect(() =>
      buildPortableSkillArtifact([{ path: "SKILL.md", content: "Instructions" }]),
    ).toThrow("safe name");
    const description = "Read before deployment. ".repeat(30).trim();
    const content = `---\nname: deploy-check\ndescription: ${JSON.stringify(description)}\n---\nInstructions`;
    const artifact = buildPortableSkillArtifact([{ path: "SKILL.md", content }]);
    expect(artifact.name).toBe("deploy-check");
    expect(artifact.description).toBe(description);
    expect(artifact.description.length).toBeGreaterThan(240);
    expect(artifact.files[0]!.content).toBe(content);
    expect(() =>
      buildPortableSkillArtifact([
        { path: "SKILL.md", content: `---\nname: deploy\ndescription: ${"x".repeat(1025)}\n---\n` },
      ]),
    ).toThrow("1024");
  });

  test("uses YAML semantics for quotes, blocks and duplicate-key validation", () => {
    expect(
      parsePortableSkillFrontmatter(
        '---\nname: deploy\ndescription: "Run \\"checks\\" before deploying"\n---\n',
      ),
    ).toEqual({
      name: "deploy",
      description: 'Run "checks" before deploying',
    });
    expect(
      parsePortableSkillFrontmatter(
        "---\nname: deploy\ndescription: >-\n  Run checks\n  before deploying.\n---\n",
      ).description,
    ).toBe("Run checks before deploying.");
    expect(
      parsePortableSkillFrontmatter(
        "---\nname: deploy\ndescription: |-\n  First line\n  Second line\n---\n",
      ).description,
    ).toBe("First line\nSecond line");
    expect(() =>
      parsePortableSkillFrontmatter("---\nname: deploy\nname: shadow\ndescription: Checks\n---\n"),
    ).toThrow("invalid YAML");
    expect(() =>
      buildPortableSkillArtifact([
        { path: "SKILL.md", content: "---\nname: deploy\ndescription: true\n---\n" },
      ]),
    ).toThrow("description");
  });

  test.each([
    "Uppercase",
    "bad_name",
    "bad.name",
    "-start",
    "end-",
    "two--hyphens",
    '" padded "',
    "a".repeat(65),
  ])("rejects invalid Skill name %s", (name) => {
    expect(() =>
      buildPortableSkillArtifact([
        { path: "SKILL.md", content: `---\nname: ${name}\ndescription: Instructions\n---\n` },
      ]),
    ).toThrow("safe name");
  });
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
