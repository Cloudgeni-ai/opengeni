import { describe, expect, test } from "bun:test";
import { agentTemplateByKey, agentTemplates } from "../src/index";

describe("ready-made agents", () => {
  test("all three content files are valid and in gallery order", () => {
    expect(agentTemplates().map((template) => template.key)).toEqual([
      "triage",
      "bug-fixer",
      "pr-reviewer",
    ]);
  });

  test("each has instructions, a merge Block and at least one suggested trigger", () => {
    for (const template of agentTemplates()) {
      expect(template.instructions.length).toBeGreaterThan(200);
      expect(template.suggestedTriggers.length).toBeGreaterThan(0);
      expect(
        template.toolPermissions.some(
          (rule) => rule.tool === "merge_pull_request" && rule.permission === "block",
        ),
      ).toBe(true);
    }
  });

  test("they stay general: no Opengeni-internal skills or names", () => {
    for (const template of agentTemplates()) {
      const text = JSON.stringify(template).toLowerCase();
      expect(text).not.toContain("cloudgeni");
      expect(template.skills).toEqual([]);
    }
  });

  test("lookup by key", () => {
    expect(agentTemplateByKey("bug-fixer")?.name).toBe("Bug fixer");
    expect(agentTemplateByKey("missing")).toBeUndefined();
  });
});
