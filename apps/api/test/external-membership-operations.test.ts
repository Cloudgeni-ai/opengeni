import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { OpenGeniClient } from "@opengeni/sdk";
import { type ApiRouteDeps } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  testSettings,
  MemoryEventBus,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  createDb,
  createWorkspace,
  createSession,
  createScheduledTask,
  withSessionRlsActorContext,
  createOrganizationApiKey,
  ensureExternalIdentity,
  type DbClient,
} from "@opengeni/db";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";
import { registerOrganizationMembershipRoutes } from "../src/routes/organization-memberships";

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("external-membership-operations");
  if (!acquired) throw new Error("External membership operations require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

async function fixture() {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Embedded product fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(db.db, { accountId, name: "Customer workspace" });
  const token = crypto.randomUUID();
  const key = await createOrganizationApiKey(db.db, {
    accountId,
    name: "Service fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["workspace:read", "members:manage", "sessions:read", "account:admin"],
  });
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
    throw error;
  });
  const deps = {
    db: db.db,
    settings: testSettings({ productAccessMode: "configured", sandboxBackend: "none" }),
    bus: new MemoryEventBus(),
  } as unknown as ApiRouteDeps;
  registerWorkspaceRoutes(app, deps);
  registerOrganizationMembershipRoutes(app, deps);
  let loseNextPath: string | null = null;
  const service = new OpenGeniClient({
    baseUrl: "http://fixture",
    apiKey: token,
    fetch: async (input, init) => {
      const response = await app.request(input, init);
      if (loseNextPath && new URL(String(input)).pathname.endsWith(loseNextPath) && response.ok) {
        loseNextPath = null;
        throw new Error("Fixture loses committed response");
      }
      return response;
    },
  });
  const reference = { source: "example:instance", externalId: crypto.randomUUID() };
  const actor = service.asUser(reference.externalId, { source: reference.source });
  const context = await actor.getAccessContext();
  const identity = await ensureExternalIdentity(db.db, { accountId, ...reference });
  expect(context.subjectId).toBe(identity.subjectId);
  const grant = {
    identity: reference,
    permissions: ["workspace:read"] as const,
    operationId: crypto.randomUUID(),
  };
  const add = (request = grant) =>
    service.addExternalWorkspaceMember(workspace.id, {
      ...request,
      permissions: [...request.permissions],
    });
  const cancellation = {
    operationId: crypto.randomUUID(),
    cancelGrantOperationId: grant.operationId,
  };
  const revoke = () =>
    service.cancelExternalWorkspaceMemberGrant(
      accountId,
      workspace.id,
      identity.organizationMembershipId,
      cancellation,
    );
  const members = () => service.listWorkspaceMembers(workspace.id);
  return {
    accountId,
    workspace,
    reference,
    identity,
    service,
    actor,
    key,
    app,
    grant,
    add,
    cancellation,
    revoke,
    members,
    lose: (path: string) => {
      loseNextPath = path;
    },
  };
}

test("lookup is non-provisioning, exact-scoped, and reads inactive membership revisions", async () => {
  const f = await fixture();
  const before = await shared.admin`select count(*)::int as n from external_identities`;
  expect(
    await f.service.lookupExternalIdentity(f.accountId, { ...f.reference, externalId: "missing" }),
  ).toEqual({ found: false });
  expect(await shared.admin`select count(*)::int as n from external_identities`).toEqual(before);
  expect(await f.service.lookupExternalIdentity(f.accountId, f.reference)).toMatchObject({
    found: true,
    subjectId: f.identity.subjectId,
    membershipStatus: "active",
    membershipAuthorizationRevision: 1,
  });
  await f.service.updateExternalIdentityMembership(
    f.accountId,
    f.identity.organizationMembershipId,
    {
      kind: "suspend",
      expectedAuthorizationRevision: 1,
      operationId: crypto.randomUUID(),
    },
  );
  expect(await f.service.lookupExternalIdentity(f.accountId, f.reference)).toMatchObject({
    found: true,
    identityStatus: "disabled",
    membershipStatus: "suspended",
    membershipAuthorizationRevision: 2,
  });
  await expect(f.actor.getAccessContext()).rejects.toMatchObject({ status: 403 });
  await expect(f.actor.lookupExternalIdentity(f.accountId, f.reference)).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    f.service.lookupExternalIdentity(crypto.randomUUID(), f.reference),
  ).rejects.toMatchObject({ status: 403 });
  await f.service.updateExternalIdentityMembership(
    f.accountId,
    f.identity.organizationMembershipId,
    {
      kind: "offboard",
      expectedAuthorizationRevision: 2,
      operationId: crypto.randomUUID(),
    },
  );
  expect(await f.service.lookupExternalIdentity(f.accountId, f.reference)).toMatchObject({
    found: true,
    identityStatus: "revoked",
    membershipStatus: "revoked",
    membershipAuthorizationRevision: 3,
  });
});

