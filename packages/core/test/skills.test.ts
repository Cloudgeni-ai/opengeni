import { describe, expect, test } from "bun:test";
import { skillBundleHash, validateSkillFiles } from "../src/domain/skills";
import { skillArtifactContentSha256 } from "@opengeni/runtime/skill-library";

const main = { path: "SKILL.md", content: "# A Skill\nDo the thing." };
describe("unified Skill text folders", () => {
  test("requires a nonempty SKILL.md", () => {
    expect(() => validateSkillFiles([])).toThrow();
    expect(() => validateSkillFiles([{ path: "skill.md", content: "x" }])).toThrow();
    expect(() => validateSkillFiles([{ path: "SKILL.md", content: " \n" }])).toThrow();
  });
  test("preserves text exactly and canonicalizes only file order", () => {
    const files = [{ path: "references/context.txt", content: "é\r\n  verbatim\n" }, main];
    expect(validateSkillFiles(files)).toEqual([main, files[0]!]);
    expect(skillBundleHash(files)).toBe(skillBundleHash([...files].reverse()));
    expect(skillBundleHash(files)).not.toBe(skillBundleHash([main]));
    expect(skillBundleHash(files)).toBe(skillArtifactContentSha256(files));
    expect(files[0]!.path).toBe("references/context.txt");
  });
  test.each([
    "/absolute",
    "../escape",
    "a/../escape",
    "./relative",
    "a//b",
    "a/",
    "a\\b",
    "C:foo",
    "a\nfile",
    "SKILL.md",
  ])("rejects unsafe/duplicate path %s", (path) => {
    expect(() => validateSkillFiles([main, { path, content: "x" }])).toThrow();
  });
  test("uses byte limits, rejects malformed Unicode and NUL", () => {
    expect(() =>
      validateSkillFiles([main, { path: "data", content: "é".repeat(131073) }]),
    ).toThrow();
    expect(() => validateSkillFiles([main, { path: "data", content: "\ud800" }])).toThrow();
    expect(() => validateSkillFiles([main, { path: "data", content: "binary\0" }])).toThrow();
    expect(() =>
      validateSkillFiles([
        main,
        ...Array.from({ length: 4 }, (_, i) => ({ path: `data${i}`, content: "x".repeat(262144) })),
      ]),
    ).toThrow();
    expect(() =>
      validateSkillFiles([
        main,
        ...Array.from({ length: 128 }, (_, i) => ({ path: `data${i}`, content: "" })),
      ]),
    ).toThrow();
    expect(validateSkillFiles([main, { path: "max", content: "x".repeat(262144) }])).toHaveLength(
      2,
    );
  });
});
