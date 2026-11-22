import { describe, expect, test } from "bun:test";
import { parseAppPackage } from "@opengeni/contracts";
import { agentTemplates, appTemplates } from "../src/index";

describe("ready-made apps", () => {
  test("every content file is a valid, complete app package", () => {
    expect(appTemplates().map((template) => template.key)).toEqual(["decision-log"]);
    for (const template of appTemplates()) {
      const parsed = parseAppPackage(template.package);
      expect(parsed.problems).toEqual([]);
      expect(parsed.package.data.collections.length).toBeGreaterThan(0);
      // The app's own HTML loads the host client for its data.
      expect(parsed.package.app.html).toContain("/__opengeni/site-tools/client.js");
    }
  });

  test("gallery content names the team it is for", () => {
    for (const template of [...appTemplates(), ...agentTemplates()]) {
      expect(template.team).toBeString();
    }
  });
});
