import { expect } from "bun:test";
import { Hono } from "hono";
import { testSettings, type SharedTestDatabase } from "@opengeni/testing";
import { createHash } from "node:crypto";
import {
  createOrganizationApiKey,
  createSession,
  ensureExternalIdentity,
  removeWorkspaceMember,
  nestedPostgresSqlState,
  withSessionRlsActorContext,
  type Database,
} from "@opengeni/db";
import {
  requireAccessGrantAuthorization,
  requireAccessContext,
  listExternalActorWorkspaces,
  externalAttributionForAuthorization,
  externalActorContinuationForAuthorization,
} from "../src/access";
import { addExternalWorkspaceMemberForRequest } from "../src/application/external-workspace-members";
import { externalCreationMetadata } from "../src/domain/external-creation-attribution";
import { requireExternalContinuationAuthority } from "../src/application/external-continuation";
import type { ExternalActorContinuation } from "@opengeni/contracts/external-identities";

/** Invoked by the real PostgreSQL acceptance suite, never a mock grant resolver. */
export async function verifyExternalAdmission(
  db: Database,
  admin: SharedTestDatabase["admin"],
  scope: { accountId: string; workspaceId: string },
) {
  const token = crypto.randomUUID();
  const key = await createOrganizationApiKey(db, {
    accountId: scope.accountId,
    name: "External admission",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["workspace:read"],
  });
  const identity = await ensureExternalIdentity(db, {
    accountId: scope.accountId,
    externalId: "http-user",
  });
  const app = new Hono();
  let continuation: ExternalActorContinuation | null = null;
  const deps = { db, settings: testSettings({ productAccessMode: "configured" }) };
  app.get("/attribution", async (c) => {
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      scope.workspaceId,
      "workspace:read",
    );
    continuation = externalActorContinuationForAuthorization(authorization);
    const first = externalAttributionForAuthorization(authorization, authorization.grant)!;
    first.authenticatingApiKeyId = "mutated";
    expect(
      externalAttributionForAuthorization(authorization, { ...authorization.grant }),
    ).toBeNull();
    const metadata = externalCreationMetadata(
      { custom: "kept" },
      authorization,
      authorization.grant,
    )!;
    const session = await withSessionRlsActorContext({ subjectId: identity.subjectId }, () =>
      createSession(db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        initialMessage: "External attribution fixture",
        createdBy: { kind: "subject", subjectId: identity.subjectId },
        resources: [],
        tools: [],
        metadata,
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
      }),
    );
    const [stored] =
      await admin`select owner_subject_id, owner_organization_membership_id, metadata from sessions where id = ${session.id}`;
    expect(stored?.owner_subject_id).toBe(identity.subjectId);
    expect(stored?.owner_organization_membership_id).toBe(identity.organizationMembershipId);
    expect(stored?.metadata).toMatchObject(metadata);
    return c.json(metadata);
  });
  app.post("/onboard", async (c) =>
    c.json(
      await addExternalWorkspaceMemberForRequest(c, deps, scope.workspaceId, await c.req.json()),
    ),
  );
  app.get("/inventory", async (c) =>
    c.json(await listExternalActorWorkspaces(await requireAccessContext(c, deps), deps)),
  );
  app.get("/test", async (c) =>
    c.json(await requireAccessGrantAuthorization(c, deps, scope.workspaceId, "workspace:read")),
  );
  const headers = {
    authorization: `Bearer ${token}`,
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({ mode: "external", identity: { externalId: "http-user" } }),
    ),
  };
  const onboarding = { identity: { externalId: "onboarded" }, permissions: ["workspace:read"] };
  const serviceHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  expect(
    (
      await app.request("/onboard", {
        method: "POST",
        headers: serviceHeaders,
        body: JSON.stringify(onboarding),
      })
    ).status,
  ).toBe(403);
  await admin`update api_keys set permissions = '["workspace:read","members:manage"]'::jsonb where id = ${key.id}`;
  const onboarded = await app.request("/onboard", {
    method: "POST",
    headers: serviceHeaders,
    body: JSON.stringify(onboarding),
  });
  expect(onboarded.status).toBe(200);
  const onboardedIdentity = await onboarded.json();
  const replay = await app.request("/onboard", {
    method: "POST",
    headers: serviceHeaders,
    body: JSON.stringify(onboarding),
  });
  expect(replay.status).toBe(200);
  expect((await replay.json()).id).toBe(onboardedIdentity.id);
  expect(
    (
      await app.request("/onboard", {
        method: "POST",
        headers: { ...serviceHeaders, ...headers },
        body: JSON.stringify(onboarding),
      })
    ).status,
  ).toBe(403);
  await admin`update api_keys set permissions = '["workspace:read"]'::jsonb where id = ${key.id}`;
  expect((await app.request("/test", { headers })).status).toBe(403);
  await admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions) values (${scope.accountId}, ${scope.workspaceId}, ${identity.subjectId}, 'member', '["workspace:read","sessions:create"]'::jsonb)`;
  const response = await app.request("/test", { headers });
  expect(response.status).toBe(200);
  const value = await response.json();
  expect(value.grant.subjectId).toBe(identity.subjectId);
  expect(value.grant.permissions).toEqual(["workspace:read"]);
  expect(value.canonicalManagedHumanSession).toBe(false);
  const attribution = await (await app.request("/attribution", { headers })).json();
  expect(attribution).toMatchObject({
    custom: "kept",
    opengeniExternalCreationAttribution: {
      authenticatingApiKeyId: key.id,
      externalIdentityId: identity.id,
      externalSubjectId: identity.subjectId,
      effectiveSubjectId: identity.subjectId,
      actingMode: "external",
    },
  });
  expect(continuation).not.toBeNull();
  await db.transaction((tx) =>
    requireExternalContinuationAuthority(
      tx,
      continuation,
      { ...scope, subjectId: identity.subjectId },
      "workspace:read",
    ),
  );
  const inventory = await app.request("/inventory", { headers });
  expect(inventory.status).toBe(200);
  expect((await inventory.json()).map((workspace: { id: string }) => workspace.id)).toEqual([
    identity.personalWorkspaceId,
    scope.workspaceId,
  ]);
  await admin`update api_keys set permissions = '[]'::jsonb where id = ${key.id}`;
  await expect(
    db.transaction((tx) =>
      requireExternalContinuationAuthority(
        tx,
        continuation,
        { ...scope, subjectId: identity.subjectId },
        "workspace:read",
      ),
    ),
  ).rejects.toThrow("unavailable");
  expect(await (await app.request("/inventory", { headers })).json()).toEqual([]);
  await admin`update api_keys set permissions = '["workspace:read"]'::jsonb where id = ${key.id}`;
  await admin`update workspace_memberships set permissions = '["workspace:admin"]'::jsonb where workspace_id = ${scope.workspaceId} and subject_id = ${identity.subjectId}`;
  const narrowed = await app.request("/test", { headers });
  expect(narrowed.status).toBe(200);
  expect((await narrowed.json()).grant.permissions).toEqual(["workspace:read"]);
  await admin`delete from workspace_memberships where workspace_id = ${scope.workspaceId} and subject_id = ${identity.subjectId}`;
  await expect(
    db.transaction((tx) =>
      requireExternalContinuationAuthority(
        tx,
        continuation,
        { ...scope, subjectId: identity.subjectId },
        "workspace:read",
      ),
    ),
  ).rejects.toThrow("unavailable");
  expect((await app.request("/test", { headers })).status).toBe(403);
  const removal = {
    ...scope,
    actorSubjectId: `api_key:${key.id}`,
    targetSubjectId: onboardedIdentity.subjectId,
  };
  // Reuse the real settlement/teardown path. The service is not a fabricated
  // organization member and cannot rely on a stale key permission snapshot.
  await expect(removeWorkspaceMember(db, removal)).rejects.toThrow();
  await admin`update api_keys set permissions = '["workspace:read","members:manage"]'::jsonb where id = ${key.id}`;
  await admin`update workspace_memberships set permissions = '["members:manage"]'::jsonb
    where workspace_id = ${scope.workspaceId} and subject_id = ${removal.targetSubjectId}`;
  expect(await removeWorkspaceMember(db, removal).then(() => null, nestedPostgresSqlState)).toBe(
    "55000",
  );
  await admin`update workspace_memberships set permissions = '["workspace:read"]'::jsonb
    where workspace_id = ${scope.workspaceId} and subject_id = ${removal.targetSubjectId}`;
  const affected = await withSessionRlsActorContext({ subjectId: removal.targetSubjectId }, () =>
    createSession(db, {
      ...scope,
      initialMessage: "Removed external member work",
      metadata: {},
      resources: [],
      tools: [],
      createdBy: { kind: "subject", subjectId: removal.targetSubjectId },
      subjectId: removal.targetSubjectId,
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    }),
  );
  const turnId = crypto.randomUUID();
  await admin`insert into session_turns (
    id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
    status, execution_generation, position, prompt, model, reasoning_effort,
    latency_mode, sandbox_backend, initiator_kind, initiator_subject_id, initiating_human_subject_id
  ) values (${turnId}, ${scope.accountId}, ${scope.workspaceId}, ${affected.id},
    ${crypto.randomUUID()}, ${`external-removal-${turnId}`}, 'queued', 1, 1, 'queued work',
    'test-model', 'medium', 'standard', 'none', 'subject', ${removal.targetSubjectId}, ${removal.targetSubjectId})`;
  expect(await removeWorkspaceMember(db, removal)).toBe(true);
  const [cancelled] =
    await admin`select status, cancelled_by, cancel_reason from session_turns where id = ${turnId}`;
  expect(cancelled).toMatchObject({
    status: "cancelled",
    cancelled_by: removal.actorSubjectId,
    cancel_reason: "authority_changed",
  });
  expect(await removeWorkspaceMember(db, removal)).toBe(false);
  const [receipt] = await admin`select actor_type, actor_subject_id from session_command_receipts
    where workspace_id = ${scope.workspaceId} and actor_subject_id = ${removal.actorSubjectId}
      and action = 'workspace.membership.remove'`;
  expect(receipt).toMatchObject({
    actor_type: "service",
    actor_subject_id: removal.actorSubjectId,
  });
  await expect(
    removeWorkspaceMember(db, { ...removal, targetSubjectId: "user:not-an-external-member" }),
  ).rejects.toThrow();
  await admin`update api_keys set revoked_at = now() where id = ${key.id}`;
  await expect(removeWorkspaceMember(db, removal)).rejects.toThrow();
  await expect(
    db.transaction((tx) =>
      requireExternalContinuationAuthority(
        tx,
        continuation,
        { ...scope, subjectId: identity.subjectId },
        "workspace:read",
      ),
    ),
  ).rejects.toThrow("unavailable");
  expect((await app.request("/test", { headers })).status).toBe(401);
  const invalid = { ...headers, "x-opengeni-external-actor": "%not-json" };
  expect((await app.request("/test", { headers: invalid })).status).toBe(401);
}
