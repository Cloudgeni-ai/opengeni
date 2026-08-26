import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { claimSessionWorkForAttempt, createDb, createSession } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const REPAIR = "0343_personal_document_force_rls_lock_repair.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

async function applyBelow(url: string, upperBound: string): Promise<void> {
  const deferred = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql") && file >= upperBound)
    .sort();
  const ledger = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await ledger.unsafe(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const file of deferred) {
      await ledger`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
    }
    await migrate(url);
    await ledger`delete from schema_migrations where name >= ${upperBound}`;
  } finally {
    await ledger.end({ timeout: 5 });
  }
}

describe("migration 0343 personal Document FORCE-RLS lock repair", () => {
  let owned: OwnerMigratedTestDatabase | null = null;

  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("migration-0343-personal-documents");
    if (!owned && requireRealDatabase) {
      throw new Error(
        "[migration-0343-personal-documents] OPENGENI_REQUIRE_REAL_DB=1 but the owner-migrated PostgreSQL harness is unavailable",
      );
    }
  }, 600_000);

  afterAll(async () => {
    await owned?.release();
  }, 120_000);

  test("reproduces the shipped legacy fallback and restores portable authority", async () => {
    if (!owned) return;
    const { admin, adminUrl, ownerUrl, ownerRole, appPassword } = owned;
    await applyBelow(ownerUrl, REPAIR);
    // Current session adapters select the complete current sessions row while
    // this fixture intentionally holds the database below 0343. Supply only
    // the later column they need, then remove it before the real deferred
    // migration chain runs so 0348 still owns creation and backfill.
    await admin`
      alter table sessions
      add column variable_set_ids jsonb not null default '[]'::jsonb`;
    await provisionRoles(adminUrl, { appPassword, rlsStrategy: "force" });

    const [posture] = await admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as superuser, rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${ownerRole}`;
    expect(posture).toEqual({ superuser: false, bypassRls: false });

    const accountId = crypto.randomUUID();
    const personalWorkspaceId = crypto.randomUUID();
    const sharedWorkspaceId = crypto.randomUUID();
    const subjectId = `user:${crypto.randomUUID()}`;
    const membershipId = crypto.randomUUID();
    await admin`insert into managed_accounts (id, name) values (${accountId}, '0343 account')`;
    await admin`
      insert into workspaces (id, account_id, name) values
        (${personalWorkspaceId}, ${accountId}, 'Personal'),
        (${sharedWorkspaceId}, ${accountId}, 'Shared')`;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id) values
        (${personalWorkspaceId}, ${accountId}), (${sharedWorkspaceId}, ${accountId})`;
    await admin`
      insert into organization_memberships (
        id, account_id, subject_id, status, personal_workspace_id
      ) values (${membershipId}, ${accountId}, ${subjectId}, 'active', ${personalWorkspaceId})`;
    await admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${accountId}, ${sharedWorkspaceId}, ${subjectId})`;

    const appUrl = new URL(ownerUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = appPassword;
    const openApp = () => postgres(appUrl.toString(), { max: 1, onnotice: () => undefined });
    let app = openApp();
    const runtimeOwner = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
    const db = createDb(adminUrl, { max: 1 });

    const session = await createSession(db.db, {
      requestedSessionId: crypto.randomUUID(),
      accountId,
      workspaceId: sharedWorkspaceId,
      initialMessage: "read portable personal document",
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
    const [sessionAuthority] = await admin<
      Array<{ visibility: string; epoch: number; membershipId: string | null }>
    >`
      select visibility, authority_epoch as epoch,
        owner_organization_membership_id as "membershipId"
      from sessions where id = ${session.id}`;
    const [turn] = await admin.begin(async (tx) => {
      await tx`select
        set_config('opengeni.account_id', ${accountId}, true),
        set_config('opengeni.workspace_id', ${sharedWorkspaceId}, true),
        set_config('opengeni.subject_id', ${subjectId}, true)`;
      return await tx<Array<{ id: string }>>`
        insert into session_turns (
          account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
          status, position, prompt, model, reasoning_effort, latency_mode, sandbox_backend,
          initiator_kind, initiator_subject_id, initiating_human_subject_id
        ) values (
          ${accountId}, ${sharedWorkspaceId}, ${session.id}, ${crypto.randomUUID()},
          ${`session-${session.id}`}, 'queued', 1, 'read', 'test-model', 'medium',
          'standard', 'modal', 'subject', ${subjectId}, ${subjectId}
        ) returning id`;
    });
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(db.db, sharedWorkspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");
    if (claimed.action === "claimed") expect(claimed.turn.id).toBe(turn!.id);
    const prepare = async () =>
      await runtimeOwner.begin(async (tx) => {
        await tx`select
          set_config('opengeni.session_variable_set_attachments_v1', '1', true),
          set_config('opengeni.account_id', ${accountId}, true),
          set_config('opengeni.workspace_id', ${sharedWorkspaceId}, true),
          set_config('opengeni.subject_id', ${subjectId}, true)`;
        const [row] = await tx<Array<{ count: number }>>`
          select prepare_session_attempt_personal_document_reads(
            ${accountId}::uuid, ${sharedWorkspaceId}::uuid,
            ${session.id}::uuid, ${attemptId}::uuid
          )::int as count`;
        return row!.count;
      });
    expect(await prepare()).toBe(0);
    const preRepairAdmissions = await admin<Array<{ id: string }>>`
      select attempt_id as id from session_attempt_personal_document_admissions
      where attempt_id = ${attemptId}`;
    expect(preRepairAdmissions).toHaveLength(0);
    const mint = async (documentId: string) =>
      await app.begin(async (tx) => {
        await tx`select
          set_config('opengeni.account_id', ${accountId}, true),
          set_config('opengeni.workspace_id', ${sharedWorkspaceId}, true),
          set_config('opengeni.subject_id', ${subjectId}, true)`;
        return [
          ...(await tx<Array<{ authorityId: string; membershipId: string }>>`
            select authority_id as "authorityId",
              owner_organization_membership_id as "membershipId"
            from create_personal_document_authority(
              ${accountId}::uuid, ${sharedWorkspaceId}::uuid, ${documentId}::uuid
            )`),
        ];
      });

    const beforeDocument = crypto.randomUUID();
    expect(await mint(beforeDocument)).toEqual([]);
    const legacyAuthorities = await admin<Array<{ id: string }>>`
      select id from organization_user_resource_authorities
      where resource_kind = 'document' and resource_id = ${beforeDocument}`;
    expect(legacyAuthorities).toHaveLength(0);

    const applicationSessionCount = async () => {
      const [row] = await admin<Array<{ count: number }>>`
        select count(*)::int as count
        from pg_stat_activity
        where datname = current_database()
          and usename = 'opengeni_app'`;
      return row!.count;
    };
    expect(await applicationSessionCount()).toBe(1);
    // This historical 0343 replay now crosses maintenance migration 0348. Model
    // the required application-writer drain instead of weakening its fail-closed guard.
    await app.end({ timeout: 5 });
    expect(await applicationSessionCount()).toBe(0);
    await admin`alter table sessions drop column variable_set_ids`;
    await migrate(ownerUrl);
    app = openApp();

    const afterDocument = crypto.randomUUID();
    const [authority] = await mint(afterDocument);
    expect(authority?.membershipId).toBe(membershipId);
    expect(authority?.authorityId).toBeTruthy();

    const [file] = await admin<Array<{ id: string }>>`
      insert into files (
        account_id, workspace_id, status, filename, safe_filename, content_type,
        size_bytes, bucket, object_key
      ) values (
        ${accountId}, ${sharedWorkspaceId}, 'ready', '0343.txt', '0343.txt',
        'text/plain', 4, 'test', ${`documents/${crypto.randomUUID()}`}
      ) returning id`;
    const [base] = await admin<Array<{ id: string }>>`
      insert into document_bases (account_id, workspace_id, name)
      values (${accountId}, ${sharedWorkspaceId}, '0343') returning id`;
    await admin`
      insert into documents (
        id, account_id, workspace_id, base_id, file_id, status, title, created_by,
        authority_kind, authority_workspace_id, authority_subject_id, authority_id,
        owner_organization_membership_id, origin_workspace_id, visibility, agent_access
      ) values (
        ${afterDocument}, ${accountId}, ${sharedWorkspaceId}, ${base!.id}, ${file!.id},
        'ready', 'portable', ${subjectId}, 'personal', null, ${subjectId},
        ${authority!.authorityId}, ${membershipId}, ${sharedWorkspaceId}, 'private', true
      )`;
    await admin`
      insert into organization_user_resource_grants (
        account_id, authority_id, owner_organization_membership_id, workspace_id,
        session_id, action, mode, context, authority_epoch, generation, status
      ) values (
        ${accountId}, ${authority!.authorityId}, ${membershipId}, ${sharedWorkspaceId},
        ${session.id}, 'document.read', 'session', ${sessionAuthority!.visibility},
        ${sessionAuthority!.epoch}, 1, 'active'
      )`;
    const eligibleDocuments = await admin<Array<{ id: string }>>`
      select document_value.id
      from documents document_value
      join organization_user_resource_authorities authority
        on authority.id = document_value.authority_id
       and authority.account_id = document_value.account_id
       and authority.organization_membership_id = document_value.owner_organization_membership_id
       and authority.resource_kind = 'document'
       and authority.resource_id = document_value.id
       and authority.status = 'active'
       and authority.revoked_at is null
      join organization_user_resource_grants grant_value
        on grant_value.account_id = document_value.account_id
       and grant_value.authority_id = document_value.authority_id
       and grant_value.owner_organization_membership_id = document_value.owner_organization_membership_id
       and grant_value.workspace_id = ${sharedWorkspaceId}
       and grant_value.session_id = ${session.id}
       and grant_value.action = 'document.read'
       and grant_value.mode = 'session'
       and grant_value.context = ${sessionAuthority!.visibility}
       and grant_value.authority_epoch = ${sessionAuthority!.epoch}
       and grant_value.status = 'active'
      where document_value.id = ${afterDocument}
        and document_value.authority_kind = 'personal'
        and document_value.authority_workspace_id is null
        and document_value.authority_subject_id = ${subjectId}
        and document_value.owner_organization_membership_id = ${membershipId}
        and document_value.status = 'ready'
        and document_value.agent_access = true`;
    expect([...eligibleDocuments]).toEqual([{ id: afterDocument }]);
    expect(await prepare()).toBe(1);
    const [snapshot] = await admin<Array<{ documentId: string; membershipId: string }>>`
      select document_id as "documentId",
        owner_organization_membership_id as "membershipId"
      from session_attempt_personal_document_snapshots where attempt_id = ${attemptId}`;
    expect(snapshot).toEqual({ documentId: afterDocument, membershipId });

    const routines = await admin<Array<{ name: string; definition: string }>>`
      select proname as name, pg_get_functiondef(oid) as definition
      from pg_proc
      where oid in (
        'create_personal_document_authority(uuid,uuid,uuid)'::regprocedure,
        'prepare_session_attempt_personal_document_reads(uuid,uuid,uuid,uuid)'::regprocedure
      ) order by proname`;
    expect(routines).toHaveLength(2);
    for (const routine of routines) {
      expect(routine.definition).toContain("membership read was RLS-blinded");
      expect(routine.definition).not.toMatch(
        /FROM organization_memberships membership[\s\S]*?membership\.revoked_at IS NULL\s+FOR SHARE;/u,
      );
    }
    const [rlsPosture] = await admin<Array<{ forced: boolean }>>`
      select relforcerowsecurity as forced from pg_class
      where oid = 'organization_memberships'::regclass`;
    expect(rlsPosture).toEqual({ forced: true });
    await expect(
      app.begin(async (tx) => {
        await tx`select
          set_config('opengeni.account_id', ${accountId}, true),
          set_config('opengeni.workspace_id', ${sharedWorkspaceId}, true),
          set_config('opengeni.subject_id', ${`human:${crypto.randomUUID()}`}, true)`;
        return await tx<Array<{ id: string }>>`
          select id from organization_memberships where id = ${membershipId}`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await db.close();
    await runtimeOwner.end({ timeout: 5 });
    await app.end({ timeout: 5 });
  }, 900_000);

  test("the migration source guards every exact predecessor fragment", async () => {
    const source = await readFile(join(migrationsDir, REPAIR), "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source.match(/repair shape changed/g)).toHaveLength(3);
    expect(source.match(/USING ERRCODE = '55000'/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
