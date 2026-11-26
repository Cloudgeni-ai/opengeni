import { describe, expect, test } from "bun:test";
import { parseAppPackage } from "@opengeni/contracts";
import { agentTemplates, appTemplates } from "../src/index";

describe("ready-made apps", () => {
  test("every content file is a valid, complete app package", () => {
    expect(appTemplates().map((template) => template.key)).toEqual([
      "work-summary",
      "issue-tracker",
      "incident-log",
      "feedback-board",
      "decision-log",
    ]);
    for (const template of appTemplates()) {
      const parsed = parseAppPackage(template.package);
      expect(parsed.problems).toEqual([]);
      // A newer version is what offers installed copies an update.
      expect(parsed.package.packageId).toBeString();
      expect(parsed.package.packageVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(parsed.package.data.collections.length).toBeGreaterThan(0);
      // The app's own HTML loads the host client for its data.
      expect(parsed.package.app.html).toContain("/__opengeni/site-tools/client.js");
      // Stored records are untrusted: rendered as text, never as HTML.
      expect(parsed.package.app.html).not.toContain("innerHTML");
    }
  });

  test("Work summary carries its Skill and a switched-off automation", () => {
    const template = appTemplates().find((entry) => entry.key === "work-summary");
    const parsed = parseAppPackage(template?.package);
    expect(parsed.problems).toEqual([]);
    expect(parsed.package.skills?.map((skill) => skill.name)).toEqual(["work-summary"]);
    expect(parsed.package.skills?.[0]?.description).toBeString();
    expect(parsed.package.automations?.map((automation) => automation.name)).toEqual([
      "Update the work summary",
    ]);
    expect(parsed.package.automations?.[0]?.prompt).toContain("{{appId}}");
  });

  test("gallery content names the team it is for", () => {
    for (const template of [...appTemplates(), ...agentTemplates()]) {
      expect(template.team).toBeString();
    }
  });

  test("every ready-made app has sample records for its preview, in its own collections", () => {
    for (const template of appTemplates()) {
      const collections = new Set(
        parseAppPackage(template.package).package.data.collections.map((each) => each.name),
      );
      const sample = Object.entries(template.preview?.records ?? {});
      expect(sample.length).toBeGreaterThan(0);
      for (const [collection, records] of sample) {
        expect(collections.has(collection)).toBe(true);
        expect(records.length).toBeGreaterThan(0);
      }
      // The preview is not demo data: installing adds none of it.
      expect(JSON.stringify(template.package)).not.toContain("{{today");
    }
  });
});
