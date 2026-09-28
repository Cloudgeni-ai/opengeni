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
  expect(skill.name).toBe("opengeni-skills");
  expect(skill.description).toContain("edit, and permanently remove Skills");
  const result = readSkillFiles(skill.files);
  expect(result.files).toHaveLength(1);
  expect(result.files[0]!.path).toBe("SKILL.md");
  expect(result.files[0]!.content).toContain("Management tools are lazy");
  expect(result.files[0]!.content).toContain("Review first");
  expect(result.files[0]!.content).toContain("Omitted files are preserved");
  expect(result.files[0]!.content).toContain("`listFiles: true`");
  expect(result.files[0]!.content).toContain("never file bodies");
});

test("management guidance sizes a Skill to the request with a short worked example", () => {
  const skill = loadSkillManagementSkill();
  // The index descriptor is unchanged; only the on-demand body teaches sizing.
  expect(skill.description).toBe(
    "Find, install, create, edit, and permanently remove Skills; understand reading, file changes, Agent learning settings, and optional sandbox checkout.",
  );
  const body = skill.files.find((file) => file.path === "SKILL.md")!.content;
  expect(body).toContain("Size a Skill to what the user asked.");
  expect(body).toContain(
    "A preference or habit needs a one-sentence\ndescription and two or three plain sentences, not a checklist.",
  );
  expect(body).toContain("When editing, change only the part the request is\nabout.");
  // The example is itself a valid, preference-sized Skill.
  const example = /```\n(---\n[\s\S]*?)\n```/u.exec(body)?.[1];
  expect(example).toBeDefined();
  expect(parsePortableSkillFrontmatter(example!)).toEqual({
    name: "preview-ui-changes",
    description: "Use when a user asks for a UI change.",
  });
  expect(example!.length).toBeLessThan(400);
});
