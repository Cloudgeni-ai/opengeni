import { describe, expect, test } from "bun:test";
import { agentTemplateByKey, agentTemplates } from "../src/index";

describe("ready-made agents", () => {
  test("every content file is valid and in gallery order", () => {
    expect(agentTemplates().map((template) => template.key)).toEqual([
      "triage",
      "bug-fixer",
      "pr-reviewer",
      "cve-scanner",
      "incident-responder",
      "dependency-updater",
      "product-analyst",
    ]);
  });

  test("names and keys are unique, and every agent named for a handoff is one of them", () => {
    const names = agentTemplates().map((template) => template.name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(agentTemplates().map((template) => template.key)).size).toBe(names.length);
    for (const template of agentTemplates()) {
      for (const [, named] of template.instructions.matchAll(/"([^"]+)" agent/gu)) {
        expect(names).toContain(named);
      }
    }
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

  test("PR reviewer adds, in one click, a review when someone on the team mentions it on a PR", () => {
    const reviewer = agentTemplateByKey("pr-reviewer");
    const mentioned = reviewer?.suggestedTriggers.find(
      (suggestion) => suggestion.name === "Review when mentioned on a PR",
    );
    expect(mentioned?.oneClick).toBe(true);
    expect(mentioned?.schedule).toBeNull();
    const team = {
      field: "data.comment.author_association",
      op: "in",
      value: ["OWNER", "MEMBER", "COLLABORATOR"],
    };
    const mention = { field: "data.comment.mentions_app", op: "equals", value: true };
    expect(mentioned?.triggers.map((trigger) => [trigger.source, trigger.eventTypes])).toEqual([
      [{ kind: "github" }, ["issue_comment.created"]],
      [{ kind: "github" }, ["pull_request_review_comment.created"]],
    ]);
    // Issue comments only on pull requests; review comments always are.
    expect(mentioned?.triggers[0]?.conditions).toEqual([
      { field: "data.issue.pull_request", op: "equals", value: true },
      mention,
      team,
    ]);
    expect(mentioned?.triggers[1]?.conditions).toEqual([mention, team]);
    // Its own comments never start it.
    expect(mentioned?.triggers.every((trigger) => !trigger.includeOwnEvents)).toBe(true);
    // The others still open the form.
    expect(reviewer?.suggestedTriggers[0]?.oneClick).toBeUndefined();
  });

  test("PR reviewer labels findings Critical, Bug or Nit", () => {
    const instructions = agentTemplateByKey("pr-reviewer")?.instructions ?? "";
    expect(instructions).toContain(
      "- Critical: security, data loss, outage, or a broken migration or public API.",
    );
    expect(instructions).toContain("- Bug: wrong behaviour in a realistic case.");
    expect(instructions).toContain("- Nit: style or an optional improvement.");
    expect(instructions).toContain(
      "Comment on conventions only where the repo has written rules (AGENTS.md, lint config).",
    );
    // The rubric replaces the old labels and review levels.
    expect(instructions).not.toContain("Blocker:");
    expect(instructions).not.toContain("Review level");
  });

  test("PR reviewer posts one scannable review: verdict, inline findings with fixes, folded nits", () => {
    const instructions = agentTemplateByKey("pr-reviewer")?.instructions ?? "";
    const step = (n: number) => {
      const start = instructions.indexOf(`\n${n}. `);
      const next = instructions.indexOf(`\n${n + 1}. `, start + 1);
      const end = next === -1 ? instructions.indexOf("\n\n", start + 1) : next;
      expect(start).toBeGreaterThan(-1);
      return instructions.slice(start, end);
    };
    const post = step(6);
    // One review, verdict first, with a short summary.
    expect(post).toContain("Post one review");
    expect(post).toContain("starts with a one-line verdict");
    expect(post).toContain("at most three lines");
    expect(post).toContain("No praise");
    // Critical and Bug findings sit on the exact line, labelled, with a concrete fix.
    expect(post).toContain("inline comment on the exact line");
    expect(post).toContain("**Bug: retries never stop**");
    expect(post).toContain("```suggestion");
    // Nits never get inline comments: left out or folded away.
    expect(post).toContain("<details><summary>Nits</summary>");
    expect(post).toContain("Give each finding once.");
    // A re-review builds on the earlier one instead of duplicating it.
    const rereview = step(7);
    expect(rereview).toContain("On a re-review");
    expect(rereview).toContain("post only new findings");
  });

  test("they stay general: no Opengeni-internal skills or names", () => {
    for (const template of agentTemplates()) {
      const text = JSON.stringify(template).toLowerCase();
      expect(text).not.toContain("cloudgeni");
      expect(template.skills).toEqual([]);
    }
  });

  test("CVE scanner runs weekly and on pull requests, skips ones without dependency changes, and hands fixes to PR reviewer", () => {
    const scanner = agentTemplateByKey("cve-scanner");
    expect(scanner?.suggestedTriggers.map((suggestion) => suggestion.schedule)).toEqual([
      { type: "calendar", hour: 8, minute: 0, daysOfWeek: ["MONDAY"] },
      null,
    ]);
    // GitHub events carry no changed paths, so the run itself skips other pull requests.
    const pullRequests = scanner?.suggestedTriggers[1];
    expect(pullRequests?.triggers[0]?.eventTypes).toEqual([
      "pull_request.opened",
      "pull_request.ready_for_review",
    ]);
    expect(pullRequests?.instructions).toContain("Otherwise, do nothing.");
    expect(scanner?.instructions).toContain("lockfile");
    expect(scanner?.instructions).toContain('"PR reviewer" agent');
  });

  test("Incident responder listens for alerts and Slack reports and hands fixes to Bug fixer", () => {
    const responder = agentTemplateByKey("incident-responder");
    const triggers = responder?.suggestedTriggers.flatMap((suggestion) => suggestion.triggers);
    expect(triggers?.map((trigger) => trigger.source)).toEqual([
      { kind: "webhook", adapter: "standard" },
      { kind: "slack" },
    ]);
    expect(triggers?.[0]?.eventTypes).toEqual(["*"]);
    expect(triggers?.[1]?.conditions).toEqual([
      { field: "data.in_thread", op: "equals", value: false },
    ]);
    expect(responder?.instructions).toContain('"Bug fixer" agent');
  });

  test("Dependency updater opens one pull request a week for PR reviewer", () => {
    const updater = agentTemplateByKey("dependency-updater");
    expect(updater?.suggestedTriggers).toHaveLength(1);
    expect(updater?.suggestedTriggers[0]?.schedule).toEqual({
      type: "calendar",
      hour: 9,
      minute: 0,
      daysOfWeek: ["MONDAY"],
    });
    expect(updater?.suggestedTriggers[0]?.triggers).toEqual([]);
    expect(updater?.instructions).toContain('"PR reviewer" agent');
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
