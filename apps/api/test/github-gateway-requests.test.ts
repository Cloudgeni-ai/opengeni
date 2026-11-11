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
      sensitive: false,
    });
    expect(rest("PUT", "/repos/acme/widgets/pulls/3/merge").action).toMatchObject({
      tools: ["pull_request_merge"],
      sensitive: false,
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
      sensitive: false,
    });
    expect(
      rest("POST", "/repos/acme/widgets/actions/workflows/ci.yml/dispatches").action,
    ).toMatchObject({ title: "Run workflow", sensitive: false });
    expect(rest("POST", "/repos/acme/widgets/releases").action).toMatchObject({
      sensitive: false,
    });
    expect(rest("POST", "/repos/acme/widgets/git/refs").action).toMatchObject({
      tools: ["ref_create"],
      sensitive: false,
    });
    expect(rest("POST", "/repos/acme/widgets/releases/1/assets?name=a.zip").action).toMatchObject({
      sensitive: false,
    });
  });

  test("destructive and settings changes are sensitive", () => {
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
      expect(rest(method, path, body).action).toMatchObject({ kind: "write", sensitive: true });
    }
  });

  test("a non-forced ref update is routine", () => {
    expect(
      rest("PATCH", "/repos/acme/widgets/git/refs/heads/feature", { sha: "a", force: false })
        .action,
    ).toMatchObject({ sensitive: false });
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
      sensitive: false,
    });
    expect(result.nodeIds).toEqual(["R_kgDOAbCdEf"]);
    expect(result.mutations).toEqual(["createPullRequest"]);
  });

  test("requests the gateway can't read or scope are unscoped", () => {
    expect(classifyGitHubGraphqlRequest({ query: "mutation {" }).action).toMatchObject({
      sensitive: true,
      unscoped: true,
      title: "Unrecognised GitHub GraphQL request",
    });
    const tooMany = Array.from(
      { length: 51 },
      (_, index) =>
        `m${index}: createCommitOnBranch(input: {branch: {repositoryNameWithOwner: "acme/r${index}", branchName: "f"}}) { clientMutationId }`,
    );
    expect(
      classifyGitHubGraphqlRequest({ query: `mutation { ${tooMany.join(" ")} }` }).action,
    ).toMatchObject({ sensitive: true, unscoped: true });
  });

  test("merges follow the merge policy; deletions and unknown mutations are sensitive", () => {
    expect(
      classifyGitHubGraphqlRequest({
        query:
          'mutation { mergePullRequest(input: {pullRequestId: "PR_kwDOAbCdEf"}) { clientMutationId } }',
      }).action,
    ).toMatchObject({ tools: ["pull_request_merge"], sensitive: false });
    expect(
      classifyGitHubGraphqlRequest({
        query: 'mutation { deleteRef(input: {refId: "REF_kwDOAbCdEf"}) { clientMutationId } }',
      }).action,
    ).toMatchObject({ sensitive: true });
    expect(
      classifyGitHubGraphqlRequest({
        query:
          'mutation { updateRepository(input: {repositoryId: "R_kgDOAbCdEf", hasWikiEnabled: false}) { clientMutationId } }',
      }).action,
    ).toMatchObject({ sensitive: true });
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
    ).toMatchObject({ sensitive: true });
  });

  test("an unreadable or ambiguous document asks", () => {
    expect(classifyGitHubGraphqlRequest({ query: "mutation {" }).action).toMatchObject({
      sensitive: true,
    });
    expect(
      classifyGitHubGraphqlRequest({
        query:
          'query A { viewer { login } } mutation B { addStar(input: {starrableId: "R_kgDOAbCdEf"}) { clientMutationId } }',
      }).action,
    ).toMatchObject({ sensitive: true });
    // The operation is chosen by name.
    expect(
      classifyGitHubGraphqlRequest({
        query:
          'query A { viewer { login } } mutation B { addStar(input: {starrableId: "R_kgDOAbCdEf"}) { clientMutationId } }',
        operationName: "B",
      }).action,
    ).toMatchObject({ kind: "write", sensitive: false });
    expect(classifyGitHubGraphqlRequest("not json").action).toMatchObject({ sensitive: true });
  });
});