test("grant receipt replay never restores removed or reduced membership", async () => {
  const f = await fixture();
  expect((await f.add()).subjectId).toBe(f.identity.subjectId);
  await shared.admin`update workspace_memberships set permissions = '[]'::jsonb where workspace_id = ${f.workspace.id} and subject_id = ${f.identity.subjectId}`;
  await f.add();
  expect(
    (await f.members()).find((m) => m.subjectId === f.identity.subjectId)?.permissions,
  ).toEqual([]);
  await f.service.removeWorkspaceMember(f.workspace.id, f.identity.subjectId);
  await f.add();
  expect(await f.members()).toEqual([]);
  await expect(
    f.service.addExternalWorkspaceMember(f.workspace.id, {
      ...f.grant,
      permissions: ["sessions:read"],
    }),
  ).rejects.toMatchObject({ status: 409 });
});

test("lost grant and revoke responses reconcile without replaying the grant", async () => {
  const f = await fixture();
  f.lose("/external-members");
  await expect(f.add()).rejects.toThrow("reconcile before retrying");
  expect((await f.members()).some((member) => member.subjectId === f.identity.subjectId)).toBe(
    true,
  );
  f.lose("/revoke");
  await expect(f.revoke()).rejects.toThrow("reconcile before retrying");
  expect(await f.revoke()).toEqual({
    removed: true,
    replay: true,
    fencedGrantOperationId: f.grant.operationId,
  });
  expect(await f.members()).toEqual([]);
  await expect(f.add()).rejects.toMatchObject({ status: 409 });
});

test("revocation before first grant commit records a durable absence fence", async () => {
  const f = await fixture();
  expect(await f.revoke()).toEqual({
    removed: false,
    replay: false,
    fencedGrantOperationId: f.grant.operationId,
  });
  await expect(f.add()).rejects.toMatchObject({ status: 409 });
  expect(await f.members()).toEqual([]);
  expect(await f.revoke()).toMatchObject({ replay: true, removed: false });
});

async function waitForBlockedOperations(count: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await shared.admin`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and query like '%prepare_external_workspace_membership_operation%'`;
    if (Number(row!.n) >= count) return;
    await Bun.sleep(5);
  }
  throw new Error(`Expected ${count} database-blocked native operations`);
}

test.each(["grant-first", "revoke-first"] as const)(
  "actual concurrent %s follows the native lock order",
  async (order) => {
    const f = await fixture();
    let first!: Promise<unknown>, second!: Promise<unknown>;
    await shared.admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${f.accountId}`}, 0))`;
      first = (order === "grant-first" ? f.add() : f.revoke()).catch((error: unknown) => error);
      await waitForBlockedOperations(1);
      second = (order === "grant-first" ? f.revoke() : f.add()).catch((error: unknown) => error);
      await waitForBlockedOperations(2);
    });
    const results = await Promise.all([first, second]);
    if (order === "revoke-first") expect(results[1]).toMatchObject({ status: 409 });
    else expect(results[1]).toMatchObject({ removed: true });
    expect(await f.members()).toEqual([]);
  },
  30_000,
);

