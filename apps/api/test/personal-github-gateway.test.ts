import { describe, expect, test } from "bun:test";
import type { PersonalGitHubGitBrokerClaims } from "@opengeni/github";
import {
  gatewayBearer,
  gatewayRepositoryDecision,
  handlePersonalGitHubGatewayRequest,
  isPersonalGitHubGatewayRequest,
  type PersonalGitHubGatewayAuthority,
  type PersonalGitHubGatewayServices,
} from "../src/routes/personal-github-gateway";
import {
  strictestGatewayPolicy,
  type GatewayDecision,
  type GatewayDecisionInput,
  type GatewayPolicyLookup,
} from "../src/routes/personal-github-gateway-policy";

const claims = { connectionId: "connection-1" } as unknown as PersonalGitHubGitBrokerClaims;
const permissions = { pull: true, triage: false, push: true, maintain: false, admin: false };

function selected(fullName: string, id: string, access: "read" | "write" = "write") {
  return {
    repositoryId: id,
    fullName,
    canonicalUrl: `https://github.com/${fullName}`,
    selectedAccess: access,
    selectionGeneration: 1,
    permissions,
    archived: false,
    disabled: false,
  };
}

const connectionMetadata = {
  credentialBindingId: "00000000-0000-4000-8000-000000000001",
  providerPrincipalId: "7",
  githubUserId: "7",
  githubLogin: "person",
} as PersonalGitHubGatewayAuthority["metadata"];

function authority(
  overrides: Partial<PersonalGitHubGatewayAuthority> = {},
): PersonalGitHubGatewayAuthority {
  return {
    claims,
    identity: { claims, initiator: { kind: "human", subjectId: "person" }, unattended: false },
    providerPrincipalId: "7",
    metadata: connectionMetadata,
    selection: {
      connectionAuthorityGeneration: 1,
      credentialBindingId: "00000000-0000-4000-8000-000000000001",
      providerPrincipalId: "7",
      selectionGeneration: 1,
      repositories: [selected("acme/widgets", "11"), selected("acme/docs", "12", "read")],
    } as unknown as PersonalGitHubGatewayAuthority["selection"],
    removedRepositories: [],
    ...overrides,
  };
}

type Upstream = { url: string; init: RequestInit & { duplex?: string } };

function bodyText(init: RequestInit): string {
  return typeof init.body === "string"
    ? init.body
    : new TextDecoder().decode(init.body as Uint8Array);
}

function harness(
  options: {
    authority?: PersonalGitHubGatewayAuthority;
    decision?: GatewayDecision;
    respond?: (url: string, init: RequestInit) => Response;
  } = {},
) {
  const upstream: Upstream[] = [];
  const decisions: GatewayDecisionInput[] = [];
  const completions: string[] = [];
  const authorized: Array<{
    url: string;
    tool: string;
    repositories: unknown[];
    everyRepository?: boolean;
  }> = [];
  const services: PersonalGitHubGatewayServices = {
    openClaims: (token) => (token === "session-pass" ? claims : null),
    resolveAuthority: async () => options.authority ?? authority(),
    authorizeProviderRequest: async (_authority, url, tool, repositories, checked) => {
      authorized.push({ url, tool, repositories, everyRepository: checked?.everyRepository });
      return "Bearer person-token";
    },
    decide: async (_identity, input) => {
      decisions.push(input);
      return options.decision ?? { kind: "allow" };
    },
    complete: async (_identity, requestId, outcome) => {
      completions.push(`${requestId}:${outcome}`);
    },
    git: {} as PersonalGitHubGatewayServices["git"],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      upstream.push({ url, init: init ?? {} });
      return options.respond?.(url, init ?? {}) ?? Response.json({ ok: true });
    }) as typeof fetch,
  };
  const send = (path: string, init: RequestInit = {}) =>
    handlePersonalGitHubGatewayRequest(
      new Request(`https://opengeni.test/v1/github/personal/gateway/api${path}`, {
        ...init,
        headers: { authorization: "Bearer session-pass", ...(init.headers ?? {}) },
      }),
      "api",
      services,
    );
  return { services, send, upstream, decisions, completions, authorized };
}

