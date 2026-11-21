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

  test("Triage listens where reports arrive and hands bugs to Bug fixer by name", () => {
    const triage = agentTemplateByKey("triage");
    const kinds = triage?.suggestedTriggers.flatMap((suggestion) =>
      suggestion.triggers.map((trigger) => trigger.source.kind),
    );
    expect(kinds).toEqual(expect.arrayContaining(["github", "slack", "webhook"]));
    const slack = triage?.suggestedTriggers.find((suggestion) =>
      suggestion.triggers.some((trigger) => trigger.source.kind === "slack"),
    );
    // New messages only, not every thread reply.
    expect(slack?.triggers[0]?.eventTypes).toEqual(["message.posted"]);
    expect(slack?.triggers[0]?.conditions).toEqual([
      { field: "data.in_thread", op: "equals", value: false },
    ]);
    expect(triage?.instructions).toContain('"Bug fixer" agent');
  });
});

describe("Can use enforcement", () => {
  test("a rule with a permission this release can't read asks first", async () => {
    const { agentToolPermissionSetsForEnforcement } = await import("../src/index");
    expect(
      agentToolPermissionSetsForEnforcement({
        toolPermissions: [
          { connector: "gmail.com", tool: "send_email", permission: "later-value" },
          { connector: "linear.app", tool: "*", permission: "block" },
          { connector: "slack.com", tool: ["a", "b"], permission: "block" },
          { nonsense: true },
        ],
      }),
    ).toEqual([
      [{ connector: "linear.app", tool: "*", permission: "block" }],
      [
        { connector: "gmail.com", tool: "send_email", permission: "ask" },
        { connector: "slack.com", tool: "*", permission: "ask" },
        { connector: "*", tool: "*", permission: "ask" },
      ],
    ]);
  });

  test("an unreadable rule never outranks a readable Block", async () => {
    const { agentToolPermissionSetsForEnforcement } = await import("../src/index");
    const { agentToolPermissionFor } = await import("@opengeni/contracts");
    const sets = agentToolPermissionSetsForEnforcement({
      toolPermissions: [
        { connector: "github.com", tool: "*", permission: "block" },
        { connector: "github_personal", tool: ["a"], permission: "block" },
      ],
    });
    const target = {
      serverId: "github_personal",
      providerDomain: "github.com",
      toolName: "pull_request_merge",
    };
    expect(sets.map((rules) => agentToolPermissionFor(rules, target))).toEqual(["block", "ask"]);
  });
});