test("authority, target, replay and native-human request lanes stay fenced", async () => {
  const f = await fixture();
  await f.add();
  const other = await fixture();
  await expect(
    f.service.cancelExternalWorkspaceMemberGrant(
      f.accountId,
      f.workspace.id,
      other.identity.organizationMembershipId,
      f.cancellation,
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    f.service.cancelExternalWorkspaceMemberGrant(
      f.accountId,
      other.workspace.id,
      f.identity.organizationMembershipId,
      f.cancellation,
    ),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    f.actor.cancelExternalWorkspaceMemberGrant(
      f.accountId,
      f.workspace.id,
      f.identity.organizationMembershipId,
      f.cancellation,
    ),
  ).rejects.toMatchObject({ status: 403 });
  // The existing human timestamp-CAS variant does not become service authority.
  await expect(
    f.service.revokeOrganizationWorkspaceMember(
      f.accountId,
      f.workspace.id,
      f.identity.organizationMembershipId,
      { operationId: crypto.randomUUID(), expectedUpdatedAt: new Date().toISOString() },
    ),
  ).rejects.toMatchObject({ status: 401 });
  await f.revoke();
  await expect(
    f.service.cancelExternalWorkspaceMemberGrant(
      f.accountId,
      f.workspace.id,
      f.identity.organizationMembershipId,
      { ...f.cancellation, cancelGrantOperationId: crypto.randomUUID() },
    ),
  ).rejects.toMatchObject({ status: 409 });
  await shared.admin`update api_keys set revoked_at = now() where id = ${f.key.id}`;
  await expect(f.revoke()).rejects.toMatchObject({ status: 401 });
});

test("legacy unkeyed onboarding remains explicitly unfenced", async () => {
  const f = await fixture();
  await f.revoke();
  await f.service.addExternalWorkspaceMember(f.workspace.id, {
    identity: f.reference,
    permissions: ["workspace:read"],
  });
  expect((await f.members()).some((member) => member.subjectId === f.identity.subjectId)).toBe(
    true,
  );
});

test("replacement service keys reconcile receipts but remain within live permission ceilings", async () => {
  const f = await fixture();
  await f.add();
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId: f.accountId,
    name: "Replacement service",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["workspace:admin"],
  });
  const replacement = new OpenGeniClient({
    baseUrl: "http://fixture",
    apiKey: token,
    fetch: (input, init) => f.app.request(input, init),
  });
  await shared.admin`update api_keys set revoked_at = now() where id = ${f.key.id}`;
  expect(
    (
      await replacement.addExternalWorkspaceMember(f.workspace.id, {
        ...f.grant,
        permissions: [...f.grant.permissions],
      })
    ).subjectId,
  ).toBe(f.identity.subjectId);
  await expect(
    replacement.addExternalWorkspaceMember(f.workspace.id, {
      ...f.grant,
      operationId: crypto.randomUUID(),
      permissions: ["secrets:read"],
    }),
  ).rejects.toMatchObject({ status: 403 });
  await replacement.cancelExternalWorkspaceMemberGrant(
    f.accountId,
    f.workspace.id,
    f.identity.organizationMembershipId,
    f.cancellation,
  );
  expect(
    await replacement.cancelExternalWorkspaceMemberGrant(
      f.accountId,
      f.workspace.id,
      f.identity.organizationMembershipId,
      f.cancellation,
    ),
  ).toMatchObject({ replay: true });
  const [event] =
    await shared.admin`select actor_membership_id, actor_service_subject from organization_workspace_lifecycle_events where account_id = ${f.accountId} and operation_id = ${f.grant.operationId}`;
  expect(event).toMatchObject({
    actor_membership_id: null,
    actor_service_subject: `api_key:${f.key.id}`,
  });
});

