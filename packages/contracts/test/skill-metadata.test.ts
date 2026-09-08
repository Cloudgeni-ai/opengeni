import { expect, test } from "bun:test";
import { CapabilityPackSkill, SessionSkill, SessionSkills } from "../src/index";

const files = [
  {
    path: "SKILL.md",
    content: "---\nname: deploy\ndescription: Run deployment checks\n---\n# Deploy",
  },
];

test("inline and Pack Skills derive metadata from files without duplicate input fields", () => {
  expect(SessionSkill.parse({ files })).toEqual({
    name: "deploy",
    description: "Run deployment checks",
    files,
  });
  expect(CapabilityPackSkill.parse({ files, activationMode: "session_selected" })).toEqual({
    name: "deploy",
    description: "Run deployment checks",
    files,
    activationMode: "session_selected",
  });
});

test("legacy metadata fields are checked rather than overriding frontmatter", () => {
  expect(
    SessionSkill.parse({ files, name: "deploy", description: "Run deployment checks" }).name,
  ).toBe("deploy");
  expect(() => SessionSkill.parse({ files, name: "other" })).toThrow("must match SKILL.md");
  expect(() => SessionSkill.parse({ files, description: "Competing summary" })).toThrow(
    "must match SKILL.md",
  );
});

test("missing frontmatter cannot enter session or Pack context through inline content", () => {
  const legacy = {
    name: "deploy",
    description: "Run deployment checks",
    files: [{ path: "SKILL.md", content: "Instructions" }],
  };
  expect(() => SessionSkill.parse(legacy)).toThrow("safe name");
  expect(() => CapabilityPackSkill.parse(legacy)).toThrow("safe name");
});

test("session deduplication compares the derived metadata and exact files", () => {
  expect(SessionSkills.parse([{ files }, { files, name: "deploy" }])).toHaveLength(1);
});
