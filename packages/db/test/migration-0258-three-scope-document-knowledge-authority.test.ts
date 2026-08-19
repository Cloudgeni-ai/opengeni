import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { createDb, createSession } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const migrationUrl = new URL(
  "../drizzle/0258_three_scope_document_knowledge_authority.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

type Scope = { accountId: string; workspaceId: string; subjectId: string };

async function withScope<T>(
  sql: postgres.Sql,
  scope: Scope,
  callback: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`select
      set_config('opengeni.account_id', ${scope.accountId}, true),
      set_config('opengeni.workspace_id', ${scope.workspaceId}, true),
      set_config('opengeni.subject_id', ${scope.subjectId}, true),
      set_config('opengeni.initiating_human_subject_id', ${scope.subjectId}, true)`;
    return await callback(tx);
  })) as T;
}

describe("migration 0258 three-scope Document/Knowledge authority", () => {
  test("keeps legacy rows anchored and requires exact-attempt grants for agent reads", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("create_personal_document_authority");
    expect(source).toContain("prepare_session_attempt_personal_document_reads");
    expect(source).toContain('CREATE TRIGGER "session_attempt_personal_document_admission"');
    expect(source).toContain("resolve_session_attempt_personal_document_reads");
    expect(source).toContain("'document.read'");
    expect(source).toContain("session_attempt_personal_document_snapshots");
    expect(source).toContain("personal_document_once_consumption_receipts");
    expect(source).toContain('"authority_workspace_id" = "workspace_id"');
    expect(source).toContain('"authority_workspace_id" IS NULL');
    expect(source).toContain("origin_workspace_id");
    expect(source).toContain("IF NOT FOUND THEN");
    expect(source).not.toContain("INTO STRICT member_row");
    expect(source).not.toMatch(/p_owner|p_subject|owner_subject/iu);
  });

  test("preserves user knowledge across workspace loss and revokes agent grants immediately", async () => {
    const blank = await acquireBlankTestDatabase("migration-0258-three-scope-documents");
    if (!blank && requireRealDatabase) {
      throw new Error(
        "[migration-0258-three-scope-documents] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    if (!blank) return;

    const appPassword = `app-${crypto.randomUUID()}`;
    let admin: postgres.Sql | undefined;
    let app: postgres.Sql | undefined;
    let db: ReturnType<typeof createDb> | undefined;
    try {
      await migrate(blank.databaseUrl);
      await provisionRoles(blank.databaseUrl, {
        appPassword,
        rlsStrategy: "force",
      });
      admin = postgres(blank.databaseUrl, {
        max: 3,
        prepare: false,
        onnotice: () => undefined,
      });
      const appUrl = new URL(blank.databaseUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = appPassword;
      app = postgres(appUrl.toString(), {
        max: 2,
        prepare: false,
        onnotice: () => undefined,
      });
      db = createDb(blank.databaseUrl, { max: 1 });

      const ownerSubject = `human:${crypto.randomUUID()}`;
      const otherSubject = `human:${crypto.randomUUID()}`;
      const [account] = await admin<Array<{ id: string }>>`
        insert into managed_accounts (name) values (${`documents-${crypto.randomUUID()}`})
        returning id`;
      const workspaceRows = await Promise.all(
        ["owner personal", "workspace a", "workspace b", "other personal"].map((name) =>
          admin!<Array<{ id: string }>>`
            insert into workspaces (account_id, name) values (${account!.id}, ${name})
            returning id`.then((rows) => rows[0]!),
        ),
      );
      const personal = workspaceRows[0]!;
      const workspaceA = workspaceRows[1]!;
      const workspaceB = workspaceRows[2]!;
      const otherPersonal = workspaceRows[3]!;
      await admin`
        insert into workspace_inference_controls (workspace_id, account_id) values
          (${personal.id}, ${account!.id}), (${workspaceA.id}, ${account!.id}),
          (${workspaceB.id}, ${account!.id}), (${otherPersonal.id}, ${account!.id})`;
      const [ownerMembership] = await admin<Array<{ id: string }>>`
        insert into organization_memberships (
          account_id, subject_id, status, personal_workspace_id, authorization_revision
        ) values (${account!.id}, ${ownerSubject}, 'active', ${personal.id}, 7)
        returning id`;
      await admin`
        insert into organization_memberships (
          account_id, subject_id, status, personal_workspace_id, authorization_revision
        ) values (${account!.id}, ${otherSubject}, 'active', ${otherPersonal.id}, 2)`;
      await admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id) values
          (${account!.id}, ${workspaceA.id}, ${ownerSubject}),
          (${account!.id}, ${workspaceB.id}, ${ownerSubject}),
          (${account!.id}, ${workspaceB.id}, ${otherSubject})`;

      const ownerA = {
        accountId: account!.id,
        workspaceId: workspaceA.id,
        subjectId: ownerSubject,
      };
      const ownerB = {
        accountId: account!.id,
        workspaceId: workspaceB.id,
        subjectId: ownerSubject,
      };
      const otherB = {
        accountId: account!.id,
        workspaceId: workspaceB.id,
        subjectId: otherSubject,
      };
      const legacySubject = `configured:${crypto.randomUUID()}`;
      const legacyDocumentId = crypto.randomUUID();
      const legacyAuthority = await withScope(
        app,
        {
          accountId: account!.id,
          workspaceId: workspaceA.id,
          subjectId: legacySubject,
        },
        async (tx) =>
          await tx<Array<{ authorityId: string }>>`
            select authority_id as "authorityId"
            from create_personal_document_authority(
              ${account!.id}::uuid, ${workspaceA.id}::uuid, ${legacyDocumentId}::uuid
            )`,
      );
      expect([...legacyAuthority]).toEqual([]);
      const legacyRows = await admin<Array<{ id: string }>>`
        select id from organization_user_resource_authorities
        where account_id = ${account!.id} and resource_kind = 'document'
          and resource_id = ${legacyDocumentId}`;
      expect([...legacyRows]).toEqual([]);
      const [file] = await admin<Array<{ id: string }>>`
        insert into files (
          account_id, workspace_id, status, filename, safe_filename, content_type,
          size_bytes, bucket, object_key
        ) values (
          ${account!.id}, ${workspaceA.id}, 'ready', 'personal.txt', 'personal.txt',
          'text/plain', 8, 'test', ${`documents/${crypto.randomUUID()}`}
        ) returning id`;
      const [base] = await admin<Array<{ id: string }>>`
        insert into document_bases (account_id, workspace_id, name)
        values (${account!.id}, ${workspaceA.id}, 'personal') returning id`;
      const [legacyFile] = await admin<Array<{ id: string }>>`
        insert into files (
          account_id, workspace_id, status, filename, safe_filename, content_type,
          size_bytes, bucket, object_key
        ) values (
          ${account!.id}, ${workspaceA.id}, 'ready', 'legacy-personal.txt',
          'legacy-personal.txt', 'text/plain', 8, 'test',
          ${`documents/${crypto.randomUUID()}`}
        ) returning id`;
      const [legacyDocument] = await admin<
        Array<{
          authorityKind: string;
          authorityWorkspaceId: string | null;
          authoritySubjectId: string | null;
          authorityId: string | null;
          visibility: string;
        }>
      >`
        insert into documents (
          id, account_id, workspace_id, base_id, file_id, status, title,
          created_by, visibility, agent_access
        ) values (
          ${legacyDocumentId}, ${account!.id}, ${workspaceA.id}, ${base!.id},
          ${legacyFile!.id}, 'ready', 'legacy personal evidence', ${legacySubject},
          'private', true
        ) returning authority_kind as "authorityKind",
          authority_workspace_id as "authorityWorkspaceId",
          authority_subject_id as "authoritySubjectId", authority_id as "authorityId",
          visibility`;
      expect(legacyDocument).toEqual({
        authorityKind: "personal",
        authorityWorkspaceId: workspaceA.id,
        authoritySubjectId: legacySubject,
        authorityId: null,
        visibility: "private",
      });
      const documentId = crypto.randomUUID();
      const [authority] = await withScope(app, ownerA, async (tx) => {
        const [created] = await tx<
          Array<{
            authorityId: string;
            ownerMembershipId: string;
            generation: number;
          }>
        >`
          select authority_id as "authorityId",
            owner_organization_membership_id as "ownerMembershipId",
            authority_generation::int as generation
          from create_personal_document_authority(
            ${account!.id}::uuid, ${workspaceA.id}::uuid, ${documentId}::uuid
          )`;
        await tx`
          insert into documents (
            id, account_id, workspace_id, base_id, file_id, status, title, created_by,
            authority_kind, authority_workspace_id, authority_subject_id,
            authority_id, owner_organization_membership_id, origin_workspace_id,
            visibility, agent_access
          ) values (
            ${documentId}, ${account!.id}, ${workspaceA.id}, ${base!.id}, ${file!.id},
            'ready', 'personal evidence', ${ownerSubject}, 'personal', null,
            ${ownerSubject}, ${created!.authorityId}, ${created!.ownerMembershipId},
            ${workspaceA.id}, 'private', true
          )`;
        return [created!];
      });
      expect(authority).toEqual({
        authorityId: expect.any(String),
        ownerMembershipId: ownerMembership!.id,
        generation: 1,
      });
      const [lateFile] = await admin<Array<{ id: string }>>`
        insert into files (
          account_id, workspace_id, status, filename, safe_filename, content_type,
          size_bytes, bucket, object_key
        ) values (
          ${account!.id}, ${workspaceA.id}, 'ready', 'later.txt', 'later.txt',
          'text/plain', 8, 'test', ${`documents/${crypto.randomUUID()}`}
        ) returning id`;
      const lateDocumentId = crypto.randomUUID();
      const [lateAuthority] = await withScope(app, ownerA, async (tx) => {
        const [created] = await tx<Array<{ authorityId: string; ownerMembershipId: string }>>`
          select authority_id as "authorityId",
            owner_organization_membership_id as "ownerMembershipId"
          from create_personal_document_authority(
            ${account!.id}::uuid, ${workspaceA.id}::uuid, ${lateDocumentId}::uuid
          )`;
        await tx`
          insert into documents (
            id, account_id, workspace_id, base_id, file_id, status, title, created_by,
            authority_kind, authority_workspace_id, authority_subject_id,
            authority_id, owner_organization_membership_id, origin_workspace_id,
            visibility, agent_access
          ) values (
            ${lateDocumentId}, ${account!.id}, ${workspaceA.id}, ${base!.id}, ${lateFile!.id},
            'ready', 'later personal evidence', ${ownerSubject}, 'personal', null,
            ${ownerSubject}, ${created!.authorityId}, ${created!.ownerMembershipId},
            ${workspaceA.id}, 'private', true
          )`;
        return [created!];
      });

      const visible = async (scope: Scope) =>
        await withScope(app!, scope, async (tx) =>
          (await tx<Array<{ id: string }>>`select id from documents where id = ${documentId}`).map(
            (row) => row.id,
          ),
        );
      expect(await visible(ownerB)).toEqual([documentId]);
      expect(await visible(otherB)).toEqual([]);
      await admin`
        delete from workspace_memberships
        where account_id = ${account!.id} and workspace_id = ${workspaceA.id}
          and subject_id = ${ownerSubject}`;
      expect(await visible(ownerB)).toEqual([documentId]);

      const session = await createSession(db.db, {
        requestedSessionId: crypto.randomUUID(),
        accountId: account!.id,
        workspaceId: workspaceB.id,
        initialMessage: "read personal knowledge",
        resources: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId: ownerSubject },
        subjectId: ownerSubject,
        model: "test-model",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "modal",
        firstPartyMcpTools: [],
      });
      const [sessionAuthority] = await admin<
        Array<{
          visibility: string;
          epoch: number;
          membershipId: string | null;
        }>
      >`
        select visibility, authority_epoch as epoch,
          owner_organization_membership_id as "membershipId"
        from sessions where id = ${session.id}`;
      const [grant] = await withScope(
        app,
        ownerB,
        async (tx) =>
          await tx<Array<{ grantId: string }>>`
          select grant_id as "grantId" from issue_self_user_resource_grant(
            ${account!.id}::uuid, ${authority!.authorityId}::uuid,
            ${workspaceB.id}::uuid, 'document.read', 'once',
            'workspace_shared', ${session.id}::uuid, true
          )`,
      );
      const [turn] = await admin<Array<{ id: string }>>`
        insert into session_turns (
          account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
          status, position, prompt, model, reasoning_effort, latency_mode, sandbox_backend,
          initiator_kind, initiator_subject_id, initiating_human_subject_id
        ) values (
          ${account!.id}, ${workspaceB.id}, ${session.id}, ${crypto.randomUUID()},
          'workflow-document', 'running', 1, 'read', 'test-model', 'medium', 'standard',
          'modal', 'subject', ${ownerSubject}, ${ownerSubject}
        ) returning id`;
      const attemptId = crypto.randomUUID();
      await admin.begin(async (tx) => {
        await tx.unsafe("set local opengeni.session_inference_claim = '1'");
        await tx`update sessions set active_turn_id = ${turn!.id}, status = 'running'
          where id = ${session.id}`;
        await tx`update session_turns set active_attempt_id = ${attemptId},
          execution_generation = 1, status = 'running' where id = ${turn!.id}`;
        await tx`
          insert into session_turn_attempts (
            id, account_id, workspace_id, session_id, turn_id, execution_generation,
            temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
            verified_control_revision, authority_epoch, authority_visibility,
            authority_owner_organization_membership_id, mcp_approval_policies,
            connector_action_policies
          ) values (
            ${attemptId}, ${account!.id}, ${workspaceB.id}, ${session.id}, ${turn!.id}, 1,
            'workflow-document', 'run-document', 'activity-document', 1,
            ${sessionAuthority!.epoch}, ${sessionAuthority!.visibility},
            ${sessionAuthority!.membershipId}, '{}'::jsonb, '[]'::jsonb
          )`;
      });

      await withScope(app, ownerB, async (tx) => {
        await tx`select issue_self_user_resource_grant(
          ${account!.id}::uuid, ${lateAuthority!.authorityId}::uuid,
          ${workspaceB.id}::uuid, 'document.read', 'always',
          'workspace_shared', null, true
        )`;
      });

      const resolve = async () =>
        await withScope(app!, ownerB, async (tx) => {
          return (
            await tx<Array<{ id: string }>>`
              select resolve_session_attempt_personal_document_reads(
                ${account!.id}::uuid, ${workspaceB.id}::uuid,
                ${session.id}::uuid, ${attemptId}::uuid
              ) as id`
          ).map((row) => row.id);
        });
      expect(await resolve()).toEqual([documentId]);
      await withScope(app, ownerB, async (tx) => {
        await tx`select revoke_self_user_resource_grant(
          ${account!.id}::uuid, ${grant!.grantId}::uuid
        )`;
      });
      await expect(resolve()).rejects.toThrow(/snapshot is no longer live/iu);
    } finally {
      await app?.end().catch(() => undefined);
      await admin?.end().catch(() => undefined);
      await db?.close().catch(() => undefined);
      await blank.release();
    }
  }, 180_000);
});
