import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import { inspectPersistentAgentInstructions } from "../src/index";
import {
  formatSkillCatalog,
  SKILL_CATALOG_INLINE_MAX_BYTES,
  SKILL_CATALOG_INLINE_TOTAL_MAX_BYTES,
  SKILL_CATALOG_MAX_BYTES,
  skillCatalogEntryIds,
  skillInstructionsBody,
} from "../src/skill-catalog";

const entryLines = (catalog: string) =>
  catalog.split("\n").filter((line) => line.startsWith("- {"));

describe("sandbox-independent Skill catalog", () => {
  test("includes management guidance and short descriptors, never bodies or paths", () => {
    const catalog = formatSkillCatalog([
      { id: "builtin:skill-management", name: "skill-management", description: "Manage Skills" },
      { id: "workspace:deploy", name: "deploy", description: "Deploy services" },
    ]);
    expect(entryLines(catalog)).toEqual([
      '- {"name":"skill-management","description":"Manage Skills"}',
      '- {"name":"deploy","description":"Deploy services"}',
    ]);
    expect(catalog).toContain("Management tools are lazy");
    expect(catalog).not.toContain("references/");
  });

  test("is deterministic, shows ids only for shared names, and rejects conflicting identities", () => {
    const entries = [
      { id: "b", name: "deploy", description: "Second" },
      { id: "a", name: "deploy", description: "First" },
      { id: "c", name: "review", description: "Third" },
    ];
    expect(formatSkillCatalog(entries)).toBe(formatSkillCatalog([...entries].reverse()));
    expect(entryLines(formatSkillCatalog(entries))).toEqual([
      '- {"id":"a","name":"deploy","description":"First"}',
      '- {"id":"b","name":"deploy","description":"Second"}',
      '- {"name":"review","description":"Third"}',
    ]);
    expect(() =>
      formatSkillCatalog([...entries, { id: "a", name: "other", description: "Conflict" }]),
    ).toThrow("Conflicting");
  });

  test("lists several hundred typical Skills in full", () => {
    const entries = Array.from({ length: 300 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `skill-${String(index).padStart(3, "0")}`,
      description: "Use when a typical task needs this procedure. ".repeat(6),
    }));
    const catalog = formatSkillCatalog(entries);
    expect(entryLines(catalog)).toHaveLength(300);
    expect(catalog).not.toContain("shortened");
    expect(catalog).not.toContain("omitted");
    expect(skillCatalogEntryIds(catalog, entries).size).toBe(300);
  });

  test("keeps every Skill listed by shortening only the longest descriptions", () => {
    const entries = [
      ...Array.from({ length: 400 }, (_, index) => ({
        id: `workspace:long-${index}`,
        name: `long-${String(index).padStart(3, "0")}`,
        description: "日本語の説明".repeat(100),
      })),
      { id: "workspace:short", name: "short", description: "Short and complete" },
    ];
    const catalog = formatSkillCatalog(entries);
    expect(Buffer.byteLength(catalog)).toBeLessThanOrEqual(SKILL_CATALOG_MAX_BYTES);
    expect(entryLines(catalog)).toHaveLength(401);
    expect(catalog).toContain('{"name":"short","description":"Short and complete"}');
    expect(catalog).toContain("…");
    expect(catalog).toContain("Some descriptions above are shortened to fit");
    expect(catalog).not.toContain("omitted");
    expect(catalog).not.toContain("\uFFFD");
  });

  test("bounds output and reports omitted entries only when names alone overflow", () => {
    const entries = Array.from({ length: 3000 }, (_, index) => ({
      id: `workspace:${index}`,
      name: `a-skill-with-a-rather-long-name-${String(index).padStart(4, "0")}`,
      description: "Description",
    }));
    const catalog = formatSkillCatalog(entries);
    expect(Buffer.byteLength(catalog)).toBeLessThanOrEqual(SKILL_CATALOG_MAX_BYTES);
    const listed = entryLines(catalog);
    expect(listed.length).toBeGreaterThan(1000);
    expect(listed[0]).toBe('- {"name":"a-skill-with-a-rather-long-name-0000"}');
    expect(catalog).toContain(
      `${3000 - listed.length} additional Skills are omitted from this index`,
    );
  });

  test("reads back exactly the ids a rendered catalog lists", () => {
    const entries = Array.from({ length: 3000 }, (_, index) => ({
      id: `workspace:${String(index).padStart(4, "0")}`,
      name: `a-skill-with-a-rather-long-name-${String(index).padStart(4, "0")}`,
      description: 'Line one\nline two with "quotes" and - { braces',
    }));
    const descriptors = [
      { id: "builtin:skill-management", name: "skill-management", description: "Manage Skills" },
      { id: "workspace:twin-a", name: "0-twin", description: "One" },
      { id: "workspace:twin-b", name: "0-twin", description: "Two" },
      ...entries,
    ];
    const catalog = formatSkillCatalog(descriptors);
    const ids = skillCatalogEntryIds(catalog, descriptors);
    expect(catalog).toContain("additional Skills are omitted");
    expect(ids.size).toBe(entryLines(catalog).length);
    expect(ids.has("builtin:skill-management")).toBe(true);
    expect(ids.has("workspace:twin-a")).toBe(true);
    expect(ids.has("workspace:twin-b")).toBe(true);
    expect(ids.has(entries[0]!.id)).toBe(true);
    expect(ids.has(entries.at(-1)!.id)).toBe(false);
    // Catalogs rendered before ids became conditional still read back.
    expect([
      ...skillCatalogEntryIds('- {"id":"workspace:old","name":"old","description":"Earlier"}'),
    ]).toEqual(["workspace:old"]);
    expect([...skillCatalogEntryIds(formatSkillCatalog([]))]).toEqual([]);
    expect([
      ...skillCatalogEntryIds('- {not json\n- plain text\n- {"id":7}\n- {"name":"unknown"}', []),
    ]).toEqual([]);
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
    "The following entries are descriptors, not the Skill instructions. Read a Skill by its name; an entry shows an id only when several Skills share that name, and then you read it by that id.",
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
        '- {"name":"skill-management","description":"Manage Skills"}',
        '- {"name":"deploy","description":"Deploy services"}',
      ].join("\n"),
    );
  });

  test("shows short instructions in full, first, under one combined notice", () => {
    const descriptors = [
      deploy,
      management,
      {
        id: "skill-1",
        name: "reply-in-norwegian",
        description: "Applies in every conversation with this user.",
        instructions: "  Always reply in Norwegian.\nKeep code and quotes as they are.\n",
      },
    ];
    const catalog = formatSkillCatalog(descriptors);
    expect(catalog).toBe(
      [
        ...header.slice(0, -1),
        "The following entries are descriptors, except that an instructions field holds that Skill's complete instructions: follow them whenever its description applies, without skill_read. Read a Skill by its name; an entry shows an id only when several Skills share that name, and then you read it by that id.",
        '- {"name":"reply-in-norwegian","description":"Applies in every conversation with this user.","instructions":"Always reply in Norwegian.\\nKeep code and quotes as they are."}',
        '- {"name":"skill-management","description":"Manage Skills"}',
        '- {"name":"deploy","description":"Deploy services"}',
      ].join("\n"),
    );
    expect([...skillCatalogEntryIds(catalog, descriptors)].sort()).toEqual([
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
    expect(shown.map((line) => JSON.parse(line.slice(2)).name)).toEqual([
      "pref-0",
      "pref-1",
      "pref-2",
      "pref-3",
    ]);
    expect(catalog).toContain('- {"name":"pref-5","description":"Preference 5"}');
    // Empty instructions stay a plain descriptor.
    expect(formatSkillCatalog([management, { ...deploy, instructions: "  " }])).toBe(
      formatSkillCatalog([management, deploy]),
    );
  });

  test("keeps shown-in-full entries when even names overrun the index", () => {
    const filler = Array.from({ length: 3000 }, (_, index) => ({
      id: `a-${String(index).padStart(4, "0")}`,
      name: `a-${String(index).padStart(4, "0")}-${"n".repeat(40)}`,
      description: "Filler",
    }));
    const descriptors = [
      ...filler,
      { id: "z", name: "zz-preference", description: "Always", instructions: "Be brief." },
    ];
    const catalog = formatSkillCatalog(descriptors);
    expect(Buffer.byteLength(catalog)).toBeLessThanOrEqual(SKILL_CATALOG_MAX_BYTES);
    expect(skillCatalogEntryIds(catalog, descriptors).has("z")).toBe(true);
    expect(catalog).toMatch(/\d+ additional Skills are omitted/u);
    // Names-only entries carry no instructions, so the plain notice applies.
    expect(catalog).not.toContain('"instructions"');
    expect(catalog).toContain(header[3]!);
  });

  test("reads the SKILL.md body without its frontmatter", () => {
    expect(
      skillInstructionsBody(
        "---\nname: reply-in-norwegian\ndescription: Always.\n---\n\n# Norwegian\n\nReply in Norwegian.\n",
      ),
    ).toBe("# Norwegian\n\nReply in Norwegian.");
    expect(skillInstructionsBody("Plain body\r\n")).toBe("Plain body");
    expect(skillInstructionsBody("---\nname: x\ndescription: y\n---\n  \n")).toBeNull();
  });

  test("treats line endings alike and never shows unclosed frontmatter", () => {
    const expected = "# Norwegian\nReply in Norwegian.";
    expect(skillInstructionsBody("# Norwegian\r\nReply in Norwegian.\r\n")).toBe(expected);
    expect(skillInstructionsBody("# Norwegian\rReply in Norwegian.")).toBe(expected);
    expect(
      skillInstructionsBody(
        "---\r\nname: x\r\ndescription: y\r\n---\r\n# Norwegian\r\nReply in Norwegian.",
      ),
    ).toBe(expected);
    expect(skillInstructionsBody("---\nname: x\ndescription: y\n# Norwegian\nReply.")).toBeNull();
    expect(skillInstructionsBody("---\r\nunterminated")).toBeNull();
  });

  test("bounds instructions by their rendered, escaped size", () => {
    // 1,024 plain bytes render as 1,024 and are shown; one escaped newline more is not.
    const plain = "a".repeat(SKILL_CATALOG_INLINE_MAX_BYTES);
    expect(formatSkillCatalog([management, { ...deploy, instructions: plain }])).toContain(
      `"instructions":"${plain}"`,
    );
    const escapedOver = `${"a".repeat(SKILL_CATALOG_INLINE_MAX_BYTES - 2)}\nb`;
    expect(formatSkillCatalog([management, { ...deploy, instructions: escapedOver }])).toBe(
      formatSkillCatalog([management, deploy]),
    );
    // 200 control characters are 200 raw bytes but 1,200 rendered ones.
    const control = `x${"\u0001".repeat(200)}x`;
    expect(formatSkillCatalog([management, { ...deploy, instructions: control }])).toBe(
      formatSkillCatalog([management, deploy]),
    );
    // The total counts rendered bytes too: five bodies of 819 raw bytes would
    // fit 4,096, but with 11 newlines each renders 830 bytes, so four fit.
    const body = `${"y\n".repeat(11)}${"z".repeat(797)}`;
    expect(Buffer.byteLength(body) * 5).toBeLessThanOrEqual(SKILL_CATALOG_INLINE_TOTAL_MAX_BYTES);
    const entries = Array.from({ length: 5 }, (_, index) => ({
      id: `p-${index}`,
      name: `p-${index}`,
      description: "Preference",
      instructions: body,
    }));
    const catalog = formatSkillCatalog([management, ...entries]);
    expect(catalog.split("\n").filter((line) => line.includes('"instructions"')).length).toBe(4);
    const shown = catalog
      .split("\n")
      .filter((line) => line.startsWith("- {"))
      .map((line) => JSON.parse(line.slice(2)) as { instructions?: string })
      .filter((entry) => entry.instructions !== undefined);
    const rendered = shown.reduce(
      (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.instructions)) - 2,
      0,
    );
    expect(rendered).toBeLessThanOrEqual(SKILL_CATALOG_INLINE_TOTAL_MAX_BYTES);
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
