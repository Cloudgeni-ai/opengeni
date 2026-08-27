import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  upsertWorkClaim,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
setDefaultTimeout(900_000);

let owned: OwnerMigratedTestDatabase | null = null;
let appClient: DbClient | null = null;
let app: postgres.Sql | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-0365-work-claims-owner");
  if (!owned) {
    if (requireRealDatabase) {
      throw new Error("migration 0365 owner-migrated PostgreSQL fixture is unavailable");
    }
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
  appClient = createDb(appUrl.toString(), { max: 4, rlsStrategy: "force" });
  app = postgres(appUrl.toString(), {
    max: 1,
    prepare: false,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    onnotice: () => undefined,
  });
}, 900_000);

afterAll(async () => {
  await app?.end({ timeout: 5 }).catch(() => undefined);
  await appClient?.close().catch(() => undefined);
  await owned?.release();
}, 180_000);

async function seedAttempt(input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  subjectId: string;
}) {
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await owned!.admin.begin(async (sql) => {
    await sql`select set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
    await sql`select set_config('opengeni.session_inference_claim', '1', true)`;
    await sql`select set_config('opengeni.account_id', ${input.accountId}, true)`;
    await sql`select set_config('opengeni.workspace_id', ${input.workspaceId}, true)`;
    await sql`select set_config('opengeni.subject_id', ${input.subjectId}, true)`;
    await sql`select set_config('opengeni.initiating_human_subject_id', ${input.subjectId}, true)`;
    await sql`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, source, position, prompt, model,
        reasoning_effort, sandbox_backend, execution_generation,
        initiator_kind, initiator_subject_id, initiator_context,
        initiating_human_subject_id
      ) values (
        ${turnId}, ${input.accountId}, ${input.workspaceId}, ${input.sessionId},
        ${crypto.randomUUID()}, ${`work-claim-owner-${turnId}`}, 'running', 'user', 1,
        'work claim owner fixture', 'test-model', 'medium', 'none', 1,
        'subject', ${input.subjectId}, '{}'::jsonb, ${input.subjectId}
      )`;
    await sql`
      update sessions set active_turn_id = ${turnId}, status = 'running'
      where workspace_id = ${input.workspaceId} and id = ${input.sessionId}`;
    await sql`
      update session_turns set active_attempt_id = ${attemptId}
      where workspace_id = ${input.workspaceId} and id = ${turnId}`;
    await sql`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id,
        temporal_activity_id, verified_control_revision, mcp_approval_policies
      ) values (
        ${attemptId}, ${input.accountId}, ${input.workspaceId}, ${input.sessionId},
        ${turnId}, 1, 'running', ${`work-claim-owner-${turnId}`},
        ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )`;
  });
  return { ...input, turnId, attemptId, executionGeneration: 1 };
}

describe("migration 0365 FORCE-RLS work-claim authority", () => {
  test("provisionRoles converges work-claim capabilities for a post-migration custom role", async () => {
    if (!owned) return;
    const role = `work_claim_runtime_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const password = crypto.randomUUID().replaceAll("-", "");
    try {
      await provisionRoles(owned.adminUrl, {
        appRole: role,
        appPassword: password,
        rlsStrategy: "force",
      });
      const [privileges] = await owned.admin<
        Array<{
          upsert: boolean;
          release: boolean;
          claimSelect: boolean;
          claimInsert: boolean;
          revisionSelect: boolean;
          capabilitySelect: boolean;
        }>
      >`
        select
          has_function_privilege(
            ${role},
            'public.upsert_session_work_claim_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid,integer,text,text,text,text,text,text,text)',
            'EXECUTE'
          ) as upsert,
          has_function_privilege(
            ${role},
            'public.release_session_work_claim_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,integer,text)',
            'EXECUTE'
          ) as release,
          has_table_privilege(${role}, 'public.session_work_claims', 'SELECT') as "claimSelect",
          has_table_privilege(${role}, 'public.session_work_claims', 'INSERT') as "claimInsert",
          has_table_privilege(
            ${role}, 'public.session_work_claim_revisions', 'SELECT'
          ) as "revisionSelect",
          has_table_privilege(
            ${role}, 'public.session_work_claim_write_capabilities', 'SELECT'
          ) as "capabilitySelect"`;
      expect(privileges).toEqual({
        upsert: true,
        release: true,
        claimSelect: true,
        claimInsert: false,
        revisionSelect: false,
        capabilitySelect: false,
      });
    } finally {
      await owned.admin.unsafe(`DROP OWNED BY "${role}"`).catch(() => undefined);
      await owned.admin.unsafe(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
    }
  });

  test("a NOSUPERUSER NOBYPASSRLS owner can mutate and settle a private claim only through capabilities", async () => {
    if (!owned || !appClient || !app) return;
    const [identity] = await owned.admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as superuser, rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${owned.ownerRole}`;
    expect(identity).toEqual({ superuser: false, bypassRls: false });

    const suffix = crypto.randomUUID();
    const userId = `work-claim-owner-migrated-${suffix}`;
    const subjectId = `user:${userId}`;
    const access = await ensureManagedAccessForUser(appClient.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Work claim owner-migrated fixture",
    });
    const grant = access.workspaceGrants[0]!;
    await owned.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (${grant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')
      on conflict (account_id) do nothing`;
    const settings = await getOrganizationPrivateSessionSettings(appClient.db, {
      organizationId: grant.accountId,
      actorSubjectId: subjectId,
    });
    await updateOrganizationPrivateSessionSettings(appClient.db, {
      organizationId: grant.accountId,
      actorSubjectId: subjectId,
      enabled: true,
      expectedVersion: settings.version,
      operationId: crypto.randomUUID(),
    });
    const session = await withSessionRlsActorContext({ subjectId }, () =>
      createSession(appClient!.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        initialMessage: "Private owner-migrated work claim",
        resources: [],
        metadata: {},
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId },
        createdByContext: {},
      }),
    );
    await transitionSessionVisibility(appClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      actorSubjectId: subjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `work-claim-owner-private-${suffix}`,
    });
    const attempt = await seedAttempt({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      subjectId,
    });
    const created = await upsertWorkClaim(appClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId: attempt.turnId,
      attemptId: attempt.attemptId,
      executionGeneration: attempt.executionGeneration,
      operationId: crypto.randomUUID(),
      expectedRevision: 0,
      subjectNamespace: "github",
      subjectType: "pull_request",
      canonicalKey: "Cloudgeni-ai/opengeni#384",
      displayLabel: "Owner-migrated private claim",
      role: "working",
      version: { kind: "pull_request_head", value: "owner-head" },
    });
    expect(created).toMatchObject({
      mutation: "created",
      replayed: false,
      claim: { state: "active", revision: 1 },
    });

    const [capabilityOutsideMutation] = await app<
      Array<{ active: boolean }>
    >`select opengeni_private.session_work_claim_capability_active() as active`;
    expect(capabilityOutsideMutation).toEqual({ active: false });
    const [capabilityRowsBefore] = await owned.admin<Array<{ count: number }>>`
      select count(*)::int as count from session_work_claim_write_capabilities`;
    expect(capabilityRowsBefore?.count).toBe(0);

    // The triggering statement carries no tenant or subject GUC. Its
    // SECURITY DEFINER settlement path must mint its own exact capability to
    // see and settle a private row while FORCE RLS binds the non-bypass owner.
    await owned.admin.begin(async (sql) => {
      await sql`select set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
      await sql`select set_config('opengeni.account_id', ${grant.accountId}, true)`;
      await sql`select set_config('opengeni.workspace_id', ${grant.workspaceId}, true)`;
      await sql`
        update sessions set status = 'cancelled'
        where workspace_id = ${grant.workspaceId} and id = ${session.id}`;
    });
    const [settled] = await owned.admin<
      Array<{ state: string; revision: number; reason: string; actorKind: string }>
    >`
      select claim.state, claim.revision, revision.reason,
        revision.actor_kind as "actorKind"
      from session_work_claims claim
      join session_work_claim_revisions revision
        on revision.workspace_id = claim.workspace_id
       and revision.claim_id = claim.id
       and revision.resulting_revision = claim.revision
      where claim.id = ${created.claim.id}`;
    expect(settled).toEqual({
      state: "released",
      revision: 2,
      reason: "cancelled",
      actorKind: "system",
    });
    const [capabilityRowsAfter] = await owned.admin<Array<{ count: number }>>`
      select count(*)::int as count from session_work_claim_write_capabilities`;
    expect(capabilityRowsAfter?.count).toBe(0);

    const owners = await owned.admin<Array<{ kind: string; name: string; owner: string }>>`
      select 'table'::text as kind, class.relname as name,
        pg_get_userbyid(class.relowner)::text as owner
      from pg_class class
      where class.relname in (
        'session_work_claims',
        'session_work_claim_revisions',
        'session_work_claim_write_capabilities'
      )
      union all
      select 'function'::text, procedure.proname,
        pg_get_userbyid(procedure.proowner)::text
      from pg_proc procedure
      where procedure.proname in (
        'upsert_session_work_claim_for_attempt',
        'release_session_work_claim_for_attempt',
        'settle_active_session_work_claims'
      )
      order by kind, name`;
    expect(owners).toHaveLength(6);
    expect(new Set(owners.map((row) => row.owner))).toEqual(new Set([owned.ownerRole]));
  });
});
