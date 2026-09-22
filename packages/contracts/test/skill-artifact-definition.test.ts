import { describe, expect, test } from "bun:test";
import { SkillArtifactDefinition, SessionSkills } from "../src";

const skill = {
  name: "infra-ops",
  files: [
    {
      path: "SKILL.md",
      content: "---\nname: infra-ops\ndescription: Operate infrastructure.\n---\n# Instructions",
    },
    { path: "references/runbook.md", content: "Runbook" },
  ],
};

describe("independent Skill artifacts", () => {
  test("validates a portable folder without any package manifest", () => {
    expect(SkillArtifactDefinition.parse(skill).files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/runbook.md",
    ]);
  });

  test("requires the canonical metadata file", () => {
    expect(() =>
      SkillArtifactDefinition.parse({ ...skill, files: skill.files.slice(1) }),
    ).toThrow();
  });

  test("rejects unsafe paths and repeated files", () => {
    for (const path of [
      "../escape.md",
      "/absolute.md",
      "a//b.md",
      "./SKILL.md",
      "refs/../SKILL.md",
      "refs\\windows.md",
      "SKILL.md",
    ]) {
      expect(() =>
        SkillArtifactDefinition.parse({
          ...skill,
          files: [...skill.files, { path, content: "x" }],
        }),
      ).toThrow();
    }
  });

  test("rejects unsafe names and conflicting session selections", () => {
    for (const name of ["infra/ops", "..", ".hidden", "-leading", ""]) {
      expect(() => SkillArtifactDefinition.parse({ ...skill, name })).toThrow();
    }
    expect(SessionSkills.parse([skill, skill])).toHaveLength(1);
    expect(() =>
      SessionSkills.parse([
        skill,
        {
          ...skill,
          files: [...skill.files, { path: "extra.md", content: "Conflicting definition" }],
        },
      ]),
    ).toThrow();
  });
});
