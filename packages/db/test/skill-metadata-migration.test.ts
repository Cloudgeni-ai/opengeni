import { describe, expect, test } from "bun:test";
import { prepareLegacySkillFolder } from "../src/skill-metadata-migration";

const legacy = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Legacy Display Title",
  description: "Historical description",
};
describe("shared-parser Skill metadata migration", () => {
  test("preserves arbitrary valid YAML bytes and exact decoded metadata", () => {
    const content =
      "---\r\n# retain this comment\r\nname: yaml-name\r\ndescription: |-\r\n  First line\r\n  Second line\r\ncustom: [one, two]\r\n---\r\nBody  \r\n";
    const files = [
      { path: "SKILL.md", content },
      { path: "references/info.txt", content: "Untouched" },
    ];
    expect(prepareLegacySkillFolder(files, legacy)).toEqual({
      files,
      name: "yaml-name",
      description: "First line\nSecond line",
    });
  });
  test("wraps only plain legacy text and leaves the complete body unchanged", () => {
    const body = "Old body\n\nwith trailing spaces  \n";
    const migrated = prepareLegacySkillFolder([{ path: "SKILL.md", content: body }], legacy);
    expect(migrated.files[0]!.content).toBe(
      `---\nname: "legacy-display-title"\ndescription: "Historical description"\n---\n${body}`,
    );
    expect(migrated.name).toBe("legacy-display-title");
  });
  test("uses stable identity for unrepresentable names without truncation", () => {
    const result = prepareLegacySkillFolder([{ path: "SKILL.md", content: "Body" }], {
      ...legacy,
      title: "a".repeat(120),
    });
    expect(result.name).toBe("legacy-11111111111141118111111111111111");
  });
  for (const content of [
    "---\nname: missing-end\ndescription: text",
    "---\nname: [\ndescription: invalid\n---\nBody",
    "---\nname: first\nname: second\ndescription: duplicate\n---\nBody",
    "---\nname: Invalid_Name\ndescription: text\n---\nBody",
    "---\nname: valid-name\n---\nBody",
    "\n---\nname: ambiguous-header\ndescription: text\n---\nBody",
  ])
    test(`fails closed for invalid/ambiguous header ${JSON.stringify(content)}`, () => {
      expect(() => prepareLegacySkillFolder([{ path: "SKILL.md", content }], legacy)).toThrow();
    });
  test("never truncates an oversized legacy description", () => {
    expect(() =>
      prepareLegacySkillFolder([{ path: "SKILL.md", content: "Body" }], {
        ...legacy,
        description: "d".repeat(1025),
      }),
    ).toThrow();
  });
});
