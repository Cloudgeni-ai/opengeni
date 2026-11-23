// opengeni:test-shared-postgres-exclusive
// Your GitHub tools (`github_personal`) in an app, outside any chat, on real
// PostgreSQL: each viewer's readiness, calls and access to stored GitHub data
// use only their own connection with All my repositories; a viewer without
// one is offered Connect and can't see the stored data.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import type { AccessGrant, Permission } from "@opengeni/contracts";
import {
  accessGrantAuthorizationFromContext,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  createDb,
  createWorkspaceArtifact,
  encryptEnvironmentValue,
  ensureManagedAccessForUser,
  getPersonalGitHubRepositorySelectionState,
  persistProviderOAuthConnection,
  replacePersonalGitHubRepositorySelections,
  updateConnectorToolPermissionPolicies,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { readPersonalGitHubToolsAuthority } from "../src/personal-github-tools";
import { markToolData, requireToolDataReader, siteToolDataTarget } from "../src/site-tool-data";
import { readSiteToolAccountInventory } from "../src/site-tool-routing";
import {
  describeWorkspaceSiteToolReadiness,
  describeWorkspaceSiteToolSetup,
  invokeWorkspaceToolTarget,
  type TargetGatewayOptions,
} from "../src/workspace-tool-target";

setDefaultTimeout(120_000);

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("app-viewer-personal-github");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("Real PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const human: TargetGatewayOptions = { reauthorize: async () => undefined };
const tool = { serverId: "github_personal", toolName: "workflow_runs_list" };
const PERMISSIONS: Permission[] = [
  "workspace:read",
  "artifacts:read",
  "connections:read",
  "connections:write",
  "github:use",
];

function repositoryJson(fullName: string, id: string, push: boolean) {
  return {
    id,
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    private: true,
    visibility: "private",
    archived: false,
    disabled: false,
    default_branch: "main",
    permissions: { pull: true, triage: false, push, maintain: false, admin: false },
  };
}

async function fixture(options: { offered?: boolean; mcpServers?: Settings["mcpServers"] } = {}) {
  const db = client!.db;
  const settings: Settings = testSettings({
    productAccessMode: "managed",
    sandboxBackend: "none",
    githubRestMcpEnabled: options.offered ?? true,
    githubPersonalOauthEnabled: true,
    githubPersonalAllRepositoriesEnabled: true,
    githubPersonalOauthClientId: "Ov23app-viewer-client",
    githubPersonalOauthClientSecret: "app-viewer-client-secret",
    integrationsEnabled: true,
    integrationsStateSecret: "app-viewer-personal-github-state",
    environmentsEncryptionKey: Buffer.alloc(32, 23).toString("base64"),
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
  });
  const key = environmentsEncryptionKeyBytes(settings)!;
  const ownerUser = `app-viewer-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(db, {
    userId: ownerUser,
    email: `${ownerUser}@example.test`,
    name: "App owner",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}, 'Deployments') returning id
  `;
  const workspaceId = workspace!.id;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspaceId}, ${accountId})
  `;
  const member = async (subjectId: string, organization: boolean) => {
    if (organization) {
      const [personal] = await shared!.admin<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${accountId}, 'Personal') returning id
      `;
      await shared!.admin`
        insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
        values (${accountId}, ${subjectId}, 'active', ${personal!.id})
      `;
    }
    await shared!.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, permissions)
      values (${accountId}, ${workspaceId}, ${subjectId}, ${JSON.stringify(PERMISSIONS)}::jsonb)
    `;
    const grant: AccessGrant = {
      accountId,
      workspaceId,
      subjectId,
      permissions: PERMISSIONS,
      principalKind: "human_session",
    };
    const authorization = accessGrantAuthorizationFromContext(
      {
        mode: "managed",
        subjectId,
        accountGrants: [{ accountId, subjectId, permissions: [] }],
        workspaceGrants: [grant],
        defaultAccountId: accountId,
        defaultWorkspaceId: workspaceId,
      },
      grant,
    );
    authorization.canonicalManagedHumanSession = true;
    return { subjectId, grant, authorization };
  };
  const owner = await member(`user:${ownerUser}`, false);
  const colleague = await member(`user:colleague-${crypto.randomUUID()}`, true);
  const carol = await member(`user:carol-${crypto.randomUUID()}`, true);

  /** Connects Your GitHub for `who` in this workspace with All my repositories. */
  const connectYourGitHub = async (
    who: { subjectId: string },
    login: string,
    token: string,
    allRepositories: "read" | "write",
  ) => {
    const credentialBindingId = crypto.randomUUID();
    const principal = String(1_000_000 + Math.floor(Math.random() * 1_000_000));
    const now = new Date().toISOString();
    const connection = await persistProviderOAuthConnection(db, {
      accountId,
      workspaceId,
      subjectId: who.subjectId,
      visibleToSubjectId: who.subjectId,
      providerDomain: "github.com",
      kind: "oauth2",
      status: "active",
      credentialEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({ access_token: token, token_type: "Bearer", scope: "repo" }),
      ),
      grantedScopes: ["repo"],
      expiresAt: null,
      metadata: {
        credentialRole: "opengeni_github_personal",
        providerFamily: "github",
        providerPrincipalId: principal,
        githubUserId: principal,
        githubLogin: login,
        oauthEnvironment: settings.environment,
        oauthClientMarker: "a".repeat(32),
        credentialBindingId,
        connectedAt: now,
        lastVerifiedAt: now,
      },
      createdBySubjectId: who.subjectId,
      updatedBySubjectId: who.subjectId,
      credentialRole: "opengeni_github_personal",
      providerFamily: "github",
      providerPrincipalId: principal,
      requireLiveUserAuthority: true,
      requiredLiveUserPermission: "connections:write",
      exclusiveProviderPrincipalPerOwner: true,
    });
    if (!connection?.authorityId) throw new Error("personal GitHub connection was not created");
    const choose = async (all: "read" | "write" | null) => {
      const state = await getPersonalGitHubRepositorySelectionState(db, {
        accountId,
        originWorkspaceId: workspaceId,
        subjectId: who.subjectId,
        connectionId: connection.id,
      });
      if (!state) throw new Error("repository selection head was not created");
      await replacePersonalGitHubRepositorySelections(db, {
        accountId,
        originWorkspaceId: workspaceId,
        subjectId: who.subjectId,
        connectionId: connection.id,
        expectedConnectionAuthorityGeneration: state.connectionAuthorityGeneration,
        expectedSelectionGeneration: state.selectionGeneration,
        idempotencyKey: crypto.randomUUID(),
        allRepositoriesAccess: all,
        repositories: [],
      });
    };
    await choose(allRepositories);
    return { connectionId: connection.id, choose };
  };

  const created = await createWorkspaceArtifact(db, {
    accountId,
    workspaceId,
    artifactId: crypto.randomUUID(),
    slug: `deployments-${crypto.randomUUID().slice(0, 8)}`,
    title: "Deployments",
    description: null,
    visibility: "workspace_shared",
    ownerSubjectId: owner.subjectId,
    contentKey: `workspace-artifacts/${workspaceId}/deployments/index.html`,
    contentSha256: "d".repeat(64),
    sizeBytes: 64,
    sourceKey: null,
    sourceSha256: null,
    sourceSizeBytes: null,
    requestedTools: [tool],
    operationKey: `deployments-${crypto.randomUUID()}`,
    actorSubjectId: owner.subjectId,
    sourceSessionId: null,
    sourceTurnId: null,
    sourceAttemptId: null,
    sourceExecutionGeneration: null,
    sourceToolName: null,
    persistContent: async () => undefined,
    discardContent: async () => undefined,
  });
  const site = { siteArtifactId: created.artifact.id, siteVersionId: created.version.id };

  // A fake GitHub: answers each token only for what that person can reach.
  const github: Array<{ path: string; authorization: string | null }> = [];
  const reachable: Record<string, Record<string, unknown>> = {
    "Bearer owner-token": repositoryJson("Cloudgeni-ai/opengeni-ops", "4242", true),
    "Bearer carol-token": repositoryJson("Cloudgeni-ai/opengeni-ops", "4242", false),
  };
  const githubPersonalFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    github.push({ path: url.pathname, authorization });
    const repository = authorization ? reachable[authorization] : undefined;
    if (!repository) return new Response("{}", { status: 404 });
    if (
      url.pathname === "/repos/Cloudgeni-ai/opengeni-ops" ||
      url.pathname === "/repositories/4242"
    )
      return Response.json(repository);
    if (url.pathname === "/repos/Cloudgeni-ai/opengeni-ops/actions/runs")
      return Response.json({
        total_count: 1,
        workflow_runs: [
          {
            id: 777,
            name: `deploy for ${authorization}`,
            display_title: "staging-canary:abc",
            status: "completed",
            conclusion: "success",
            event: "workflow_dispatch",
            head_branch: "main",
            head_sha: "a".repeat(40),
            run_number: 9,
            run_attempt: 1,
            html_url: "https://github.com/Cloudgeni-ai/opengeni-ops/actions/runs/777",
            created_at: "2026-11-22T10:00:00Z",
            updated_at: "2026-11-22T10:05:00Z",
          },
        ],
      });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const deps = { db, settings, githubPersonalFetch } as unknown as ApiRouteDeps;
  const readiness = async (who: { authorization: AccessGrantAuthorization }) =>
    await describeWorkspaceSiteToolReadiness(
      deps,
      who.authorization,
      { ...site, targets: [{ identity: tool }] },
      human,
    );
  const invoke = async (who: { authorization: AccessGrantAuthorization }) =>
    await invokeWorkspaceToolTarget(
      deps,
      who.authorization,
      {
        ...site,
        target: { identity: tool },
        operationId: crypto.randomUUID(),
        arguments: { repository: "Cloudgeni-ai/opengeni-ops", limit: 1 },
      } as Parameters<typeof invokeWorkspaceToolTarget>[2],
      human,
    );
  return {
    db,
    deps,
    settings,
    accountId,
    workspaceId,
    owner,
    colleague,
    carol,
    site,
    github,
    connectYourGitHub,
    readiness,
    invoke,
  };
}

const failure = async (promise: Promise<unknown>) =>
  (await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )) as
    | { status?: number; message?: string; code?: string; details?: { code?: string } }
    | undefined;

describe("Your GitHub tools in an app", () => {
  test("each viewer is ready on their own GitHub account and runs the tool as themselves", async () => {
    if (!shared) return;
    const f = await fixture();
    await f.connectYourGitHub(f.owner, "benyhh", "owner-token", "write");
    await f.connectYourGitHub(f.carol, "carol-gh", "carol-token", "read");

    expect((await f.readiness(f.owner)).tools[0]).toMatchObject({
      state: "ready",
      runsAs: { connector: "Your GitHub", account: "benyhh", shared: false },
    });
    expect((await f.readiness(f.carol)).tools[0]).toMatchObject({
      state: "ready",
      runsAs: { connector: "Your GitHub", account: "carol-gh", shared: false },
    });

    const own = JSON.stringify(await f.invoke(f.owner));
    expect(own).toContain("deploy for Bearer owner-token");
    const carols = JSON.stringify(await f.invoke(f.carol));
    expect(carols).toContain("deploy for Bearer carol-token");
    expect(carols).not.toContain("owner-token");
    // Every GitHub request carried the caller's own token, never another's.
    expect(f.github.length).toBeGreaterThan(0);
    expect(
      f.github.every(
        (request) =>
          request.authorization === "Bearer owner-token" ||
          request.authorization === "Bearer carol-token",
      ),
    ).toBe(true);
  });

  test("a viewer without Your GitHub is offered Connect and can't run it on someone else's", async () => {
    if (!shared) return;
    const f = await fixture();
    await f.connectYourGitHub(f.owner, "benyhh", "owner-token", "write");
    expect((await f.readiness(f.colleague)).tools[0]).toMatchObject({
      state: "connect",
      connector: "Your GitHub",
    });
    const setup = await describeWorkspaceSiteToolSetup(
      f.deps,
      f.colleague.authorization,
      f.site,
      human,
    );
    expect(setup.items).toEqual([
      expect.objectContaining({
        action: "connect",
        connector: "Your GitHub",
        capabilityId: "api:github-personal",
        tools: [tool],
      }),
    ]);
    const refused = await failure(f.invoke(f.colleague));
    expect(refused).toBeDefined();
    expect(JSON.stringify(refused)).toContain("site_tool_connection_required");
    expect(f.github).toEqual([]);
  });

  test("switching All my repositories off stops it at once", async () => {
    if (!shared) return;
    const f = await fixture();
    const yours = await f.connectYourGitHub(f.owner, "benyhh", "owner-token", "write");
    expect((await f.readiness(f.owner)).tools[0]).toMatchObject({ state: "ready" });
    await yours.choose(null);
    expect((await f.readiness(f.owner)).tools[0]).toMatchObject({ state: "connect" });
    expect(await failure(f.invoke(f.owner))).toBeDefined();
    expect(f.github).toEqual([]);
  });

  test("the person's GitHub action choices apply", async () => {
    if (!shared) return;
    const f = await fixture();
    const yours = await f.connectYourGitHub(f.owner, "benyhh", "owner-token", "write");
    await updateConnectorToolPermissionPolicies(f.db, {
      ...f.owner.grant,
      connectionId: yours.connectionId,
      serverId: tool.serverId,
      toolNames: [tool.toolName],
      policy: "block",
    });
    expect((await f.readiness(f.owner)).tools[0]).toMatchObject({ state: "blocked" });
    expect(await failure(f.invoke(f.owner))).toBeDefined();
    expect(f.github).toEqual([]);
  });

  test("a connection GitHub stopped accepting is offered Reconnect, not Connect", async () => {
    if (!shared) return;
    const f = await fixture();
    const yours = await f.connectYourGitHub(f.owner, "benyhh", "owner-token", "write");
    await shared.admin`update connections set status = 'needs_reauth' where id = ${yours.connectionId}`;
    expect((await f.readiness(f.owner)).tools[0]).toMatchObject({ state: "reconnect" });
    const setup = await describeWorkspaceSiteToolSetup(
      f.deps,
      f.owner.authorization,
      f.site,
      human,
    );
    expect(setup.items).toEqual([
      expect.objectContaining({
        action: "reconnect",
        connector: "Your GitHub",
        capabilityId: "api:github-personal",
        connectionId: yours.connectionId,
        account: "benyhh",
        shared: false,
      }),
    ]);
    expect(await failure(f.invoke(f.owner))).toBeDefined();
    expect(f.github).toEqual([]);
  });

  test("a configured server with the reserved id stays as configured", async () => {
    if (!shared) return;
    const f = await fixture({
      mcpServers: [{ id: "github_personal", name: "Configured", url: "https://mcp.example.test/" }],
    });
    await f.connectYourGitHub(f.owner, "benyhh", "owner-token", "write");
    const inventory = await readSiteToolAccountInventory(f.deps, f.owner.grant);
    expect(inventory.canonical.get("github_personal")?.name).not.toBe("Your GitHub");
    expect(inventory.accounts.some((account) => account.connector === "Your GitHub")).toBe(false);
    await failure(f.invoke(f.owner));
    expect(f.github).toEqual([]);
  });

  test("only viewers who have Your GitHub may read the app's stored GitHub data", async () => {
    if (!shared) return;
    const f = await fixture();
    await f.connectYourGitHub(f.owner, "benyhh", "owner-token", "write");
    const scope = { accountId: f.accountId, workspaceId: f.workspaceId };
    const target = siteToolDataTarget("collection", "runs");
    // A former sync stored github_personal data in "runs".
    await markToolData(f.deps, scope, f.site.siteArtifactId, [
      { target, connector: "github_personal", route: "github_personal", shared: false },
    ]);
    const read = (subjectId: string) =>
      requireToolDataReader(f.deps, {
        scope,
        siteId: f.site.siteArtifactId,
        target,
        reader: { subjectId },
      });
    await read(f.owner.subjectId);
    const refused = await failure(read(f.colleague.subjectId));
    expect(refused).toBeDefined();
    expect(JSON.stringify(refused)).toContain("restricted_tool_data");
    expect(refused?.message).toContain("Your GitHub");
  });

  test("only a person's own grant gets it, and only where the deployment offers it", async () => {
    if (!shared) return;
    const f = await fixture();
    const yours = await f.connectYourGitHub(f.owner, "benyhh", "owner-token", "write");
    const read = (grant: AccessGrant, settings: Settings = f.settings) =>
      readPersonalGitHubToolsAuthority(f.db, settings, grant);
    expect(await read(f.owner.grant)).toMatchObject({
      subjectId: f.owner.subjectId,
      connectionId: yours.connectionId,
      login: "benyhh",
      access: "write",
    });
    expect(await read(f.colleague.grant)).toBeNull();
    expect(await read({ ...f.owner.grant, principalKind: "service" })).toBeNull();
    expect(await read({ ...f.owner.grant, principalKind: "agent_attempt" })).toBeNull();
    expect(
      await read({
        ...f.owner.grant,
        metadata: { sessionId: crypto.randomUUID(), turnId: crypto.randomUUID() },
      }),
    ).toBeNull();
    expect(await read({ ...f.owner.grant, metadata: { delegated: true } })).toBeNull();
    expect(await read(f.owner.grant, { ...f.settings, githubRestMcpEnabled: false })).toBeNull();
    // Without it the app offers no Your GitHub connector at all.
    const off = await fixture({ offered: false });
    const inventory = await readSiteToolAccountInventory(off.deps, off.owner.grant);
    expect(inventory.canonical.has("github_personal")).toBe(false);
  });
});
