import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { OpenGeniClient } from "@opengeni/sdk";
import { type ApiRouteDeps } from "@opengeni/core";
import {
  acquireOwnerMigratedTestDatabase,
  testSettings,
  MemoryEventBus,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import {
  createDb,
  createWorkspace,
  createSession,
  createScheduledTask,
  withSessionRlsActorContext,
  createOrganizationApiKey,
  ensureExternalIdentity,
  migrate,
  provisionRoles,
  withWorkspaceSubjectRls,
  type DbClient,
} from "@opengeni/db";
import { rawRows } from "../../../packages/db/src/database";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";
import { registerOrganizationMembershipRoutes } from "../src/routes/organization-memberships";

let shared: OwnerMigratedTestDatabase;
let db: DbClient;
const appRole = `external_membership_app_${crypto.randomUUID().replaceAll("-", "")}`;
const appPassword = crypto.randomUUID();
beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("external-membership-operations");
  if (!acquired) throw new Error("External membership operations require real PostgreSQL");
  shared = acquired;
  // SECURITY DEFINER does not bypass FORCE RLS for the production migration owner.
  await migrate(shared.ownerUrl, "public", { applicationDatabaseRoles: [appRole] });
  await provisionRoles(shared.adminUrl, {
    appRole,
    appPassword,
    rlsStrategy: "force",
    artifactOutboxDispatcherPassword: "",
    artifactMaterializerPassword: "",
    hostExportPassword: "",
    temporalPassword: "",
    temporalDatabases: [],
  });
  const appUrl = new URL(shared.adminUrl);
  appUrl.username = appRole;
  appUrl.password = appPassword;
  db = createDb(appUrl.toString());
}, 180_000);
afterAll(async () => {
  try {
    await db?.close();
  } finally {
    if (shared) {
      try {
        if ((await shared.admin`select 1 from pg_roles where rolname = ${appRole}`).length) {
          await shared.admin`DROP OWNED BY ${shared.admin(appRole)}`;
          await shared.admin`DROP ROLE ${shared.admin(appRole)}`;
        }
      } finally {
        await shared.release();
      }
    }
  }
}, 60_000);

test("rolling owner-RLS repair replay preserves definitions, ownership and ACLs", async () => {
  const definitions = () => shared.admin`select p.proname, pg_get_functiondef(p.oid) as definition,
    p.proowner, p.proacl::text as acl from pg_proc p
    where p.oid in ('prepare_workspace_membership_removal_settlements(jsonb)'::regprocedure,
      'workspace_membership_removal_command(jsonb)'::regprocedure) order by p.proname`;
  const before = await definitions();
  const repair = await Bun.file(
    new URL(
      "../../../packages/db/drizzle/0558_external_membership_removal_owner_rls.sql",
      import.meta.url,
    ),
  ).text();
  const owner = postgres(shared.ownerUrl, { max: 1 });
  try {
    // Simulate SQL commit followed by a lost migration-ledger receipt. Replay
    // must work under the same non-bypass owner, not merely skip via migrate().
    await owner.begin(async (tx) => {
      await tx.unsafe(repair);
    });
    await owner.begin(async (tx) => {
      await tx.unsafe(repair);
    });
    expect(await definitions()).toEqual(before);
  } finally {
    await owner.end();
  }
  await migrate(shared.ownerUrl, "public", { applicationDatabaseRoles: [appRole] });
  expect(await definitions()).toEqual(before);
}, 180_000);

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

