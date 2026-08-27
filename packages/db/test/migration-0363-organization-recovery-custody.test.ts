import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";

import {
  acceptOrganizationRecoveryCustody,
  acquireManagedAuthActorMutationLease,
  applyCanonicalHumanIdentityOperation,
  approveOrganizationRecoveryOperation,
  bootstrapManagedAuthSessionSet,
  cancelOrganizationRecoveryOperation,
  configureOrganizationRecoveryPolicy,
  createDb,
  disableOrganizationRecoveryPolicy,
  ensureManagedAccessForUser,
  executeOrganizationRecoveryOperation,
  getCanonicalHumanIdentityProjection,
  getOrganizationRecoveryOverview,
  listSelfOrganizationMemberships,
  nestedPostgresSqlState,
  prepareOrganizationRecoveryNotifications,
  reconcileOrganizationRecoveryNotification,
  releaseManagedAuthActorMutationLease,
  settleOrganizationRecoveryNotification,
  startOrganizationRecoveryOperation,
  synchronizeCanonicalHumanLoginBindings,
  updateOrganizationMember,
  type DbClient,
  type OrganizationRecoveryActorFence,
  type OrganizationRecoveryMutationResult,
  OrganizationRecoveryDeniedError,
  OrganizationRecoveryOperationReuseError,
  OrganizationRecoveryUnavailableError,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { FORCE_RLS_TABLES, PROTECTED_NO_DIRECT_DML_TABLES } from "../src/runtime-posture";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const migrationSource = readFileSync(
  new URL("../drizzle/0363_organization_recovery_custody.sql", import.meta.url),
  "utf8",
);

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let ownerClient: DbClient | null = null;
let app: postgres.Sql | null = null;

const recoveryTables = [
  "organization_recovery_policies",
  "organization_recovery_policy_heads",
  "organization_recovery_custodians",
  "organization_recovery_custodian_acceptances",
  "organization_recovery_operations",
  "organization_recovery_approvals",
  "organization_recovery_command_receipts",
  "organization_recovery_events",
  "organization_recovery_notification_outbox",
  "organization_recovery_notification_attempts",
] as const;

type RecoveryActor = {
  userId: string;
  subjectId: string;
  membershipId: string;
  authorizationRevision: number;
  identityId: string;
  sessionId: string;
  authorityHash: string;
  actorEpoch: string;
};

type Ceremony = {
  organizationId: string;
  owner: RecoveryActor;
  custodians: [RecoveryActor, RecoveryActor, RecoveryActor];
  target: RecoveryActor;
  policyRevision: number;
  linkedCustodianLogin: RecoveryActor | undefined;
};

const hex = (value: string) => createHash("sha256").update(value).digest("hex");

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-0363-organization-recovery");
  if (!owned) {
    if (requireRealDatabase) throw new Error("migration 0363 requires real PostgreSQL");
    return;
  }
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, {
    appPassword: owned.appPassword,
    rlsStrategy: "force",
  });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 12, rlsStrategy: "force" });
  ownerClient = createDb(owned.ownerUrl, { max: 8, rlsStrategy: "force" });
  app = postgres(appUrl.toString(), {
    max: 4,
    prepare: false,
    onnotice: () => undefined,
  });
}, 900_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await ownerClient?.close().catch(() => undefined);
  await app?.end({ timeout: 5 }).catch(() => undefined);
  await owned?.release();
}, 180_000);

async function attachManagedLogin(input: {
  userId: string;
  label: string;
  membershipId: string;
  authorizationRevision: number;
}): Promise<RecoveryActor> {
  if (!owned || !client) throw new Error("test database unavailable");
  const email = `${input.userId}@example.test`;
  await owned.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${input.userId}, ${input.label}, ${email}, true)
    on conflict (id) do update set name = excluded.name, email = excluded.email,
      email_verified = true`;
  await owned.admin`
    insert into auth_identities (id, user_id, provider_id, account_id, created_at, updated_at)
    values (${crypto.randomUUID()}, ${input.userId}, 'credential', ${input.userId}, now(), now())
    on conflict (provider_id, account_id) do nothing`;
  await synchronizeCanonicalHumanLoginBindings(client.db, input.userId);
  return await createManagedLoginFromBinding({
    userId: input.userId,
    membershipId: input.membershipId,
    authorizationRevision: input.authorizationRevision,
    providerId: "credential",
  });
}

async function createManagedLoginFromBinding(input: {
  userId: string;
  membershipId: string;
  authorizationRevision: number;
  providerId: string;
}): Promise<RecoveryActor> {
  if (!owned || !client) throw new Error("test database unavailable");
  const identity = await getCanonicalHumanIdentityProjection(client.db, input.userId);
  const binding = identity.loginBindings.find(
    (candidate) => candidate.providerId === input.providerId && candidate.status === "active",
  );
  if (!binding) throw new Error(`${input.providerId} binding was not synchronized`);
  const sessionId = crypto.randomUUID();
  await owned.admin`
    insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision,
      login_binding_id, login_binding_revision
    ) values (
      ${sessionId}, ${input.userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.activeIdentity.id}::uuid, ${identity.activeIdentity.identityRevision},
      ${identity.activeIdentity.authRevision}, ${binding.id}::uuid, ${binding.revision}
    )`;
  const authorityHash = hex(`recovery-authority:${crypto.randomUUID()}`);
  const snapshot = await bootstrapManagedAuthSessionSet(client.db, {
    authorityHash,
    csrfHash: hex(`csrf:${authorityHash}`),
    authSessionId: sessionId,
    mode: "broker",
    operationId: crypto.randomUUID(),
    requestDigest: hex(`bootstrap:${authorityHash}`),
    expectedGeneration: "1",
    expectedActorEpoch: "1",
  });
  await owned.admin.begin(async (transactionSql) => {
    await transactionSql`select set_config('opengeni.managed_auth_session_set_lifecycle', 'active', true)`;
    await transactionSql`
      insert into managed_auth_session_set_operations (
        operation_id, session_set_id, operation_type, request_digest,
        expected_generation, result_generation, result_actor_epoch,
        target_slot_id, outcome, result, created_at
      ) select
        ${crypto.randomUUID()}::uuid, session_set.id, 'complete_reauth',
        ${hex(`complete-reauth:${authorityHash}`)}, session_set.generation,
        session_set.generation, session_set.actor_epoch, session_set.selected_slot_id,
        'applied', '{}'::jsonb, now()
      from managed_auth_session_sets session_set
      where session_set.authority_hash = ${authorityHash}`;
  });
  return {
    userId: input.userId,
    subjectId: `user:${input.userId}`,
    membershipId: input.membershipId,
    authorizationRevision: input.authorizationRevision,
    identityId: identity.activeIdentity.id,
    sessionId,
    authorityHash,
    actorEpoch: snapshot.actorEpoch,
  };
}

async function addSecondLinkedManagedLogin(
  actor: RecoveryActor,
): Promise<[RecoveryActor, RecoveryActor]> {
  if (!owned || !client) throw new Error("test database unavailable");
  await owned.admin`
    insert into auth_identities (id, user_id, provider_id, account_id, created_at, updated_at)
    values (
      ${crypto.randomUUID()}, ${actor.userId}, 'github', ${`github-${actor.userId}`}, now(), now()
    )`;
  await synchronizeCanonicalHumanLoginBindings(client.db, actor.userId);
  return await Promise.all([
    createManagedLoginFromBinding({
      userId: actor.userId,
      membershipId: actor.membershipId,
      authorizationRevision: actor.authorizationRevision,
      providerId: "credential",
    }),
    createManagedLoginFromBinding({
      userId: actor.userId,
      membershipId: actor.membershipId,
      authorizationRevision: actor.authorizationRevision,
      providerId: "github",
    }),
  ]);
}

async function createMember(
  organizationId: string,
  label: string,
  role: "member" | "admin" = "member",
): Promise<RecoveryActor> {
  if (!owned) throw new Error("test database unavailable");
  const userId = `recovery-${crypto.randomUUID()}`;
  const membershipId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  await owned.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${label}, ${`${userId}@example.test`}, true)`;
  await owned.admin`
    insert into workspaces (id, account_id, name)
    values (${workspaceId}, ${organizationId}, ${`${label} Personal`})`;
  await owned.admin`
    insert into organization_memberships (
      id, account_id, subject_id, role, status, personal_workspace_id
    ) values (
      ${membershipId}, ${organizationId}, ${`user:${userId}`}, ${role}, 'active', ${workspaceId}
    )`;
  return await attachManagedLogin({
    userId,
    label,
    membershipId,
    authorizationRevision: 1,
  });
}

