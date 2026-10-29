import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import { inspectPersistentAgentInstructions } from "../src/index";
import {
  formatSkillCatalog,
  SKILL_CATALOG_INLINE_MAX_BYTES,
  SKILL_CATALOG_INLINE_TOTAL_MAX_BYTES,
  SKILL_CATALOG_MAX_BYTES,
  SKILL_CATALOG_MAX_ENTRIES,
  skillCatalogEntryIds,
  skillInstructionsBody,
} from "../src/skill-catalog";

describe("sandbox-independent Skill catalog", () => {
  test("includes management guidance and short descriptors, never bodies or paths", () => {
    const catalog = formatSkillCatalog([
      { id: "builtin:skill-management", name: "skill-management", description: "Manage Skills" },
      { id: "workspace:deploy", name: "deploy", description: "Deploy services" },
    ]);
    expect(catalog).toContain("builtin:skill-management");
    expect(catalog).toContain("workspace:deploy");
    expect(catalog).toContain("Management tools are lazy");
    expect(catalog).not.toContain("references/");
  });

  test("is deterministic, supports duplicate display names, and rejects conflicting identities", () => {
    const entries = [
      { id: "b", name: "deploy", description: "Second" },
      { id: "a", name: "deploy", description: "First" },
    ];
    expect(formatSkillCatalog(entries)).toBe(formatSkillCatalog([...entries].reverse()));
    expect(formatSkillCatalog(entries)).toContain('"id":"a"');
    expect(formatSkillCatalog(entries)).toContain('"id":"b"');
    expect(() =>
      formatSkillCatalog([...entries, { id: "a", name: "other", description: "Conflict" }]),
    ).toThrow("Conflicting");
  });

  test("bounds Unicode output and explicitly reports omitted entries", () => {
    const catalog = formatSkillCatalog(
      Array.from({ length: 250 }, (_, index) => ({
        id: `skill-${index}`,
        name: `skill-${index}`,
        description: "日本語".repeat(1000),
      })),
    );
    expect(Buffer.byteLength(catalog)).toBeLessThanOrEqual(SKILL_CATALOG_MAX_BYTES);
    expect(catalog).toContain("additional Skills are omitted");
    expect(catalog).not.toContain("builtin:skill-management");
  });

  test("reads back exactly the ids a rendered catalog lists", () => {
    const entries = Array.from({ length: SKILL_CATALOG_MAX_ENTRIES + 3 }, (_, index) => ({
      id: `workspace:${String(index).padStart(3, "0")}`,
      name: `skill-${String(index).padStart(3, "0")}`,
      description: 'Line one\nline two with "quotes" and - { braces',
    }));
    const catalog = formatSkillCatalog([
      { id: "builtin:skill-management", name: "skill-management", description: "Manage Skills" },
      ...entries,
    ]);
    const ids = skillCatalogEntryIds(catalog);
    expect(catalog).toContain("4 additional Skills are omitted");
    expect(ids.size).toBe(SKILL_CATALOG_MAX_ENTRIES);
    expect(ids.has("builtin:skill-management")).toBe(true);
    expect(ids.has(entries.at(-1)!.id)).toBe(false);
    expect([...skillCatalogEntryIds(formatSkillCatalog([]))]).toEqual([]);
    expect([...skillCatalogEntryIds('- {not json\n- plain text\n- {"id":7}')]).toEqual([]);
  });

  test("an empty host selection does not inject hidden management guidance", () => {
    const catalog = formatSkillCatalog([]);
    expect(catalog).toContain("skill_read");
    expect(catalog).not.toContain("skill-management");
  });

  const header = [
    "## Skills",
    "Use skill_read to read a relevant Skill without a sandbox. Omit paths for SKILL.md, or supply paths to read exactly those files.",
    "For finding, installing, creating, or editing Skills, read the skill-management Skill. Management tools are lazy and available through tool search.",
    "The following entries are descriptors, not the Skill instructions. Use the id when names are ambiguous.",
  ];
  const management = {
    id: "builtin:skill-management",
    name: "skill-management",
    description: "Manage Skills",
  };
  const deploy = { id: "workspace:deploy", name: "deploy", description: "Deploy services" };

  test("a catalog without shown-in-full entries renders exactly as before", () => {
    expect(formatSkillCatalog([deploy, management])).toBe(
      [
        ...header,
        '- {"id":"builtin:skill-management","name":"skill-management","description":"Manage Skills"}',
        '- {"id":"workspace:deploy","name":"deploy","description":"Deploy services"}',
      ].join("\n"),
    );
  });

  test("shows short instructions in full, first, under one notice", () => {
    const catalog = formatSkillCatalog([
      deploy,
      management,
      {
        id: "skill-1",
        name: "reply-in-norwegian",
        description: "Applies in every conversation with this user.",
        instructions: "  Always reply in Norwegian.\nKeep code and quotes as they are.\n",
      },
    ]);
    expect(catalog).toBe(
      [
        ...header,
        "Entries with an instructions field show that Skill's complete instructions: follow them whenever the description applies, without skill_read.",
        '- {"id":"skill-1","name":"reply-in-norwegian","description":"Applies in every conversation with this user.","instructions":"Always reply in Norwegian.\\nKeep code and quotes as they are."}',
        '- {"id":"builtin:skill-management","name":"skill-management","description":"Manage Skills"}',
        '- {"id":"workspace:deploy","name":"deploy","description":"Deploy services"}',
      ].join("\n"),
    );
    expect([...skillCatalogEntryIds(catalog)].sort()).toEqual([
      "builtin:skill-management",
      "skill-1",
      "workspace:deploy",
    ]);
  });

  test("keeps larger instructions read-on-demand and bounds the inline total", () => {
    const atBound = "a".repeat(SKILL_CATALOG_INLINE_MAX_BYTES);
    const tooLarge = formatSkillCatalog([management, { ...deploy, instructions: `${atBound}b` }]);
    expect(tooLarge).toBe(formatSkillCatalog([management, deploy]));

    const entries = Array.from({ length: 6 }, (_, index) => ({
      id: `skill-${index}`,
      name: `pref-${index}`,
      description: `Preference ${index}`,
      instructions: String(index).repeat(SKILL_CATALOG_INLINE_MAX_BYTES),
    }));
    const catalog = formatSkillCatalog([management, ...entries]);
    const shown = catalog.split("\n").filter((line) => line.includes('"instructions"'));
    expect(shown.length).toBe(
      SKILL_CATALOG_INLINE_TOTAL_MAX_BYTES / SKILL_CATALOG_INLINE_MAX_BYTES,
    );
    expect(shown.map((line) => JSON.parse(line.slice(2)).id)).toEqual([
      "skill-0",
      "skill-1",
      "skill-2",
      "skill-3",
    ]);
    expect(catalog).toContain('"id":"skill-5","name":"pref-5","description":"Preference 5"}');
    // Empty instructions stay a plain descriptor.
    expect(formatSkillCatalog([management, { ...deploy, instructions: "  " }])).toBe(
      formatSkillCatalog([management, deploy]),
    );
  });

  test("never omits shown-in-full entries when the index is full", () => {
    const filler = Array.from({ length: SKILL_CATALOG_MAX_ENTRIES + 10 }, (_, index) => ({
      id: `a-${String(index).padStart(3, "0")}`,
      name: `a-${String(index).padStart(3, "0")}`,
      description: "Filler",
    }));
    const catalog = formatSkillCatalog([
      ...filler,
      { id: "z", name: "zz-preference", description: "Always", instructions: "Be brief." },
    ]);
    expect(skillCatalogEntryIds(catalog).has("z")).toBe(true);
    expect(catalog).toContain("11 additional Skills are omitted");
  });

  test("reads the SKILL.md body without its frontmatter", () => {
    expect(
      skillInstructionsBody(
        "---\nname: reply-in-norwegian\ndescription: Always.\n---\n\n# Norwegian\n\nReply in Norwegian.\n",
      ),
    ).toBe("# Norwegian\n\nReply in Norwegian.");
    expect(skillInstructionsBody("Plain body\r\n")).toBe("Plain body");
    expect(skillInstructionsBody("---\nname: x\ndescription: y\n---\n  \n")).toBeNull();
    expect(skillInstructionsBody("---\nunterminated")).toBe("---\nunterminated");
  });

  test("composes through the ordinary no-sandbox instruction path", () => {
    const inspection = inspectPersistentAgentInstructions(
      testSettings({ sandboxBackend: "none" }),
      {
        skillCatalog: [],
        sessionInstructions: "Session-specific instructions",
      },
    );
    expect(inspection.layers.find((layer) => layer.id === "skill_catalog")?.content).toContain(
      "skill_read",
    );
    expect(inspection.composed.endsWith("Session-specific instructions")).toBe(true);
    expect(inspection.composed).not.toContain("skill-management");
    expect(inspection.composed).not.toContain("skill_save");
  });

  test("places a rendered catalog in instructions and refreshes only on a new composition", () => {
    const descriptors = [{ id: "workspace:deploy", name: "deploy", description: "Original" }];
    const options = {
      workspaceGovernance: "Workspace governance",
      skillCatalog: descriptors,
      sessionInstructions: "Session instructions",
    };
    const settings = testSettings({ sandboxBackend: "none" });
    const first = inspectPersistentAgentInstructions(settings, options);
    const ids = first.layers.map((layer) => layer.id);
    expect(ids.indexOf("skill_catalog")).toBeGreaterThan(ids.indexOf("workspace_governance"));
    expect(ids.indexOf("skill_catalog")).toBeLessThan(ids.indexOf("session_instructions"));
    const original = first.composed;
    descriptors[0]!.description = "Updated";
    expect(first.composed).toBe(original);
    expect(first.layers.find((layer) => layer.id === "skill_catalog")?.content).toContain(
      "Original",
    );
    const next = inspectPersistentAgentInstructions(settings, options);
    expect(next.layers.find((layer) => layer.id === "skill_catalog")?.content).toContain("Updated");
  });
});
