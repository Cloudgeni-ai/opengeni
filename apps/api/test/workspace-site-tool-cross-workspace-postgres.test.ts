// opengeni:test-shared-postgres-exclusive
// A person's own account added in one workspace and turned on in another
// ("Use it here"): a Site in the second workspace resolves, confirms and runs
// its tools on that account, on real PostgreSQL under row-level security.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  accessGrantAuthorizationFromContext,
  turnOnOwnLoginHere,
  type ApiRouteDeps,
} from "@opengeni/core";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  bootstrapWorkspace,
  createConnection,
  createDb,
  createOrganizationApiKey,
  createWorkspaceArtifact,
  encryptEnvironmentValue,
  getConnectionMetadata,
  registerDbBinding,
  revokeSelfUserResourceGrant,
  updateConnectorToolPermissionPolicies,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";
import {
  approveWorkspaceToolTarget,
  describeWorkspaceSiteToolConsent,
  describeWorkspaceSiteToolReadiness,
  invokeWorkspaceToolTarget,
  resolveWorkspaceToolTarget,
  type TargetGatewayOptions,
} from "../src/workspace-tool-target";

const encryptionKey = randomBytes(32).toString("base64");
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("site-tool-cross-workspace");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("Real PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl);
  registerDbBinding(client.db, { rlsStrategy: "force" });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

const human: TargetGatewayOptions = { reauthorize: async () => undefined };

async function fixture() {
  const db = client!.db;
  const suffix = crypto.randomUUID();
  const subjectId = `human:${suffix}`;
  const home = await bootstrapWorkspace(db, {
    accountExternalSource: "site-tool-cross-workspace",
    accountExternalId: suffix,
    accountName: "Cross-workspace accounts",
    workspaceExternalSource: "site-tool-cross-workspace",
    workspaceExternalId: `${suffix}:home`,
    workspaceName: "Home",
    subjectId,
  });
  const here = await bootstrapWorkspace(db, {
    accountExternalSource: "site-tool-cross-workspace",
    accountExternalId: suffix,
    accountName: "Cross-workspace accounts",
    workspaceExternalSource: "site-tool-cross-workspace",
    workspaceExternalId: `${suffix}:here`,
    workspaceName: "Here",
    subjectId,
  });
  const homeGrant = home.workspaceGrants[0]!;
  const grant = here.workspaceGrants.find((entry) => entry.workspaceId !== homeGrant.workspaceId)!;
  expect(grant.accountId).toBe(homeGrant.accountId);
  let effects = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const mcp = new McpServer({ name: "cross-workspace", version: "1.0.0" });
      mcp.registerTool("create_item", { inputSchema: { title: z.string() } }, async () => {
        effects++;
        return { content: [{ type: "text", text: "created" }] };
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      return transport.handleRequest(request);
    },
  });
  const canonical = { serverId: "tracker", toolName: "create_item" };
  const settings = testSettings({
    productAccessMode: "configured",
    environmentsEncryptionKey: encryptionKey,
    mcpServers: [
      {
        id: "tracker",
        url: `${provider.url}mcp`,
        cacheToolsList: false,
        allowedTools: ["create_item"],
        connectionRef: {
          providerDomain: "127.0.0.1",
          kind: "api_key",
          subjectScope: "subject",
          accountSelection: "all_eligible",
        },
      },
    ],
  });
  // A personal account belongs to the person's organization membership; it
  // was added in their Personal workspace.
  await shared!.admin`
    insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
    values (${grant.accountId}, ${subjectId}, 'active', ${homeGrant.workspaceId})
  `;
  // Added in the home workspace, as the person's own account.
  const connection = await createConnection(db, {
    accountId: homeGrant.accountId,
    workspaceId: homeGrant.workspaceId,
    subjectId,
    providerDomain: "127.0.0.1",
    kind: "api_key",
    credentialEncrypted: encryptEnvironmentValue(
      environmentsEncryptionKeyBytes(settings)!,
      JSON.stringify({ headers: { authorization: "Bearer cross-workspace" } }),
    ),
    metadata: { displayName: "ada@example.com" },
    createdBySubjectId: subjectId,
  });
  const authorityId = (await getConnectionMetadata(
    db,
    homeGrant.workspaceId,
    connection.id,
    subjectId,
  ))!.authorityId!;
  const artifactId = crypto.randomUUID();
  const created = await createWorkspaceArtifact(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    artifactId,
    slug: `cross-site-${artifactId.slice(0, 8)}`,
    title: "Cross-workspace Site",
    description: null,
    visibility: "workspace_shared",
    ownerSubjectId: subjectId,
    contentKey: `workspace-artifacts/${grant.workspaceId}/${artifactId}/index.html`,
    contentSha256: "c".repeat(64),
    sizeBytes: 64,
    sourceKey: null,
    sourceSha256: null,
    sourceSizeBytes: null,
    requestedTools: [canonical],
    operationKey: `cross-site-${artifactId}`,
    actorSubjectId: subjectId,
    sourceSessionId: null,
    sourceTurnId: null,
    sourceAttemptId: null,
    sourceExecutionGeneration: null,
    sourceToolName: null,
    persistContent: async () => undefined,
    discardContent: async () => undefined,
  });
  const authorization = accessGrantAuthorizationFromContext(here, grant);
  authorization.canonicalManagedHumanSession = true;
  const site = { siteArtifactId: created.artifact.id, siteVersionId: created.version.id };
  const deps = { db, settings } as ApiRouteDeps;
  return {
    db,
    suffix,
    grant,
    homeGrant,
    settings,
    authorityId,
    subjectId,
    connection,
    canonical,
    site,
    deps,
    authorization,
    provider,
    effects: () => effects,
    turnOn: async () =>
      await turnOnOwnLoginHere(db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId,
        authorityId,
      }),
    setPolicy: (policy: "allow" | "ask") =>
      updateConnectorToolPermissionPolicies(db, {
        ...grant,
        connectionId: connection.id,
        serverId: "tracker",
        toolNames: ["create_item"],
        policy,
      }),
  };
}