async function createCeremony(input?: { linkFirstCustodianLogin?: boolean }): Promise<Ceremony> {
  if (!owned || !client) throw new Error("test database unavailable");
  const ownerUserId = `recovery-owner-${crypto.randomUUID()}`;
  await ensureManagedAccessForUser(client.db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Recovery Owner",
  });
  const [ownerMembership] = await listSelfOrganizationMemberships(client.db, `user:${ownerUserId}`);
  if (!ownerMembership) throw new Error("owner membership was not provisioned");
  const owner = await attachManagedLogin({
    userId: ownerUserId,
    label: "Recovery Owner",
    membershipId: ownerMembership.id,
    authorizationRevision: ownerMembership.authorizationRevision,
  });
  const organizationId = ownerMembership.organizationId;
  const custodians = (await Promise.all([
    createMember(organizationId, "Recovery Custodian One"),
    createMember(organizationId, "Recovery Custodian Two"),
    createMember(organizationId, "Recovery Custodian Three"),
  ])) as [RecoveryActor, RecoveryActor, RecoveryActor];
  let linkedCustodianLogin: RecoveryActor | undefined;
  if (input?.linkFirstCustodianLogin) {
    [custodians[0], linkedCustodianLogin] = await addSecondLinkedManagedLogin(custodians[0]);
  }
  const target = await createMember(organizationId, "Recovery Target");

  const configured = await withActorFence(owner, (actorFence) =>
    configureOrganizationRecoveryPolicy(client!.db, {
      organizationId,
      actorSubjectId: owner.subjectId,
      actorAuthUserId: owner.userId,
      actorAuthSessionId: owner.sessionId,
      operationId: crypto.randomUUID(),
      actorFence,
      expectedPolicyRevision: 0,
      custodianMembershipIds: custodians.map((actor) => actor.membershipId) as [
        string,
        string,
        string,
      ],
    }),
  );
  expect(configured.replay).toBe(false);
  expect(configured.overview.policy?.state).toBe("pending_acceptance");
  for (const custodian of custodians) {
    const accepted = await withActorFence(custodian, (actorFence) =>
      acceptOrganizationRecoveryCustody(client!.db, {
        organizationId,
        actorSubjectId: custodian.subjectId,
        actorAuthUserId: custodian.userId,
        actorAuthSessionId: custodian.sessionId,
        operationId: crypto.randomUUID(),
        actorFence,
        expectedPolicyRevision: configured.overview.policy!.revision,
      }),
    );
    expect(accepted.overview.policy?.custodians.filter((row) => row.acceptedAt)).toHaveLength(
      custodians.indexOf(custodian) + 1,
    );
  }
  const overview = await getOverviewFor(owner, organizationId);
  expect(overview.availability).toBe("available");
  expect(overview.policy?.state).toBe("active");
  return {
    organizationId,
    owner,
    custodians,
    target,
    policyRevision: overview.policy!.revision,
    linkedCustodianLogin,
  };
}

async function withActorFence<T>(
  actor: RecoveryActor,
  action: (fence: OrganizationRecoveryActorFence) => Promise<T>,
): Promise<T> {
  if (!client) throw new Error("test database unavailable");
  const requestId = crypto.randomUUID();
  await acquireManagedAuthActorMutationLease(client.db, {
    authorityHash: actor.authorityHash,
    actorEpoch: actor.actorEpoch,
    requestId,
    leaseSeconds: 60,
  });
  try {
    return await action({
      authorityHash: actor.authorityHash,
      actorEpoch: actor.actorEpoch,
      requestId,
    });
  } finally {
    await releaseManagedAuthActorMutationLease(client.db, {
      authorityHash: actor.authorityHash,
      requestId,
    }).catch(() => undefined);
  }
}

async function getOverviewFor(actor: RecoveryActor, organizationId: string, includeProof = true) {
  if (!client) throw new Error("test database unavailable");
  return await getOrganizationRecoveryOverview(client.db, {
    organizationId,
    actorSubjectId: actor.subjectId,
    actorAuthUserId: actor.userId,
    actorAuthSessionId: actor.sessionId,
    actorFence: includeProof
      ? {
          authorityHash: actor.authorityHash,
          actorEpoch: actor.actorEpoch,
        }
      : null,
  });
}

async function startAndReachQuorum(
  ceremony: Ceremony,
): Promise<OrganizationRecoveryMutationResult> {
  const [first, second] = ceremony.custodians;
  const started = await withActorFence(first, (actorFence) =>
    startOrganizationRecoveryOperation(client!.db, {
      organizationId: ceremony.organizationId,
      actorSubjectId: first.subjectId,
      actorAuthUserId: first.userId,
      actorAuthSessionId: first.sessionId,
      operationId: crypto.randomUUID(),
      actorFence,
      expectedPolicyRevision: ceremony.policyRevision,
      targetMembershipId: ceremony.target.membershipId,
    }),
  );
  const operationId = started.overview.operation!.id;
  const firstApproval = await withActorFence(first, (actorFence) =>
    approveOrganizationRecoveryOperation(client!.db, {
      organizationId: ceremony.organizationId,
      actorSubjectId: first.subjectId,
      actorAuthUserId: first.userId,
      actorAuthSessionId: first.sessionId,
      operationId: crypto.randomUUID(),
      actorFence,
      recoveryOperationId: operationId,
      expectedOperationRevision: started.overview.operation!.revision,
    }),
  );
  return await withActorFence(second, (actorFence) =>
    approveOrganizationRecoveryOperation(client!.db, {
      organizationId: ceremony.organizationId,
      actorSubjectId: second.subjectId,
      actorAuthUserId: second.userId,
      actorAuthSessionId: second.sessionId,
      operationId: crypto.randomUUID(),
      actorFence,
      recoveryOperationId: operationId,
      expectedOperationRevision: firstApproval.overview.operation!.revision,
    }),
  );
}

async function elapseCooldown(operationId: string): Promise<void> {
  if (!owned) throw new Error("test database unavailable");
  await owned.admin.begin(async (transactionSql) => {
    await transactionSql`select set_config('opengeni.organization_recovery_lifecycle', 'active', true)`;
    await transactionSql`update organization_recovery_operations set
      quorum_at = now() - interval '7 days',
      executable_at = now(), revision = revision + 1, updated_at = now()
      where id = ${operationId}::uuid`;
  });
}

async function setCooldownBoundary(operationId: string, delayMs: number): Promise<void> {
  if (!owned) throw new Error("test database unavailable");
  await owned.admin.begin(async (transactionSql) => {
    await transactionSql`select set_config('opengeni.organization_recovery_lifecycle', 'active', true)`;
    await transactionSql`with boundary as (
      select clock_timestamp() + ${`${delayMs} milliseconds`}::interval as value
    ) update organization_recovery_operations set
      quorum_at = boundary.value - interval '7 days',
      executable_at = boundary.value, revision = revision + 1, updated_at = now()
      from boundary where id = ${operationId}::uuid`;
  });
}

async function setExpiryBoundary(operationId: string, delayMs: number): Promise<void> {
  if (!owned) throw new Error("test database unavailable");
  await owned.admin.begin(async (transactionSql) => {
    await transactionSql`select set_config('opengeni.organization_recovery_lifecycle', 'active', true)`;
    await transactionSql`with boundary as (
      select clock_timestamp() + ${`${delayMs} milliseconds`}::interval as value
    ) update organization_recovery_operations set
      created_at = boundary.value - interval '30 days', expires_at = boundary.value,
      updated_at = now()
      from boundary where id = ${operationId}::uuid`;
  });
}