describe("GitHub gateway review fixes", () => {
  test("a fragment chain too deep to read is unrecognised, not a hidden mutation", () => {
    const chain = Array.from({ length: 70 }, (_, index) =>
      index === 69
        ? `fragment F69 on Mutation { deleteProjectV2(input: {projectId: "PVT_kwDOProject1"}) { clientMutationId } }`
        : `fragment F${index} on Mutation { ...F${index + 1} }`,
    ).join("\n");
    const result = classifyGitHubGraphqlRequest({
      query: `mutation { addComment(input: {subjectId: "I_kwDOWidgets1", body: "hi"}) { clientMutationId } ...F0 }\n${chain}`,
    });
    expect(result.action).toMatchObject({ sensitive: true, unscoped: true });
    // Scoping reads only ID-typed keys, never free text.
    const sponsor = classifyGitHubGraphqlRequest({
      query:
        'mutation { createSponsorship(input: {sponsorableLogin: "x", clientMutationId: "R_kgDOWidgets", websiteUrl: "https://github.com/acme/widgets"}) { clientMutationId } }',
    });
    expect(sponsor.fields).toEqual([
      expect.objectContaining({ nodeIds: [], namesRepository: false, sensitive: true }),
    ]);
  });

  test("block strings are read as GitHub reads them, and unreadable IDs leave a mutation unscoped", () => {
    const transfer = classifyGitHubGraphqlRequest({
      query:
        'mutation { transferIssue(input: {\n  issueId: """\n  I_kwDOForbidden1\n  """, repositoryId: "R_kgDOAllowed1" }) { issue { id } } }',
    });
    expect(transfer.nodeIds).toEqual(["I_kwDOForbidden1", "R_kgDOAllowed1"]);
    expect(transfer.fields[0]).toMatchObject({
      nodeIds: ["I_kwDOForbidden1", "R_kgDOAllowed1"],
      unreadableId: false,
    });
    const padded = classifyGitHubGraphqlRequest({
      query:
        'mutation($issue: ID!) { transferIssue(input: {issueId: $issue, repositoryId: "R_kgDOAllowed1"}) { issue { id } } }',
      variables: { issue: " I_kwDOForbidden1 " },
    });
    expect(padded.fields[0]).toMatchObject({ unreadableId: true });
    // A body keeps its own text, and a block string's escaped quotes stay quotes.
    const comment = classifyGitHubGraphqlRequest({
      query:
        'mutation { addComment(input: {subjectId: "I_kwDOWidgets1", body: """\n    hi \\""" there\n    """}) { clientMutationId } }',
    });
    expect(comment.fields[0]).toMatchObject({ nodeIds: ["I_kwDOWidgets1"], unreadableId: false });
  });

  test("only reruns and cancels are routine on a workflow run", () => {
    expect(
      rest("POST", "/repos/acme/widgets/actions/runs/9/rerun-failed-jobs").action,
    ).toMatchObject({
      sensitive: false,
    });
    expect(rest("POST", "/repos/acme/widgets/actions/runs/9/cancel").action).toMatchObject({
      sensitive: false,
    });
    for (const sub of ["pending_deployments", "approve", "deployment_protection_rule"]) {
      expect(rest("POST", `/repos/acme/widgets/actions/runs/9/${sub}`).action).toMatchObject({
        sensitive: true,
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
      sensitive: true,
    });
    expect(classify("b".repeat(40))).toMatchObject({ title: "Update branch", sensitive: false });
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
    // A `%` the gateway couldn't decode might name another ref on GitHub.
    expect(refRewriteFollowsPolicy("refs/heads/%6Dain%", "main")).toBe(false);
    expect(refRewriteFollowsPolicy("refs/heads/x%00", "main")).toBe(false);
  });

  test("REST deletions and force updates name their ref and still ask until confirmed", () => {
    expect(rest("DELETE", "/repos/acme/widgets/git/refs/heads/feature/x").action).toEqual({
      kind: "write",
      tools: ["ref_create"],
      sensitive: true,
      title: "Delete branch or tag",
      refRewrites: {
        targets: [{ kind: "name", ref: "refs/heads/feature/x" }],
        sensitiveOtherwise: false,
      },
    });
    expect(
      rest("PATCH", "/repos/acme/widgets/git/refs/heads/feature", { sha: "a", force: true }).action,
    ).toMatchObject({
      sensitive: true,
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
    ).toMatchObject({ sensitive: true, title: "Force-update branch" });
  });

  test("a ref whose slashes gh encodes still names its branch", () => {
    // `gh pr merge --delete-branch` and `gh api` send `heads%2Fem%2Fx`.
    expect(
      rest("DELETE", "/repos/acme/widgets/git/refs/heads%2Fem%2Fstaging-live-binary-readiness")
        .action,
    ).toEqual({
      kind: "write",
      tools: ["ref_create"],
      sensitive: true,
      title: "Delete branch or tag",
      refRewrites: {
        targets: [{ kind: "name", ref: "refs/heads/em/staging-live-binary-readiness" }],
        sensitiveOtherwise: false,
      },
    });
    expect(
      rest("PATCH", "/repos/acme/widgets/git/refs/heads%2Ffeature", { sha: "a", force: true })
        .action,
    ).toMatchObject({ refRewrites: { targets: [{ kind: "name", ref: "refs/heads/feature" }] } });
    // Crafted encodings never confirm a tag or the default branch as a branch.
    for (const ref of [
      "heads%2F..%2Ftags%2Fv1",
      "heads%2Fx%2F..%2F..%2Ftags%2Fv1",
      "heads%2F.hidden",
      "heads%2F%2Fmain",
      "heads%2Fmain%00",
      "heads%252Fmain",
      "heads%2",
    ]) {
      const action = rest("DELETE", `/repos/acme/widgets/git/refs/${ref}`).action;
      expect(action).toMatchObject({ sensitive: true });
      const targets =
        action.kind === "write" && action.refRewrites ? action.refRewrites.targets : [];
      for (const target of targets) {
        if (target.kind === "name") expect(refRewriteFollowsPolicy(target.ref, "main")).toBe(false);
      }
    }
    expect(rest("DELETE", "/repos/acme/widgets/git/refs/tags%2Fv1").action).toEqual({
      kind: "write",
      tools: ["ref_create"],
      sensitive: true,
      title: "Delete branch or tag",
    });
  });

  test("account and organization writes are unscoped: the repository allowlist can't cover them", () => {
    expect(rest("PUT", "/orgs/acme/actions/secrets/TOKEN", { encrypted_value: "x" })).toEqual({
      action: {
        kind: "write",
        tools: [],
        sensitive: true,
        unscoped: true,
        title: "Change GitHub account data",
      },
      repository: null,
    });
    expect(rest("DELETE", "/user/keys/1").action).toMatchObject({
      sensitive: true,
      unscoped: true,
      title: "Delete on GitHub",
    });
    // A repository write is checked against the allowlist instead.
    expect(
      rest("PUT", "/repos/acme/widgets/environments/staging/secrets/X", {}).action,
    ).not.toHaveProperty("unscoped");
  });

  test("environment secrets and other settings are sensitive, with no policy action of their own", () => {
    expect(
      rest(
        "PUT",
        "/repos/acme/widgets/environments/staging/secrets/OPENGENI_OBSERVABILITY_CREDITS_PROBE_API_KEY",
        { encrypted_value: "x", key_id: "1" },
      ).action,
    ).toEqual({
      kind: "write",
      tools: [],
      sensitive: true,
      title: "Change repository environments",
    });
  });

  test("GraphQL variable defaults count, as GitHub applies them", () => {
    const forcedByDefault = classifyGitHubGraphqlRequest({
      query:
        'mutation($f: Boolean = true) { updateRef(input: {refId: "REF_kwDOAbCdEf", oid: "abc", force: $f}) { clientMutationId } }',
    }).action;
    expect(forcedByDefault).toMatchObject({
      title: "Force-update branch",
      sensitive: true,
      refRewrites: { targets: [{ kind: "node", refNodeId: "REF_kwDOAbCdEf" }] },
    });
    expect(
      classifyGitHubGraphqlRequest({
        query:
          'mutation($i: UpdateRefInput! = {refId: "REF_kwDOAbCdEf", oid: "abc", force: true}) { updateRef(input: $i) { clientMutationId } }',
      }).action,
    ).toMatchObject({ title: "Force-update branch", sensitive: true });
    // A variable the request sets wins over its default.
    expect(
      classifyGitHubGraphqlRequest({
        query:
          'mutation($f: Boolean = true) { updateRef(input: {refId: "REF_kwDOAbCdEf", oid: "abc", force: $f}) { clientMutationId } }',
        variables: { f: false },
      }).action,
    ).toMatchObject({ title: "Update branch", sensitive: false });
    // An input the gateway can't read asks, and names no ref.
    const unreadable = classifyGitHubGraphqlRequest({
      query: "mutation($i: UpdateRefInput!) { updateRef(input: $i) { clientMutationId } }",
    }).action;
    expect(unreadable).toMatchObject({ title: "Force-update branch", sensitive: true });
    expect(unreadable).not.toHaveProperty("refRewrites");
  });

  test("GraphQL deleteRef, forced updateRef and updateRefs name their refs", () => {
    expect(
      classifyGitHubGraphqlRequest({
        query: 'mutation { deleteRef(input: {refId: "REF_kwDOAbCdEf"}) { clientMutationId } }',
      }).action,
    ).toMatchObject({
      tools: ["ref_create"],
      sensitive: true,
      refRewrites: { targets: [{ kind: "node", refNodeId: "REF_kwDOAbCdEf" }] },
    });
    expect(
      classifyGitHubGraphqlRequest({
        query:
          'mutation { updateRef(input: {refId: "REF_kwDOAbCdEf", oid: "abc"}) { clientMutationId } }',
      }).action,
    ).toMatchObject({ sensitive: false, title: "Update branch" });
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
      sensitive: true,
      refRewrites: {
        targets: [
          { kind: "name", ref: "refs/heads/x", repositoryNodeId: "R_kgDOAbCdEf" },
          { kind: "name", ref: "refs/heads/y", repositoryNodeId: "R_kgDOAbCdEf" },
        ],
        sensitiveOtherwise: false,
      },
    });
    // With another sensitive mutation, confirming the refs is not enough.
    expect(
      classifyGitHubGraphqlRequest({
        query:
          'mutation { deleteRef(input: {refId: "REF_kwDOAbCdEf"}) { clientMutationId } deleteIssue(input: {issueId: "I_kwDOAbCdEf"}) { clientMutationId } }',
      }).action,
    ).toMatchObject({ sensitive: true, refRewrites: { sensitiveOtherwise: true } });
    // A ref it cannot name stays sensitive.
    expect(
      classifyGitHubGraphqlRequest({
        query: "mutation($i: UpdateRefsInput!) { updateRefs(input: $i) { clientMutationId } }",
        variables: { i: { refUpdates: [{ name: "refs/heads/x", afterOid: "0" }] } },
      }).action,
    ).not.toHaveProperty("refRewrites");
  });
});