describe("personal GitHub gateway", () => {
  test("recognises its paths and the pass in gh's headers", () => {
    expect(isPersonalGitHubGatewayRequest("/v1/github/personal/gateway/api/user")).toBe(true);
    expect(isPersonalGitHubGatewayRequest("/v1/github/personal/repositories")).toBe(false);
    expect(gatewayBearer("Bearer abc")).toBe("abc");
    expect(gatewayBearer("token abc")).toBe("abc");
    expect(gatewayBearer(`Basic ${btoa("opengeni:abc")}`)).toBe("abc");
    expect(gatewayBearer(null)).toBeNull();
  });

  test("refuses a request without a current pass", async () => {
    const { services, upstream } = harness();
    const response = await handlePersonalGitHubGatewayRequest(
      new Request("https://opengeni.test/v1/github/personal/gateway/api/user", {
        headers: { authorization: "Bearer stolen" },
      }),
      "api",
      services,
    );
    expect(response.status).toBe(401);
    expect(upstream).toEqual([]);
  });

  test("forwards a read with the person's token and never the pass", async () => {
    const { send, upstream, decisions } = harness({
      respond: () =>
        new Response('{"full_name":"acme/widgets"}', {
          headers: {
            "content-type": "application/json",
            "set-cookie": "a=b",
            "x-ratelimit-remaining": "4999",
          },
        }),
    });
    const response = await send("/repos/acme/widgets?per_page=1", {
      headers: {
        cookie: "session=1",
        "x-forwarded-for": "1.2.3.4",
        accept: "application/vnd.github+json",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ full_name: "acme/widgets" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-ratelimit-remaining")).toBe("4999");
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url).toBe("https://api.github.com/repos/acme/widgets?per_page=1");
    const headers = new Headers(upstream[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer person-token");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(upstream[0]!.init.redirect).toBe("manual");
    expect(JSON.stringify(upstream)).not.toContain("session-pass");
    expect(decisions).toEqual([]);
  });

  test("passes redirects back to gh instead of following them", async () => {
    const { send } = harness({
      respond: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://results.example/logs.zip" },
        }),
    });
    const response = await send("/repos/acme/widgets/actions/runs/1/logs");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://results.example/logs.zip");
  });

  test("account-level reads pass; repositories outside the allowlist do not", async () => {
    const { send, upstream } = harness();
    expect((await send("/user/repos")).status).toBe(200);
    expect((await send("/orgs/acme/repos")).status).toBe(200);
    const denied = await send("/repos/other/secret");
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { message: string }).message).toContain(
      "other/secret is not one of the repositories the person allowed",
    );
    expect(upstream).toHaveLength(2);
  });

  test("writes need write access to the repository", async () => {
    const { send, upstream } = harness();
    const denied = await send("/repos/acme/docs/issues", {
      method: "POST",
      body: JSON.stringify({ title: "x" }),
    });
    expect(denied.status).toBe(403);
    expect(upstream).toEqual([]);
  });

  test("an allowed write runs and is recorded once", async () => {
    const { send, decisions, completions, upstream } = harness({
      decision: { kind: "run", requestId: "request-1" },
    });
    const response = await send("/repos/acme/widgets/issues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Bug", body: "Details" }),
    });
    expect(response.status).toBe(200);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.title).toBe("Create issue on acme/widgets");
    expect(decisions[0]!.action).toMatchObject({ tools: ["issue_create"], sensitive: false });
    expect(decisions[0]!.reviewArguments).toEqual({
      request: "POST /repos/acme/widgets/issues",
      body: { title: "Bug", body: "Details" },
    });
    expect(completions).toEqual(["request-1:completed"]);
    expect(new TextDecoder().decode(upstream[0]!.init.body as Uint8Array)).toBe(
      JSON.stringify({ title: "Bug", body: "Details" }),
    );
  });

  test("the same request has the same digest, a different one does not", async () => {
    const { send, decisions } = harness();
    await send("/repos/acme/widgets/issues", { method: "POST", body: '{"title":"A","body":"b"}' });
    await send("/repos/acme/widgets/issues", { method: "POST", body: '{"title":"A","body":"b"}' });
    await send("/repos/acme/widgets/issues", { method: "POST", body: '{"title":"B"}' });
    expect(decisions[0]!.digest).toBe(decisions[1]!.digest);
    expect(decisions[2]!.digest).not.toBe(decisions[0]!.digest);
  });

  test("a request waiting for approval tells gh and does not reach GitHub", async () => {
    const { send, upstream } = harness({
      decision: {
        kind: "refuse",
        status: 403,
        waiting: true,
        message: "Waiting for approval: Delete repository on acme/widgets.",
      },
    });
    const response = await send("/repos/acme/widgets", { method: "DELETE" });
    expect(response.status).toBe(403);
    expect(response.headers.get("x-opengeni-approval")).toBe("pending");
    expect(((await response.json()) as { message: string }).message).toContain(
      "Waiting for approval",
    );
    expect(upstream).toEqual([]);
  });

  test("a GitHub error leaves the request not executed; no answer leaves it uncertain", async () => {
    const failing = harness({
      decision: { kind: "run", requestId: "r" },
      respond: () => Response.json({ message: "Validation Failed" }, { status: 422 }),
    });
    expect(
      (await failing.send("/repos/acme/widgets/issues", { method: "POST", body: "{}" })).status,
    ).toBe(422);
    expect(failing.completions).toEqual(["r:not_executed"]);
    const unanswered = harness({
      decision: { kind: "run", requestId: "r" },
      respond: () => {
        throw new Error("reset");
      },
    });
    expect(
      (await unanswered.send("/repos/acme/widgets/issues", { method: "POST", body: "{}" })).status,
    ).toBe(502);
    expect(unanswered.completions).toEqual(["r:uncertain"]);
  });

  test("GraphQL mutations are checked against the repositories of their node IDs", async () => {
    const respond = (url: string, init: RequestInit) => {
      const body = JSON.parse(bodyText(init)) as {
        query: string;
        variables?: { ids?: string[] };
      };
      if (body.query.includes("OpengeniGatewayNodes")) {
        return Response.json({
          data: {
            nodes: body.variables!.ids!.map((id) =>
              id === "R_kgDOWidgets"
                ? { __typename: "Repository", nameWithOwner: "acme/widgets" }
                : { __typename: "PullRequest", repository: { nameWithOwner: "other/secret" } },
            ),
          },
        });
      }
      return Response.json({ data: { createPullRequest: { pullRequest: { url } } } });
    };
    const mutation = (id: string) =>
      JSON.stringify({
        query:
          "mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { url } } }",
        variables: {
          input: { repositoryId: id, baseRefName: "main", headRefName: "f", title: "T" },
        },
      });
    const allowed = harness({ respond });
    expect(
      (await allowed.send("/graphql", { method: "POST", body: mutation("R_kgDOWidgets") })).status,
    ).toBe(200);
    expect(allowed.decisions[0]!.title).toBe("Open pull request on acme/widgets");
    const denied = harness({ respond });
    const response = await denied.send("/graphql", {
      method: "POST",
      body: mutation("PR_kwDOSecret1"),
    });
    expect(response.status).toBe(403);
    expect(denied.decisions).toEqual([]);
    // A node ID in an indented block string is the same ID to GitHub.
    const hidden = harness({ respond });
    const blockString = await hidden.send("/graphql", {
      method: "POST",
      body: JSON.stringify({
        query:
          'mutation { transferIssue(input: {\n  issueId: """\n  I_kwDOSecret1\n  """, repositoryId: "R_kgDOWidgets" }) { issue { id } } }',
      }),
    });
    expect(blockString.status).toBe(403);
    expect(hidden.decisions).toEqual([]);
  });

  test("GraphQL queries check the repositories they name", async () => {
    const { send } = harness();
    const query = (owner: string, name: string) =>
      JSON.stringify({
        query: "query($o: String!, $n: String!) { repository(owner: $o, name: $n) { id } }",
        variables: { o: owner, n: name },
      });
    expect(
      (await send("/graphql", { method: "POST", body: query("acme", "widgets") })).status,
    ).toBe(200);
    expect(
      (await send("/graphql", { method: "POST", body: query("other", "secret") })).status,
    ).toBe(403);
  });

  test("unresolvable node IDs make the mutation ask", async () => {
    const { send, decisions } = harness({
      respond: (_url, init) => {
        const text = bodyText(init);
        return text.includes("OpengeniGatewayNodes")
          ? Response.json({ message: "Bad credentials" }, { status: 401 })
          : Response.json({ data: {} });
      },
    });
    await send("/graphql", {
      method: "POST",
      body: JSON.stringify({
        query: 'mutation { addStar(input: {starrableId: "R_kgDOWidgets"}) { clientMutationId } }',
      }),
    });
    expect(decisions[0]!.action).toMatchObject({ sensitive: true, unscoped: true });
  });

  test("a mutation on a node without a repository asks even when every policy allows it", async () => {
    const { send, decisions } = harness({
      respond: (_url, init) =>
        bodyText(init).includes("OpengeniGatewayNodes")
          ? Response.json({ data: { nodes: [{ __typename: "BranchProtectionRule" }] } })
          : Response.json({ data: {} }),
    });
    await send("/graphql", {
      method: "POST",
      body: JSON.stringify({
        query:
          'mutation { deleteBranchProtectionRule(input: {branchProtectionRuleId: "BPR_other"}) { clientMutationId } }',
      }),
    });
    const action = decisions[0]!.action;
    expect(action).toMatchObject({ sensitive: true, unscoped: true });
    const allowEverything: GatewayPolicyLookup = async () => "allow";
    expect((await strictestGatewayPolicy(action, allowEverything)).decision).toBe("ask");
  });

  test("a mutation on an allowed repository can't vouch for an organization write bundled with it", async () => {
    const nodes: Record<string, unknown> = {
      PVT_kwDOProject1: { __typename: "ProjectV2" },
      I_kwDOWidgets1: { __typename: "Issue", repository: { nameWithOwner: "acme/widgets" } },
    };
    const respond = (_url: string, init?: RequestInit) => {
      const body = JSON.parse(bodyText(init)) as { query: string; variables?: { ids?: string[] } };
      return body.query.includes("OpengeniGatewayNodes")
        ? Response.json({ data: { nodes: (body.variables?.ids ?? []).map((id) => nodes[id]) } })
        : Response.json({ data: {} });
    };
    const comment =
      'addComment(input: {subjectId: "I_kwDOWidgets1", body: "hi"}) { clientMutationId }';
    const send = async (query: string, options: Parameters<typeof harness>[0] = {}) => {
      const gateway = harness({ respond, ...options });
      await gateway.send("/graphql", { method: "POST", body: JSON.stringify({ query }) });
      return gateway.decisions[0]!.action;
    };
    // A comment alone is scoped to its repository.
    expect(await send(`mutation { ${comment} }`)).not.toHaveProperty("unscoped");
    // A project deletion bundled with it still can't be confirmed.
    const bundled = `mutation { deleteProjectV2(input: {projectId: "PVT_kwDOProject1"}) { clientMutationId } ${comment} }`;
    const action = await send(bundled);
    expect(action).toMatchObject({ sensitive: true, unscoped: true });
    const allowEverything: GatewayPolicyLookup = async () => "allow";
    expect((await strictestGatewayPolicy(action, allowEverything)).decision).toBe("ask");
    // Nor can an unrecognised mutation that names a repository node next to a project.
    expect(
      await send(
        'mutation { moveProjectV2Item(input: {projectId: "PVT_kwDOProject1", contentId: "I_kwDOWidgets1"}) { clientMutationId } }',
      ),
    ).toMatchObject({ sensitive: true, unscoped: true });
    // With every repository allowed for writing, the person's policy decides.
    const allWrite = authority({
      selection: {
        ...authority().selection,
        repositories: [],
        allRepositoriesAccess: "write",
      } as unknown as PersonalGitHubGatewayAuthority["selection"],
    });
    expect(await send(bundled, { authority: allWrite })).not.toHaveProperty("unscoped");
  });

  test("a repository named in free text can't scope an account write", async () => {
    const respond = (_url: string, init?: RequestInit) => {
      const body = JSON.parse(bodyText(init)) as { query: string; variables?: { ids?: string[] } };
      return body.query.includes("OpengeniGatewayNodes")
        ? Response.json({
            data: {
              nodes: (body.variables?.ids ?? []).map((id) =>
                id === "R_kgDOWidgets"
                  ? { __typename: "Repository", nameWithOwner: "acme/widgets" }
                  : null,
              ),
            },
          })
        : Response.json({ data: {} });
    };
    const send = async (body: unknown) => {
      const gateway = harness({ respond });
      await gateway.send("/graphql", { method: "POST", body: JSON.stringify(body) });
      return gateway.decisions[0]!.action;
    };
    const sponsor =
      'createSponsorship(input: {sponsorableLogin: "someone", amount: 500, clientMutationId: "R_kgDOWidgets"}) { clientMutationId }';
    expect(await send({ query: `mutation { ${sponsor} }` })).toMatchObject({ unscoped: true });
    expect(
      await send({
        query:
          "mutation($input: CreateSponsorshipInput!) { createSponsorship(input: $input) { clientMutationId } }",
        variables: {
          input: { sponsorableLogin: "someone", amount: 500, clientMutationId: "R_kgDOWidgets" },
        },
      }),
    ).toMatchObject({ unscoped: true });
    expect(
      await send({
        query:
          'mutation { updateSponsorsListing(input: {websiteUrl: "https://github.com/acme/widgets"}) { clientMutationId } }',
      }),
    ).toMatchObject({ unscoped: true });
    // A sensitive mutation on an allowed repository plus a node GitHub won't show.
    expect(
      await send({
        query:
          'mutation { updateRepository(input: {repositoryId: "R_kgDOWidgets", ownerId: "O_kgDOHidden1"}) { clientMutationId } }',
      }),
    ).toMatchObject({ unscoped: true });
  });
});