test.each([
  "prepare_workspace_membership_removal_settlements",
  "workspace_membership_removal_command",
] as const)(
  "%s scopes its owner-only membership reads without leaking authority",
  async (routine) => {
    const f = await fixture();
    const actorSubjectId = `api_key:${f.key.id}`;
    const [posture] = await shared.admin`select r.rolsuper, r.rolbypassrls, p.prosecdef,
    c.relforcerowsecurity,
      has_table_privilege(${appRole}, c.oid, 'INSERT,UPDATE,DELETE') as app_can_write,
      has_table_privilege(${appRole}, 'opengeni_private.session_tenancy_fenced_access_capabilities', 'SELECT,INSERT,UPDATE,DELETE') as app_can_access_capabilities
    from pg_proc p join pg_roles r on r.oid = p.proowner
    cross join pg_class c where p.oid = ${`${routine}(jsonb)`}::regprocedure
      and c.oid = 'organization_memberships'::regclass`;
    expect(posture).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      prosecdef: true,
      relforcerowsecurity: true,
      app_can_write: false,
      app_can_access_capabilities: false,
    });
    const command = {
      action: "remove",
      organizationId: f.accountId,
      workspaceId: f.workspace.id,
      actorSubjectId,
      targetSubjectId: f.identity.subjectId,
      operationId: crypto.randomUUID(),
    };
    const call = (workspaceId = f.workspace.id) =>
      sql`select ${sql.raw(routine)}(${JSON.stringify({ ...command, workspaceId })}::jsonb) as result`;
    // The public boolean oracle is not authorization: pass the real owner to
    // observe leaked invocation tokens, and current_user to pin app isolation.
    const capabilityState = sql`select session_tenancy_fence_owner_policy_active(
      ${shared.ownerRole}, ${shared.ownerRole}, 'public'::regnamespace::oid,
      ${f.workspace.id}::uuid, false) as owner_active,
      session_tenancy_fence_owner_policy_active(current_user, ${shared.ownerRole},
        'public'::regnamespace::oid, ${f.workspace.id}::uuid, false) as app_active`;
    await withWorkspaceSubjectRls(db.db, f.workspace.id, actorSubjectId, async (tx) => {
      await tx.execute(
        sql`select set_config('opengeni.organization_tenancy_lifecycle', 'test:outer', true)`,
      );
      const marker = async () =>
        rawRows(
          tx,
          sql`select current_setting('opengeni.organization_tenancy_lifecycle') as marker`,
        );
      const [row] = await rawRows(tx, call());
      expect(row?.result).toEqual(routine.startsWith("prepare_") ? [] : { removed: false });
      expect(await marker()).toEqual([{ marker: "test:outer" }]);
      expect(await rawRows(tx, capabilityState)).toEqual([
        { owner_active: false, app_active: false },
      ]);
      // A caller-supplied lifecycle marker grants no direct app access.
      await tx.execute(
        sql`select set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true)`,
      );
      await expect(
        tx.transaction(async (nested) =>
          rawRows(nested, sql`select id from organization_memberships`),
        ),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
      await tx.execute(
        sql`select set_config('opengeni.organization_tenancy_lifecycle', 'test:outer', true)`,
      );
    });
    await f.add();
    await withWorkspaceSubjectRls(db.db, f.workspace.id, actorSubjectId, async (tx) => {
      await tx.execute(
        sql`select set_config('opengeni.organization_tenancy_lifecycle', 'test:outer', true)`,
      );
      const [row] = await rawRows(tx, call());
      if (routine.startsWith("prepare_")) expect(row?.result).toEqual([]);
      else expect(row?.result).toMatchObject({ removed: true });
      expect(
        await rawRows(
          tx,
          sql`select current_setting('opengeni.organization_tenancy_lifecycle') as marker`,
        ),
      ).toEqual([{ marker: "test:outer" }]);
      expect(await rawRows(tx, capabilityState)).toEqual([
        { owner_active: false, app_active: false },
      ]);
    });
    // End the key's FOR SHARE lock before revoking it through the fixture pool.
    await shared.admin`update api_keys set revoked_at = now() where id = ${f.key.id}`;
    await withWorkspaceSubjectRls(db.db, f.workspace.id, actorSubjectId, async (tx) => {
      await tx.execute(
        sql`select set_config('opengeni.organization_tenancy_lifecycle', 'test:outer', true)`,
      );
      // Live service authority still applies, and an exceptional exit restores
      // the caller's marker just like the no-membership early return above.
      await expect(tx.transaction(async (nested) => rawRows(nested, call()))).rejects.toMatchObject(
        {
          cause: { code: "42501", message: "workspace member administration required" },
        },
      );
      expect(
        await rawRows(
          tx,
          sql`select current_setting('opengeni.organization_tenancy_lifecycle') as marker`,
        ),
      ).toEqual([{ marker: "test:outer" }]);
      expect(await rawRows(tx, capabilityState)).toEqual([
        { owner_active: false, app_active: false },
      ]);
    });
    await shared.admin`update api_keys set revoked_at = null where id = ${f.key.id}`;
    // Seeing the target organization row must not make its Personal workspace
    // administrable through either native removal pass.
    await expect(
      withWorkspaceSubjectRls(db.db, f.identity.personalWorkspaceId, actorSubjectId, async (tx) =>
        rawRows(tx, call(f.identity.personalWorkspaceId)),
      ),
    ).rejects.toMatchObject({ cause: { code: "P0002", message: "shared workspace not found" } });
  },
  30_000,
);

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
  // The legacy human timestamp-CAS variant does not derive verified
  // organization administration from this service request.
  const membersBeforeNativeRevoke = await f.members();
  await expect(
    f.service.revokeOrganizationWorkspaceMember(
      f.accountId,
      f.workspace.id,
      f.identity.organizationMembershipId,
      { operationId: crypto.randomUUID(), expectedUpdatedAt: new Date().toISOString() },
    ),
  ).rejects.toMatchObject({
    status: 403,
    body: JSON.stringify({ message: "organization administration is not authorized" }),
  });
  expect(await f.members()).toEqual(membersBeforeNativeRevoke);
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
    await shared.admin.begin(async (tx) => {
      // The seed still runs through owner-owned triggers; give them the same
      // runtime protocol and tenant/actor scope as a real accepted turn.
      await tx`select set_config('opengeni.session_variable_set_attachments_v1', '1', true),
        set_config('opengeni.account_id', ${f.accountId}, true),
        set_config('opengeni.workspace_id', ${workspaceId}, true),
        set_config('opengeni.subject_id', ${subjectId}, true)`;
      await tx`insert into session_turns (id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, execution_generation, position, prompt, model, reasoning_effort,
        latency_mode, sandbox_backend, initiator_kind, initiator_subject_id, initiating_human_subject_id)
        values (${turnId}, ${f.accountId}, ${workspaceId}, ${session.id}, ${crypto.randomUUID()}, ${`membership-${turnId}`},
          'queued', 1, 1, 'Queued work', 'test-model', 'medium', 'standard', 'none', 'subject', ${subjectId}, ${subjectId})`;
    });
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
    await tx`select set_config('opengeni.session_inference_claim', '1', true),
      set_config('opengeni.session_variable_set_attachments_v1', '1', true),
      set_config('opengeni.account_id', ${f.accountId}, true),
      set_config('opengeni.workspace_id', ${f.workspace.id}, true),
      set_config('opengeni.subject_id', ${f.identity.subjectId}, true)`;
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

