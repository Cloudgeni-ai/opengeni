import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { testSettings, type SharedTestDatabase } from "@opengeni/testing";
import {
  createOrganizationApiKey,
  createSession,
  createWorkspace,
  ensureExternalIdentity,
  grantWorkspaceAccess,
  nestedPostgresSqlState,
  withSessionRlsActorContext,
  type Database,
} from "@opengeni/db";
import { updateExternalIdentityMembershipForRequest } from "../src/application/external-identity-lifecycle";
import { organizationMembershipHttpStatus } from "../src/domain/organization-membership-lifecycle";

/** Real non-owner PostgreSQL acceptance, not a mocked admission stamp. */
export async function verifyExternalLifecycle(
  db: Database,
  admin: SharedTestDatabase["admin"],
  scope: { accountId: string; workspaceId: string },
) {
  const token = crypto.randomUUID();
  const key = await createOrganizationApiKey(db, {
    accountId: scope.accountId,
    name: "External lifecycle",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["account:admin"],
  });
  const identity = await ensureExternalIdentity(db, {
    accountId: scope.accountId,
    externalId: "lifecycle-user",
  });
  await grantWorkspaceAccess(db, {
    ...scope,
    subjectId: identity.subjectId,
    permissions: ["workspace:read"],
  });
  const session = await withSessionRlsActorContext({ subjectId: identity.subjectId }, () =>
    createSession(db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      subjectId: identity.subjectId,
      createdBy: { kind: "subject", subjectId: identity.subjectId },
      initialMessage: "Lifecycle work",
      resources: [],
      tools: [],
      metadata: {},
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
  ) values (${turnId}, ${scope.accountId}, ${scope.workspaceId}, ${session.id}, ${crypto.randomUUID()},
    ${`external-lifecycle-${turnId}`}, 'queued', 1, 1, 'queued work', 'test-model', 'medium', 'standard', 'none',
    'subject', ${identity.subjectId}, ${identity.subjectId})`;
  const deps = { db, settings: testSettings({ productAccessMode: "configured" }) };
  const app = new Hono();
  app.patch("/:organizationId/:membershipId", async (c) => {
    try {
      return c.json(
        await updateExternalIdentityMembershipForRequest(
          c,
          deps,
          c.req.param("organizationId"),
          c.req.param("membershipId"),
          await c.req.json(),
        ),
      );
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      const status = organizationMembershipHttpStatus(nestedPostgresSqlState(error));
      if (status !== null) throw new HTTPException(status, { message: "Lifecycle rejected" });
      throw error;
    }
  });
  const path = `/${scope.accountId}/${identity.organizationMembershipId}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const suspend = {
    kind: "suspend",
    expectedAuthorizationRevision: 1,
    operationId: crypto.randomUUID(),
  };
  const invoke = (body: unknown, extra: Record<string, string> = {}, requestPath = path) =>
    app.request(requestPath, {
      method: "PATCH",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  expect(
    (
      await invoke(suspend, {
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({ mode: "external", identity: { externalId: identity.externalId } }),
        ),
      })
    ).status,
  ).toBe(403);
  expect((await invoke({ ...suspend, kind: "change_role", role: "owner" })).status).toBe(422);
  expect(
    (await invoke(suspend, {}, `/${crypto.randomUUID()}/${identity.organizationMembershipId}`))
      .status,
  ).toBe(403);
  const nativePersonal = await createWorkspace(db, {
    accountId: scope.accountId,
    name: "Native lifecycle boundary fixture",
  });
  const [native] =
    await admin`insert into organization_memberships (account_id, subject_id, personal_workspace_id, role, status)
    values (${scope.accountId}, ${`user:lifecycle-native-${crypto.randomUUID()}`}, ${nativePersonal.id}, 'member', 'active') returning id`;
  if (!native) throw new Error("Native boundary fixture missing");
  expect((await invoke(suspend, {}, `/${scope.accountId}/${native.id}`)).status).toBe(403);
  const suspended = await invoke(suspend);
  expect(suspended.status).toBe(200);
  expect(await suspended.json()).toMatchObject({
    id: identity.organizationMembershipId,
    status: "suspended",
    authorizationRevision: 2,
  });
  const [cancelled] =
    await admin`select status, cancelled_by from session_turns where id = ${turnId}`;
  expect(cancelled).toEqual({ status: "cancelled", cancelled_by: `api_key:${key.id}` });
  expect((await invoke(suspend)).status).toBe(200);
  expect(
    await ensureExternalIdentity(db, {
      accountId: scope.accountId,
      externalId: identity.externalId,
    }).then(() => null, nestedPostgresSqlState),
  ).toBe("42501");
  const [stored] =
    await admin`select status, authorization_revision::int as revision from external_identities where id = ${identity.id}`;
  expect(stored).toEqual({ status: "disabled", revision: 2 });
  const [audit] =
    await admin`select actor_membership_id, actor_service_subject from organization_membership_lifecycle_events where account_id = ${scope.accountId} and operation_id = ${suspend.operationId}`;
  expect(audit).toEqual({ actor_membership_id: null, actor_service_subject: `api_key:${key.id}` });
  await admin`update api_keys set permissions = '[]'::jsonb where id = ${key.id}`;
  expect((await invoke(suspend)).status).toBe(403);
  await admin`update api_keys set permissions = '["account:admin"]'::jsonb where id = ${key.id}`;
  const reactivate = {
    kind: "reactivate",
    expectedAuthorizationRevision: 2,
    operationId: crypto.randomUUID(),
  };
  expect((await invoke({ ...reactivate, expectedAuthorizationRevision: 1 })).status).toBe(409);
  expect((await invoke(reactivate)).status).toBe(200);
  const resumed = await ensureExternalIdentity(db, {
    accountId: scope.accountId,
    externalId: identity.externalId,
  });
  expect(resumed).toMatchObject({ id: identity.id, status: "active", authorizationRevision: 3 });
  const [membership] =
    await admin`select count(*)::int as count from workspace_memberships where workspace_id = ${scope.workspaceId} and subject_id = ${identity.subjectId}`;
  expect(membership?.count).toBe(0);
  const offboard = {
    kind: "offboard",
    expectedAuthorizationRevision: 3,
    operationId: crypto.randomUUID(),
  };
  expect((await invoke(offboard)).status).toBe(200);
  expect(
    (
      await invoke({
        ...reactivate,
        expectedAuthorizationRevision: 4,
        operationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  const [revoked] =
    await admin`select status, authorization_revision::int as revision from external_identities where id = ${identity.id}`;
  expect(revoked).toEqual({ status: "revoked", revision: 4 });
  await admin`update api_keys set revoked_at = now() where id = ${key.id}`;
  expect((await invoke(offboard)).status).toBe(401);
}
