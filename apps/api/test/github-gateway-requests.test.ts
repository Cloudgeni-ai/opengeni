import { describe, expect, test } from "bun:test";
import {
  classifyGitHubGraphqlRequest,
  classifyGitHubRestRequest,
  GITHUB_GATEWAY_ROUTINE_TOOLS,
} from "../src/integrations/github-gateway-requests";

function rest(method: string, path: string, body: unknown = null) {
  return classifyGitHubRestRequest(method, path, body);
}

describe("GitHub gateway REST classification", () => {
  test("reads pass and keep their repository", () => {
    expect(rest("GET", "/repos/acme/widgets/pulls/1")).toEqual({
      action: { kind: "read", title: "Read" },
      repository: { kind: "name", owner: "acme", name: "widgets" },
    });
    expect(rest("GET", "/user").action.kind).toBe("read");
    expect(rest("GET", "/orgs/acme/repos").repository).toBeNull();
    expect(rest("GET", "/repositories/42/actions/runs").repository).toEqual({ kind: "id", id: "42" });
    expect(rest("GET", "/api/v3/repos/acme/widgets").repository).toEqual({
      kind: "name",
      owner: "acme",
      name: "widgets",
    });
  });

  test("ordinary writes follow the matching policy actions", () => {
    expect(rest("POST", "/repos/acme/widgets/pulls").action).toMatchObject({
      kind: "write",
      tools: ["pull_request_create"],
      alwaysAsk: false,
    });
    expect(rest("PUT", "/repos/acme/widgets/pulls/3/merge").action).toMatchObject({
      tools: ["pull_request_merge"],
      alwaysAsk: false,
    });
    expect(rest("POST", "/repos/acme/widgets/pulls/3/reviews").action).toMatchObject({
      tools: ["pull_request_review_submit"],
    });
    expect(rest("POST", "/repos/acme/widgets/issues").action).toMatchObject({
      tools: ["issue_create"],
    });
    expect(rest("POST", "/repos/acme/widgets/issues/3/comments").action).toMatchObject({
      tools: ["issue_comment", "pull_request_comment"],
    });
    expect(rest("POST", "/repos/acme/widgets/actions/runs/9/rerun").action).toMatchObject({
      tools: GITHUB_GATEWAY_ROUTINE_TOOLS,
      alwaysAsk: false,
    });
    expect(
      rest("POST", "/repos/acme/widgets/actions/workflows/ci.yml/dispatches").action,
    ).toMatchObject({ title: "Run workflow", alwaysAsk: false });
    expect(rest("POST", "/repos/acme/widgets/releases").action).toMatchObject({
      alwaysAsk: false,
    });
    expect(rest("POST", "/repos/acme/widgets/git/refs").action).toMatchObject({
      tools: ["ref_create"],
      alwaysAsk: false,
    });
    expect(rest("POST", "/repos/acme/widgets/releases/1/assets?name=a.zip").action).toMatchObject({
      alwaysAsk: false,
    });
  });

  test("destructive and settings changes always ask", () => {
    for (const [method, path, body] of [
      ["DELETE", "/repos/acme/widgets", null],
      ["PATCH", "/repos/acme/widgets", { private: false }],
      ["POST", "/repos/acme/widgets/transfer", { new_owner: "x" }],
      ["DELETE", "/repos/acme/widgets/git/refs/heads/main", null],
      ["PATCH", "/repos/acme/widgets/git/refs/heads/main", { sha: "a", force: true }],
      ["DELETE", "/repos/acme/widgets/releases/5", null],
      ["PUT", "/repos/acme/widgets/collaborators/mallory", null],
      ["PUT", "/repos/acme/widgets/actions/secrets/TOKEN", { encrypted_value: "x" }],
      ["POST", "/repos/acme/widgets/hooks", { config: {} }],
      ["PUT", "/repos/acme/widgets/branches/main/protection", {}],
      ["POST", "/user/repos", { name: "new" }],
      ["DELETE", "/orgs/acme/members/bob", null],
      ["POST", "/repos/acme/widgets/something-new", {}],
    ] as const) {
      expect(rest(method, path, body).action).toMatchObject({ kind: "write", alwaysAsk: true });
    }
  });

  test("a non-forced ref update is routine", () => {
    expect(
      rest("PATCH", "/repos/acme/widgets/git/refs/heads/feature", { sha: "a", force: false }).action,
    ).toMatchObject({ alwaysAsk: false });
  });
});

