import { describe, expect, test } from "bun:test";
import {
  githubGatewayApproval,
  githubGatewayContinuationNote,
} from "../src/activities/github-gateway-approvals";

const base = {
  approvalId: "ghgw:abc",
  requestId: "req-1",
  toolName: "pull_request_merge",
  status: "pending",
  title: "Merge pull request #12 in acme/app",
  reviewArguments: JSON.stringify({ method: "PUT", path: "/repos/acme/app/pulls/12/merge" }),
};

describe("GitHub gateway approvals", () => {
  test("a held gh request becomes an approval card", () => {
    expect(githubGatewayApproval(base)).toEqual({
      id: "ghgw:abc",
      name: "pull_request_merge",
      source: "github_gateway",
      requestId: "req-1",
      arguments: { method: "PUT", path: "/repos/acme/app/pulls/12/merge" },
      display: { toolName: "pull_request_merge", title: "Merge pull request #12 in acme/app" },
    });
  });

  test("unreadable review arguments and a missing title still give a card", () => {
    const approval = githubGatewayApproval({ ...base, title: null, reviewArguments: "{" });
    expect(approval.arguments).toEqual({});
    expect(approval.display.title).toBe("GitHub request (pull_request_merge)");
  });

  test("the continuation note names decided requests only", () => {
    expect(githubGatewayContinuationNote([base])).toBeUndefined();
    const note = githubGatewayContinuationNote([
      { ...base, status: "approved" },
      { ...base, approvalId: "ghgw:def", status: "rejected", title: "Delete branch old" },
      { ...base, approvalId: "ghgw:ghi" },
    ]);
    expect(note).toContain("Approved: Merge pull request #12 in acme/app");
    expect(note).toContain("Run the same command again");
    expect(note).toContain("Declined: Delete branch old");
    expect(note?.split("\n")).toHaveLength(3);
  });
});
