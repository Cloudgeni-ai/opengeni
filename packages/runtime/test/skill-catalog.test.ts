import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import { inspectPersistentAgentInstructions } from "../src/index";
import {
  formatSkillCatalog,
  SKILL_CATALOG_MAX_BYTES,
  skillCatalogEntryIds,
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
