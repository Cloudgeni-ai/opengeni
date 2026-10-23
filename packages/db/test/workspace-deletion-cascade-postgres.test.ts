import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import {
  createDb,
  createSession,
  deleteWorkspaceIfQuiescent,
  initializeSessionStartAtomically,
  type DbClient,
} from "../src/index";

// Deleting a workspace removes its rows through cascading foreign keys.
// PostgreSQL runs that cascade level by level and orders a row's foreign key
// actions by trigger name, so an immediate check between two removed tables
// can run while the referencing row still waits for its own cascade. These
// tests pin the schema invariant that prevents that, and delete workspaces
// holding the rows that used to make them undeletable.
let shared: SharedTestDatabase;
let app: postgres.Sql;
let appClient: DbClient;
let adminClient: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("workspace-deletion-cascade");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  app = postgres(shared.appUrl, {
    max: 1,
    prepare: false,
    onnotice: () => undefined,
  });
  appClient = createDb(shared.appUrl, { max: 2 });
  adminClient = createDb(shared.adminUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await app?.end({ timeout: 5 }).catch(() => undefined);
  await appClient?.close();
  await adminClient?.close();
  await shared?.release();
}, 60_000);

const REMOVED_TABLES = `
  WITH RECURSIVE removed(relation_id) AS (
    SELECT format('%I.workspaces', current_schema())::regclass::oid
    UNION
    SELECT c.conrelid FROM pg_constraint c JOIN removed ON c.confrelid = removed.relation_id
    WHERE c.contype = 'f' AND c.confdeltype = 'c' AND c.conparentid = 0
  )`;

/**
 * Foreign keys from tables a workspace deletion keeps into tables it removes.
 * Each one deliberately refuses the deletion while such a row exists.
 */
const KEPT_REFERENCES = new Map<string, string>([
  [
    "editable_artifacts_workspace_fk",
    "documents keep content-addressed blob storage that a workspace deletion does not purge yet",
  ],
  [
    "editable_artifact_blob_refs_source_file_fk",
    "a document blob keeps the uploaded file it was imported from",
  ],
  [
    "organization_memberships_personal_workspace_account_fk",
    "a member's personal workspace is deleted only with the membership",
  ],
  [
    "external_identities_personal_workspace_id_account_id_fkey",
    "a linked identity's personal workspace is deleted only with the identity",
  ],
  [
    "self_service_organization_setup_rece_personal_workspace_id_fkey",
    "organization setup receipts keep the workspaces they created",
  ],
  [
    "additional_organization_creation_rec_personal_workspace_id_fkey",
    "organization creation receipts keep the workspaces they created",
  ],
  [
    "additional_organization_creation_recei_shared_workspace_id_fkey",
    "organization creation receipts keep the workspaces they created",
  ],
]);

describe("workspace deletion schema", () => {
  test("every reference between two removed tables is a deferrable no-action check", async () => {
    const rows = await shared.admin.unsafe<Array<{ name: string; action: string }>>(`
      ${REMOVED_TABLES}
      SELECT c.conname AS name,
        c.confdeltype::text || CASE WHEN c.condeferrable THEN ' deferrable' ELSE '' END AS action
      FROM pg_constraint c
      WHERE c.contype = 'f' AND c.conparentid = 0
        AND c.conrelid IN (SELECT relation_id FROM removed)
        AND c.confrelid IN (SELECT relation_id FROM removed)
        AND (c.confdeltype = 'r' OR (c.confdeltype = 'a' AND NOT c.condeferrable))
      ORDER BY 1`);
    // RESTRICT is never deferred, and an immediate NO ACTION check runs in
    // the middle of the cascade. Declare the key DEFERRABLE (NO ACTION).
    expect(rows.map((row) => `${row.name} (${row.action})`)).toEqual([]);
  });

  test("only reviewed references from kept tables can refuse a deletion", async () => {
    const rows = await shared.admin.unsafe<Array<{ name: string }>>(`
      ${REMOVED_TABLES}
      SELECT c.conname AS name
      FROM pg_constraint c
      WHERE c.contype = 'f' AND c.conparentid = 0
        AND c.conrelid NOT IN (SELECT relation_id FROM removed)
        AND c.confrelid IN (SELECT relation_id FROM removed)
        AND c.confdeltype IN ('r', 'a')
      ORDER BY 1`);
    expect(rows.map((row) => row.name)).toEqual([...KEPT_REFERENCES.keys()].sort());
  });
});

