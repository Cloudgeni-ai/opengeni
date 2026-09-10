import { describe, expect, test } from "bun:test";
import { GitHubActionPoliciesResponse, UpdateGitHubActionPolicyRequest } from "../src/index";

describe("GitHub action policy contracts", () => {
  test("accepts independent routine, review, and merge projections", () => {
    expect(
      GitHubActionPoliciesResponse.parse({
        enabled: true,
        actors: [
          {
            kind: "workspace_app",
            installationId: 71,
            label: "OpenGeni bot on Cloudgeni-ai",
            groups: { routine: "allow", review: "ask", merge: "block" },
          },
          {
            kind: "personal",
            connectionId: "connection-1",
            label: "@bendik",
            groups: { routine: "mixed", review: "ask", merge: "ask" },
          },
        ],
      }).actors,
    ).toHaveLength(2);
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