test("keyed cancellation tears down private, child, live and scheduled work only in the exact scope", async () => {
  const f = await fixture();
  await f.add();
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${f.accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'external-membership-test')`;
  await shared.admin`insert into organization_private_session_settings (account_id, enabled, version, updated_by_membership_id)
    values (${f.accountId}, true, 1, null) on conflict (account_id) do update set enabled = true`;
  const otherWorkspace = await createWorkspace(db.db, {
    accountId: f.accountId,
    name: "Other customer workspace",
  });
  await f.service.addExternalWorkspaceMember(otherWorkspace.id, {
    identity: f.reference,
    permissions: ["workspace:read"],
    operationId: crypto.randomUUID(),
  });
  const bystander = await ensureExternalIdentity(db.db, {
    accountId: f.accountId,
    source: f.reference.source,
    externalId: crypto.randomUUID(),
  });
  await f.service.addExternalWorkspaceMember(f.workspace.id, {
    identity: { source: bystander.source, externalId: bystander.externalId },
    permissions: ["workspace:read"],
    operationId: crypto.randomUUID(),
  });
  async function queued(
    workspaceId: string,
    subjectId: string,
    parentSessionId?: string,
    isPrivate = true,
  ) {
    const session = await withSessionRlsActorContext({ subjectId }, () =>
      createSession(db.db, {
        accountId: f.accountId,
        workspaceId,
        initialMessage: "Queued member work",
        resources: [],
        metadata: {},
        visibility: isPrivate ? "user_private" : "workspace_shared",
        parentSessionId,
        createdBy: { kind: "subject", subjectId },
        subjectId,
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
      }),
    );
    const turnId = crypto.randomUUID();
    await shared.admin`insert into session_turns (id, account_id, workspace_id, session_id, trigger_event_id,
      temporal_workflow_id, status, execution_generation, position, prompt, model, reasoning_effort,
      latency_mode, sandbox_backend, initiator_kind, initiator_subject_id, initiating_human_subject_id)
      values (${turnId}, ${f.accountId}, ${workspaceId}, ${session.id}, ${crypto.randomUUID()}, ${`membership-${turnId}`},
        'queued', 1, 1, 'Queued work', 'test-model', 'medium', 'standard', 'none', 'subject', ${subjectId}, ${subjectId})`;
    return { sessionId: session.id, turnId };
  }
  const target = await queued(f.workspace.id, f.identity.subjectId);
  const parent = await queued(f.workspace.id, f.identity.subjectId, undefined, false);
  const child = await queued(f.workspace.id, f.identity.subjectId, parent.sessionId, false);
  const live = await queued(f.workspace.id, f.identity.subjectId);
  const other = await queued(otherWorkspace.id, f.identity.subjectId);
  const peer = await queued(f.workspace.id, bystander.subjectId);
  const attemptId = crypto.randomUUID();
  await shared.admin.begin(async (tx) => {
    // Test-only owner fixture: materialize an already claimed attempt without
    // starting an inference worker. The removal itself uses the public API.
    await tx`select set_config('opengeni.session_inference_claim', '1', true)`;
    await tx`update sessions set active_turn_id = ${live.turnId}, status = 'running' where id = ${live.sessionId}`;
    await tx`update session_turns set status = 'running', active_attempt_id = ${attemptId} where id = ${live.turnId}`;
    await tx`insert into session_turn_attempts (id, account_id, workspace_id, session_id, turn_id, execution_generation,
      state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id, verified_control_revision, mcp_approval_policies)
      values (${attemptId}, ${f.accountId}, ${f.workspace.id}, ${live.sessionId}, ${live.turnId}, 1, 'running',
        ${`membership-${live.turnId}`}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, 0, '{}'::jsonb)`;
  });
  const schedule = await createScheduledTask(db.db, {
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    name: "Member schedule",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: crypto.randomUUID(),
    runMode: "existing_session",
    overlapPolicy: "skip",
    targetSessionId: target.sessionId,
    agentConfig: { prompt: "Review", resources: [], tools: [], metadata: {} },
    createdBy: { kind: "subject", subjectId: f.identity.subjectId },
    metadata: {},
  });
  await f.revoke();
  const rows =
    await shared.admin`select id, status from session_turns where id in (${target.turnId}, ${other.turnId}, ${peer.turnId})`;
  expect(rows.find((row) => row.id === target.turnId)?.status).toBe("cancelled");
  expect(rows.find((row) => row.id === other.turnId)?.status).toBe("queued");
  expect(rows.find((row) => row.id === peer.turnId)?.status).toBe("queued");
  const [childTurn] =
    await shared.admin`select status from session_turns where id = ${child.turnId}`;
  expect(childTurn!.status).toBe("cancelled");
  const [privateSession] =
    await shared.admin`select authority_epoch::int as epoch from sessions where id = ${target.sessionId}`;
  expect(privateSession!.epoch).toBe(2);
  const [task] =
    await shared.admin`select status, authority_revision::int as revision from scheduled_tasks where id = ${schedule.id}`;
  expect(task).toMatchObject({ status: "paused", revision: 2 });
  const [interruption] =
    await shared.admin`select count(*)::int as n from session_attempt_interruptions where attempt_id = ${attemptId}`;
  expect(interruption!.n).toBe(1);
  expect(
    (await f.service.listWorkspaceMembers(otherWorkspace.id)).some(
      (member) => member.subjectId === f.identity.subjectId,
    ),
  ).toBe(true);
  const [wake] =
    await shared.admin`select count(*)::int as n from session_workflow_wake_outbox where session_id = ${target.sessionId}`;
  expect(wake!.n).toBeGreaterThan(0);
});