describe("GitHub gateway GraphQL classification", () => {
  test("queries are reads with their repository references", () => {
    const result = classifyGitHubGraphqlRequest({
      query:
        "query PullRequestForBranch($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { pullRequests(first: 1) { nodes { number } } } viewer { login } }",
      variables: { owner: "acme", repo: "widgets" },
    });
    expect(result.action.kind).toBe("read");
    expect(result.repositories).toEqual([{ owner: "acme", name: "widgets" }]);
  });

  test("mutations map to policy actions and collect node IDs", () => {
    const result = classifyGitHubGraphqlRequest({
      query:
        "mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { url } } }",
      variables: {
        input: { repositoryId: "R_kgDOAbCdEf", baseRefName: "main", headRefName: "f", title: "T" },
      },
    });
    expect(result.action).toMatchObject({
      kind: "write",
      tools: ["pull_request_create"],
      alwaysAsk: false,
    });
    expect(result.nodeIds).toEqual(["R_kgDOAbCdEf"]);
    expect(result.mutations).toEqual(["createPullRequest"]);
  });

  test("merges follow the merge policy; deletions and unknown mutations always ask", () => {
    expect(
      classifyGitHubGraphqlRequest({
        query: 'mutation { mergePullRequest(input: {pullRequestId: "PR_kwDOAbCdEf"}) { clientMutationId } }',
      }).action,
    ).toMatchObject({ tools: ["pull_request_merge"], alwaysAsk: false });
    expect(
      classifyGitHubGraphqlRequest({
        query: 'mutation { deleteRef(input: {refId: "REF_kwDOAbCdEf"}) { clientMutationId } }',
      }).action,
    ).toMatchObject({ alwaysAsk: true });
    expect(
      classifyGitHubGraphqlRequest({
        query: 'mutation { updateRepository(input: {repositoryId: "R_kgDOAbCdEf", hasWikiEnabled: false}) { clientMutationId } }',
      }).action,
    ).toMatchObject({ alwaysAsk: true });
    expect(
      classifyGitHubGraphqlRequest({
        query: "mutation($i: UpdateRefsInput!) { updateRefs(input: $i) { clientMutationId } }",
        variables: { i: { repositoryId: "R_kgDOAbCdEf", refUpdates: [{ name: "refs/heads/x", afterOid: "a", force: true }] } },
      }).action,
    ).toMatchObject({ alwaysAsk: true });
  });

  test("an unreadable or ambiguous document asks", () => {
    expect(classifyGitHubGraphqlRequest({ query: "mutation {" }).action).toMatchObject({
      alwaysAsk: true,
    });
    expect(
      classifyGitHubGraphqlRequest({ query: "query A { viewer { login } } mutation B { addStar(input: {starrableId: \"R_kgDOAbCdEf\"}) { clientMutationId } }" })
        .action,
    ).toMatchObject({ alwaysAsk: true });
    // The operation is chosen by name.
    expect(
      classifyGitHubGraphqlRequest({
        query: "query A { viewer { login } } mutation B { addStar(input: {starrableId: \"R_kgDOAbCdEf\"}) { clientMutationId } }",
        operationName: "B",
      }).action,
    ).toMatchObject({ kind: "write", alwaysAsk: false });
    expect(classifyGitHubGraphqlRequest("not json").action).toMatchObject({ alwaysAsk: true });
  });
});

describe("GitHub gateway review fixes", () => {
  test("only reruns and cancels are routine on a workflow run", () => {
    expect(rest("POST", "/repos/acme/widgets/actions/runs/9/rerun-failed-jobs").action).toMatchObject({
      alwaysAsk: false,
    });
    expect(rest("POST", "/repos/acme/widgets/actions/runs/9/cancel").action).toMatchObject({
      alwaysAsk: false,
    });
    for (const sub of ["pending_deployments", "approve", "deployment_protection_rule"]) {
      expect(rest("POST", `/repos/acme/widgets/actions/runs/9/${sub}`).action).toMatchObject({
        alwaysAsk: true,
      });
    }
  });

  test("updateRefs with a zero afterOid deletes, so it asks", () => {
    const classify = (afterOid: string) =>
      classifyGitHubGraphqlRequest({
        query: "mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
        variables: {
          input: {
            repositoryId: "R_kgDOWidgets",
            refUpdates: [{ name: "refs/heads/x", beforeOid: "a".repeat(40), afterOid }],
          },
        },
      }).action;
    expect(classify("0".repeat(40))).toMatchObject({ title: "Delete branch or tag", alwaysAsk: true });
    expect(classify("b".repeat(40))).toMatchObject({ title: "Update branch", alwaysAsk: false });
  });

  test("repositories named in mutation input are collected", () => {
    const result = classifyGitHubGraphqlRequest({
      query:
        "mutation($a: CreateCommitOnBranchInput!, $b: AddSubIssueInput!) { createCommitOnBranch(input: $a) { clientMutationId } addSubIssue(input: $b) { clientMutationId } }",
      variables: {
        a: { branch: { repositoryNameWithOwner: "acme/widgets", branchName: "main" } },
        b: { issueId: "I_kwDOAbcdefgh", subIssueUrl: "https://github.com/other/secret/issues/3" },
      },
    });
    expect(result.mutationRepositories).toEqual([
      { owner: "acme", name: "widgets" },
      { owner: "other", name: "secret" },
    ]);
    expect(result.accountLevel).toBe(false);
  });

  test("account-level mutations and owner-scoped reads", () => {
    expect(
      classifyGitHubGraphqlRequest({
        query: 'mutation { addStar(input: {starrableId: "R_kgDOWidgets"}) { clientMutationId } }',
      }).accountLevel,
    ).toBe(true);
    expect(
      classifyGitHubGraphqlRequest({
        query:
          'query { repositoryOwner(login: "acme") { repository(name: "widgets") { id } } viewer { repository(name: "mine") { id } } }',
      }).repositories,
    ).toEqual([
      { owner: "acme", name: "widgets" },
      { owner: null, name: "mine" },
    ]);
  });
});
