import { describe, expect, test } from "bun:test";
import { GitHubActionPoliciesResponse, UpdateGitHubActionPolicyRequest } from "../src/index";

describe("GitHub action policy contracts", () => {
  test("accepts independent routine, review, merge and (for Your GitHub) sensitive projections", () => {
    expect(
      GitHubActionPoliciesResponse.parse({
        enabled: true,
        actors: [
          {
            kind: "workspace_app",
            installationId: 71,
            label: "Opengeni bot on Cloudgeni-ai",
            groups: { routine: "allow", review: "ask", merge: "block" },
          },
          {
            kind: "personal",
            connectionId: "connection-1",
            label: "@bendik",
            groups: { routine: "mixed", review: "ask", merge: "ask", sensitive: "allow" },
          },
        ],
      }).actors,
    ).toHaveLength(2);
    expect(() =>
      GitHubActionPoliciesResponse.parse({
        enabled: true,
        actors: [
          {
            kind: "personal",
            connectionId: "connection-1",
            label: "@bendik",
            groups: { routine: "allow", review: "allow", merge: "allow" },
          },
        ],
      }),
    ).toThrow();
    expect(
      UpdateGitHubActionPolicyRequest.parse({
        actor: { kind: "personal", connectionId: "connection-1" },
        group: "sensitive",
        decision: "allow",
      }).group,
    ).toBe("sensitive");
  });

  test("rejects Mixed as a requested decision", () => {
    expect(() =>
      UpdateGitHubActionPolicyRequest.parse({
        actor: { kind: "workspace_app", installationId: 71 },
        group: "routine",
        decision: "mixed",
      }),
    ).toThrow();
  });
});
