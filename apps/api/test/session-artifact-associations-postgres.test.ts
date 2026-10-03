import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { signDelegatedAccessToken, type AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps, EditableArtifactApplicationPort } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  createOrganizationApiKey,
  createWorkspace,
  ensureExternalIdentity,
  listEditableArtifactIdsForSession,
  listWorkspaceArtifacts,
  PostgresEditableArtifactLiveTicketStore,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { registerSessionArtifactAssociationRoutes } from "../src/routes/session-artifact-associations";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";
import { registerEditableArtifactRoutes } from "../src/routes/editable-artifacts";
import { editableArtifactSourceSessionAuthorizer } from "../src/editable-artifact-source-session";
import {
  EditableArtifactLiveTicketAuthority,
  WebCryptoEditableArtifactLiveTokens,
  editableArtifactId,
  editableArtifactReplicaId,
} from "@opengeni/core";

let shared: SharedTestDatabase;
let client: DbClient;
const secret = "association-real-postgres";

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-artifact-associations");
  if (!acquired) throw new Error("Exact artifact associations require real PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "association-test",
    accountExternalId: suffix,
    accountName: "Association test",
    workspaceExternalSource: "association-test",
    workspaceExternalId: suffix,
    workspaceName: "Association test",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "association fixture",
    resources: [],
    metadata: {},
    model: "fixture",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    createdByContext: {},
  });
  const otherSession = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "other source",
    resources: [],
    metadata: {},
    model: "fixture",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    createdByContext: {},
  });
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  const ids = Array.from({ length: 70 }, (_, index) => (index + 1).toString(16).padStart(32, "0"));
  const siteIds = Array.from({ length: 501 }, () => crypto.randomUUID());
  await shared.admin.begin(async (tx) => {
    // Administrator-only fixture setup, while runtime queries use opengeni_app
    // and the real FORCE-RLS/owner-routine boundary.
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`insert into editable_artifacts (
      account_id, workspace_id, id, modality, title, authorization_revision,
      head_sequence, causal_frontier, state_hash, created_by_subject_id)
      select ${scope.accountId}::uuid, ${scope.workspaceId}::uuid, id, 'document',
        'Fixture', 1, 0, null, ${`sha256:${"1".repeat(64)}`}, ${grant.subjectId}
      from unnest(${ids}::text[]) as id`;
    await tx`insert into editable_artifact_session_links (
      account_id, workspace_id, session_id, artifact_id, first_used_at, last_used_at)
      select ${scope.accountId}::uuid, ${scope.workspaceId}::uuid, ${session.id}::uuid, id,
        now() - interval '1 day', now() - (ordinality * interval '1 minute')
      from unnest(${ids}::text[]) with ordinality as entry(id, ordinality)`;
    await tx`insert into workspace_artifacts (
      id, account_id, workspace_id, slug, title, created_by_subject_id, updated_at)
      select id, ${scope.accountId}::uuid, ${scope.workspaceId}::uuid, id::text, 'Site fixture',
        ${grant.subjectId}, now() - (ordinality * interval '1 minute')
      from unnest(${siteIds}::uuid[]) with ordinality as entry(id, ordinality)`;
    await tx`insert into workspace_artifact_versions (
      account_id, workspace_id, artifact_id, revision, content_key, size_bytes, operation_key,
      source_session_id, source_turn_id, source_attempt_id, source_execution_generation, created_by_subject_id)
      select ${scope.accountId}::uuid, ${scope.workspaceId}::uuid, id, 1, 'fixture.html', 1,
        id::text, ${session.id}::uuid, ${crypto.randomUUID()}::uuid, ${crypto.randomUUID()}::uuid,
        1, ${grant.subjectId} from unnest(${siteIds}::uuid[]) as id`;
    await tx`update workspace_artifacts artifact set current_version_id = version.id
      from workspace_artifact_versions version
      where artifact.id = version.artifact_id and artifact.workspace_id = ${scope.workspaceId}`;
  });
  let allowed = true;
  const deps = {
    db: client.db,
    settings: testSettings({ productAccessMode: "managed", delegationSecret: secret }),
    bus: new MemoryEventBus(),
    sessionAuthorization: {
      authorizeSession: async () =>
        allowed ? { allowed: true } : { allowed: false, reason: "revoked" },
      resolveListScope: async () => ({ kind: "all" as const }),
    },
  } as unknown as ApiRouteDeps;
  const app = new Hono();
  app.onError((error, context) => {
    if (error instanceof HTTPException)
      return context.json({ message: error.message }, error.status);
    throw error;
  });
  registerSessionArtifactAssociationRoutes(app, deps);
  const token = await signDelegatedAccessToken(secret, {
    ...scope,
    subjectId: grant.subjectId,
    principalKind: "human_session",
    permissions: ["sessions:read", "artifacts:read", "artifacts:publish"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const headers = { authorization: `Bearer ${token}` };
  const request = (artifactId: string, sourceId = session.id, kind?: string) =>
    app.request(
      `/v1/workspaces/${scope.workspaceId}/sessions/${sourceId}/artifact-associations/${artifactId}${kind ? `?kind=${kind}` : ""}`,
      { headers },
    );
  return {
    scope,
    grant,
    session,
    otherSession,
    ids,
    siteIds,
    deps,
    app,
    headers,
    request,
    revoke: () => {
      allowed = false;
    },
  };
}

test("exact API finds associations beyond 64 editable entries and five Site pages without widening scope", async () => {
  const f = await fixture();
  expect(await listEditableArtifactIdsForSession(client.db, f.scope, f.session.id)).not.toContain(
    f.ids[69],
  );
  const page = await listWorkspaceArtifacts(client.db, f.scope.workspaceId, {
    sourceSessionId: f.session.id,
    limit: 100,
  });
  expect(page.artifacts.map((artifact) => artifact.id)).not.toContain(f.siteIds[500]);
  const editable = await f.request(f.ids[69]!, f.session.id, "editable");
  expect(editable.status, await editable.clone().text()).toBe(200);
  expect(await editable.json()).toEqual({
    sessionId: f.session.id,
    artifactId: f.ids[69],
    kind: "editable",
  });
  const site = await f.request(f.siteIds[500]!, f.session.id, "site");
  expect(site.status, await site.clone().text()).toBe(200);
  expect(await site.json()).toEqual({
    sessionId: f.session.id,
    artifactId: f.siteIds[500],
    kind: "site",
  });
  expect((await f.request(f.ids[69]!, f.otherSession.id)).status).toBe(404);
  expect((await f.request(f.siteIds[500]!, f.otherSession.id)).status).toBe(404);
  expect((await f.request(f.ids[69]!, f.session.id, "site")).status).toBe(404);
  expect((await f.request("invalid", "invalid")).status).toBe(404);
  // Canonical durable private-session visibility must precede associations.
  const [personal] =
    await shared.admin`insert into workspaces(account_id,name) values(${f.scope.accountId},'Owner Personal') returning id`;
  const membershipId = crypto.randomUUID();
  await shared.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`insert into organization_memberships(id,account_id,subject_id,role,status,personal_workspace_id)
      values(${membershipId},${f.scope.accountId},${f.grant.subjectId},'owner','active',${personal!.id})`;
    await tx`update sessions set visibility='user_private',owner_subject_id=${f.grant.subjectId},
      owner_organization_membership_id=${membershipId} where id=${f.session.id}`;
  });
  const stranger = await signDelegatedAccessToken(secret, {
    ...f.scope,
    subjectId: `user:${crypto.randomUUID()}`,
    principalKind: "human_session",
    permissions: ["sessions:read", "artifacts:read"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  expect(
    (
      await f.app.request(
        `/v1/workspaces/${f.scope.workspaceId}/sessions/${f.session.id}/artifact-associations/${f.ids[69]}`,
        {
          headers: { authorization: `Bearer ${stranger}` },
        },
      )
    ).status,
  ).toBe(404);
  expect((await f.request(f.ids[69]!)).status).toBe(200);
  f.revoke();
  expect((await f.request(f.ids[69]!)).status).toBe(404);
  expect((await f.request(f.siteIds[500]!)).status).toBe(404);
});

test("one-use PG ticket authenticates source authority and canonical API rechecks host revocation and unlinking", async () => {
  const f = await fixture();
  const authority = new EditableArtifactLiveTicketAuthority({
    authorization: { authorize: async () => ({ allowed: true, revision: 1 }) },
    tickets: new PostgresEditableArtifactLiveTicketStore(client.db),
    tokens: new WebCryptoEditableArtifactLiveTokens(),
    clock: { now: () => new Date() },
  });
  const ticket = await authority.mint({
    scope: f.scope,
    artifactId: editableArtifactId(f.ids[0]!),
    modality: "document",
    actor: {
      kind: "human",
      subjectId: f.grant.subjectId,
      replicaId: editableArtifactReplicaId("1".repeat(16)),
    },
    allowEdit: true,
    sourceSessionAuthority: {
      sessionId: f.session.id,
      grant: {
        ...f.grant,
        permissions: ["sessions:read", "artifacts:read", "artifacts:publish"],
      },
    },
  });
  await expect(
    authority.consume({
      token: ticket.token.split(".ogs2.")[0]!,
      artifactId: editableArtifactId(f.ids[0]!),
      protocolVersion: 2,
    }),
  ).rejects.toMatchObject({ code: "ticket_replayed" });
  const record = await authority.consume({
    token: ticket.token,
    artifactId: editableArtifactId(f.ids[0]!),
    protocolVersion: 2,
  });
  const check = editableArtifactSourceSessionAuthorizer(f.deps);
  expect(await check(record, "read")).toBe(true);
  expect(await check(record, "edit")).toBe(true);
  await shared.admin`delete from editable_artifact_session_links where workspace_id=${f.scope.workspaceId} and session_id=${f.session.id} and artifact_id=${f.ids[0]}`;
  expect(await check(record, "read")).toBe(false);
  f.revoke();
  expect(await check(record, "read")).toBe(false);
  await expect(
    authority.consume({
      token: ticket.token,
      artifactId: editableArtifactId(f.ids[0]!),
      protocolVersion: 2,
    }),
  ).rejects.toMatchObject({ code: "ticket_replayed" });
});

test("ticket HTTP mint binds the exact authorized source and cannot mint another session's association", async () => {
  const f = await fixture();
  const calls: Array<Parameters<EditableArtifactApplicationPort["mintLiveTicket"]>[0]> = [];
  registerEditableArtifactRoutes(f.app, {
    ...f.deps,
    editableArtifacts: {
      mintLiveTicket: async (input) => {
        calls.push(input);
        return {
          artifactId: input.artifactId,
          modality: "document",
          replicaId: input.actor.replicaId,
          token: "t".repeat(43),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          protocolVersion: 2,
        };
      },
    } as EditableArtifactApplicationPort,
  });
  const mint = (sourceSessionId: string, headers = f.headers) =>
    f.app.request(
      `/v1/workspaces/${f.scope.workspaceId}/editable-artifacts/${f.ids[0]}/live-ticket`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          sourceSessionId,
          replicaId: "1".repeat(16),
          modality: "document",
          liveProtocolVersion: 2,
          kernelVersion: "fixture",
          modelSchemaVersion: 1,
          snapshotVersion: 1,
          commandProtocolVersion: 1,
          committedTransactionProtocolVersion: 1,
        }),
      },
    );
  const response = await mint(f.session.id);
  expect(response.status, await response.clone().text()).toBe(201);
  expect(calls[0]?.sourceSessionAuthority).toMatchObject({
    sessionId: f.session.id,
    grant: {
      ...f.scope,
      subjectId: f.grant.subjectId,
      permissions: ["sessions:read", "artifacts:read", "artifacts:publish"],
    },
  });
  const broadCaller = await signDelegatedAccessToken(secret, {
    ...f.scope,
    subjectId: f.grant.subjectId,
    subjectLabel: "label".repeat(2_000),
    principalKind: "human_session",
    permissions: ["workspace:admin"],
    firstPartyMcpTools: Array.from({ length: 1_000 }, () => "session_get" as const),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const broadResponse = await mint(f.session.id, { authorization: `Bearer ${broadCaller}` });
  expect(broadResponse.status, await broadResponse.clone().text()).toBe(201);
  const boundGrant = calls[1]!.sourceSessionAuthority!.grant;
  expect(boundGrant).not.toHaveProperty("subjectLabel");
  expect(boundGrant.metadata).toEqual({ delegated: true });
  expect(boundGrant.permissions).not.toContain("workspace:admin");
  const ticketAuthority = new EditableArtifactLiveTicketAuthority({
    authorization: { authorize: async () => ({ allowed: true, revision: 1 }) },
    tickets: new PostgresEditableArtifactLiveTicketStore(client.db),
    tokens: new WebCryptoEditableArtifactLiveTokens(),
    clock: { now: () => new Date() },
  });
  const boundedTicket = await ticketAuthority.mint(calls[1]!);
  expect(new TextEncoder().encode(boundedTicket.token).byteLength).toBeLessThan(4096);
  expect((await mint(f.otherSession.id)).status).toBe(404);
  f.revoke();
  expect((await mint(f.session.id)).status).toBe(404);
  expect(calls).toHaveLength(2);
});

test("selected workspace grants resolve external asUser with empty inventory and obey key ceilings", async () => {
  const [account] =
    await shared.admin`insert into managed_accounts(name) values ('Effective grant fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(client.db, { accountId, name: "External workspace" });
  const identity = await ensureExternalIdentity(client.db, {
    accountId,
    source: "grant-test",
    externalId: crypto.randomUUID(),
  });
  const rawKey = crypto.randomUUID();
  const key = await createOrganizationApiKey(client.db, {
    accountId,
    name: "Grant ceiling",
    prefix: "test",
    keyHash: createHash("sha256").update(rawKey).digest("hex"),
    permissions: ["workspace:read", "sessions:read", "artifacts:read"],
  });
  await shared.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`insert into workspace_memberships(account_id,workspace_id,subject_id,permissions)
      values(${accountId},${workspace.id},${identity.subjectId},'["workspace:admin","artifacts:publish"]')`;
  });
  const app = new Hono();
  app.onError((error, context) => {
    if (error instanceof HTTPException)
      return context.json({ message: error.message }, error.status);
    throw error;
  });
  registerWorkspaceRoutes(app, {
    db: client.db,
    settings: testSettings({ productAccessMode: "managed" }),
    bus: new MemoryEventBus(),
  } as unknown as ApiRouteDeps);
  const headers = {
    authorization: `Bearer ${rawKey}`,
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({
        mode: "external",
        identity: { source: identity.source, externalId: identity.externalId },
      }),
    ),
  };
  const inventory = await app.request("/v1/access/me", { headers });
  expect(inventory.status, await inventory.clone().text()).toBe(200);
  expect((await inventory.json()).workspaceGrants).toEqual([]);
  const response = await app.request(`/v1/workspaces/${workspace.id}/access/grant`, { headers });
  expect(response.status, await response.clone().text()).toBe(200);
  const resolved = (await response.json()) as AccessGrant;
  expect(resolved.subjectId).toBe(identity.subjectId);
  expect(resolved.permissions).toContain("artifacts:read");
  expect(resolved.permissions).not.toContain("artifacts:publish");
  expect(resolved.permissions).not.toContain("workspace:admin");
  const session = await createSession(client.db, {
    accountId,
    workspaceId: workspace.id,
    initialMessage: "External editor source",
    resources: [],
    metadata: {},
    model: "fixture",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: identity.subjectId },
    createdByContext: {},
  });
  const artifactId = "9".repeat(32);
  await shared.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`insert into editable_artifacts (
      account_id,workspace_id,id,modality,title,authorization_revision,head_sequence,causal_frontier,state_hash,created_by_subject_id)
      values(${accountId},${workspace.id},${artifactId},'document','External editor',1,0,null,${`sha256:${"1".repeat(64)}`},${identity.subjectId})`;
    await tx`insert into editable_artifact_session_links(account_id,workspace_id,session_id,artifact_id)
      values(${accountId},${workspace.id},${session.id},${artifactId})`;
  });
  const liveCheck = editableArtifactSourceSessionAuthorizer({
    db: client.db,
  } as ApiRouteDeps);
  const record = {
    tokenDigest: `sha256:${"2".repeat(64)}`,
    scope: { accountId, workspaceId: workspace.id },
    artifactId: editableArtifactId(artifactId),
    modality: "document" as const,
    actor: {
      kind: "human" as const,
      subjectId: identity.subjectId,
      replicaId: editableArtifactReplicaId("1".repeat(16)),
    },
    allowEdit: false,
    protocolVersion: 2,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    sourceSessionAuthority: {
      sessionId: session.id,
      grant: resolved,
      externalContinuation: {
        identity: { source: identity.source, externalId: identity.externalId },
        actor: resolved.metadata!.externalActor as never,
      },
    },
  };
  expect(await liveCheck(record, "read")).toBe(true);
  expect(await liveCheck(record, "edit")).toBe(false);
  await shared.admin`update api_keys set permissions='["workspace:read","sessions:read"]' where id=${key.id}`;
  expect(await liveCheck(record, "read")).toBe(false);
  const reduced = await app.request(`/v1/workspaces/${workspace.id}/access/grant`, { headers });
  expect((await reduced.json()).permissions).not.toContain("artifacts:read");
  await shared.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`delete from workspace_memberships where workspace_id=${workspace.id} and subject_id=${identity.subjectId}`;
  });
  expect(
    (await app.request(`/v1/workspaces/${workspace.id}/access/grant`, { headers })).status,
  ).toBe(403);
});
