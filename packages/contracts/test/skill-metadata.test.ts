import { expect, test } from "bun:test";
import {
  parseLenientSkillFrontmatter,
  parseSkillFrontmatter,
  SkillArtifactDefinition,
  SkillFrontmatterError,
  SessionSkill,
  SessionSkills,
  StoredSessionSkills,
} from "../src/index";

const files = [
  {
    path: "SKILL.md",
    content: "---\nname: deploy\ndescription: Run deployment checks\n---\n# Deploy",
  },
];

test("inline and portable Skills derive metadata from files without duplicate input fields", () => {
  expect(SessionSkill.parse({ files })).toEqual({
    name: "deploy",
    description: "Run deployment checks",
    files,
  });
  expect(SkillArtifactDefinition.parse({ files, activationMode: "session_selected" })).toEqual({
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
  expect(() => SkillArtifactDefinition.parse(legacy)).toThrow("safe name");
});

test("session deduplication compares the derived metadata and exact files", () => {
  expect(SessionSkills.parse([{ files }, { files, name: "deploy" }])).toHaveLength(1);
});

test("every inline admission rejects non-text, oversized and conflicting folder content", () => {
  const invalidFiles = [
    [...files, { path: "data.bin", content: "a\u0000b" }],
    [...files, { path: "bad.txt", content: "\ud800" }],
    [...files, { path: "big.txt", content: "é".repeat(1_120_000) }],
    [...files, { path: "scripts", content: "file" }, { path: "scripts/run", content: "code" }],
    [...files, { path: "bad:path", content: "text" }],
    [...files, { path: "bad\ud800path", content: "text" }],
    [
      ...files,
      ...Array.from({ length: 5 }, (_, index) => ({
        path: `part-${index}`,
        content: "x".repeat(2_000_000),
      })),
    ],
  ];
  for (const candidate of invalidFiles) {
    expect(SessionSkill.safeParse({ files: candidate }).success).toBe(false);
    expect(SkillArtifactDefinition.safeParse({ files: candidate }).success).toBe(false);
  }
  const text = [
    ...files,
    { path: "no-extension", content: "日本語\n" },
    { path: "custom.bin", content: "\ufeffThis is text." },
  ];
  expect(SessionSkill.parse({ files: text }).files).toEqual(text);
});

test("stored metadata is derived without rewriting historical files", () => {
  const legacy = { name: "old-label", description: "Old database description", files };
  const historicalBytes = JSON.stringify(legacy);
  expect(StoredSessionSkills.parse([legacy])).toEqual(SessionSkills.parse([{ files }]));
  expect(JSON.stringify(legacy)).toBe(historicalBytes);
  expect(SessionSkill.safeParse(legacy).success).toBe(false);
});

test("stored projection never invents missing frontmatter or hides invalid content", () => {
  const plain = {
    name: "legacy",
    description: "Old description",
    files: [{ path: "SKILL.md", content: "No frontmatter" }],
  };
  expect(StoredSessionSkills.safeParse([plain]).success).toBe(false);
});

const colonDescription = "---\nname: deploy\ndescription: Use when: shipping\n---\n# Deploy";

test("strict frontmatter errors keep their message and add a bounded reason", () => {
  let error: unknown;
  try {
    parseSkillFrontmatter(colonDescription);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(SkillFrontmatterError);
  expect((error as SkillFrontmatterError).message).toContain(
    "This skill's SKILL.md header contains invalid YAML",
  );
  expect((error as SkillFrontmatterError).reason).toBe("yaml_block_as_implicit_key");
  expect(() => parseSkillFrontmatter("---\n- item\n---\n")).toThrow(
    "Skill artifact SKILL.md frontmatter must be a mapping",
  );
});

test("managed and inline Skill admission stays strict for hand-written headers", () => {
  expect(() =>
    SessionSkill.parse({ files: [{ path: "SKILL.md", content: colonDescription }] }),
  ).toThrow("invalid YAML");
});

test("lenient frontmatter returns strict YAML unchanged when it parses", () => {
  const markdown = '---\nname: deploy\ndescription: "Use when: shipping"\nlicense: MIT\n---\n';
  expect(parseLenientSkillFrontmatter(markdown)).toEqual(parseSkillFrontmatter(markdown));
  expect(parseLenientSkillFrontmatter("# No header")).toEqual({ name: null, description: null });
});

test.each([
  [colonDescription, "deploy", "Use when: shipping", "yaml_block_as_implicit_key"],
  [
    "---\nname:\tdeploy\ndescription:\n\tTabbed: text\n\tsecond line\n---\n",
    "deploy",
    "Tabbed: text second line",
    "yaml_tab_as_indent",
  ],
  [
    "---\nname: deploy\ndescription: |\n  Line one: a\n    nested\n\n  Line two\nextra: [\n---\n",
    "deploy",
    "Line one: a\n  nested\n\nLine two",
    "yaml_",
  ],
  [
    "---\nname: 'deploy'\ndescription: 'It''s: fine' and more\n---\n",
    "deploy",
    "'It''s: fine' and more",
    "yaml_",
  ],
  [
    '---\nname: "deploy"\ndescription: "Say \\"hi\\": now"\nbad: [\n---\n',
    "deploy",
    'Say "hi": now',
    "yaml_",
  ],
  ["---\nname: deploy\ndescription: % complete\n---\n", "deploy", "% complete", "yaml_"],
  ["---\nname: deploy\ndescription:\nother: [\n---\n", "deploy", null, "yaml_"],
])(
  "lenient frontmatter recovers name and description: %#",
  (markdown, name, description, reason) => {
    const parsed = parseLenientSkillFrontmatter(markdown);
    expect(parsed.name).toBe(name);
    expect(parsed.description).toBe(description);
    expect(parsed.fallbackReason).toStartWith(reason);
    expect(parsed.keys).toContain("name");
  },
);

test.each([
  ["---\nname: first\nname: second\n---\n", "duplicate_name"],
  ["---\n- not a mapping\n---\n", "yaml_not_mapping_without_name"],
  ["---\ndescription: Use when: shipping\n---\n", "yaml_block_as_implicit_key_without_name"],
  ["---\nname:\ndescription: Use when: shipping\n---\n", "yaml_block_as_implicit_key_without_name"],
  ["---\n  name: indented: deploy\n---\n", "yaml_block_as_implicit_key_without_name"],
])("lenient frontmatter never accepts a header without one usable name: %s", (markdown, reason) => {
  let error: unknown;
  try {
    parseLenientSkillFrontmatter(markdown);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(SkillFrontmatterError);
  expect((error as SkillFrontmatterError).reason).toBe(reason);
});
