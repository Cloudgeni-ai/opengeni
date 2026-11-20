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
      // Both an outside GitHub connection's merge tool and Opengeni's own.
      for (const tool of ["merge_pull_request", "pull_request_merge"]) {
        expect(
          template.toolPermissions.some(
            (rule) =>
              rule.connector === "github.com" && rule.tool === tool && rule.permission === "block",
          ),
        ).toBe(true);
      }
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

describe("Can use enforcement", () => {
  test("a rule with a permission this release can't read asks first", async () => {
    const { agentToolPermissionsForEnforcement } = await import("../src/index");
    expect(
      agentToolPermissionsForEnforcement({
        toolPermissions: [
          { connector: "gmail.com", tool: "send_email", permission: "later-value" },
          { connector: "linear.app", tool: "*", permission: "block" },
          { connector: "slack.com", tool: ["a", "b"], permission: "block" },
          { nonsense: true },
        ],
      }),
    ).toEqual([
      { connector: "gmail.com", tool: "send_email", permission: "ask" },
      { connector: "linear.app", tool: "*", permission: "block" },
      { connector: "slack.com", tool: "*", permission: "ask" },
      { connector: "*", tool: "*", permission: "ask" },
    ]);
  });
});
