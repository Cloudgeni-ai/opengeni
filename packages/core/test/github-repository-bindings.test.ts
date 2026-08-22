import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ResourceRef } from "@opengeni/contracts";
import {
  bindAuthorizedGitHubInstallationRepositories,
  createDb,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  applyGitHubRepositoryBindings,
  listGitHubRepositoryBindingCandidates,
  parseGitHubRepositoryCoordinates,
  resolveGitHubRepositoryBindings,
  unboundGitHubRepositoryResources,
  type GitHubRepositoryBindingCandidate,
  type GitHubRepositoryBindingLookup,
} from "../src/domain/github-repository-bindings";

const repo = (overrides: Record<string, unknown> = {}): ResourceRef =>
  ({
    kind: "repository",
    uri: "https://github.com/acme/app.git",
    ref: "main",
    mountPath: "repos/github.com/acme/app",
    ...overrides,
  }) as ResourceRef;

const candidate = (
  overrides: Partial<GitHubRepositoryBindingCandidate> = {},
): GitHubRepositoryBindingCandidate => ({
  installationId: 123,
  accountLogin: "acme",
  repositoryIds: [456],
  ...overrides,
});

function catalogLookup(
  entries: Array<{ installationId: number; fullName: string; id: number }>,
  calls: Array<{ installationId: number; owner: string; name: string }> = [],
): GitHubRepositoryBindingLookup {
  return async (input) => {
    calls.push(input);
    const match = entries.find(
      (entry) =>
        entry.installationId === input.installationId &&
        entry.fullName.toLowerCase() === `${input.owner}/${input.name}`.toLowerCase(),
    );
    return match ? { id: match.id } : null;
  };
}

describe("GitHub repository coordinates", () => {
  test("parses canonical github.com clone and browse URIs", () => {
    expect(parseGitHubRepositoryCoordinates("https://github.com/acme/app.git")).toEqual({
      owner: "acme",
      name: "app",
    });
    expect(parseGitHubRepositoryCoordinates("https://GitHub.com/Acme/App/")).toEqual({
      owner: "Acme",
      name: "App",
    });
    expect(parseGitHubRepositoryCoordinates("https://github.com/acme/app")).toEqual({
      owner: "acme",
      name: "app",
    });
  });

  test("rejects non-GitHub hosts, credentials, queries, and non-repository paths", () => {
    for (const uri of [
      "https://gitlab.com/acme/app.git",
      "https://github.com/acme",
      "https://github.com/acme/app/tree/main",
      "https://user:pw@github.com/acme/app.git",
      "https://github.com/acme/app.git?x=1",
      "https://github.com/acme/app.git#frag",
      "ssh://git@github.com/acme/app.git",
      "not a url",
    ]) {
      expect(parseGitHubRepositoryCoordinates(uri)).toBeNull();
    }
  });
});

describe("unbound GitHub repository resources", () => {
  test("selects bare github.com repositories with no platform identity", () => {
    const bare = repo();
    const explicitProvider = repo({ uri: "https://github.com/acme/two.git", provider: "github" });
    const selected = unboundGitHubRepositoryResources([bare, explicitProvider]);
    expect(selected.map((entry) => entry.resource)).toEqual([bare, explicitProvider]);
    expect(selected[0]).toMatchObject({ owner: "acme", name: "app" });
  });

  test("never rewrites resources that already carry identity or another provider", () => {
    expect(
      unboundGitHubRepositoryResources([
        repo({ githubInstallationId: 123, githubRepositoryId: 456 }),
        repo({ provider: "github", installationId: "123", repositoryId: "456" }),
        repo({ provider: "github", credentialBindingId: "binding-1" }),
        repo({ provider: "github", connectionId: "connection-1" }),
        repo({
          uri: "https://github.com/acme/personal",
          provider: "github",
          connectionType: "github_personal",
          credentialBindingId: "11111111-2222-4333-8444-555555555555",
          repositoryId: "1",
          access: "read",
        }),
        repo({ uri: "https://gitlab.com/acme/app.git", provider: "gitlab" }),
        { kind: "file", fileId: crypto.randomUUID() },
      ]),
    ).toEqual([]);
  });
});

