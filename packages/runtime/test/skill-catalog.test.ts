import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { inspectPersistentAgentInstructions } from "../src/index";
import {
  formatSkillCatalog,
  SKILL_CATALOG_MAX_BYTES,
  SKILL_CATALOG_MAX_ENTRIES,
  skillCatalogEntryIds,
} from "../src/skill-catalog";

describe("sandbox-independent Skill catalog", () => {
  test("includes management guidance and short descriptors, never bodies or paths", () => {
    const catalog = formatSkillCatalog([
      { id: "builtin:opengeni-skills", name: "opengeni-skills", description: "Manage Skills" },
      { id: "workspace:deploy", name: "deploy", description: "Deploy services" },
    ]);
    expect(catalog).toContain("builtin:opengeni-skills");
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
    expect(catalog).not.toContain("builtin:opengeni-skills");
  });

  test("reads back exactly the ids a rendered catalog lists", () => {
    const entries = Array.from({ length: SKILL_CATALOG_MAX_ENTRIES + 3 }, (_, index) => ({
      id: `workspace:${String(index).padStart(3, "0")}`,
      name: `skill-${String(index).padStart(3, "0")}`,
      description: 'Line one\nline two with "quotes" and - { braces',
    }));
    const catalog = formatSkillCatalog([
      { id: "builtin:opengeni-skills", name: "opengeni-skills", description: "Manage Skills" },
      ...entries,
    ]);
    const ids = skillCatalogEntryIds(catalog);
    expect(catalog).toContain("4 additional Skills are omitted");
    expect(ids.size).toBe(SKILL_CATALOG_MAX_ENTRIES);
    expect(ids.has("builtin:opengeni-skills")).toBe(true);
    expect(ids.has(entries.at(-1)!.id)).toBe(false);
    expect([...skillCatalogEntryIds(formatSkillCatalog([]))]).toEqual([]);
    expect([...skillCatalogEntryIds('- {not json\n- plain text\n- {"id":7}')]).toEqual([]);
  });

  test("an empty host selection does not inject hidden management guidance", () => {
    const catalog = formatSkillCatalog([]);
    expect(catalog).toContain("skill_read");
    expect(catalog).not.toContain("opengeni-skills");
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
    expect(inspection.composed).not.toContain("opengeni-skills");
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
