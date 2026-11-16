// opengeni:test-shared-postgres-exclusive
// What a Site's tools need for this viewer, and its reset, on real PostgreSQL:
// saved permissions, "Always allow on this Site" and its reset read the real
// tables under row-level security, and an unreachable provider is a typed 503.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { accessGrantAuthorizationFromContext, type ApiRouteDeps } from "@opengeni/core";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  bootstrapWorkspace,
  createConnection,
  createDb,
  createOrganizationApiKey,
  createWorkspaceArtifact,
  encryptEnvironmentValue,
  listSiteToolAllowances,
  recordSiteToolAllowance,
  registerDbBinding,
  updateConnectorToolPermissionPolicies,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";
import {
  describeWorkspaceSiteToolReadiness,
  invokeWorkspaceToolTarget,
  resetWorkspaceSiteToolAllowances,
  type TargetGatewayOptions,
} from "../src/workspace-tool-target";

const encryptionKey = randomBytes(32).toString("base64");
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("site-tool-readiness");
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

/** A connector whose server refuses connections: nothing is ever sent. */
const unreachableUrl = "http://127.0.0.1:9/mcp";
const canonical = { serverId: "grafana", toolName: "search_documents" };
const human: TargetGatewayOptions = { reauthorize: async () => undefined };

/** A connector (and the one account serving it) other than the default. */
type FixtureConnector = {
  server: ReturnType<typeof testSettings>["mcpServers"][number];
  tool: typeof canonical;
  providerDomain: string;
  kind: "api_key" | "oauth2";
  grantedScopes?: string[];
  metadata: Record<string, unknown>;
};