async function seedAccount(label: string) {
  const accountId = crypto.randomUUID();
  const personalWorkspaceId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const subjectId = `human:${crypto.randomUUID()}`;
  await shared.admin`insert into managed_accounts (id, name) values (${accountId}, ${label})`;
  await shared.admin`
    insert into workspaces (id, account_id, name) values
      (${personalWorkspaceId}, ${accountId}, 'personal'),
      (${workspaceId}, ${accountId}, 'shared')`;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id) values
      (${personalWorkspaceId}, ${accountId}), (${workspaceId}, ${accountId})`;
  await shared.admin`
    insert into organization_memberships (
      account_id, subject_id, status, personal_workspace_id, authorization_revision
    ) values (${accountId}, ${subjectId}, 'active', ${personalWorkspaceId}, 7)`;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id)
    values (${accountId}, ${workspaceId}, ${subjectId})`;
  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${accountId}, 1, ${"a".repeat(64)}, ${"b".repeat(64)}, 'workspace-deletion')`;
  return { accountId, personalWorkspaceId, workspaceId, subjectId };
}

async function workspaceRowCount(workspaceId: string) {
  const [row] = await shared.admin<Array<{ count: number }>>`
    select count(*)::int as count from workspaces where id = ${workspaceId}`;
  return row!.count;
}

/** A finished chat whose turn ran on the owner's personal machine under a grant. */
async function workspaceWithMachineGrantTurn() {
  const { accountId, workspaceId, subjectId } = await seedAccount("machine grant");
  const sessionId = crypto.randomUUID();
  const inTenancy = async <T>(work: (sql: postgres.TransactionSql) => Promise<T>) =>
    await app.begin(async (sql) => {
      await sql`select set_config('opengeni.account_id', ${accountId}, true)`;
      await sql`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
      await sql`select set_config('opengeni.subject_id', ${subjectId}, true)`;
      return await work(sql);
    });

  const [machine] = await inTenancy(
    async (sql) =>
      await sql<Array<{ sandboxId: string }>>`
        select sandbox_id as "sandboxId"
        from finalize_scoped_enrollment(
          ${accountId}::uuid, ${workspaceId}::uuid, 'user',
          ${`pubkey-${crypto.randomUUID()}`}, true, false, 'macos', 'arm64',
          'Owner machine', false
        )`,
  );
  if (!machine) throw new Error("personal machine fixture missing");
  await createSession(adminClient.db, {
    requestedSessionId: sessionId,
    accountId,
    workspaceId,
    initialMessage: "run the simulations",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId },
    subjectId,
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "modal",
    firstPartyMcpTools: [],
  });
  const started = await initializeSessionStartAtomically(adminClient.db, {
    accountId,
    workspaceId,
    sessionId,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  if (!started.turn) throw new Error("turn fixture missing");
  const turnId = started.turn.id;
  await shared.admin`
      update sessions set active_sandbox_id = ${machine.sandboxId},
        active_epoch = active_epoch + 1
      where id = ${sessionId} and account_id = ${accountId}`;
  const [authority] = await shared.admin<
    Array<{
      visibility: string;
      authorityEpoch: number;
      ownerMembershipId: string;
    }>
  >`
      select visibility, authority_epoch::int as "authorityEpoch",
        owner_organization_membership_id as "ownerMembershipId"
      from sessions where id = ${sessionId}`;
  if (!authority) throw new Error("session authority fixture missing");
  await inTenancy(
    async (sql) =>
      await sql`
        select 1 from accept_turn_personal_resource_attachment(
          ${accountId}::uuid, ${workspaceId}::uuid, ${sessionId}::uuid, ${turnId}::uuid,
          'session', ${authority.authorityEpoch}::integer,
          ${authority.visibility === "workspace_shared"}, 1
        )`,
  );

  // The turn runs on the machine under the owner's grant, then finishes.
  const attemptId = crypto.randomUUID();
  await shared.admin.begin(async (sql) => {
    await sql.unsafe("set local opengeni.session_inference_claim = '1'");
    await sql`
        update sessions set active_turn_id = ${turnId}, status = 'running'
        where id = ${sessionId}`;
    await sql`
        update session_turns set active_attempt_id = ${attemptId},
          execution_generation = 1, status = 'running'
        where id = ${turnId}`;
    await sql`
        insert into session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id, execution_generation,
          state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
          verified_control_revision, authority_epoch, authority_visibility,
          authority_owner_organization_membership_id, mcp_approval_policies,
          connector_action_policies, personal_resource_protocol_version
        ) values (
          ${attemptId}, ${accountId}, ${workspaceId}, ${sessionId}, ${turnId}, 1,
          'running', 'workflow', 'run-1', 'activity-1', 0,
          ${authority.authorityEpoch}, ${authority.visibility},
          ${authority.ownerMembershipId}, '{}'::jsonb, '[]'::jsonb, 0
        )`;
  });
  await shared.admin.begin(async (sql) => {
    await sql.unsafe("set local opengeni.session_inference_claim = '1'");
    await sql`
        update session_turn_attempts set state = 'closed', outcome = 'completed',
          closed_at = now()
        where id = ${attemptId}`;
    await sql`
        update session_turns set status = 'completed', finished_at = now()
        where id = ${turnId}`;
    await sql`
        update sessions set active_turn_id = null, status = 'idle'
        where id = ${sessionId}`;
  });
  const [authorizations] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from session_attempt_connected_machine_authorizations
      where attempt_id = ${attemptId}`;
  expect(authorizations!.count).toBe(1);
  return { accountId, workspaceId };
}

async function grantCount(workspaceId: string) {
  const [row] = await shared.admin<Array<{ count: number }>>`
    select count(*)::int as count from organization_user_resource_grants
    where workspace_id = ${workspaceId}`;
  return row!.count;
}

describe("deleting a workspace", () => {
  test("removes a chat whose turn used a personal machine grant", async () => {
    const { accountId, workspaceId } = await workspaceWithMachineGrantTurn();
    const result = await deleteWorkspaceIfQuiescent(appClient.db, {
      accountId,
      workspaceId,
    });
    expect(result.status).toBe("deleted");
    expect(await workspaceRowCount(workspaceId)).toBe(0);
    expect(await grantCount(workspaceId)).toBe(0);
  }, 120_000);

  test("succeeds when the grant is removed before the turn that used it", async () => {
    const { workspaceId } = await workspaceWithMachineGrantTurn();
    // Which of the two the cascade reaches first depends on trigger OIDs.
    // Remove the grant first, exactly what a database ordered that way does.
    const rollback = new Error("rollback");
    await expect(
      shared.admin.begin(async (sql) => {
        await sql`select opengeni_private.defer_workspace_cascade_foreign_keys()`;
        await sql`delete from organization_user_resource_grants where workspace_id = ${workspaceId}`;
        await sql`delete from workspaces where id = ${workspaceId}`;
        await sql`set constraints session_attempt_connected_machine_grant_fk immediate`;
        const [row] = await sql<Array<{ count: number }>>`
          select count(*)::int as count from session_attempt_connected_machine_authorizations
          where workspace_id = ${workspaceId}`;
        expect(row!.count).toBe(0);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  }, 120_000);

  test("removes retained scoped knowledge and Memory history", async () => {
    const { accountId, workspaceId } = await seedAccount("retained knowledge");
    const scopeKey = `workspace:${workspaceId}:-`;
    const hash = "c".repeat(64);
    const entityId = crypto.randomUUID();
    const memoryId = crypto.randomUUID();
    const relatedMemoryId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await shared.admin`
      insert into knowledge_entities (
        id, account_id, scope_kind, scope_workspace_id, scope_key, entity_type,
        normalized_key, display_name, operation_id, input_hash, actor_kind, actor_subject_id
      ) values (
        ${entityId}, ${accountId}, 'workspace', ${workspaceId}, ${scopeKey}, 'project',
        'apollo', 'Apollo', ${`entity-${entityId}`}, ${hash}, 'service', 'service:test'
      )`;
    await shared.admin`
      insert into knowledge_facts (
        account_id, scope_kind, scope_workspace_id, scope_key, subject_entity_id,
        predicate_key, object_kind, object_value, object_hash, operation_id, input_hash,
        actor_kind, actor_subject_id
      ) values (
        ${accountId}, 'workspace', ${workspaceId}, ${scopeKey}, ${entityId},
        'status', 'text', '"active"'::jsonb, ${hash}, ${`fact-${entityId}`}, ${hash},
        'service', 'service:test'
      )`;
    // Memory history is no longer written by any release; seed it the way an
    // older release left it, without the guards that now reject new rows.
    await shared.admin.begin(async (sql) => {
      await sql.unsafe("set local session_replication_role = replica");
      await sql`
        insert into knowledge_memories (id, account_id, workspace_id, text) values
          (${memoryId}, ${accountId}, ${workspaceId}, 'Apollo ships in May'),
          (${relatedMemoryId}, ${accountId}, ${workspaceId}, 'Apollo ships in June')`;
      await sql`
        insert into knowledge_memory_lifecycle_events (
          id, account_id, workspace_id, operation_id, action, operation_type,
          target_memory_id, actor_kind, actor_subject_id, plan_hash, before_state, after_state
        ) values (
          ${eventId}, ${accountId}, ${workspaceId}, ${crypto.randomUUID()}, 'apply', 'archive',
          ${memoryId}, 'service', 'service:test', ${hash}, '{}'::jsonb, '{}'::jsonb
        )`;
      await sql`
        insert into knowledge_memory_relationships (
          account_id, workspace_id, source_memory_id, target_memory_id,
          relationship_type, created_by_event_id
        ) values (
          ${accountId}, ${workspaceId}, ${relatedMemoryId}, ${memoryId}, 'supersedes', ${eventId}
        )`;
    });

    // Retained history stays immutable outside a workspace deletion.
    await expect(
      shared.admin`delete from knowledge_entities where id = ${entityId}`,
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      shared.admin`delete from knowledge_memory_lifecycle_events where id = ${eventId}`,
    ).rejects.toMatchObject({ code: "55000" });

    const result = await deleteWorkspaceIfQuiescent(appClient.db, {
      accountId,
      workspaceId,
    });
    expect(result.status).toBe("deleted");
    expect(await workspaceRowCount(workspaceId)).toBe(0);
    const [remaining] = await shared.admin<Array<{ count: number }>>`
      select
        (select count(*) from knowledge_entities where scope_workspace_id = ${workspaceId})
        + (select count(*) from knowledge_facts where scope_workspace_id = ${workspaceId})
        + (select count(*) from knowledge_memories where workspace_id = ${workspaceId})
        + (select count(*) from knowledge_memory_lifecycle_events where workspace_id = ${workspaceId})
        + (select count(*) from knowledge_memory_relationships where workspace_id = ${workspaceId})
        AS count`;
    expect(Number(remaining!.count)).toBe(0);
  }, 120_000);
});
