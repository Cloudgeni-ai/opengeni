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
import type { GatewayDecision, GatewayDecisionInput } from "../src/routes/personal-github-gateway-policy";

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

function authority(overrides: Partial<PersonalGitHubGatewayAuthority> = {}): PersonalGitHubGatewayAuthority {
  return {
    claims,
    identity: { claims, initiator: { kind: "human", subjectId: "person" }, unattended: false },
    providerPrincipalId: "7",
    metadata: {} as PersonalGitHubGatewayAuthority["metadata"],
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
  return typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as Uint8Array);
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
  const authorized: Array<{ url: string; tool: string; repositories: unknown[] }> = [];
  const services: PersonalGitHubGatewayServices = {
    openClaims: (token) => (token === "session-pass" ? claims : null),
    resolveAuthority: async () => options.authority ?? authority(),
    authorizeProviderRequest: async (_authority, url, tool, repositories) => {
      authorized.push({ url, tool, repositories });
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
          headers: { "content-type": "application/json", "set-cookie": "a=b", "x-ratelimit-remaining": "4999" },
        }),
    });
    const response = await send("/repos/acme/widgets?per_page=1", {
      headers: { cookie: "session=1", "x-forwarded-for": "1.2.3.4", accept: "application/vnd.github+json" },
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
        new Response(null, { status: 302, headers: { location: "https://results.example/logs.zip" } }),
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
      "other/secret is not one of the repositories Opengeni may use as you",
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
    expect(decisions[0]!.action).toMatchObject({ tools: ["issue_create"], alwaysAsk: false });
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
        message: "Waiting for your approval in Opengeni: Delete repository on acme/widgets.",
      },
    });
    const response = await send("/repos/acme/widgets", { method: "DELETE" });
    expect(response.status).toBe(403);
    expect(response.headers.get("x-opengeni-approval")).toBe("pending");
    expect(((await response.json()) as { message: string }).message).toContain(
      "Waiting for your approval in Opengeni",
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
        variables: { input: { repositoryId: id, baseRefName: "main", headRefName: "f", title: "T" } },
      });
    const allowed = harness({ respond });
    expect((await allowed.send("/graphql", { method: "POST", body: mutation("R_kgDOWidgets") })).status).toBe(200);
    expect(allowed.decisions[0]!.title).toBe("Open pull request on acme/widgets");
    const denied = harness({ respond });
    const response = await denied.send("/graphql", { method: "POST", body: mutation("PR_kwDOSecret1") });
    expect(response.status).toBe(403);
    expect(denied.decisions).toEqual([]);
  });

  test("GraphQL queries check the repositories they name", async () => {
    const { send } = harness();
    const query = (owner: string, name: string) =>
      JSON.stringify({
        query: "query($o: String!, $n: String!) { repository(owner: $o, name: $n) { id } }",
        variables: { o: owner, n: name },
      });
    expect((await send("/graphql", { method: "POST", body: query("acme", "widgets") })).status).toBe(200);
    expect((await send("/graphql", { method: "POST", body: query("other", "secret") })).status).toBe(403);
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
    expect(decisions[0]!.action).toMatchObject({ alwaysAsk: true });
  });
});

describe("personal GitHub gateway review fixes", () => {
  const removedWidgets = [
    {
      resource: { kind: "repository", uri: "https://github.com/acme/widgets", ref: "main" },
    } as unknown as PersonalGitHubGatewayAuthority["removedRepositories"][number],
  ];

  test("a removed repository addressed by ID is refused too", async () => {
    const { send, upstream } = harness({ authority: authority({ removedRepositories: removedWidgets }) });
    const response = await send("/repositories/11/issues", {
      method: "POST",
      body: JSON.stringify({ title: "x" }),
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { message: string }).message).toContain("removed from this chat");
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
    expect((await send("/graphql", { method: "POST", body: commit("other/secret") })).status).toBe(403);
    expect((await send("/graphql", { method: "POST", body: commit("acme/docs") })).status).toBe(403);
    expect(upstream).toEqual([]);
    expect((await send("/graphql", { method: "POST", body: commit("acme/widgets") })).status).toBe(200);
  });

  test("a repository mutation whose repository can't be found asks", async () => {
    const { send, decisions } = harness();
    await send("/graphql", {
      method: "POST",
      body: JSON.stringify({ query: "mutation { createIssue(input: {title: \"x\"}) { issue { id } } }" }),
    });
    expect(decisions[0]!.action).toMatchObject({ alwaysAsk: true });
  });

  test("GraphQL reads under an owner login are scoped", async () => {
    const { send } = harness();
    const query = (login: string) =>
      JSON.stringify({
        query: `query { organization(login: "${login}") { repository(name: "secret") { id } } }`,
      });
    expect((await send("/graphql", { method: "POST", body: query("other") })).status).toBe(403);
    const viewer = harness({
      authority: authority({ metadata: { githubLogin: "acme" } as PersonalGitHubGatewayAuthority["metadata"] }),
    });
    const own = JSON.stringify({ query: 'query { viewer { repository(name: "widgets") { id } } }' });
    expect((await viewer.send("/graphql", { method: "POST", body: own })).status).toBe(200);
  });

  test("GraphQL needs POST, and only GitHub's own headers are forwarded", async () => {
    const { send, upstream } = harness();
    expect((await send("/graphql")).status).toBe(405);
    await send("/user", {
      headers: { "x-http-method-override": "DELETE", "x-real-ip": "1.2.3.4", "x-github-api-version": "2022-11-28" },
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
    expect(gatewayRepositoryDecision(all, { kind: "name", owner: "x", name: "y" }, "read")).toEqual({
      allowed: true,
    });
    expect(gatewayRepositoryDecision(all, { kind: "name", owner: "x", name: "y" }, "write").allowed).toBe(
      false,
    );
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

  test("repositories are matched by ID too", () => {
    expect(gatewayRepositoryDecision(authority(), { kind: "id", id: "11" }, "write").allowed).toBe(true);
    expect(gatewayRepositoryDecision(authority(), { kind: "id", id: "99" }, "read").allowed).toBe(false);
  });
});
