import { expect, test } from "bun:test";
import { loadSkillManagementSkill, readSkillFiles } from "../src/skill-library";

test("management guidance is a readable text Skill without a sandbox", () => {
  const skill = loadSkillManagementSkill();
  expect(skill.name).toBe("opengeni-skills");
  expect(skill.description).toContain("edit workspace Skills");
  const result = readSkillFiles(skill.files);
  expect(result.files).toHaveLength(1);
  expect(result.files[0]!.path).toBe("SKILL.md");
  expect(result.files[0]!.content).toContain("Management tools are lazy");
  expect(result.files[0]!.content).toContain("Require approval");
  expect(result.files[0]!.content).toContain("Omitted files are preserved");
});