describe("personal GitHub gateway review fixes", () => {
  const removedWidgets = [
    {
      resource: { kind: "repository", uri: "https://github.com/acme/widgets", ref: "main" },
    } as unknown as PersonalGitHubGatewayAuthority["removedRepositories"][number],
  ];

  test("a removed repository addressed by ID is refused too", async () => {
    const { send, upstream } = harness({
      authority: authority({ removedRepositories: removedWidgets }),
    });
    const response = await send("/repositories/11/issues", {
      method: "POST",
      body: JSON.stringify({ title: "x" }),
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { message: string }).message).toContain(
      "removed from this chat",
    );
    expect(upstream).toEqual([]);
  });

  test("with All my repositories, GitHub names a repository addressed by ID", async () => {
    const all = authority({
      removedRepositories: removedWidgets,
      selection: {
        ...authority().selection,
        repositories: [],
        allRepositoriesAccess: "write",
      } as unknown as PersonalGitHubGatewayAuthority["selection"],
    });
    const { send, upstream } = harness({
      authority: all,
      respond: (url) =>
        url.endsWith("/repositories/77")
          ? Response.json({ id: 77, full_name: "acme/widgets" })
          : Response.json({ ok: true }),
    });
    const response = await send("/repositories/77/issues", {
      method: "POST",
      body: JSON.stringify({ title: "x" }),
    });
    expect(response.status).toBe(403);
    expect(upstream.map((call) => call.url)).toEqual(["https://api.github.com/repositories/77"]);
  });

  test("with All my repositories for writing, account writes follow the person's policy", async () => {
    const allWrite = (removedRepositories: typeof removedWidgets = []) =>
      authority({
        removedRepositories,
        selection: {
          ...authority().selection,
          repositories: [],
          allRepositoriesAccess: "write",
        } as unknown as PersonalGitHubGatewayAuthority["selection"],
      });
    const addKey = () => ({ method: "POST", body: JSON.stringify({ key: "ssh-ed25519 AAAA" }) });
    const covered = harness({ authority: allWrite() });
    await covered.send("/user/keys", addKey());
    expect(covered.decisions[0]!.action).toMatchObject({ sensitive: true });
    expect(covered.decisions[0]!.action).not.toHaveProperty("unscoped");
    // The send re-checks that every repository is still allowed for writing.
    expect(covered.authorized[0]).toMatchObject({ everyRepository: true });
    // A repository removed from the chat is an allowlist again: it asks.
    const restricted = harness({ authority: allWrite(removedWidgets) });
    await restricted.send("/user/keys", addKey());
    expect(restricted.decisions[0]!.action).toMatchObject({ sensitive: true, unscoped: true });
    // Chosen repositories are an allowlist too.
    const chosen = harness();
    await chosen.send("/user/keys", addKey());
    expect(chosen.decisions[0]!.action).toMatchObject({ unscoped: true });
  });

  test("a mutation naming its repository by name is checked against the allowlist", async () => {
    const { send, upstream } = harness();
    const commit = (repository: string) =>
      JSON.stringify({
        query:
          "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
        variables: {
          input: {
            branch: { repositoryNameWithOwner: repository, branchName: "main" },
            expectedHeadOid: "a".repeat(40),
            message: { headline: "x" },
          },
        },
      });
    expect((await send("/graphql", { method: "POST", body: commit("other/secret") })).status).toBe(
      403,
    );
    expect((await send("/graphql", { method: "POST", body: commit("acme/docs") })).status).toBe(
      403,
    );
    expect(upstream).toEqual([]);
    expect((await send("/graphql", { method: "POST", body: commit("acme/widgets") })).status).toBe(
      200,
    );
  });

  test("a repository mutation whose repository can't be found asks", async () => {
    const { send, decisions } = harness();
    await send("/graphql", {
      method: "POST",
      body: JSON.stringify({
        query: 'mutation { createIssue(input: {title: "x"}) { issue { id } } }',
      }),
    });
    expect(decisions[0]!.action).toMatchObject({ sensitive: true });
  });

  test("GraphQL reads under an owner login are scoped", async () => {
    const { send } = harness();
    const query = (login: string) =>
      JSON.stringify({
        query: `query { organization(login: "${login}") { repository(name: "secret") { id } } }`,
      });
    expect((await send("/graphql", { method: "POST", body: query("other") })).status).toBe(403);
    const viewer = harness({
      authority: authority({
        metadata: { ...connectionMetadata, githubLogin: "acme" },
      }),
    });
    const own = JSON.stringify({
      query: 'query { viewer { repository(name: "widgets") { id } } }',
    });
    expect((await viewer.send("/graphql", { method: "POST", body: own })).status).toBe(200);
  });

  test("GraphQL needs POST, and only GitHub's own headers are forwarded", async () => {
    const { send, upstream } = harness();
    expect((await send("/graphql")).status).toBe(405);
    await send("/user", {
      headers: {
        "x-http-method-override": "DELETE",
        "x-real-ip": "1.2.3.4",
        "x-github-api-version": "2022-11-28",
      },
    });
    const headers = new Headers(upstream[0]!.init.headers);
    expect(headers.get("x-http-method-override")).toBeNull();
    expect(headers.get("x-real-ip")).toBeNull();
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
  });

  test("approvals bind the exact body bytes", async () => {
    const { send, decisions } = harness();
    await send("/repos/acme/widgets/issues", { method: "POST", body: '{"title":"a","body":"b"}' });
    await send("/repos/acme/widgets/issues", { method: "POST", body: '{"body":"b","title":"a"}' });
    expect(decisions[0]!.digest).not.toBe(decisions[1]!.digest);
  });
});

