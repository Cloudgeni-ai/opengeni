import { describe, expect, test } from "bun:test";
import {
  GITHUB_REST_WRITE_TOOL_NAMES,
  GITHUB_SENSITIVE_REQUEST_POLICY_NAME,
} from "@opengeni/runtime/github-rest-mcp";
import type { ConnectorActionPolicySnapshotEntry } from "@opengeni/db";
import {
  GITHUB_ACTION_POLICY_GROUP_TOOL_NAMES,
  GitHubActionPolicyGroupNotApplicableError,
  githubAppActionPolicyActor,
  personalGitHubActionPolicyActor,
  projectGitHubActionPolicyActor,
  updateGitHubActionPolicyGroup,
} from "../src/domain/github-action-policies";

const actor = githubAppActionPolicyActor({ installationId: 71, accountLogin: "Cloudgeni-ai" });
const personal = personalGitHubActionPolicyActor({
  connectionId: "personal-1",
  githubLogin: "benyhh",
});

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
    expect([...grouped].sort()).toEqual(
      [...GITHUB_REST_WRITE_TOOL_NAMES, GITHUB_SENSITIVE_REQUEST_POLICY_NAME].sort(),
    );
  });

  test("inherits accepted repository write capability when no policy exists", () => {
    expect(projectGitHubActionPolicyActor([], actor)).toEqual({
      kind: "workspace_app",
      installationId: 71,
      label: "Opengeni bot on Cloudgeni-ai",
      groups: { routine: "allow", review: "allow", merge: "allow" },
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
      projectGitHubActionPolicyActor([policy("pull_request_create", "ask")], actor).groups,
    ).toEqual({
      routine: "mixed",
      review: "allow",
      merge: "allow",
    });
  });

  test("Settings and deletions is Your GitHub's alone and asks until the person chooses", () => {
    const personalPolicy = (toolName: string, decision: "allow" | "ask" | "block") =>
      policy(toolName, decision, { connectionId: "personal-1", serverId: "github_personal" });
    expect(projectGitHubActionPolicyActor([], personal)).toEqual({
      kind: "personal",
      connectionId: "personal-1",
      label: "@benyhh",
      groups: { routine: "allow", review: "allow", merge: "allow", sensitive: "ask" },
    });
    expect(projectGitHubActionPolicyActor([], actor).groups).not.toHaveProperty("sensitive");
    expect(
      projectGitHubActionPolicyActor(
        [personalPolicy(GITHUB_SENSITIVE_REQUEST_POLICY_NAME, "allow")],
        personal,
      ).groups,
    ).toMatchObject({ sensitive: "allow" });
    // A connection-wide Allow predates the choice and doesn't make it.
    expect(
      projectGitHubActionPolicyActor([personalPolicy("*", "allow")], personal).groups,
    ).toMatchObject({ routine: "allow", sensitive: "ask" });
    expect(
      projectGitHubActionPolicyActor([personalPolicy("*", "block")], personal).groups,
    ).toMatchObject({ sensitive: "block" });
  });

  test("the workspace app can't be given Settings and deletions", async () => {
    await expect(
      updateGitHubActionPolicyGroup({} as never, {
        accountId: "account",
        workspaceId: "workspace",
        subjectId: "subject",
        actor,
        group: "sensitive",
        decision: "allow",
      }),
    ).rejects.toBeInstanceOf(GitHubActionPolicyGroupNotApplicableError);
  });
});