describe("Site tools on an account turned on from another workspace", () => {
  test("off here, the Site can't use it; turned on, it resolves, confirms and runs once", async () => {
    if (!shared) return;
    const f = await fixture();
    try {
      const readiness = async () =>
        (
          await describeWorkspaceSiteToolReadiness(
            f.deps,
            f.authorization,
            { ...f.site, targets: [{ identity: f.canonical }] },
            human,
          )
        ).tools[0]!;
      const resolve = () =>
        resolveWorkspaceToolTarget(
          f.deps,
          f.authorization,
          { ...f.site, target: { identity: f.canonical } },
          human,
        );
      // Not turned on here: nothing routes to it.
      expect((await readiness()).state).not.toBe("ready");
      await expect(resolve()).rejects.toMatchObject({
        details: { code: "site_tool_connection_required" },
      });

      await f.turnOn();
      await f.setPolicy("ask");
      expect(await readiness()).toMatchObject({
        state: "confirm",
        runsAs: { account: "ada@example.com" },
      });
      const resolved = await resolve();
      expect(resolved.entry.identity.toolName).toBe("create_item");

      const consent = await describeWorkspaceSiteToolConsent(
        f.deps,
        f.authorization,
        { identity: f.canonical, ...f.site, arguments: { title: "Hello" } },
        human,
      );
      expect(consent.connect).toBeNull();
      expect(consent.accounts).toHaveLength(1);
      expect(consent.accounts[0]).toMatchObject({
        account: "ada@example.com",
        connectionId: f.connection.id,
      });
      const route = consent.accounts[0]!.identity;

      // Ask first: invoking without a confirmation runs nothing.
      const operationId = crypto.randomUUID();
      await expect(
        invokeWorkspaceToolTarget(
          f.deps,
          f.authorization,
          { ...f.site, target: { identity: route }, operationId, arguments: { title: "Hello" } },
          human,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(f.effects()).toBe(0);

      const approved = await approveWorkspaceToolTarget(
        f.deps,
        f.authorization,
        {
          identity: route,
          ...f.site,
          operationId,
          arguments: { title: "Hello" },
          expectedDefinitionDigest: resolved.definitionDigest,
        },
        human,
      );
      const called = await invokeWorkspaceToolTarget(
        f.deps,
        f.authorization,
        {
          ...f.site,
          target: { identity: route },
          operationId,
          arguments: { title: "Hello" },
          approvalToken: approved.approvalToken,
        },
        human,
      );
      expect(called.result.isError).not.toBe(true);
      expect(f.effects()).toBe(1);
    } finally {
      f.provider.stop(true);
    }
  }, 120_000);

  const readinessOf = async (f: Awaited<ReturnType<typeof fixture>>) =>
    (
      await describeWorkspaceSiteToolReadiness(
        f.deps,
        f.authorization,
        { ...f.site, targets: [{ identity: f.canonical }] },
        human,
      )
    ).tools[0]!;
  const resolveAs = (f: Awaited<ReturnType<typeof fixture>>) =>
    resolveWorkspaceToolTarget(
      f.deps,
      f.authorization,
      { ...f.site, target: { identity: f.canonical } },
      human,
    );
  const credential = (f: Awaited<ReturnType<typeof fixture>>, token: string) =>
    encryptEnvironmentValue(
      environmentsEncryptionKeyBytes(f.settings)!,
      JSON.stringify({ headers: { authorization: `Bearer ${token}` } }),
    );

  test("another member's account turned on here is never the viewer's", async () => {
    if (!shared) return;
    const f = await fixture();
    try {
      // Another member of this workspace, with an account of their own added
      // in their own workspace and turned on here.
      const other = `human:${crypto.randomUUID()}`;
      const workspace = (key: string, name: string) =>
        bootstrapWorkspace(f.db, {
          accountExternalSource: "site-tool-cross-workspace",
          accountExternalId: f.suffix,
          accountName: "Cross-workspace accounts",
          workspaceExternalSource: "site-tool-cross-workspace",
          workspaceExternalId: `${f.suffix}:${key}`,
          workspaceName: name,
          subjectId: other,
        });
      const theirHome = (await workspace("their-home", "Their home")).workspaceGrants.find(
        (entry) =>
          entry.workspaceId !== f.grant.workspaceId &&
          entry.workspaceId !== f.homeGrant.workspaceId,
      )!;
      const theirHere = await workspace("here", "Here");
      await shared!.admin`
        insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
        values (${f.grant.accountId}, ${other}, 'active', ${theirHome.workspaceId})
      `;
      const theirs = await createConnection(f.db, {
        accountId: theirHome.accountId,
        workspaceId: theirHome.workspaceId,
        subjectId: other,
        providerDomain: "127.0.0.1",
        kind: "api_key",
        credentialEncrypted: credential(f, "theirs"),
        metadata: { displayName: "bob@example.com" },
        createdBySubjectId: other,
      });
      const theirAuthority = (await getConnectionMetadata(
        f.db,
        theirHome.workspaceId,
        theirs.id,
        other,
      ))!.authorityId!;
      await turnOnOwnLoginHere(f.db, {
        accountId: f.grant.accountId,
        workspaceId: f.grant.workspaceId,
        subjectId: other,
        authorityId: theirAuthority,
      });
      expect((await readinessOf(f)).state).toBe("connect");
      await expect(resolveAs(f)).rejects.toMatchObject({
        details: { code: "site_tool_connection_required" },
      });
      expect(f.effects()).toBe(0);
      // It is turned on here: its owner's own Site call resolves to it.
      const theirAuthorization = accessGrantAuthorizationFromContext(
        theirHere,
        theirHere.workspaceGrants.find((entry) => entry.workspaceId === f.grant.workspaceId)!,
      );
      theirAuthorization.canonicalManagedHumanSession = true;
      const theirConsent = await describeWorkspaceSiteToolConsent(
        f.deps,
        theirAuthorization,
        { identity: f.canonical, ...f.site, arguments: { title: "Hello" } },
        human,
      );
      expect(theirConsent.accounts.map((account) => account.connectionId)).toEqual([theirs.id]);
    } finally {
      f.provider.stop(true);
    }
  }, 120_000);

  test("another workspace's shared account is never used here", async () => {
    if (!shared) return;
    const f = await fixture();
    try {
      await createConnection(f.db, {
        accountId: f.homeGrant.accountId,
        workspaceId: f.homeGrant.workspaceId,
        subjectId: null,
        providerDomain: "127.0.0.1",
        kind: "api_key",
        credentialEncrypted: credential(f, "home-shared"),
        metadata: { displayName: "Home team" },
        createdBySubjectId: f.subjectId,
      });
      expect((await readinessOf(f)).state).toBe("connect");
      await expect(resolveAs(f)).rejects.toMatchObject({
        details: { code: "site_tool_connection_required" },
      });
    } finally {
      f.provider.stop(true);
    }
  }, 120_000);

  test("an organization service key reaches no personal account", async () => {
    if (!shared) return;
    const f = await fixture();
    try {
      await f.turnOn();
      await f.setPolicy("allow");
      const bearer = `ogk_cross_${crypto.randomUUID().replaceAll("-", "")}`;
      await createOrganizationApiKey(f.db, {
        accountId: f.grant.accountId,
        name: "Cross-workspace key",
        prefix: bearer.slice(0, 12),
        keyHash: createHash("sha256").update(bearer).digest("hex"),
        permissions: ["workspace:read"],
      });
      const app = createApp({
        settings: f.settings,
        db: f.db,
        bus: {} as never,
        workflowClient: {} as never,
        objectStorage: null,
      } as never);
      const post = async (operation: string, body: unknown) =>
        await app.request(
          `http://localhost/v1/workspaces/${f.grant.workspaceId}/tools/${operation}`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
      const resolved = await post("resolve", { ...f.site, target: { identity: f.canonical } });
      // A service key has no personal accounts, here or anywhere.
      expect(resolved.status).toBe(409);
      expect(await resolved.json()).toMatchObject({
        error: { details: { code: "site_tool_connection_required" } },
      });
      const invoked = await post("invoke", {
        ...f.site,
        target: { identity: f.canonical },
        operationId: crypto.randomUUID(),
        arguments: { title: "Hello" },
      });
      expect(invoked.status).toBe(409);
      expect(await invoked.json()).toMatchObject({
        error: { details: { code: "site_tool_connection_required" } },
      });
      expect(f.effects()).toBe(0);
    } finally {
      f.provider.stop(true);
    }
  }, 120_000);

  test("an account turned off here after preparation is refused before it runs", async () => {
    if (!shared) return;
    const f = await fixture();
    try {
      await f.turnOn();
      await f.setPolicy("ask");
      const resolved = await resolveAs(f);
      const consent = await describeWorkspaceSiteToolConsent(
        f.deps,
        f.authorization,
        { identity: f.canonical, ...f.site, arguments: { title: "Hello" } },
        human,
      );
      const route = consent.accounts[0]!.identity;
      const operationId = crypto.randomUUID();
      const approved = await approveWorkspaceToolTarget(
        f.deps,
        f.authorization,
        {
          identity: route,
          ...f.site,
          operationId,
          arguments: { title: "Hello" },
          expectedDefinitionDigest: resolved.definitionDigest,
        },
        human,
      );
      // Turned off here between the confirmation and the call.
      const [grantRow] = await shared!.admin<Array<{ id: string }>>`
        select id from organization_user_resource_grants
        where workspace_id = ${f.grant.workspaceId} and authority_id = ${f.authorityId}
          and status = 'active'
      `;
      await revokeSelfUserResourceGrant(f.db, {
        accountId: f.grant.accountId,
        workspaceId: f.grant.workspaceId,
        subjectId: f.subjectId,
        grantId: grantRow!.id,
      });
      const refused = await invokeWorkspaceToolTarget(
        f.deps,
        f.authorization,
        {
          ...f.site,
          target: { identity: route },
          operationId,
          arguments: { title: "Hello" },
          approvalToken: approved.approvalToken,
        },
        human,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      // The fence re-reads the account's authority at the call.
      expect(refused).toMatchObject({ status: 403, message: "site_tool_not_authorized" });
      expect(f.effects()).toBe(0);
    } finally {
      f.provider.stop(true);
    }
  }, 120_000);
});