async function waitForBlockedRecoveryCommand(timeoutMs = 10_000): Promise<void> {
  if (!owned) throw new Error("test database unavailable");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [activity] = await owned.admin<Array<{ blocked: boolean }>>`
      select exists (
        select 1 from pg_stat_activity
        where pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
          and query ilike '%organization_recovery_command%'
      ) as blocked`;
    if (activity?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("organization recovery command did not block on custody evidence");
}

describe("migration 0363 organization recovery custody", () => {
  test("is rolling, fixed-path, FORCE-RLS, append-only, and revision-fenced", async () => {
    expect(migrationSource.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(migrationSource).toContain("FORCE ROW LEVEL SECURITY");
    expect(migrationSource).toContain("actorAuthSessionId");
    expect(migrationSource).toContain("operation.operation_type = 'complete_reauth'");
    expect(migrationSource).not.toContain("reauthOperationId', '')");
    expect(migrationSource).toContain("p_command - 'actorFence' - 'actorAuthSessionId'");
    for (const stamp of [
      "membership.authorization_revision = acceptance.membership_authorization_revision",
      "identity_row.identity_revision = acceptance.identity_revision",
      "identity_row.auth_revision = acceptance.auth_revision",
      "subject_row.revision = acceptance.subject_revision",
      "binding.revision = acceptance.login_binding_revision",
    ]) {
      expect(migrationSource).toContain(stamp);
    }
    expect(migrationSource).toContain("interval '7 days'");
    expect(migrationSource).toContain("interval '30 days'");
    expect(migrationSource).toContain('"expires_at" = "created_at" + interval \'30 days\'');
    expect(migrationSource).toContain("claim_expired");
    expect(migrationSource).toContain("reconciled_retry");
    expect(migrationSource).toContain("ORDER BY outbox.created_at, outbox.id\n    LIMIT p_limit");
    expect(migrationSource).toContain("organization_recovery_lock_policy_evidence");
    expect(migrationSource).toContain("FOR UPDATE OF identity_row");
    expect(migrationSource).toContain("FOR UPDATE OF binding");
    expect(migrationSource).toContain("'reason', 'policy_rotated'");
    expect(migrationSource).toContain("'reason', 'policy_disabled'");
    expect(migrationSource).toContain("'operation_expired'");
    expect(migrationSource).toContain(
      "head_row.enabled AND policy_state = 'active' AND valid_acceptances = 3",
    );
    for (const table of recoveryTables) {
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain(table);
    }
    if (!owned || !app) return;
    const functions = await owned.admin<
      Array<{ name: string; settings: string[] | null; publicExecute: boolean }>
    >`
      select procedure.proname as name, procedure.proconfig as settings,
        exists (
          select 1 from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = current_schema()
        and procedure.proname like '%organization_recovery%'
      order by procedure.proname`;
    expect(functions.length).toBeGreaterThanOrEqual(9);
    for (const routine of functions) {
      expect(routine.publicExecute).toBe(false);
      expect(routine.settings?.[0]).toContain("search_path=pg_catalog,");
      expect(routine.settings?.[0]).toContain(", pg_temp");
    }
    await expectSqlState(() => app!`select * from organization_recovery_events`, "42501");
    await expectSqlState(
      () =>
        app!`insert into organization_recovery_command_receipts (
          account_id, operation_id, action, actor_membership_id, actor_identity_id,
          input_hash, result
        ) values (
          ${crypto.randomUUID()}, ${crypto.randomUUID()}, 'configure_policy',
          ${crypto.randomUUID()}, ${crypto.randomUUID()}, ${"0".repeat(64)}, '{}'::jsonb
        )`,
      "42501",
    );
    await expectSqlState(
      () =>
        ownerClient!.db.execute(sql`insert into organization_recovery_events (
          account_id, event_type, event_revision
        ) values (${crypto.randomUUID()}::uuid, 'policy_configured', 1)`),
      "42501",
    );
  });

  test("executes the exact 3-of-3 enrollment, 2-of-3 quorum, replay, and notification lifecycle", async () => {
    if (!owned || !client || !ownerClient || !app) return;
    const ceremony = await createCeremony();
    const ownerOverview = await getOverviewFor(ceremony.owner, ceremony.organizationId);
    expect(ownerOverview.eligibleMembers).toHaveLength(4);
    expect(ownerOverview.capabilities).toMatchObject({
      configure: true,
      disable: true,
    });
    expect(ownerOverview.recentReauthenticationAt).not.toBeNull();
    await expectSqlState(
      () =>
        updateOrganizationMember(client!.db, {
          organizationId: ceremony.organizationId,
          actorSubjectId: ceremony.owner.subjectId,
          operationId: crypto.randomUUID(),
          membershipId: ceremony.owner.membershipId,
          transition: {
            kind: "offboard",
            expectedAuthorizationRevision: ceremony.owner.authorizationRevision,
            operationId: crypto.randomUUID(),
          },
        }),
      "55000",
    );
    const [soleOwner] = await owned.admin<Array<{ status: string; role: string }>>`
      select status, role from organization_memberships
      where id = ${ceremony.owner.membershipId}::uuid`;
    expect(soleOwner).toEqual({ status: "active", role: "owner" });
    const proofAbsent = await getOverviewFor(ceremony.owner, ceremony.organizationId, false);
    expect(proofAbsent.recentReauthenticationAt).toBeNull();
    expect(Object.values(proofAbsent.capabilities).every((value) => !value)).toBe(true);
    await owned.admin`update auth_sessions set expires_at = now() - interval '1 minute'
      where id = ${ceremony.owner.sessionId}`;
    const proofExpired = await getOverviewFor(ceremony.owner, ceremony.organizationId);
    expect(proofExpired.recentReauthenticationAt).toBeNull();
    expect(Object.values(proofExpired.capabilities).every((value) => !value)).toBe(true);
    expect(ownerOverview.policy?.custodians.map((row) => row.name)).toEqual([
      "Recovery Custodian One",
      "Recovery Custodian Two",
      "Recovery Custodian Three",
    ]);
    await expect(getOverviewFor(ceremony.target, ceremony.organizationId)).rejects.toBeInstanceOf(
      OrganizationRecoveryDeniedError,
    );
    const [shadowedOverview] = await app.begin(async (transactionSql) => {
      await transactionSql`select
        set_config('opengeni.account_id', ${ceremony.organizationId}, true),
        set_config('opengeni.workspace_id', '', true),
        set_config('opengeni.subject_id', ${ceremony.owner.subjectId}, true)`;
      await transactionSql`create temporary table organization_memberships (
        account_id uuid, subject_id text, status text
      ) on commit drop`;
      await transactionSql`create temporary table organization_recovery_policy_heads (
        account_id uuid, current_policy_id uuid, revision bigint
      ) on commit drop`;
      return await transactionSql<Array<{ result: typeof ownerOverview }>>`
        select get_organization_recovery_overview(
          ${ceremony.organizationId}::uuid, ${ceremony.owner.subjectId}::text,
          ${JSON.stringify({
            authorityHash: ceremony.owner.authorityHash,
            actorEpoch: ceremony.owner.actorEpoch,
            requestId: crypto.randomUUID(),
          })}::jsonb,
          ${ceremony.owner.sessionId}::text, ${ceremony.owner.userId}::text
        ) as result`;
    });
    expect(shadowedOverview?.result.policy?.id).toBe(ownerOverview.policy?.id);

    const quorum = await startAndReachQuorum(ceremony);
    expect(quorum.overview.operation).toMatchObject({
      state: "cooling",
      approvalCount: 2,
      notificationJournaled: true,
    });
    expect(quorum.overview.operation?.approvals.map((approval) => approval.name)).toEqual([
      "Recovery Custodian One",
      "Recovery Custodian Two",
    ]);
    const operationId = quorum.overview.operation!.id;

    const replayOperationId = crypto.randomUUID();
    const third = ceremony.custodians[2];
    const approved = await withActorFence(third, (actorFence) =>
      approveOrganizationRecoveryOperation(client!.db, {
        organizationId: ceremony.organizationId,
        actorSubjectId: third.subjectId,
        actorAuthUserId: third.userId,
        actorAuthSessionId: third.sessionId,
        operationId: replayOperationId,
        actorFence,
        recoveryOperationId: operationId,
        expectedOperationRevision: quorum.overview.operation!.revision,
      }),
    );
    const replayed = await withActorFence(third, (actorFence) =>
      approveOrganizationRecoveryOperation(client!.db, {
        organizationId: ceremony.organizationId,
        actorSubjectId: third.subjectId,
        actorAuthUserId: third.userId,
        actorAuthSessionId: third.sessionId,
        operationId: replayOperationId,
        actorFence,
        recoveryOperationId: operationId,
        expectedOperationRevision: quorum.overview.operation!.revision,
      }),
    );
    expect(approved.replay).toBe(false);
    expect(replayed).toEqual({ replay: true, overview: approved.overview });
    await expect(
      withActorFence(third, (actorFence) =>
        approveOrganizationRecoveryOperation(client!.db, {
          organizationId: ceremony.organizationId,
          actorSubjectId: third.subjectId,
          actorAuthUserId: third.userId,
          actorAuthSessionId: third.sessionId,
          operationId: replayOperationId,
          actorFence,
          recoveryOperationId: operationId,
          expectedOperationRevision: approved.overview.operation!.revision,
        }),
      ),
    ).rejects.toBeInstanceOf(OrganizationRecoveryOperationReuseError);

    const [firstClaims, secondClaims] = await Promise.all([
      prepareOrganizationRecoveryNotifications(ownerClient.db, {
        provider: "fake",
        claimOwner: "fake-worker-a",
        limit: 100,
        leaseSeconds: 15,
      }),
      prepareOrganizationRecoveryNotifications(ownerClient.db, {
        provider: "fake",
        claimOwner: "fake-worker-b",
        limit: 100,
        leaseSeconds: 15,
      }),
    ]);
    const claims = [...firstClaims, ...secondClaims];
    expect(new Set(claims.map((claim) => claim.outboxId)).size).toBe(claims.length);
    expect(claims.length).toBeGreaterThanOrEqual(4);
    const ambiguous = claims[0]!;
    const stale = claims[1]!;
    const failed = claims[2]!;
    const unknown = await settleOrganizationRecoveryNotification(ownerClient.db, {
      outboxId: ambiguous.outboxId,
      deliveryId: ambiguous.deliveryId,
      claimOwner: ambiguous.claimOwner,
      phase: "outcome_unknown",
    });
    expect(unknown).toMatchObject({ phase: "outcome_unknown", replay: false });
    expect(
      await settleOrganizationRecoveryNotification(ownerClient.db, {
        outboxId: ambiguous.outboxId,
        deliveryId: ambiguous.deliveryId,
        claimOwner: ambiguous.claimOwner,
        phase: "outcome_unknown",
      }),
    ).toMatchObject({ phase: "outcome_unknown", replay: true });
    expect(
      await settleOrganizationRecoveryNotification(ownerClient.db, {
        outboxId: failed.outboxId,
        deliveryId: failed.deliveryId,
        claimOwner: failed.claimOwner,
        phase: "failed",
        errorClass: "provider_unavailable",
      }),
    ).toMatchObject({ phase: "failed", replay: false });
    expect(
      (
        await prepareOrganizationRecoveryNotifications(ownerClient.db, {
          provider: "fake",
          claimOwner: "fake-worker-c",
          limit: 100,
          leaseSeconds: 30,
        })
      ).some((claim) => claim.outboxId === ambiguous.outboxId),
    ).toBe(false);
    expect(
      (
        await prepareOrganizationRecoveryNotifications(ownerClient.db, {
          provider: "fake",
          claimOwner: "fake-worker-failed-backoff",
          limit: 100,
          leaseSeconds: 30,
        })
      ).some((claim) => claim.outboxId === failed.outboxId),
    ).toBe(false);
    const reconciled = await reconcileOrganizationRecoveryNotification(ownerClient.db, {
      outboxId: ambiguous.outboxId,
      deliveryId: ambiguous.deliveryId,
      reconciliationOwner: "fake-operator",
      resolution: "retry",
    });
    expect(reconciled).toMatchObject({ resolution: "retry", replay: false });
    expect(
      await reconcileOrganizationRecoveryNotification(ownerClient.db, {
        outboxId: ambiguous.outboxId,
        deliveryId: ambiguous.deliveryId,
        reconciliationOwner: "fake-operator",
        resolution: "retry",
      }),
    ).toMatchObject({ resolution: "retry", replay: true });
    const reclaimed = await prepareOrganizationRecoveryNotifications(ownerClient.db, {
      provider: "fake",
      claimOwner: "fake-worker-d",
      limit: 100,
      leaseSeconds: 30,
    });
    expect(reclaimed.find((claim) => claim.outboxId === ambiguous.outboxId)).toMatchObject({
      attemptNumber: 2,
      idempotencyKey: ambiguous.idempotencyKey,
    });
    await new Promise((resolve) => setTimeout(resolve, 15_100));
    const expiredLeaseReclaims = await prepareOrganizationRecoveryNotifications(ownerClient.db, {
      provider: "fake",
      claimOwner: "fake-worker-expired-lease",
      limit: 100,
      leaseSeconds: 30,
    });
    expect(expiredLeaseReclaims.find((claim) => claim.outboxId === stale.outboxId)).toMatchObject({
      attemptNumber: 2,
      idempotencyKey: stale.idempotencyKey,
    });
    const stalePhases = await owned.admin<Array<{ phase: string }>>`
      select phase from organization_recovery_notification_attempts
      where outbox_id = ${stale.outboxId}::uuid
      order by created_at, id`;
    expect(stalePhases.map((row) => row.phase)).toContain("claim_expired");

    const [targetBeforeExecution] = await owned.admin<Array<{ personalWorkspaceId: string }>>`
      select personal_workspace_id as "personalWorkspaceId"
      from organization_memberships where id = ${ceremony.target.membershipId}::uuid`;
    const [ungrantedWorkspace] = await owned.admin<Array<{ id: string }>>`
      insert into workspaces (account_id, name)
      values (${ceremony.organizationId}::uuid, 'Recovery Ungranted Shared Workspace')
      returning id`;
    const [ungrantedBeforeExecution] = await owned.admin<Array<{ count: number }>>`
      select count(*)::integer as count from workspace_memberships
      where workspace_id = ${ungrantedWorkspace!.id}::uuid
        and subject_id = ${ceremony.target.subjectId}`;
    expect(ungrantedBeforeExecution?.count).toBe(0);

    await elapseCooldown(operationId);
    const executable = await getOverviewFor(ceremony.custodians[0], ceremony.organizationId);
    const executeCommandId = crypto.randomUUID();
    const executed = await withActorFence(ceremony.custodians[0], (actorFence) =>
      executeOrganizationRecoveryOperation(client!.db, {
        organizationId: ceremony.organizationId,
        actorSubjectId: ceremony.custodians[0].subjectId,
        actorAuthUserId: ceremony.custodians[0].userId,
        actorAuthSessionId: ceremony.custodians[0].sessionId,
        operationId: executeCommandId,
        actorFence,
        recoveryOperationId: operationId,
        expectedOperationRevision: executable.operation!.revision,
      }),
    );
    expect(executed.overview.operation?.state).toBe("executed");
    const executionReplay = await withActorFence(ceremony.custodians[0], (actorFence) =>
      executeOrganizationRecoveryOperation(client!.db, {
        organizationId: ceremony.organizationId,
        actorSubjectId: ceremony.custodians[0].subjectId,
        actorAuthUserId: ceremony.custodians[0].userId,
        actorAuthSessionId: ceremony.custodians[0].sessionId,
        operationId: executeCommandId,
        actorFence,
        recoveryOperationId: operationId,
        expectedOperationRevision: executable.operation!.revision,
      }),
    );
    expect(executionReplay).toEqual({
      replay: true,
      overview: executed.overview,
    });
    await expect(
      withActorFence(ceremony.custodians[0], (actorFence) =>
        executeOrganizationRecoveryOperation(client!.db, {
          organizationId: ceremony.organizationId,
          actorSubjectId: ceremony.custodians[0].subjectId,
          actorAuthUserId: ceremony.custodians[0].userId,
          actorAuthSessionId: ceremony.custodians[0].sessionId,
          operationId: executeCommandId,
          actorFence,
          recoveryOperationId: operationId,
          expectedOperationRevision: executed.overview.operation!.revision,
        }),
      ),
    ).rejects.toBeInstanceOf(OrganizationRecoveryOperationReuseError);
    await expect(
      withActorFence(ceremony.custodians[0], (actorFence) =>
        executeOrganizationRecoveryOperation(client!.db, {
          organizationId: ceremony.organizationId,
          actorSubjectId: ceremony.custodians[0].subjectId,
          actorAuthUserId: ceremony.custodians[0].userId,
          actorAuthSessionId: ceremony.custodians[0].sessionId,
          operationId: crypto.randomUUID(),
          actorFence,
          recoveryOperationId: operationId,
          expectedOperationRevision: executed.overview.operation!.revision,
        }),
      ),
    ).rejects.toBeInstanceOf(OrganizationRecoveryUnavailableError);
    const [target] = await owned.admin<Array<{ role: string }>>`
      select role from organization_memberships where id = ${ceremony.target.membershipId}::uuid`;
    expect(target?.role).toBe("owner");
    const [ownerCount] = await owned.admin<Array<{ count: number }>>`
      select count(*)::integer as count from organization_memberships
      where account_id = ${ceremony.organizationId} and status = 'active' and role = 'owner'`;
    expect(ownerCount!.count).toBeGreaterThanOrEqual(2);

    const [targetWorkspace] = await owned.admin<Array<{ id: string }>>`
      select personal_workspace_id as id from organization_memberships
      where id = ${ceremony.target.membershipId}::uuid`;
    expect(targetWorkspace?.id).toBe(targetBeforeExecution?.personalWorkspaceId);
    const [ungrantedAfterExecution] = await owned.admin<Array<{ count: number }>>`
      select count(*)::integer as count from workspace_memberships
      where workspace_id = ${ungrantedWorkspace!.id}::uuid
        and subject_id = ${ceremony.target.subjectId}`;
    expect(ungrantedAfterExecution?.count).toBe(0);
    await expectSqlState(
      () =>
        owned!.admin`update workspaces set account_id = ${crypto.randomUUID()}
          where id = ${targetWorkspace!.id}::uuid`,
      "0A000",
    );
    await owned.admin`update workspaces set account_id = account_id
      where id = ${targetWorkspace!.id}::uuid`;
    await expectSqlState(
      () =>
        owned!.admin.begin(async (transactionSql) => {
          await transactionSql`select set_config('opengeni.organization_recovery_lifecycle', 'active', true)`;
          await transactionSql`update organization_recovery_command_receipts set result = '{}'::jsonb
            where account_id = ${ceremony.organizationId}::uuid`;
        }),
      "42501",
    );
  }, 180_000);

  test("deduplicates linked-login evidence by canonical human and denies target self-approval", async () => {
    if (!owned || !client) return;
    const ceremony = await createCeremony({ linkFirstCustodianLogin: true });
    const primary = ceremony.custodians[0];
    const alias = ceremony.linkedCustodianLogin!;
    const duplicateAcceptance = await withActorFence(alias, (actorFence) =>
      acceptOrganizationRecoveryCustody(client!.db, {
        organizationId: ceremony.organizationId,
        actorSubjectId: alias.subjectId,
        actorAuthUserId: alias.userId,
        actorAuthSessionId: alias.sessionId,
        operationId: crypto.randomUUID(),
        actorFence,
        expectedPolicyRevision: ceremony.policyRevision,
      }),
    );
    expect(duplicateAcceptance.replay).toBe(false);
    const [acceptanceEvidence] = await owned.admin<Array<{ count: number }>>`
      select count(*)::integer as count
      from organization_recovery_custodian_acceptances
      where policy_id = ${duplicateAcceptance.overview.policy!.id}::uuid
        and canonical_identity_id = ${primary.identityId}::uuid`;
    expect(acceptanceEvidence?.count).toBe(1);

    const started = await withActorFence(primary, (actorFence) =>
      startOrganizationRecoveryOperation(client!.db, {
        organizationId: ceremony.organizationId,
        actorSubjectId: primary.subjectId,
        actorAuthUserId: primary.userId,
        actorAuthSessionId: primary.sessionId,
        operationId: crypto.randomUUID(),
        actorFence,
        expectedPolicyRevision: ceremony.policyRevision,
        targetMembershipId: ceremony.target.membershipId,
      }),
    );
    const firstApproval = await withActorFence(primary, (actorFence) =>
      approveOrganizationRecoveryOperation(client!.db, {
        organizationId: ceremony.organizationId,
        actorSubjectId: primary.subjectId,
        actorAuthUserId: primary.userId,
        actorAuthSessionId: primary.sessionId,
        operationId: crypto.randomUUID(),
        actorFence,
        recoveryOperationId: started.overview.operation!.id,
        expectedOperationRevision: started.overview.operation!.revision,
      }),
    );
    const duplicateApproval = await withActorFence(alias, (actorFence) =>
      approveOrganizationRecoveryOperation(client!.db, {
        organizationId: ceremony.organizationId,
        actorSubjectId: alias.subjectId,
        actorAuthUserId: alias.userId,
        actorAuthSessionId: alias.sessionId,
        operationId: crypto.randomUUID(),
        actorFence,
        recoveryOperationId: started.overview.operation!.id,
        expectedOperationRevision: firstApproval.overview.operation!.revision,
      }),
    );
    expect(duplicateApproval.overview.operation).toMatchObject({
      revision: firstApproval.overview.operation!.revision,
      approvalCount: 1,
    });
    const [approvalEvidence] = await owned.admin<Array<{ count: number }>>`
      select count(*)::integer as count from organization_recovery_approvals
      where operation_id = ${started.overview.operation!.id}::uuid
        and canonical_identity_id = ${primary.identityId}::uuid`;
    expect(approvalEvidence?.count).toBe(1);

    const cancelled = await withActorFence(ceremony.owner, (actorFence) =>
      cancelOrganizationRecoveryOperation(client!.db, {
        organizationId: ceremony.organizationId,
        actorSubjectId: ceremony.owner.subjectId,
        actorAuthUserId: ceremony.owner.userId,
        actorAuthSessionId: ceremony.owner.sessionId,
        operationId: crypto.randomUUID(),
        actorFence,
        recoveryOperationId: started.overview.operation!.id,
        expectedOperationRevision: duplicateApproval.overview.operation!.revision,
      }),
    );
    expect(cancelled.overview.operation?.state).toBe("cancelled");
    const selfTargeted = await withActorFence(ceremony.custodians[1], (actorFence) =>
      startOrganizationRecoveryOperation(client!.db, {
        organizationId: ceremony.organizationId,
        actorSubjectId: ceremony.custodians[1].subjectId,
        actorAuthUserId: ceremony.custodians[1].userId,
        actorAuthSessionId: ceremony.custodians[1].sessionId,
        operationId: crypto.randomUUID(),
        actorFence,
        expectedPolicyRevision: ceremony.policyRevision,
        targetMembershipId: primary.membershipId,
      }),
    );
    await expect(
      withActorFence(primary, (actorFence) =>
        approveOrganizationRecoveryOperation(client!.db, {
          organizationId: ceremony.organizationId,
          actorSubjectId: primary.subjectId,
          actorAuthUserId: primary.userId,
          actorAuthSessionId: primary.sessionId,
          operationId: crypto.randomUUID(),
          actorFence,
          recoveryOperationId: selfTargeted.overview.operation!.id,
          expectedOperationRevision: selfTargeted.overview.operation!.revision,
        }),
      ),
    ).rejects.toBeInstanceOf(OrganizationRecoveryDeniedError);
  }, 180_000);

  test("invalidates stamped custody and quorum when membership authority changes", async () => {
    if (!owned || !client) return;
    const ceremony = await createCeremony();
    const cooling = await startAndReachQuorum(ceremony);
    const suspended = await updateOrganizationMember(client.db, {
      organizationId: ceremony.organizationId,
      actorSubjectId: ceremony.owner.subjectId,
      operationId: crypto.randomUUID(),
      membershipId: ceremony.custodians[1].membershipId,
      transition: {
        kind: "suspend",
        expectedAuthorizationRevision: ceremony.custodians[1].authorizationRevision,
        operationId: crypto.randomUUID(),
      },
    });
    await expect(
      getOverviewFor(ceremony.custodians[1], ceremony.organizationId),
    ).rejects.toBeInstanceOf(OrganizationRecoveryDeniedError);
    await elapseCooldown(cooling.overview.operation!.id);
    const degraded = await getOverviewFor(ceremony.owner, ceremony.organizationId);
    expect(degraded).toMatchObject({
      availability: "recovery_unavailable",
      unavailableReason: "degraded",
      policy: { state: "degraded" },
      operation: { state: "collecting", approvalCount: 1 },
      capabilities: { execute: false },
    });
    const thirdDegraded = await getOverviewFor(ceremony.custodians[2], ceremony.organizationId);
    expect(thirdDegraded.capabilities.approve).toBe(false);
    const [beforeDeniedApproval] = await owned.admin<
      Array<{
        revision: number;
        approvalCount: number;
        notificationCount: number;
      }>
    >`
      select operation.revision::integer as revision,
        (select count(*)::integer from organization_recovery_approvals approval
          where approval.operation_id = operation.id) as "approvalCount",
        (select count(*)::integer from organization_recovery_notification_outbox outbox
          where outbox.operation_id = operation.id) as "notificationCount"
      from organization_recovery_operations operation
      where operation.id = ${cooling.overview.operation!.id}::uuid`;
    await expect(
      withActorFence(ceremony.custodians[2], (actorFence) =>
        approveOrganizationRecoveryOperation(client!.db, {
          organizationId: ceremony.organizationId,
          actorSubjectId: ceremony.custodians[2].subjectId,
          actorAuthUserId: ceremony.custodians[2].userId,
          actorAuthSessionId: ceremony.custodians[2].sessionId,
          operationId: crypto.randomUUID(),
          actorFence,
          recoveryOperationId: cooling.overview.operation!.id,
          expectedOperationRevision: thirdDegraded.operation!.revision,
        }),
      ),
    ).rejects.toBeInstanceOf(OrganizationRecoveryUnavailableError);
    const [afterDeniedApproval] = await owned.admin<
      Array<{
        revision: number;
        approvalCount: number;
        notificationCount: number;
      }>
    >`
      select operation.revision::integer as revision,
        (select count(*)::integer from organization_recovery_approvals approval
          where approval.operation_id = operation.id) as "approvalCount",
        (select count(*)::integer from organization_recovery_notification_outbox outbox
          where outbox.operation_id = operation.id) as "notificationCount"
      from organization_recovery_operations operation
      where operation.id = ${cooling.overview.operation!.id}::uuid`;
    expect(afterDeniedApproval).toEqual(beforeDeniedApproval);
    await expect(
      withActorFence(ceremony.custodians[0], (actorFence) =>
        executeOrganizationRecoveryOperation(client!.db, {
          organizationId: ceremony.organizationId,
          actorSubjectId: ceremony.custodians[0].subjectId,
          actorAuthUserId: ceremony.custodians[0].userId,
          actorAuthSessionId: ceremony.custodians[0].sessionId,
          operationId: crypto.randomUUID(),
          actorFence,
          recoveryOperationId: cooling.overview.operation!.id,
          expectedOperationRevision: degraded.operation!.revision,
        }),
      ),
    ).rejects.toBeInstanceOf(OrganizationRecoveryUnavailableError);

    const reactivated = await updateOrganizationMember(client.db, {
      organizationId: ceremony.organizationId,
      actorSubjectId: ceremony.owner.subjectId,
      operationId: crypto.randomUUID(),
      membershipId: ceremony.custodians[1].membershipId,
      transition: {
        kind: "reactivate",
        expectedAuthorizationRevision: suspended.authorizationRevision,
        operationId: crypto.randomUUID(),
      },
    });
    expect(reactivated.status).toBe("active");
    const renewedAcceptance = await withActorFence(ceremony.custodians[1], (actorFence) =>
      acceptOrganizationRecoveryCustody(client!.db, {
        organizationId: ceremony.organizationId,
        actorSubjectId: ceremony.custodians[1].subjectId,
        actorAuthUserId: ceremony.custodians[1].userId,
        actorAuthSessionId: ceremony.custodians[1].sessionId,
        operationId: crypto.randomUUID(),
        actorFence,
        expectedPolicyRevision: ceremony.policyRevision,
      }),
    );
    expect(renewedAcceptance.overview.policy?.state).toBe("active");
    expect(renewedAcceptance.overview.operation?.approvalCount).toBe(1);
    const renewedApproval = await withActorFence(ceremony.custodians[1], (actorFence) =>
      approveOrganizationRecoveryOperation(client!.db, {
        organizationId: ceremony.organizationId,
        actorSubjectId: ceremony.custodians[1].subjectId,
        actorAuthUserId: ceremony.custodians[1].userId,
        actorAuthSessionId: ceremony.custodians[1].sessionId,
        operationId: crypto.randomUUID(),
        actorFence,
        recoveryOperationId: cooling.overview.operation!.id,
        expectedOperationRevision: renewedAcceptance.overview.operation!.revision,
      }),
    );
    expect(renewedApproval.overview.operation).toMatchObject({
      state: "cooling",
      approvalCount: 2,
      notificationJournaled: true,
    });
  }, 180_000);

  test("invalidates acceptance and approval on canonical auth and login-binding revision changes", async () => {
    if (!client) return;
    const ceremony = await createCeremony();
    const cooling = await startAndReachQuorum(ceremony);
    const [renewedPrimary] = await addSecondLinkedManagedLogin(ceremony.custodians[1]);
    const afterAuthRevision = await getOverviewFor(ceremony.owner, ceremony.organizationId);
    expect(afterAuthRevision).toMatchObject({
      availability: "recovery_unavailable",
      policy: { state: "degraded" },
      operation: { state: "collecting", approvalCount: 1 },
    });
    const reaccepted = await withActorFence(renewedPrimary, (actorFence) =>
      acceptOrganizationRecoveryCustody(client!.db, {
        organizationId: ceremony.organizationId,
        actorSubjectId: renewedPrimary.subjectId,
        actorAuthUserId: renewedPrimary.userId,
        actorAuthSessionId: renewedPrimary.sessionId,
        operationId: crypto.randomUUID(),
        actorFence,
        expectedPolicyRevision: ceremony.policyRevision,
      }),
    );
    expect(reaccepted.overview.policy?.state).toBe("active");
    const reapproved = await withActorFence(renewedPrimary, (actorFence) =>
      approveOrganizationRecoveryOperation(client!.db, {
        organizationId: ceremony.organizationId,
        actorSubjectId: renewedPrimary.subjectId,
        actorAuthUserId: renewedPrimary.userId,
        actorAuthSessionId: renewedPrimary.sessionId,
        operationId: crypto.randomUUID(),
        actorFence,
        recoveryOperationId: cooling.overview.operation!.id,
        expectedOperationRevision: reaccepted.overview.operation!.revision,
      }),
    );
    expect(reapproved.overview.operation).toMatchObject({
      state: "cooling",
      approvalCount: 2,
    });

    const projection = await getCanonicalHumanIdentityProjection(client.db, renewedPrimary.userId);
    const linkedBinding = projection.loginBindings.find(
      (binding) => binding.providerId === "github",
    )!;
    const bindingRevisionBefore = linkedBinding.revision;
    await applyCanonicalHumanIdentityOperation(client.db, {
      operationId: crypto.randomUUID(),
      authUserId: renewedPrimary.userId,
      expectedIdentityRevision: projection.activeIdentity.identityRevision,
      operationType: "unlink",
      bindingId: linkedBinding.id,
      reason: "Exercise recovery evidence invalidation",
    });
    const mutatedProjection = await getCanonicalHumanIdentityProjection(
      client.db,
      renewedPrimary.userId,
    );
    expect(
      mutatedProjection.loginBindings.find((binding) => binding.id === linkedBinding.id),
    ).toMatchObject({ status: "revoked", revision: bindingRevisionBefore + 1 });
    const afterBindingRevision = await getOverviewFor(ceremony.owner, ceremony.organizationId);
    expect(afterBindingRevision).toMatchObject({
      availability: "recovery_unavailable",
      policy: { state: "degraded" },
      operation: { state: "collecting", approvalCount: 1 },
      capabilities: { execute: false },
    });
  }, 180_000);

  test("enforces the exact seven-day cooldown and thirty-day expiry boundaries", async () => {
    if (!client) return;
    const cooldownCeremony = await createCeremony();
    const cooling = await startAndReachQuorum(cooldownCeremony);
    await setCooldownBoundary(cooling.overview.operation!.id, 1_000);
    const beforeCooldown = await getOverviewFor(
      cooldownCeremony.custodians[0],
      cooldownCeremony.organizationId,
    );
    expect(beforeCooldown.capabilities.execute).toBe(false);
    await expect(
      withActorFence(cooldownCeremony.custodians[0], (actorFence) =>
        executeOrganizationRecoveryOperation(client!.db, {
          organizationId: cooldownCeremony.organizationId,
          actorSubjectId: cooldownCeremony.custodians[0].subjectId,
          actorAuthUserId: cooldownCeremony.custodians[0].userId,
          actorAuthSessionId: cooldownCeremony.custodians[0].sessionId,
          operationId: crypto.randomUUID(),
          actorFence,
          recoveryOperationId: cooling.overview.operation!.id,
          expectedOperationRevision: beforeCooldown.operation!.revision,
        }),
      ),
    ).rejects.toBeInstanceOf(OrganizationRecoveryUnavailableError);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const atCooldown = await getOverviewFor(
      cooldownCeremony.custodians[0],
      cooldownCeremony.organizationId,
    );
    expect(atCooldown.capabilities.execute).toBe(true);

    const expiryCeremony = await createCeremony();
    await expect(
      getOverviewFor(expiryCeremony.target, cooldownCeremony.organizationId),
    ).rejects.toBeInstanceOf(OrganizationRecoveryDeniedError);
    const started = await withActorFence(expiryCeremony.custodians[0], (actorFence) =>
      startOrganizationRecoveryOperation(client!.db, {
        organizationId: expiryCeremony.organizationId,
        actorSubjectId: expiryCeremony.custodians[0].subjectId,
        actorAuthUserId: expiryCeremony.custodians[0].userId,
        actorAuthSessionId: expiryCeremony.custodians[0].sessionId,
        operationId: crypto.randomUUID(),
        actorFence,
        expectedPolicyRevision: expiryCeremony.policyRevision,
        targetMembershipId: expiryCeremony.target.membershipId,
      }),
    );
    await setExpiryBoundary(started.overview.operation!.id, 1_000);
    const beforeExpiry = await getOverviewFor(
      expiryCeremony.custodians[0],
      expiryCeremony.organizationId,
    );
    expect(beforeExpiry.operation?.state).toBe("collecting");
    expect(beforeExpiry.capabilities.approve).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const atExpiry = await getOverviewFor(
      expiryCeremony.custodians[0],
      expiryCeremony.organizationId,
    );
    expect(atExpiry.operation?.state).toBe("expired");
    expect(atExpiry.capabilities.approve).toBe(false);
    await expect(
      withActorFence(expiryCeremony.custodians[0], (actorFence) =>
        approveOrganizationRecoveryOperation(client!.db, {
          organizationId: expiryCeremony.organizationId,
          actorSubjectId: expiryCeremony.custodians[0].subjectId,
          actorAuthUserId: expiryCeremony.custodians[0].userId,
          actorAuthSessionId: expiryCeremony.custodians[0].sessionId,
          operationId: crypto.randomUUID(),
          actorFence,
          recoveryOperationId: started.overview.operation!.id,
          expectedOperationRevision: atExpiry.operation!.revision,
        }),
      ),
    ).rejects.toBeInstanceOf(OrganizationRecoveryUnavailableError);
    const replacement = await withActorFence(expiryCeremony.custodians[0], (actorFence) =>
      startOrganizationRecoveryOperation(client!.db, {
        organizationId: expiryCeremony.organizationId,
        actorSubjectId: expiryCeremony.custodians[0].subjectId,
        actorAuthUserId: expiryCeremony.custodians[0].userId,
        actorAuthSessionId: expiryCeremony.custodians[0].sessionId,
        operationId: crypto.randomUUID(),
        actorFence,
        expectedPolicyRevision: expiryCeremony.policyRevision,
        targetMembershipId: expiryCeremony.target.membershipId,
      }),
    );
    expect(replacement.overview.operation?.id).not.toBe(started.overview.operation!.id);
    const [expiredTruth] = await owned!.admin<Array<{ state: string; eventCount: number }>>`
      select operation.state,
        (select count(*)::integer from organization_recovery_events event
          where event.operation_id = operation.id
            and event.event_type = 'operation_expired') as "eventCount"
      from organization_recovery_operations operation
      where operation.id = ${started.overview.operation!.id}::uuid`;
    expect(expiredTruth).toEqual({ state: "expired", eventCount: 1 });
  }, 180_000);

  test("invalidates execution when the stamped target membership is offboarded", async () => {
    if (!owned || !client) return;
    const ceremony = await createCeremony();
    const cooling = await startAndReachQuorum(ceremony);
    const offboarded = await updateOrganizationMember(client.db, {
      organizationId: ceremony.organizationId,
      actorSubjectId: ceremony.owner.subjectId,
      operationId: crypto.randomUUID(),
      membershipId: ceremony.target.membershipId,
      transition: {
        kind: "offboard",
        expectedAuthorizationRevision: ceremony.target.authorizationRevision,
        operationId: crypto.randomUUID(),
      },
    });
    expect(offboarded.status).toBe("revoked");
    await expect(getOverviewFor(ceremony.target, ceremony.organizationId)).rejects.toBeInstanceOf(
      OrganizationRecoveryDeniedError,
    );
    await elapseCooldown(cooling.overview.operation!.id);
    const invalidated = await getOverviewFor(ceremony.owner, ceremony.organizationId);
    expect(invalidated.operation).toMatchObject({ state: "collecting" });
    expect(invalidated.capabilities.execute).toBe(false);
    await expect(
      withActorFence(ceremony.custodians[0], (actorFence) =>
        executeOrganizationRecoveryOperation(client!.db, {
          organizationId: ceremony.organizationId,
          actorSubjectId: ceremony.custodians[0].subjectId,
          actorAuthUserId: ceremony.custodians[0].userId,
          actorAuthSessionId: ceremony.custodians[0].sessionId,
          operationId: crypto.randomUUID(),
          actorFence,
          recoveryOperationId: cooling.overview.operation!.id,
          expectedOperationRevision: invalidated.operation!.revision,
        }),
      ),
    ).rejects.toBeInstanceOf(OrganizationRecoveryUnavailableError);
    const disabled = await withActorFence(ceremony.owner, (actorFence) =>
      disableOrganizationRecoveryPolicy(client!.db, {
        organizationId: ceremony.organizationId,
        actorSubjectId: ceremony.owner.subjectId,
        actorAuthUserId: ceremony.owner.userId,
        actorAuthSessionId: ceremony.owner.sessionId,
        operationId: crypto.randomUUID(),
        actorFence,
        expectedPolicyRevision: ceremony.policyRevision,
      }),
    );
    expect(disabled.overview).toMatchObject({
      policy: { state: "disabled" },
      operation: { state: "superseded" },
    });
    const disabledEvents = await owned.admin<Array<{ reason: string | null }>>`
      select evidence ->> 'reason' as reason
      from organization_recovery_events
      where operation_id = ${cooling.overview.operation!.id}::uuid
        and event_type = 'operation_superseded'
      order by created_at, id`;
    expect([...disabledEvents]).toEqual([{ reason: "policy_disabled" }]);
  }, 180_000);

  test("serializes approval versus policy rotation on two connections", async () => {
    if (!owned || !client) return;
    const ceremony = await createCeremony();
    const started = await withActorFence(ceremony.custodians[0], (actorFence) =>
      startOrganizationRecoveryOperation(client!.db, {
        organizationId: ceremony.organizationId,
        actorSubjectId: ceremony.custodians[0].subjectId,
        actorAuthUserId: ceremony.custodians[0].userId,
        actorAuthSessionId: ceremony.custodians[0].sessionId,
        operationId: crypto.randomUUID(),
        actorFence,
        expectedPolicyRevision: ceremony.policyRevision,
        targetMembershipId: ceremony.target.membershipId,
      }),
    );
    const results = await Promise.allSettled([
      withActorFence(ceremony.custodians[0], (actorFence) =>
        approveOrganizationRecoveryOperation(client!.db, {
          organizationId: ceremony.organizationId,
          actorSubjectId: ceremony.custodians[0].subjectId,
          actorAuthUserId: ceremony.custodians[0].userId,
          actorAuthSessionId: ceremony.custodians[0].sessionId,
          operationId: crypto.randomUUID(),
          actorFence,
          recoveryOperationId: started.overview.operation!.id,
          expectedOperationRevision: started.overview.operation!.revision,
        }),
      ),
      withActorFence(ceremony.owner, (actorFence) =>
        configureOrganizationRecoveryPolicy(client!.db, {
          organizationId: ceremony.organizationId,
          actorSubjectId: ceremony.owner.subjectId,
          actorAuthUserId: ceremony.owner.userId,
          actorAuthSessionId: ceremony.owner.sessionId,
          operationId: crypto.randomUUID(),
          actorFence,
          expectedPolicyRevision: ceremony.policyRevision,
          custodianMembershipIds: ceremony.custodians.map((actor) => actor.membershipId) as [
            string,
            string,
            string,
          ],
        }),
      ),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    const overview = await getOverviewFor(ceremony.owner, ceremony.organizationId);
    expect(overview.policy?.revision).toBe(ceremony.policyRevision + 1);
    expect(overview.operation?.state).toBe("superseded");
    const supersededEvents = await owned.admin<Array<{ reason: string | null }>>`
      select evidence ->> 'reason' as reason
      from organization_recovery_events
      where operation_id = ${started.overview.operation!.id}::uuid
        and event_type = 'operation_superseded'
      order by created_at, id`;
    expect([...supersededEvents]).toEqual([{ reason: "policy_rotated" }]);
  }, 180_000);

  test("serializes execute versus canonical authority revision on two connections", async () => {
    if (!owned || !client) return;
    const ceremony = await createCeremony({ linkFirstCustodianLogin: true });
    const cooling = await startAndReachQuorum(ceremony);
    await elapseCooldown(cooling.overview.operation!.id);
    const current = await getOverviewFor(ceremony.custodians[1], ceremony.organizationId);
    expect(current.capabilities.execute).toBe(true);

    const projection = await getCanonicalHumanIdentityProjection(
      client.db,
      ceremony.custodians[0].userId,
    );
    const linkedBinding = projection.loginBindings.find(
      (binding) => binding.providerId === "github" && binding.status === "active",
    );
    if (!linkedBinding) throw new Error("linked custodian binding is unavailable");

    let identityLocked!: () => void;
    const identityLockAcquired = new Promise<void>((resolve) => {
      identityLocked = resolve;
    });
    let continueMutation!: () => void;
    const mutationMayContinue = new Promise<void>((resolve) => {
      continueMutation = resolve;
    });
    const mutationOperationId = crypto.randomUUID();
    const mutation = owned.admin.begin(async (transactionSql) => {
      await transactionSql`select set_config(
        'opengeni.canonical_human_identity_lifecycle', 'active', true
      )`;
      await transactionSql`select 1 from canonical_human_identities
        where id = ${ceremony.custodians[0].identityId}::uuid for update`;
      identityLocked();
      await mutationMayContinue;
      await transactionSql`
        select * from apply_canonical_human_identity_operation(
          ${mutationOperationId}::uuid,
          ${ceremony.custodians[0].userId}::text,
          ${projection.activeIdentity.identityRevision}::bigint,
          'unlink'::text,
          ${linkedBinding.id}::uuid,
          null::text,
          null::text,
          'Serialize recovery execution against canonical authority mutation'::text
        )`;
    });
    await identityLockAcquired;

    const execution = withActorFence(ceremony.custodians[1], (actorFence) =>
      executeOrganizationRecoveryOperation(client!.db, {
        organizationId: ceremony.organizationId,
        actorSubjectId: ceremony.custodians[1].subjectId,
        actorAuthUserId: ceremony.custodians[1].userId,
        actorAuthSessionId: ceremony.custodians[1].sessionId,
        operationId: crypto.randomUUID(),
        actorFence,
        recoveryOperationId: current.operation!.id,
        expectedOperationRevision: current.operation!.revision,
      }),
    );
    try {
      await waitForBlockedRecoveryCommand();
    } finally {
      continueMutation();
    }
    await mutation;
    await expect(execution).rejects.toBeInstanceOf(OrganizationRecoveryUnavailableError);

    const [truth] = await owned.admin<Array<{ operationState: string; targetRole: string }>>`
      select operation.state as "operationState", membership.role as "targetRole"
      from organization_recovery_operations operation
      join organization_memberships membership
        on membership.id = operation.target_membership_id
      where operation.id = ${current.operation!.id}::uuid`;
    expect(truth).toEqual({ operationState: "cooling", targetRole: "member" });
    const degraded = await getOverviewFor(ceremony.owner, ceremony.organizationId);
    expect(degraded).toMatchObject({
      availability: "recovery_unavailable",
      policy: { state: "degraded" },
      operation: { state: "collecting", approvalCount: 1 },
      capabilities: { execute: false },
    });
  }, 240_000);

  test("serializes execute versus offboard and owner cancel versus execute", async () => {
    if (!owned || !client) return;
    const offboardRace = await createCeremony();
    const cooling = await startAndReachQuorum(offboardRace);
    await elapseCooldown(cooling.overview.operation!.id);
    const current = await getOverviewFor(offboardRace.custodians[0], offboardRace.organizationId);
    const offboardResults = await Promise.allSettled([
      withActorFence(offboardRace.custodians[0], (actorFence) =>
        executeOrganizationRecoveryOperation(client!.db, {
          organizationId: offboardRace.organizationId,
          actorSubjectId: offboardRace.custodians[0].subjectId,
          actorAuthUserId: offboardRace.custodians[0].userId,
          actorAuthSessionId: offboardRace.custodians[0].sessionId,
          operationId: crypto.randomUUID(),
          actorFence,
          recoveryOperationId: current.operation!.id,
          expectedOperationRevision: current.operation!.revision,
        }),
      ),
      updateOrganizationMember(client.db, {
        organizationId: offboardRace.organizationId,
        actorSubjectId: offboardRace.owner.subjectId,
        operationId: crypto.randomUUID(),
        membershipId: offboardRace.target.membershipId,
        transition: {
          kind: "offboard",
          expectedAuthorizationRevision: offboardRace.target.authorizationRevision,
          operationId: crypto.randomUUID(),
        },
      }),
    ]);
    expect(offboardResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [offboardTruth] = await owned.admin<Array<{ state: string; status: string }>>`
      select operation.state, membership.status
      from organization_recovery_operations operation
      join organization_memberships membership on membership.id = operation.target_membership_id
      where operation.id = ${current.operation!.id}::uuid`;
    expect(offboardTruth?.state === "executed" || offboardTruth?.status === "revoked").toBe(true);

    const cancelRace = await createCeremony();
    const cancelCooling = await startAndReachQuorum(cancelRace);
    await elapseCooldown(cancelCooling.overview.operation!.id);
    const cancelCurrent = await getOverviewFor(cancelRace.custodians[0], cancelRace.organizationId);
    const terminal = await Promise.allSettled([
      withActorFence(cancelRace.owner, (actorFence) =>
        cancelOrganizationRecoveryOperation(client!.db, {
          organizationId: cancelRace.organizationId,
          actorSubjectId: cancelRace.owner.subjectId,
          actorAuthUserId: cancelRace.owner.userId,
          actorAuthSessionId: cancelRace.owner.sessionId,
          operationId: crypto.randomUUID(),
          actorFence,
          recoveryOperationId: cancelCurrent.operation!.id,
          expectedOperationRevision: cancelCurrent.operation!.revision,
        }),
      ),
      withActorFence(cancelRace.custodians[0], (actorFence) =>
        executeOrganizationRecoveryOperation(client!.db, {
          organizationId: cancelRace.organizationId,
          actorSubjectId: cancelRace.custodians[0].subjectId,
          actorAuthUserId: cancelRace.custodians[0].userId,
          actorAuthSessionId: cancelRace.custodians[0].sessionId,
          operationId: crypto.randomUUID(),
          actorFence,
          recoveryOperationId: cancelCurrent.operation!.id,
          expectedOperationRevision: cancelCurrent.operation!.revision,
        }),
      ),
    ]);
    expect(terminal.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [truth] = await owned.admin<Array<{ state: string }>>`
      select state from organization_recovery_operations
      where id = ${cancelCurrent.operation!.id}::uuid`;
    expect(["cancelled", "executed"]).toContain(truth?.state ?? "");
  }, 240_000);
});