describe("gateway repository allowlist", () => {
  test("All my repositories allows any repository up to its access", () => {
    const all = authority({
      selection: {
        ...authority().selection,
        allRepositoriesAccess: "read",
      } as PersonalGitHubGatewayAuthority["selection"],
    });
    expect(gatewayRepositoryDecision(all, { kind: "name", owner: "x", name: "y" }, "read")).toEqual(
      {
        allowed: true,
      },
    );
    expect(
      gatewayRepositoryDecision(all, { kind: "name", owner: "x", name: "y" }, "write").allowed,
    ).toBe(false);
  });

  test("a repository removed from the chat is refused", () => {
    const removed = authority({
      removedRepositories: [
        {
          resource: { kind: "repository", uri: "https://github.com/acme/widgets", ref: "main" },
        } as unknown as PersonalGitHubGatewayAuthority["removedRepositories"][number],
      ],
    });
    expect(
      gatewayRepositoryDecision(removed, { kind: "name", owner: "ACME", name: "widgets" }, "read"),
    ).toEqual({ allowed: false, message: "ACME/widgets was removed from this chat." });
  });

  test("All my repositories allows a repository that was not picked, minus ones removed from the chat", () => {
    const all = authority({
      selection: {
        ...authority().selection,
        repositories: [],
        allRepositoriesAccess: "write",
      } as PersonalGitHubGatewayAuthority["selection"],
      removedRepositories: [
        {
          resource: { kind: "repository", uri: "https://github.com/acme/widgets", ref: "main" },
        } as unknown as PersonalGitHubGatewayAuthority["removedRepositories"][number],
      ],
    });
    expect(
      gatewayRepositoryDecision(all, { kind: "name", owner: "other", name: "tool" }, "write"),
    ).toEqual({ allowed: true });
    expect(
      gatewayRepositoryDecision(all, { kind: "name", owner: "acme", name: "widgets" }, "read"),
    ).toEqual({ allowed: false, message: "acme/widgets was removed from this chat." });
  });

  test("without All my repositories only the picked repositories are allowed, at their access", () => {
    expect(
      gatewayRepositoryDecision(
        authority(),
        { kind: "name", owner: "other", name: "tool" },
        "read",
      ),
    ).toEqual({
      allowed: false,
      message: "other/tool is not one of the repositories the person allowed under Your GitHub.",
    });
    expect(
      gatewayRepositoryDecision(
        authority(),
        { kind: "name", owner: "acme", name: "docs" },
        "write",
      ),
    ).toEqual({ allowed: false, message: "acme/docs may only be read as the person." });
  });

  test("a changed connection is refused", () => {
    const changed = authority({
      metadata: {
        ...connectionMetadata,
        credentialBindingId: "00000000-0000-4000-8000-000000000009",
      },
    });
    expect(
      gatewayRepositoryDecision(changed, { kind: "name", owner: "acme", name: "widgets" }, "read")
        .allowed,
    ).toBe(false);
  });

  test("repositories are matched by ID too", () => {
    expect(gatewayRepositoryDecision(authority(), { kind: "id", id: "11" }, "write").allowed).toBe(
      true,
    );
    expect(gatewayRepositoryDecision(authority(), { kind: "id", id: "99" }, "read").allowed).toBe(
      false,
    );
  });
});

