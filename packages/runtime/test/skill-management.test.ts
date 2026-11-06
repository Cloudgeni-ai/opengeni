import { expect, test } from "bun:test";
import {
  listSkillLibraryEntries,
  loadSkillLibrarySkill,
  loadSkillManagementSkill,
  readSkillFiles,
  parsePortableSkillFrontmatter,
} from "../src/skill-library";

test("curated library descriptors come from the pinned SKILL.md, not handwritten summaries", () => {
  const entries = listSkillLibraryEntries();
  expect(entries).toHaveLength(9);
  for (const entry of entries) {
    const { skill } = loadSkillLibrarySkill(entry.id);
    const main = skill.files.find((file) => file.path === "SKILL.md")!;
    const metadata = parsePortableSkillFrontmatter(main.content);
    expect({ name: entry.name, description: entry.description }).toEqual(metadata);
    expect({ name: skill.name, description: skill.description }).toEqual(metadata);
  }
});

test("management guidance is a readable text Skill without a sandbox", () => {
  const skill = loadSkillManagementSkill();
  expect(skill.name).toBe("skill-management");
  expect(skill.description).toContain("edit, and permanently remove Skills");
  const result = readSkillFiles(skill.files);
  expect(result.files).toHaveLength(1);
  expect(result.files[0]!.path).toBe("SKILL.md");
  expect(result.files[0]!.content).toContain("Management tools are lazy");
  expect(result.files[0]!.content).toContain("Review first");
  expect(result.files[0]!.content).toContain("Omitted files are preserved");
  expect(result.files[0]!.content).toContain("`listFiles: true`");
  expect(result.files[0]!.content).toContain("never file bodies");
  // Pending approval is explained the same way as in the Skill write tools.
  const text = result.files[0]!.content.replace(/\s+/g, " ");
  expect(text).toContain(
    "A save, publish, or install pending approval has no effect until someone who can manage it approves it, in Knowledge > Review or from its card in the chat where one is shown; an edited Skill keeps its current version until then. Say so in your reply",
  );
  expect(text).not.toContain("Needs review");
});