async function fixture(connector?: FixtureConnector) {
  const tool = connector?.tool ?? canonical;
  const db = client!.db;
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "site-tool-readiness",
    accountExternalId: suffix,
    accountName: "Site tool readiness",
    workspaceExternalSource: "site-tool-readiness",
    workspaceExternalId: suffix,
    workspaceName: "Site tool readiness",
    subjectId: `human:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const settings = testSettings({
    productAccessMode: "configured",
    environmentsEncryptionKey: encryptionKey,
    mcpServers: [
      connector?.server ?? {
        id: "grafana",
        url: unreachableUrl,
        cacheToolsList: false,
        allowedTools: ["search_documents"],
        connectionRef: {
          providerDomain: "127.0.0.1",
          kind: "api_key",
          accountSelection: "all_eligible",
        },
      },
    ],
  });
  const connection = await createConnection(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    providerDomain: connector?.providerDomain ?? "127.0.0.1",
    kind: connector?.kind ?? "api_key",
    ...(connector?.grantedScopes ? { grantedScopes: connector.grantedScopes } : {}),
    credentialEncrypted: encryptEnvironmentValue(
      environmentsEncryptionKeyBytes(settings)!,
      JSON.stringify({ headers: { authorization: "Bearer readiness-token" } }),
    ),
    metadata: connector?.metadata ?? { displayName: "Shared Grafana" },
    createdBySubjectId: grant.subjectId,
  });
  const artifactId = crypto.randomUUID();
  const created = await createWorkspaceArtifact(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    artifactId,
    slug: `readiness-site-${artifactId.slice(0, 8)}`,
    title: "Readiness Site",
    description: null,
    visibility: "workspace_shared",
    ownerSubjectId: grant.subjectId,
    contentKey: `workspace-artifacts/${grant.workspaceId}/${artifactId}/index.html`,
    contentSha256: "e".repeat(64),
    sizeBytes: 64,
    sourceKey: null,
    sourceSha256: null,
    sourceSizeBytes: null,
    requestedTools: [tool],
    operationKey: `readiness-site-${artifactId}`,
    actorSubjectId: grant.subjectId,
    sourceSessionId: null,
    sourceTurnId: null,
    sourceAttemptId: null,
    sourceExecutionGeneration: null,
    sourceToolName: null,
    persistContent: async () => undefined,
    discardContent: async () => undefined,
  });
  const authorization = accessGrantAuthorizationFromContext(access, grant);
  authorization.canonicalManagedHumanSession = true;
  const site = { siteArtifactId: created.artifact.id, siteVersionId: created.version.id };
  const deps = { db, settings } as ApiRouteDeps;
  const readiness = async () =>
    (
      await describeWorkspaceSiteToolReadiness(
        deps,
        authorization,
        { ...site, targets: [{ identity: tool }] },
        human,
      )
    ).tools[0]!;
  const setPolicy = (policy: "allow" | "ask" | "block" | null) =>
    updateConnectorToolPermissionPolicies(db, {
      ...grant,
      connectionId: connection.id,
      serverId: tool.serverId,
      toolNames: [tool.toolName],
      policy,
    });
  return { db, grant, settings, connection, site, deps, authorization, readiness, setPolicy };
}

describe("Site tool readiness on PostgreSQL", () => {
  test("an account whose access is fixed reports a tool it lacks access for as unavailable for it", async () => {
    if (!client) return;
    // A connector served by a first-party bridge that gates tools on the
    // account's recorded grants, with an account allowed to read only.
    const gmail = (metadata: Record<string, unknown>): FixtureConnector => ({
      server: {
        id: "gmail",
        url: "https://gmailmcp.googleapis.com/mcp/v1",
        cacheToolsList: false,
        allowedTools: ["create_draft"],
        connectionRef: {
          providerDomain: "gmailmcp.googleapis.com",
          kind: "oauth2",
          accountSelection: "all_eligible",
        },
      },
      tool: { serverId: "gmail", toolName: "create_draft" },
      providerDomain: "gmailmcp.googleapis.com",
      kind: "oauth2",
      grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      metadata,
    });
    const native = await fixture(gmail({ displayName: "Mail" }));
    const grant = await native.readiness();
    expect(grant).toMatchObject({ state: "grant" });
    expect(grant.scopes?.length).toBeGreaterThan(0);
    const nango = await fixture(gmail({ displayName: "Mail", integrationBackend: "nango" }));
    const fixed = await nango.readiness();
    expect(fixed).toMatchObject({ state: "unavailable", unavailableReason: "account" });
    expect(fixed.scopes).toBeUndefined();
  });
  test("follows saved permissions, Always allow and its reset without reaching the provider", async () => {
    if (!shared) return;
    const f = await fixture();
    // No saved choice: it runs as the workspace's shared account; the provider may still ask.
    expect(await f.readiness()).toMatchObject({
      target: { identity: canonical },
      state: "ready",
      confirm: "maybe",
      runsAs: { account: "Shared Grafana", shared: true },
    });

    await f.setPolicy("ask");
    expect(await f.readiness()).toMatchObject({ state: "confirm", confirm: "always" });

    await recordSiteToolAllowance(f.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      subjectId: f.grant.subjectId,
      siteId: f.site.siteArtifactId,
      serverId: "grafana",
      toolName: "search_documents",
      connectionId: f.connection.id,
    });
    expect(await f.readiness()).toMatchObject({ state: "ready", confirm: "remembered" });

    expect(await resetWorkspaceSiteToolAllowances(f.deps, f.authorization, f.site, human)).toEqual({
      version: 1,
      removed: 1,
    });
    expect(
      await listSiteToolAllowances(f.db, {
        workspaceId: f.grant.workspaceId,
        subjectId: f.grant.subjectId,
        siteId: f.site.siteArtifactId,
      }),
    ).toEqual([]);
    expect(await f.readiness()).toMatchObject({ state: "confirm", confirm: "always" });

    await f.setPolicy("block");
    expect(await f.readiness()).toMatchObject({ state: "blocked" });
  }, 120_000);

  test("an unreachable provider is a typed, retryable 503 on invoke", async () => {
    if (!shared) return;
    const f = await fixture();
    await f.setPolicy("allow");
    const attempt = invokeWorkspaceToolTarget(
      f.deps,
      f.authorization,
      {
        ...f.site,
        target: { identity: canonical },
        operationId: crypto.randomUUID(),
        arguments: { query: "up" },
      } as Parameters<typeof invokeWorkspaceToolTarget>[2],
      human,
    );
    const error = (await attempt.then(
      () => undefined,
      (caught: unknown) => caught,
    )) as { status?: number; code?: string; details?: { code?: string } } | undefined;
    expect(error?.status).toBe(503);
    expect(error?.code).toBe("upstream_unavailable");
    expect(error?.details?.code).toBe("tool_server_unreachable");
  }, 120_000);

  test("the routes answer readiness and refuse a reset without a person", async () => {
    if (!shared) return;
    const f = await fixture();
    const bearer = `ogk_ready_${crypto.randomUUID().replaceAll("-", "")}`;
    await createOrganizationApiKey(f.db, {
      accountId: f.grant.accountId,
      name: "Readiness key",
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
    });
    const post = (path: string, body: unknown) =>
      app.request(`http://localhost/v1/workspaces/${f.grant.workspaceId}/tools/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const ready = await post("readiness", { ...f.site, targets: [{ identity: canonical }] });
    expect(ready.status).toBe(200);
    const body = (await ready.json()) as { version: number; tools: { state: string }[] };
    expect(body.version).toBe(1);
    expect(body.tools).toHaveLength(1);
    expect((await post("site-allowances/reset", f.site)).status).toBe(403);
  }, 120_000);
});