describe("force updates and deletions of refs", () => {
  /**
   * GitHub for acme/widgets, whose default branch is main: the REST
   * repository, GraphQL Ref and Repository nodes, and the request itself.
   */
  function github(defaultBranch: string | null = "main") {
    const repositoryReads: string[] = [];
    const respond = (url: string, init: RequestInit) => {
      if (
        url.startsWith("https://api.github.com/repos/acme/widgets") &&
        (init.method ?? "GET") === "GET"
      ) {
        repositoryReads.push(url);
        return defaultBranch
          ? Response.json({ full_name: "acme/widgets", default_branch: defaultBranch })
          : Response.json({ message: "Not Found" }, { status: 404 });
      }
      if (url === "https://api.github.com/graphql") {
        const body = JSON.parse(bodyText(init)) as {
          query: string;
          variables?: { ids?: string[] };
        };
        const branchRef = defaultBranch ? { name: defaultBranch } : null;
        const nodes = (body.variables?.ids ?? []).map((id) => {
          if (id === "R_kgDOWidgets") {
            return {
              __typename: "Repository",
              nameWithOwner: "acme/widgets",
              defaultBranchRef: branchRef,
            };
          }
          const [prefix, name] = {
            REF_kwDOFeature1: ["refs/heads/", "feature"],
            REF_kwDOMainRef1: ["refs/heads/", "main"],
            REF_kwDOTagRef01: ["refs/tags/", "v1"],
          }[id] ?? ["refs/heads/", "unknown"];
          // Asked again for the ref, GitHub names a repository the gateway
          // didn't check.
          const nameWithOwner =
            id === "REF_kwDOElsewhr" && body.query.includes("OpengeniGatewayRefs")
              ? "other/widgets"
              : "acme/widgets";
          return {
            __typename: "Ref",
            name,
            prefix,
            repository: { nameWithOwner, defaultBranchRef: branchRef },
          };
        });
        if (body.query.includes("OpengeniGateway")) return Response.json({ data: { nodes } });
        return Response.json({ data: {} });
      }
      return Response.json({ ok: true });
    };
    return { respond, repositoryReads };
  }

  const graphql = (query: string, variables: Record<string, unknown> = {}) => ({
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });

  test("of a branch other than the default branch follow the person's policy", async () => {
    const { respond } = github();
    const { send, decisions, upstream } = harness({ respond });
    expect(
      (await send("/repos/acme/widgets/git/refs/heads/feature/x", { method: "DELETE" })).status,
    ).toBe(200);
    await send("/repos/acme/widgets/git/refs/heads/feature", {
      method: "PATCH",
      body: JSON.stringify({ sha: "a".repeat(40), force: true }),
    });
    await send(
      "/graphql",
      graphql('mutation { deleteRef(input: {refId: "REF_kwDOFeature1"}) { clientMutationId } }'),
    );
    await send(
      "/graphql",
      graphql(
        'mutation { updateRef(input: {refId: "REF_kwDOFeature1", oid: "abc", force: true}) { clientMutationId } }',
      ),
    );
    await send(
      "/graphql",
      graphql("mutation($i: UpdateRefsInput!) { updateRefs(input: $i) { clientMutationId } }", {
        i: {
          repositoryId: "R_kgDOWidgets",
          refUpdates: [
            { name: "refs/heads/feature", beforeOid: "a".repeat(40), afterOid: "0".repeat(40) },
            { name: "refs/heads/other", afterOid: "b".repeat(40), force: true },
          ],
        },
      }),
    );
    expect(decisions.map((decision) => [decision.title, decision.action])).toEqual([
      [
        "Delete branch or tag on acme/widgets",
        expect.objectContaining({ tools: ["ref_create"], sensitive: false }),
      ],
      [
        "Force-update branch on acme/widgets",
        expect.objectContaining({ tools: ["ref_create"], sensitive: false }),
      ],
      ["Delete branch or tag on acme/widgets", expect.objectContaining({ sensitive: false })],
      ["Force-update branch on acme/widgets", expect.objectContaining({ sensitive: false })],
      ["Delete branch or tag on acme/widgets", expect.objectContaining({ sensitive: false })],
    ]);
    expect(upstream.some((request) => request.init.method === "DELETE")).toBe(true);
  });

  test("an agent's merged branch that gh names with encoded slashes follows the person's policy", async () => {
    // What `gh pr merge --delete-branch` sends for em/staging-live-binary-readiness.
    const { respond } = github();
    const { send, decisions, upstream } = harness({ respond });
    const response = await send(
      "/repos/acme/widgets/git/refs/heads%2Fem%2Fstaging-live-binary-readiness",
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);
    expect(decisions.map((decision) => [decision.title, decision.action])).toEqual([
      [
        "Delete branch or tag on acme/widgets",
        expect.objectContaining({ tools: ["ref_create"], sensitive: false }),
      ],
    ]);
    expect(
      upstream.some(
        (request) =>
          request.init.method === "DELETE" &&
          request.url.endsWith("/git/refs/heads%2Fem%2Fstaging-live-binary-readiness"),
      ),
    ).toBe(true);
    // The default branch, encoded the same way, stays sensitive.
    await send("/repos/acme/widgets/git/refs/heads%2Fmain", { method: "DELETE" });
    expect(decisions.at(-1)?.action).toEqual(expect.objectContaining({ sensitive: true }));
  });

  test("of the default branch, a tag or an unconfirmed ref are sensitive", async () => {
    const { respond } = github();
    const { send, decisions } = harness({ respond });
    await send("/repos/acme/widgets/git/refs/heads/main", { method: "DELETE" });
    await send("/repos/acme/widgets/git/refs/heads/Main", {
      method: "PATCH",
      body: JSON.stringify({ sha: "a".repeat(40), force: true }),
    });
    await send("/repos/acme/widgets/git/refs/tags/v1", { method: "DELETE" });
    await send(
      "/graphql",
      graphql('mutation { deleteRef(input: {refId: "REF_kwDOMainRef1"}) { clientMutationId } }'),
    );
    await send(
      "/graphql",
      graphql('mutation { deleteRef(input: {refId: "REF_kwDOTagRef01"}) { clientMutationId } }'),
    );
    await send(
      "/graphql",
      graphql("mutation($i: UpdateRefsInput!) { updateRefs(input: $i) { clientMutationId } }", {
        i: {
          repositoryId: "R_kgDOWidgets",
          refUpdates: [
            { name: "refs/heads/feature", afterOid: "0".repeat(40) },
            { name: "refs/heads/main", afterOid: "b".repeat(40), force: true },
          ],
        },
      }),
    );
    // A ref in a repository other than the one the gateway checked.
    await send(
      "/graphql",
      graphql('mutation { deleteRef(input: {refId: "REF_kwDOElsewhr"}) { clientMutationId } }'),
    );
    // Another sensitive mutation keeps the request sensitive.
    await send(
      "/graphql",
      graphql(
        'mutation { deleteRef(input: {refId: "REF_kwDOFeature1"}) { clientMutationId } updateRepository(input: {repositoryId: "R_kgDOWidgets", hasWikiEnabled: false}) { clientMutationId } }',
      ),
    );
    expect(decisions.map((decision) => decision.action)).toHaveLength(8);
    expect(
      decisions.every((decision) => decision.action.kind === "write" && decision.action.sensitive),
    ).toBe(true);
  });

  test("ask when GitHub does not tell the default branch", async () => {
    const { respond } = github(null);
    const { send, decisions } = harness({ respond });
    await send("/repos/acme/widgets/git/refs/heads/feature", { method: "DELETE" });
    await send(
      "/graphql",
      graphql('mutation { deleteRef(input: {refId: "REF_kwDOFeature1"}) { clientMutationId } }'),
    );
    expect(decisions.map((decision) => decision.action)).toEqual([
      expect.objectContaining({ sensitive: true }),
      expect.objectContaining({ sensitive: true }),
    ]);
  });

  test("the default branch is read once with the person's token and kept", async () => {
    const { respond, repositoryReads } = github();
    const { services, send, decisions, authorized } = harness({ respond });
    services.defaultBranches = new Map();
    await send("/repos/acme/widgets/git/refs/heads/one", { method: "DELETE" });
    await send("/repos/acme/widgets/git/refs/heads/two", { method: "DELETE" });
    expect(repositoryReads).toEqual(["https://api.github.com/repos/acme/widgets"]);
    expect(
      authorized.some((call) => call.url === "https://api.github.com/repos/acme/widgets"),
    ).toBe(true);
    expect(decisions.map((decision) => decision.action)).toEqual([
      expect.objectContaining({ sensitive: false }),
      expect.objectContaining({ sensitive: false }),
    ]);
  });

  test("with Ask first a branch rewrite still asks; with Allow it runs", async () => {
    const { respond } = github();
    for (const policy of ["allow", "ask"] as const) {
      const context = harness({ respond });
      context.services.decide = async (_identity, input) => {
        context.decisions.push(input);
        return policy === "allow" && !input.action.sensitive
          ? { kind: "allow" }
          : {
              kind: "refuse",
              status: 403,
              waiting: true,
              message: `Waiting for approval: ${input.title}.`,
            };
      };
      const response = await context.send("/repos/acme/widgets/git/refs/heads/feature", {
        method: "DELETE",
      });
      if (policy === "allow") {
        expect(response.status).toBe(200);
        expect(context.upstream.some((request) => request.init.method === "DELETE")).toBe(true);
      } else {
        expect(response.status).toBe(403);
        expect(response.headers.get("x-opengeni-approval")).toBe("pending");
        expect(context.upstream.some((request) => request.init.method === "DELETE")).toBe(false);
      }
    }
  });
});