test("keyed permission updates widen, narrow, and replay without teardown", async () => {
  const f = await fixture();
  await f.add();
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${f.accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'external-membership-update-test')`;
  await shared.admin`insert into organization_private_session_settings (account_id, enabled, version, updated_by_membership_id)
    values (${f.accountId}, true, 1, null) on conflict (account_id) do update set enabled = true`;
  const privateSession = await withSessionRlsActorContext({ subjectId: f.identity.subjectId }, () =>
    createSession(db.db, {
      accountId: f.accountId,
      workspaceId: f.workspace.id,
      initialMessage: "Member work",
      resources: [],
      metadata: {},
      visibility: "user_private",
      createdBy: { kind: "subject", subjectId: f.identity.subjectId },
      subjectId: f.identity.subjectId,
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    }),
  );
  const membershipId = f.identity.organizationMembershipId;
  const update = (operationId: string, permissions: string[]) =>
    f.service.updateExternalWorkspaceMember(f.accountId, f.workspace.id, membershipId, {
      operationId,
      permissions: permissions as never,
    });
  const permissionsNow = async () =>
    [
      ...((await f.members()).find((member) => member.subjectId === f.identity.subjectId)
        ?.permissions ?? []),
    ].sort();
  const revision = async () =>
    (
      (await f.service.lookupExternalIdentity(f.accountId, f.reference)) as {
        membershipAuthorizationRevision: number;
        identityAuthorizationRevision: number;
      }
    ).membershipAuthorizationRevision;

  // Widening only rewrites the set.
  const widenId = crypto.randomUUID();
  expect(await update(widenId, ["sessions:read", "workspace:read"])).toEqual({
    subjectId: f.identity.subjectId,
    organizationMembershipId: membershipId,
    permissions: ["sessions:read", "workspace:read"],
    narrowed: false,
    replay: false,
  });
  expect(await permissionsNow()).toEqual(["sessions:read", "workspace:read"]);
  expect(await revision()).toBe(1);

  // An exact replay returns the stored receipt; a changed body is refused.
  expect(await update(widenId, ["workspace:read", "sessions:read"])).toMatchObject({
    narrowed: false,
    replay: true,
  });
  await expect(update(widenId, ["workspace:read"])).rejects.toMatchObject({ status: 409 });

  // Narrowing advances the authorization revision but tears nothing down.
  const narrowId = crypto.randomUUID();
  expect(await update(narrowId, ["workspace:read"])).toMatchObject({
    permissions: ["workspace:read"],
    narrowed: true,
    replay: false,
  });
  expect(await permissionsNow()).toEqual(["workspace:read"]);
  expect(await revision()).toBe(2);
  const [identityRow] =
    await shared.admin`select authorization_revision::int as revision, status from external_identities where organization_membership_id = ${membershipId}`;
  expect(identityRow).toEqual({ revision: 2, status: "active" });
  const [sessionRow] =
    await shared.admin`select status, authority_epoch::int as epoch from sessions where id = ${privateSession.id}`;
  expect(sessionRow).toEqual({ status: privateSession.status, epoch: 1 });

  // A replay after a later change still answers the original receipt.
  expect(await update(widenId, ["sessions:read", "workspace:read"])).toMatchObject({
    permissions: ["sessions:read", "workspace:read"],
    replay: true,
  });
  expect(await permissionsNow()).toEqual(["workspace:read"]);

  const [events] =
    await shared.admin`select count(*)::int as n from organization_workspace_lifecycle_events where account_id = ${f.accountId} and kind = 'update'`;
  expect(events!.n).toBe(2);

  // Authority, target, and membership failures are client errors.
  await expect(update(crypto.randomUUID(), ["secrets:write"])).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    f.service.updateExternalWorkspaceMember(f.accountId, f.workspace.id, crypto.randomUUID(), {
      operationId: crypto.randomUUID(),
      permissions: ["workspace:read"],
    }),
  ).rejects.toMatchObject({ status: 404 });
  const otherWorkspace = await createWorkspace(db.db, {
    accountId: f.accountId,
    name: "Workspace without the member",
  });
  await expect(
    f.service.updateExternalWorkspaceMember(f.accountId, otherWorkspace.id, membershipId, {
      operationId: crypto.randomUUID(),
      permissions: ["workspace:read"],
    }),
  ).rejects.toMatchObject({ status: 404 });
}, 180_000);