describe("GitHub repository binding resolution", () => {
  test("stamps ids when exactly one bound installation allowlists the repository", async () => {
    const calls: Array<{ installationId: number; owner: string; name: string }> = [];
    const result = await resolveGitHubRepositoryBindings({
      resources: [repo(), { kind: "file", fileId: "11111111-1111-4111-8111-111111111111" }],
      candidates: [candidate()],
      lookup: catalogLookup([{ installationId: 123, fullName: "acme/app", id: 456 }], calls),
    });
    expect(result.resources[0]).toEqual(
      repo({ provider: "github", githubInstallationId: 123, githubRepositoryId: 456 }),
    );
    expect(result.resources[1]).toEqual({
      kind: "file",
      fileId: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.resolutions).toEqual([
      {
        uri: "https://github.com/acme/app.git",
        owner: "acme",
        name: "app",
        outcome: { status: "resolved", binding: { installationId: 123, repositoryId: 456 } },
      },
    ]);
    expect(calls).toEqual([{ installationId: 123, owner: "acme", name: "app" }]);
  });

  test("matches the bound account login case-insensitively and keeps the stored URI", async () => {
    const result = await resolveGitHubRepositoryBindings({
      resources: [repo({ uri: "https://github.com/ACME/App.git" })],
      candidates: [candidate({ accountLogin: "Acme" })],
      lookup: catalogLookup([{ installationId: 123, fullName: "acme/app", id: 456 }]),
    });
    expect(result.resources[0]).toMatchObject({
      uri: "https://github.com/ACME/App.git",
      githubInstallationId: 123,
      githubRepositoryId: 456,
    });
  });

  test("leaves an unbound owner bare without a lookup or warning", async () => {
    const calls: Array<{ installationId: number; owner: string; name: string }> = [];
    const result = await resolveGitHubRepositoryBindings({
      resources: [repo({ uri: "https://github.com/someone-else/public.git" })],
      candidates: [candidate()],
      lookup: catalogLookup([], calls),
    });
    expect(result.resources).toEqual([repo({ uri: "https://github.com/someone-else/public.git" })]);
    expect(result.resolutions[0]?.outcome).toEqual({ status: "unbound" });
    expect(calls).toEqual([]);
  });

  test("keeps a bound owner's non-allowlisted repository bare and reports it", async () => {
    const result = await resolveGitHubRepositoryBindings({
      resources: [repo()],
      candidates: [candidate({ repositoryIds: [999] })],
      lookup: catalogLookup([{ installationId: 123, fullName: "acme/app", id: 456 }]),
    });
    expect(result.resources).toEqual([repo()]);
    expect(result.resolutions[0]?.outcome).toEqual({
      status: "not_allowlisted",
      installationIds: [123],
    });
  });

  test("treats a repository GitHub cannot see through the installation as not allowlisted", async () => {
    const result = await resolveGitHubRepositoryBindings({
      resources: [repo()],
      candidates: [candidate()],
      lookup: catalogLookup([]),
    });
    expect(result.resources).toEqual([repo()]);
    expect(result.resolutions[0]?.outcome).toEqual({
      status: "not_allowlisted",
      installationIds: [123],
    });
  });

  test("keeps an ambiguous repository bare when two bound installations allowlist it", async () => {
    const result = await resolveGitHubRepositoryBindings({
      resources: [repo()],
      candidates: [candidate(), candidate({ installationId: 124 })],
      lookup: catalogLookup([
        { installationId: 123, fullName: "acme/app", id: 456 },
        { installationId: 124, fullName: "acme/app", id: 456 },
      ]),
    });
    expect(result.resources).toEqual([repo()]);
    expect(result.resolutions[0]?.outcome).toEqual({
      status: "ambiguous",
      installationIds: [123, 124],
    });
  });

  test("keeps the repository bare and reports an unavailable lookup instead of failing", async () => {
    const result = await resolveGitHubRepositoryBindings({
      resources: [repo()],
      candidates: [candidate()],
      lookup: async () => {
        throw new Error("GitHub API 403: installation suspended");
      },
    });
    expect(result.resources).toEqual([repo()]);
    expect(result.resolutions[0]?.outcome).toEqual({
      status: "unavailable",
      installationIds: [123],
      message: "GitHub API 403: installation suspended",
    });
  });

  test("applies one resolution to an inherited child resource list", async () => {
    // A child created with omitted resources inherits the parent's bare
    // repository verbatim. The turn-time resolution is keyed by URI, so the
    // same bindings apply to the parent's turn resources and to the child's
    // runtime resources alike.
    const parentResources = [repo(), repo({ uri: "https://github.com/acme/docs.git" })];
    const childResources = [...parentResources];
    const result = await resolveGitHubRepositoryBindings({
      resources: parentResources,
      candidates: [candidate({ repositoryIds: [456, 457] })],
      lookup: catalogLookup([
        { installationId: 123, fullName: "acme/app", id: 456 },
        { installationId: 123, fullName: "acme/docs", id: 457 },
      ]),
    });
    expect(applyGitHubRepositoryBindings(childResources, result.bindings)).toEqual(
      result.resources,
    );
    expect(result.resources.map((resource) => (resource as any).githubRepositoryId)).toEqual([
      456, 457,
    ]);
    // Already-identified resources are never restamped, even for a known URI.
    expect(
      applyGitHubRepositoryBindings(
        [repo({ githubInstallationId: 777, githubRepositoryId: 888 })],
        result.bindings,
      ),
    ).toEqual([repo({ githubInstallationId: 777, githubRepositoryId: 888 })]);
  });

  test("is a no-op without bare GitHub repositories", async () => {
    const resources = [repo({ githubInstallationId: 123, githubRepositoryId: 456 })];
    const result = await resolveGitHubRepositoryBindings({
      resources,
      candidates: [candidate()],
      lookup: async () => {
        throw new Error("must not be called");
      },
    });
    expect(result.resources).toEqual(resources);
    expect(result.resolutions).toEqual([]);
  });
});

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-github-repository-bindings");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    return;
  }
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function workspaceFixture(): Promise<{
  accountId: string;
  workspaceId: string;
  subjectId: string;
}> {
  const subjectId = `user:core-github-bindings-${crypto.randomUUID()}`;
  const suffix = crypto.randomUUID();
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${`core github bindings ${suffix}`}) returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`core github bindings workspace ${suffix}`}) returning id`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  await shared!.admin`
    insert into workspace_memberships (workspace_id, account_id, subject_id, role)
    values (${workspace!.id}, ${account!.id}, ${subjectId}, 'owner')`;
  return { accountId: account!.id, workspaceId: workspace!.id, subjectId };
}

describe("GitHub repository binding candidates (Postgres)", () => {
  test("lists only the workspace's auditable installations with their allowlists", async () => {
    if (!shared) return;
    const own = await workspaceFixture();
    const other = await workspaceFixture();
    const authorityCheckedAt = new Date();
    const bind = (
      target: { accountId: string; workspaceId: string; subjectId: string },
      installationId: number,
      accountLogin: string,
      repositoryIds: number[],
    ) =>
      bindAuthorizedGitHubInstallationRepositories(db, {
        accountId: target.accountId,
        workspaceId: target.workspaceId,
        installationId,
        githubAccountId: installationId * 100,
        accountLogin,
        accountType: "Organization",
        linkedBySubjectId: target.subjectId,
        githubActorId: installationId * 100 + 1,
        githubActorLogin: `${accountLogin}-owner`,
        authorityKind: "organization_owner",
        authorityCheckedAt,
        authorityExpiresAt: new Date(authorityCheckedAt.getTime() + 10 * 60_000),
        authorityNonce: `core-github-bindings-${crypto.randomUUID()}`,
        repositoryIds,
      });
    await bind(own, 501, "acme", [456, 457]);
    await bind(own, 502, "globex", [900]);
    await bind(other, 503, "acme", [456]);
    // A legacy row without owner-authority receipts is visible for unlink only
    // and must never resolve a URI.
    await shared!.admin`
      insert into github_installations (account_id, workspace_id, installation_id, account_login, account_type, repository_scope)
      values (${own.accountId}, ${own.workspaceId}, 504, 'legacy-org', 'Organization', 'all')`;

    const candidates = await listGitHubRepositoryBindingCandidates(db, own.workspaceId);
    expect(
      candidates
        .map((entry) => ({
          ...entry,
          repositoryIds: [...entry.repositoryIds].sort((a, b) => a - b),
        }))
        .sort((a, b) => a.installationId - b.installationId),
    ).toEqual([
      { installationId: 501, accountLogin: "acme", repositoryIds: [456, 457] },
      { installationId: 502, accountLogin: "globex", repositoryIds: [900] },
    ]);

    // The other workspace's binding for the same account never leaks in, and
    // the end-to-end resolution uses exactly this workspace's allowlist.
    const result = await resolveGitHubRepositoryBindings({
      resources: [
        repo(),
        repo({ uri: "https://github.com/acme/private-elsewhere.git" }),
        repo({ uri: "https://github.com/legacy-org/tool.git" }),
      ],
      candidates,
      lookup: catalogLookup([
        { installationId: 501, fullName: "acme/app", id: 456 },
        { installationId: 501, fullName: "acme/private-elsewhere", id: 777 },
        { installationId: 503, fullName: "acme/private-elsewhere", id: 777 },
        { installationId: 504, fullName: "legacy-org/tool", id: 778 },
      ]),
    });
    expect(result.resolutions.map((resolution) => resolution.outcome)).toEqual([
      { status: "resolved", binding: { installationId: 501, repositoryId: 456 } },
      { status: "not_allowlisted", installationIds: [501] },
      { status: "unbound" },
    ]);
  });
});
