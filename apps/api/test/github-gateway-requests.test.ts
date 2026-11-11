import { describe, expect, test } from "bun:test";
import {
  classifyGitHubGraphqlRequest,
  classifyGitHubRestRequest,
  GITHUB_GATEWAY_ROUTINE_TOOLS,
  refRewriteFollowsPolicy,
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
    expect(rest("GET", "/repositories/42/actions/runs").repository).toEqual({
      kind: "id",
      id: "42",
    });
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
      rest("PATCH", "/repos/acme/widgets/git/refs/heads/feature", { sha: "a", force: false })
        .action,
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
        query:
          'mutation { mergePullRequest(input: {pullRequestId: "PR_kwDOAbCdEf"}) { clientMutationId } }',
      }).action,
    ).toMatchObject({ tools: ["pull_request_merge"], alwaysAsk: false });
    expect(
      classifyGitHubGraphqlRequest({
        query: 'mutation { deleteRef(input: {refId: "REF_kwDOAbCdEf"}) { clientMutationId } }',
      }).action,
    ).toMatchObject({ alwaysAsk: true });
    expect(
      classifyGitHubGraphqlRequest({
        query:
          'mutation { updateRepository(input: {repositoryId: "R_kgDOAbCdEf", hasWikiEnabled: false}) { clientMutationId } }',
      }).action,
    ).toMatchObject({ alwaysAsk: true });
    expect(
      classifyGitHubGraphqlRequest({
        query: "mutation($i: UpdateRefsInput!) { updateRefs(input: $i) { clientMutationId } }",
        variables: {
          i: {
            repositoryId: "R_kgDOAbCdEf",
            refUpdates: [{ name: "refs/heads/x", afterOid: "a", force: true }],
          },
        },
      }).action,
    ).toMatchObject({ alwaysAsk: true });
  });

  test("an unreadable or ambiguous document asks", () => {
    expect(classifyGitHubGraphqlRequest({ query: "mutation {" }).action).toMatchObject({
      alwaysAsk: true,
    });
    expect(
      classifyGitHubGraphqlRequest({
        query:
          'query A { viewer { login } } mutation B { addStar(input: {starrableId: "R_kgDOAbCdEf"}) { clientMutationId } }',
      }).action,
    ).toMatchObject({ alwaysAsk: true });
    // The operation is chosen by name.
    expect(
      classifyGitHubGraphqlRequest({
        query:
          'query A { viewer { login } } mutation B { addStar(input: {starrableId: "R_kgDOAbCdEf"}) { clientMutationId } }',
        operationName: "B",
      }).action,
    ).toMatchObject({ kind: "write", alwaysAsk: false });
    expect(classifyGitHubGraphqlRequest("not json").action).toMatchObject({ alwaysAsk: true });
  });
});

