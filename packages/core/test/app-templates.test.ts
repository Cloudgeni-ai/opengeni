import { describe, expect, test } from "bun:test";
import { parseAppPackage } from "@opengeni/contracts";
import { agentTemplates, appTemplates } from "../src/index";

describe("ready-made apps", () => {
  test("every content file is a valid, complete app package", () => {
    expect(appTemplates().map((template) => template.key)).toEqual([
      "issue-tracker",
      "incident-log",
      "feedback-board",
      "decision-log",
    ]);
    for (const template of appTemplates()) {
      const parsed = parseAppPackage(template.package);
      expect(parsed.problems).toEqual([]);
      expect(parsed.package.data.collections.length).toBeGreaterThan(0);
      // The app's own HTML loads the host client for its data.
      expect(parsed.package.app.html).toContain("/__opengeni/site-tools/client.js");
      // Stored records are untrusted: rendered as text, never as HTML.
      expect(parsed.package.app.html).not.toContain("innerHTML");
    }
  });

  test("gallery content names the team it is for", () => {
    for (const template of [...appTemplates(), ...agentTemplates()]) {
      expect(template.team).toBeString();
    }
  });

  test("keep setup simple: no app requires an agent, a setup or a connection", () => {
    const agentKeys = agentTemplates().map((template) => template.key);
    for (const template of appTemplates()) {
      // These use only Site Data, so nothing is required before they work.
      expect(
        (template.setup?.connections ?? []).filter((connection) => connection.required),
      ).toEqual([]);
      for (const connection of template.setup?.connections ?? []) {
        expect(agentKeys).not.toContain(connection.provider);
      }
      // Enable ends with one small first job.
      expect(template.setup?.firstJob).toBeTruthy();
    }
  });
});
