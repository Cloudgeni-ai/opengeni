import { describe, expect, test } from "bun:test";
import { GITHUB_REST_WRITE_TOOL_NAMES } from "@opengeni/runtime/github-rest-mcp";
import type { ConnectorActionPolicySnapshotEntry } from "@opengeni/db";
import {
  GITHUB_ACTION_POLICY_GROUP_TOOL_NAMES,
  githubAppActionPolicyActor,
  projectGitHubActionPolicyActor,
} from "../src/domain/github-action-policies";

const actor = githubAppActionPolicyActor({ installationId: 71, accountLogin: "Cloudgeni-ai" });

function policy(
  toolName: string,
  decision: "allow" | "ask" | "block",
  overrides: Partial<ConnectorActionPolicySnapshotEntry> = {},
): ConnectorActionPolicySnapshotEntry {
  return {
    id: crypto.randomUUID(),
    connectionId: "github-app:71",
    serverId: "github_app",
    toolName,
    actionName: toolName,
    policy: decision,
    version: 1,
    ...overrides,
  };
}

describe("GitHub action policy projection", () => {
  test("keeps every write in one independently configurable risk group", () => {
    const grouped = Object.values(GITHUB_ACTION_POLICY_GROUP_TOOL_NAMES).flat();
    expect(grouped).toHaveLength(new Set(grouped).size);
    expect([...grouped].sort()).toEqual([...GITHUB_REST_WRITE_TOOL_NAMES].sort());
  });

  test("defaults every unmanaged GitHub write group to Ask", () => {
    expect(projectGitHubActionPolicyActor([], actor)).toEqual({
      kind: "workspace_app",
      installationId: 71,
      label: "OpenGeni bot on Cloudgeni-ai",
      groups: { routine: "ask", review: "ask", merge: "ask" },
    });
  });

  test("allows routine PR work without widening review or merge", () => {
    const policies = [
      ...GITHUB_ACTION_POLICY_GROUP_TOOL_NAMES.routine.map((toolName) => policy(toolName, "allow")),
      policy("pull_request_review_submit", "ask"),
      policy("pull_request_merge", "block"),
    ];
    expect(projectGitHubActionPolicyActor(policies, actor).groups).toEqual({
      routine: "allow",
      review: "ask",
      merge: "block",
    });
  });

  test("surfaces a pre-existing per-tool split as Mixed", () => {
    expect(
      projectGitHubActionPolicyActor([policy("pull_request_create", "allow")], actor).groups,
    ).toEqual({
      routine: "mixed",
      review: "ask",
      merge: "ask",
    });
  });
});