describe("GitHub gateway review fixes", () => {
  test("only reruns and cancels are routine on a workflow run", () => {
    expect(
      rest("POST", "/repos/acme/widgets/actions/runs/9/rerun-failed-jobs").action,
    ).toMatchObject({
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
        query:
          "mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
        variables: {
          input: {
            repositoryId: "R_kgDOWidgets",
            refUpdates: [{ name: "refs/heads/x", beforeOid: "a".repeat(40), afterOid }],
          },
        },
      }).action;
    expect(classify("0".repeat(40))).toMatchObject({
      title: "Delete branch or tag",
      alwaysAsk: true,
    });
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

  test("repository links may name an enterprise managed user's owner", () => {
    const result = classifyGitHubGraphqlRequest({
      query: "mutation($b: AddSubIssueInput!) { addSubIssue(input: $b) { clientMutationId } }",
      variables: {
        b: {
          issueId: "I_kwDOAbcdefgh",
          subIssueUrl: "https://github.com/octocat_acme/tools/issues/3",
        },
      },
    });
    expect(result.mutationRepositories).toEqual([{ owner: "octocat_acme", name: "tools" }]);
  });

  test("links in free text are not repository targets", () => {
    const result = classifyGitHubGraphqlRequest({
      query:
        "mutation($input: AddCommentInput!) { addComment(input: $input) { clientMutationId } }",
      variables: {
        input: {
          subjectId: "PR_kwDOAbcdefgh",
          body: "https://github.com/upstream/lib/issues/42 is fixed by this",
          projectUrl: "https://github.com/orgs/acme/projects/3",
        },
      },
    });
    expect(result.mutationRepositories).toEqual([]);
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

describe("GitHub gateway force updates and deletions of refs", () => {
  test("only a branch other than the default branch follows the policy", () => {
    expect(refRewriteFollowsPolicy("refs/heads/feature/x", "main")).toBe(true);
    expect(refRewriteFollowsPolicy("refs/heads/main", "main")).toBe(false);
    expect(refRewriteFollowsPolicy("refs/heads/MAIN", "main")).toBe(false);
    expect(refRewriteFollowsPolicy("refs/tags/v1", "main")).toBe(false);
    expect(refRewriteFollowsPolicy("refs/notes/commits", "main")).toBe(false);
    expect(refRewriteFollowsPolicy("refs/heads/feature", null)).toBe(false);
    expect(refRewriteFollowsPolicy("refs/heads/", "main")).toBe(false);
    expect(refRewriteFollowsPolicy("refs/heads/a/../main", "main")).toBe(false);
    expect(refRewriteFollowsPolicy("refs/heads/.hidden", "main")).toBe(false);
  });

  test("REST deletions and force updates name their ref and still ask until confirmed", () => {
    expect(rest("DELETE", "/repos/acme/widgets/git/refs/heads/feature/x").action).toEqual({
      kind: "write",
      tools: ["ref_create"],
      alwaysAsk: true,
      title: "Delete branch or tag",
      refRewrites: {
        targets: [{ kind: "name", ref: "refs/heads/feature/x" }],
        alwaysAskOtherwise: false,
      },
    });
    expect(
      rest("PATCH", "/repos/acme/widgets/git/refs/heads/feature", { sha: "a", force: true }).action,
    ).toMatchObject({
      alwaysAsk: true,
      refRewrites: { targets: [{ kind: "name", ref: "refs/heads/feature" }] },
    });
    // No ref to confirm.
    expect(rest("DELETE", "/repos/acme/widgets/git/refs").action).not.toHaveProperty("refRewrites");
    // Only a path under heads/ names a branch.
    expect(
      rest("DELETE", "/repos/acme/widgets/git/refs/refs/heads/feature").action,
    ).not.toHaveProperty("refRewrites");
    // A force that is present and not exactly false counts.
    expect(
      rest("PATCH", "/repos/acme/widgets/git/refs/heads/feature", { sha: "a", force: "true" })
        .action,
    ).toMatchObject({ alwaysAsk: true, title: "Force-update branch" });
  });

  test("GraphQL variable defaults count, as GitHub applies them", () => {
    const forcedByDefault = classifyGitHubGraphqlRequest({
      query:
        'mutation($f: Boolean = true) { updateRef(input: {refId: "REF_kwDOAbCdEf", oid: "abc", force: $f}) { clientMutationId } }',
    }).action;
    expect(forcedByDefault).toMatchObject({
      title: "Force-update branch",
      alwaysAsk: true,
      refRewrites: { targets: [{ kind: "node", refNodeId: "REF_kwDOAbCdEf" }] },
    });
    expect(
      classifyGitHubGraphqlRequest({
        query:
          'mutation($i: UpdateRefInput! = {refId: "REF_kwDOAbCdEf", oid: "abc", force: true}) { updateRef(input: $i) { clientMutationId } }',
      }).action,
    ).toMatchObject({ title: "Force-update branch", alwaysAsk: true });
    // A variable the request sets wins over its default.
    expect(
      classifyGitHubGraphqlRequest({
        query:
          'mutation($f: Boolean = true) { updateRef(input: {refId: "REF_kwDOAbCdEf", oid: "abc", force: $f}) { clientMutationId } }',
        variables: { f: false },
      }).action,
    ).toMatchObject({ title: "Update branch", alwaysAsk: false });
    // An input the gateway can't read asks, and names no ref.
    const unreadable = classifyGitHubGraphqlRequest({
      query: "mutation($i: UpdateRefInput!) { updateRef(input: $i) { clientMutationId } }",
    }).action;
    expect(unreadable).toMatchObject({ title: "Force-update branch", alwaysAsk: true });
    expect(unreadable).not.toHaveProperty("refRewrites");
  });

  test("GraphQL deleteRef, forced updateRef and updateRefs name their refs", () => {
    expect(
      classifyGitHubGraphqlRequest({
        query: 'mutation { deleteRef(input: {refId: "REF_kwDOAbCdEf"}) { clientMutationId } }',
      }).action,
    ).toMatchObject({
      tools: ["ref_create"],
      alwaysAsk: true,
      refRewrites: { targets: [{ kind: "node", refNodeId: "REF_kwDOAbCdEf" }] },
    });
    expect(
      classifyGitHubGraphqlRequest({
        query:
          'mutation { updateRef(input: {refId: "REF_kwDOAbCdEf", oid: "abc"}) { clientMutationId } }',
      }).action,
    ).toMatchObject({ alwaysAsk: false, title: "Update branch" });
    const refs = classifyGitHubGraphqlRequest({
      query: "mutation($i: UpdateRefsInput!) { updateRefs(input: $i) { clientMutationId } }",
      variables: {
        i: {
          repositoryId: "R_kgDOAbCdEf",
          refUpdates: [
            { name: "refs/heads/x", afterOid: "a", force: true },
            { name: "refs/heads/y", afterOid: "0".repeat(40) },
            { name: "refs/heads/z", afterOid: "b" },
          ],
        },
      },
    }).action;
    expect(refs).toMatchObject({
      title: "Delete branch or tag",
      alwaysAsk: true,
      refRewrites: {
        targets: [
          { kind: "name", ref: "refs/heads/x", repositoryNodeId: "R_kgDOAbCdEf" },
          { kind: "name", ref: "refs/heads/y", repositoryNodeId: "R_kgDOAbCdEf" },
        ],
        alwaysAskOtherwise: false,
      },
    });
    // With another mutation that always asks, confirming the refs is not enough.
    expect(
      classifyGitHubGraphqlRequest({
        query:
          'mutation { deleteRef(input: {refId: "REF_kwDOAbCdEf"}) { clientMutationId } deleteIssue(input: {issueId: "I_kwDOAbCdEf"}) { clientMutationId } }',
      }).action,
    ).toMatchObject({ alwaysAsk: true, refRewrites: { alwaysAskOtherwise: true } });
    // A ref it cannot name always asks.
    expect(
      classifyGitHubGraphqlRequest({
        query: "mutation($i: UpdateRefsInput!) { updateRefs(input: $i) { clientMutationId } }",
        variables: { i: { refUpdates: [{ name: "refs/heads/x", afterOid: "0" }] } },
      }).action,
    ).not.toHaveProperty("refRewrites");
  });
});
