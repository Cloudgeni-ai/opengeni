import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const migrationUrl = new URL(
  "../drizzle/0334_document_authority_reclassification.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const subjectId = `human:${crypto.randomUUID()}`;
const otherSubjectId = `human:${crypto.randomUUID()}`;

let blank: BlankTestDatabase | null = null;
let admin: postgres.Sql | null = null;
let app: postgres.Sql | null = null;
let accountId = "";
let workspaceIds: string[] = [];

function accountAdminAuthorization(
  account = accountId,
  actorSubjectId = subjectId,
): Record<string, string> {
  return {
    authorizationId: crypto.randomUUID(),
    accountId: account,
    actorSubjectId,
    permission: "account:admin",
  };
}

async function withScope<T>(
  scope: { accountId: string; workspaceId: string; subjectId: string },
  callback: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  if (!app) throw new Error("test database is unavailable");
  return (await app.begin(async (tx) => {
    await tx`select
      set_config('opengeni.account_id', ${scope.accountId}, true),
      set_config('opengeni.workspace_id', ${scope.workspaceId}, true),
      set_config('opengeni.subject_id', ${scope.subjectId}, true),
      set_config('opengeni.initiating_human_subject_id', ${scope.subjectId}, true)`;
    return await callback(tx);
  })) as T;
}

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0334-document-authority");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0334-document-authority] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    return;
  }
  const password = `app-${crypto.randomUUID()}`;
  await migrate(blank.databaseUrl);
  await provisionRoles(blank.databaseUrl, { appPassword: password, rlsStrategy: "force" });
  admin = postgres(blank.databaseUrl, { max: 3, prepare: false, onnotice: () => undefined });
  const appUrl = new URL(blank.databaseUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = password;
  app = postgres(appUrl.toString(), { max: 2, prepare: false, onnotice: () => undefined });

  const [account] = await admin<Array<{ id: string }>>`
    insert into managed_accounts (name) values (${`document-migration-${crypto.randomUUID()}`})
    returning id`;
  accountId = account!.id;
  workspaceIds = await Promise.all(
    ["personal", "alpha", "beta", "gamma"].map(async (name) => {
      const [workspace] = await admin!<Array<{ id: string }>>`
        insert into workspaces (account_id, name)
        values (${accountId}, ${`document-migration-${name}`}) returning id`;
      return workspace!.id;
    }),
  );
  await admin`
    insert into organization_memberships (
      account_id, subject_id, role, status, personal_workspace_id, authorization_revision
    ) values
      (${accountId}, ${subjectId}, 'admin', 'active', ${workspaceIds[0]!}, 1),
      (${accountId}, ${otherSubjectId}, 'member', 'active', ${workspaceIds[3]!}, 1)`;
  await admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values
      (${accountId}, ${workspaceIds[1]!}, ${subjectId}, 'admin'),
      (${accountId}, ${workspaceIds[2]!}, ${subjectId}, 'member'),
      (${accountId}, ${workspaceIds[1]!}, ${otherSubjectId}, 'member')`;
  await admin`
    insert into document_bases (account_id, workspace_id, name)
    values (${accountId}, ${workspaceIds[2]!}, 'default')`;
}, 180_000);

afterAll(async () => {
  await app?.end().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  await blank?.release();
}, 180_000);

describe("migration 0334 Document authority reclassification", () => {
  test("is rolling, explicit, and keeps legacy authority unchanged until a lifecycle call", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("document_authority_reclassifications");
    expect(source).toContain("document_default_collection_backfill_receipts");
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain("document authority changed before reclassification");
    expect(source).toContain(
      "personal document reclassification requires the original creating subject",
    );
    expect(source).not.toMatch(/update\s+documents[\s\S]{0,120}where\s+authority_kind\s*=/iu);
  });

  test("atomically migrates the exact Document and chunks with replay-safe receipts", async () => {
    if (!admin || !app) return;
    const workspaceId = workspaceIds[1]!;
    const [file] = await admin<Array<{ id: string }>>`
      insert into files (
        account_id, workspace_id, status, filename, safe_filename, content_type,
        size_bytes, bucket, object_key
      ) values (
        ${accountId}, ${workspaceId}, 'ready', 'legacy.txt', 'legacy.txt', 'text/plain',
        6, 'test', ${`documents/${crypto.randomUUID()}`}
      ) returning id`;
    const [base] = await admin<Array<{ id: string }>>`
      insert into document_bases (account_id, workspace_id, name)
      values (${accountId}, ${workspaceId}, 'legacy') returning id`;
    const [document] = await admin<Array<{ id: string }>>`
      insert into documents (
        account_id, workspace_id, base_id, file_id, status, title, created_by,
        authority_kind, authority_workspace_id, visibility, agent_access
      ) values (
        ${accountId}, ${workspaceId}, ${base!.id}, ${file!.id}, 'ready', 'legacy',
        ${subjectId}, 'workspace', ${workspaceId}, 'workspace', true
      ) returning id`;
    const zeroVector = `[${Array.from({ length: 3072 }, () => "0").join(",")}]`;
    await admin`
      insert into document_chunks (
        account_id, workspace_id, document_id, base_id, file_id, chunk_index,
        text, metadata, embedding, embedding_model, authority_kind,
        authority_workspace_id
      ) values (
        ${accountId}, ${workspaceId}, ${document!.id}, ${base!.id}, ${file!.id}, 0,
        'legacy', '{}'::jsonb, ${zeroVector}::vector, 'test', 'workspace', ${workspaceId}
      )`;

    const operationId = crypto.randomUUID();
    const command = {
      accountId,
      workspaceId,
      documentId: document!.id,
      operationId,
      actorSubjectId: subjectId,
      expectedAuthority: {
        kind: "workspace",
        workspaceId,
        subjectId: null,
        authorityId: null,
      },
      targetAuthorityKind: "personal",
      accountAdminAuthorization: null,
    };
    await expect(
      withScope({ accountId, workspaceId, subjectId: otherSubjectId }, async (tx) => {
        await tx`select reclassify_document_authority(${tx.json({
          ...command,
          operationId: crypto.randomUUID(),
          actorSubjectId: otherSubjectId,
        })}::jsonb)`;
      }),
    ).rejects.toThrow("personal document reclassification requires the original creating subject");
    const [beforeAcceptedMigration] = await admin<
      Array<{ kind: string; workspaceId: string | null }>
    >`
      select authority_kind as kind, authority_workspace_id as "workspaceId"
      from documents where id = ${document!.id}`;
    expect(beforeAcceptedMigration).toEqual({ kind: "workspace", workspaceId });

    const first = await withScope({ accountId, workspaceId, subjectId }, async (tx) => {
      const [scope] = await tx<
        Array<{ accountId: string; workspaceId: string; subjectId: string }>
      >`
          select current_setting('opengeni.account_id') as "accountId",
            current_setting('opengeni.workspace_id') as "workspaceId",
            current_setting('opengeni.subject_id') as "subjectId"`;
      expect(scope).toEqual({ accountId, workspaceId, subjectId });
      const [parsedCommand] = await tx<
        Array<{
          accountId: string | null;
          workspaceId: string | null;
          documentId: string | null;
          operationId: string | null;
          actorSubjectId: string | null;
        }>
      >`
          select (${tx.json(command)}::jsonb) ->> 'accountId' as "accountId",
            (${tx.json(command)}::jsonb) ->> 'workspaceId' as "workspaceId",
            (${tx.json(command)}::jsonb) ->> 'documentId' as "documentId",
            (${tx.json(command)}::jsonb) ->> 'operationId' as "operationId",
            (${tx.json(command)}::jsonb) ->> 'actorSubjectId' as "actorSubjectId"`;
      expect(parsedCommand).toEqual({
        accountId,
        workspaceId,
        documentId: document!.id,
        operationId,
        actorSubjectId: subjectId,
      });
      return (
        await tx<Array<{ result: Record<string, unknown> }>>`
            select reclassify_document_authority(${tx.json(command)}::jsonb) as result`
      )[0]!.result;
    });
    const replay = await withScope(
      { accountId, workspaceId, subjectId },
      async (tx) =>
        (
          await tx<Array<{ result: Record<string, unknown> }>>`
            select reclassify_document_authority(${tx.json(command)}::jsonb) as result`
        )[0]!.result,
    );
    expect(replay).toEqual(first);
    await expect(
      withScope({ accountId, workspaceId, subjectId }, async (tx) => {
        await tx`select reclassify_document_authority(${tx.json({
          ...command,
          expectedAuthority: {
            ...command.expectedAuthority,
            workspaceId: workspaceIds[2]!,
          },
        })}::jsonb)`;
      }),
    ).rejects.toThrow("document reclassification operation id was reused with different input");
    expect(first).toMatchObject({
      operationId,
      documentId: document!.id,
      previousAuthority: { kind: "workspace", workspaceId },
      authority: { kind: "personal", workspaceId: null, subjectId },
    });

    const [stored] = await admin<
      Array<{
        documentKind: string;
        documentWorkspace: string | null;
        documentSubject: string | null;
        documentAuthorityId: string | null;
        originWorkspaceId: string;
        createdBy: string;
        chunkKind: string;
        chunkWorkspace: string | null;
        chunkSubject: string | null;
        chunkAuthorityId: string | null;
        receiptCount: number;
      }>
    >`
      select document.authority_kind as "documentKind",
        document.authority_workspace_id as "documentWorkspace",
        document.authority_subject_id as "documentSubject",
        document.authority_id as "documentAuthorityId",
        document.origin_workspace_id as "originWorkspaceId",
        document.created_by as "createdBy",
        chunk.authority_kind as "chunkKind",
        chunk.authority_workspace_id as "chunkWorkspace",
        chunk.authority_subject_id as "chunkSubject",
        chunk.authority_id as "chunkAuthorityId",
        (select count(*)::int from document_authority_reclassifications receipt
          where receipt.operation_id = ${operationId}) as "receiptCount"
      from documents document
      join document_chunks chunk on chunk.document_id = document.id
      where document.id = ${document!.id}`;
    expect(stored).toEqual({
      documentKind: "personal",
      documentWorkspace: null,
      documentSubject: subjectId,
      documentAuthorityId: expect.any(String),
      originWorkspaceId: workspaceId,
      createdBy: subjectId,
      chunkKind: "personal",
      chunkWorkspace: null,
      chunkSubject: subjectId,
      chunkAuthorityId: stored!.documentAuthorityId,
      receiptCount: 1,
    });

    await admin`
      delete from workspace_memberships
      where account_id = ${accountId} and workspace_id = ${workspaceId}
        and subject_id = ${subjectId}`;

    const ownerPortableRows = await withScope(
      { accountId, workspaceId: workspaceIds[2]!, subjectId },
      async (tx) =>
        await tx<Array<{ documentId: string; chunkId: string }>>`
          select document.id as "documentId", chunk.id as "chunkId"
          from documents document
          join document_chunks chunk on chunk.document_id = document.id
          where document.id = ${document!.id}`,
    );
    expect([...ownerPortableRows]).toEqual([
      { documentId: document!.id, chunkId: expect.any(String) },
    ]);
    const portableCommand = {
      ...command,
      workspaceId: workspaceIds[2]!,
      operationId: crypto.randomUUID(),
      expectedAuthority: {
        kind: "personal",
        workspaceId: null,
        subjectId,
        authorityId: stored!.documentAuthorityId,
      },
      targetAuthorityKind: "personal",
    };
    await expect(
      withScope(
        { accountId, workspaceId: workspaceIds[2]!, subjectId },
        async (tx) =>
          (
            await tx<Array<{ result: Record<string, unknown> }>>`
              select reclassify_document_authority(${tx.json(portableCommand)}::jsonb) as result`
          )[0]!.result,
      ),
    ).resolves.toMatchObject({
      documentId: document!.id,
      authority: { kind: "personal", authorityId: stored!.documentAuthorityId },
    });
    await expect(
      withScope({ accountId, workspaceId: workspaceIds[2]!, subjectId }, async (tx) => {
        await tx`select reclassify_document_authority(${tx.json({
          ...portableCommand,
          operationId: crypto.randomUUID(),
          targetAuthorityKind: "workspace",
        })}::jsonb)`;
      }),
    ).rejects.toThrow("workspace document target requires the immutable origin workspace route");
    const otherUserRows = await withScope(
      { accountId, workspaceId, subjectId: otherSubjectId },
      async (tx) =>
        await tx<Array<{ id: string }>>`select id from documents where id = ${document!.id}`,
    );
    expect([...otherUserRows]).toEqual([]);
    const [otherAccount] = await admin<Array<{ id: string }>>`
      insert into managed_accounts (name) values (${`other-${crypto.randomUUID()}`}) returning id`;
    const [otherWorkspace] = await admin<Array<{ id: string }>>`
      insert into workspaces (account_id, name)
      values (${otherAccount!.id}, 'other') returning id`;
    const crossOrganizationRows = await withScope(
      { accountId: otherAccount!.id, workspaceId: otherWorkspace!.id, subjectId },
      async (tx) =>
        await tx<Array<{ id: string }>>`select id from documents where id = ${document!.id}`,
    );
    expect([...crossOrganizationRows]).toEqual([]);

    const receipts = await withScope(
      { accountId, workspaceId, subjectId },
      async (tx) =>
        await tx<Array<{ result: Record<string, unknown> }>>`
          select list_document_authority_reclassifications(
            ${accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, ${document!.id}::uuid,
            2, null, null
          ) as result`,
    );
    expect(receipts.map((row) => row.result)).toEqual([first]);

    await expect(
      withScope({ accountId, workspaceId, subjectId }, async (tx) => {
        await tx`select reclassify_document_authority(${tx.json({
          ...command,
          operationId: crypto.randomUUID(),
          targetAuthorityKind: "organization",
          accountAdminAuthorization: accountAdminAuthorization(),
        })}::jsonb)`;
      }),
    ).rejects.toThrow("document authority changed before reclassification");
    const [afterConflict] = await admin<Array<{ kind: string; authorityId: string | null }>>`
      select authority_kind as kind, authority_id as "authorityId"
      from documents where id = ${document!.id}`;
    expect(afterConflict).toEqual({ kind: "personal", authorityId: stored!.documentAuthorityId });

    await admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${accountId}, ${workspaceId}, ${subjectId}, 'admin')`;

    const [grant] = await admin<Array<{ id: string }>>`
      insert into organization_user_resource_grants (
        account_id, authority_id, owner_organization_membership_id, workspace_id,
        action, mode, context
      )
      select authority.account_id, authority.id, authority.organization_membership_id,
        ${workspaceIds[2]!}::uuid, 'document.read', 'always', 'workspace_shared'
      from organization_user_resource_authorities authority
      where authority.id = ${stored!.documentAuthorityId}::uuid
      returning id`;
    const rollbackCommand = {
      ...command,
      operationId: crypto.randomUUID(),
      expectedAuthority: {
        kind: "personal",
        workspaceId: null,
        subjectId,
        authorityId: stored!.documentAuthorityId,
      },
      targetAuthorityKind: "workspace",
    };
    const rollback = await withScope({ accountId, workspaceId, subjectId }, async (tx) => {
      const [row] = await tx<Array<{ result: Record<string, unknown> }>>`
        select reclassify_document_authority(${tx.json(rollbackCommand)}::jsonb) as result`;
      return row!.result;
    });
    const rollbackReplay = await withScope(
      { accountId, workspaceId, subjectId },
      async (tx) =>
        (
          await tx<Array<{ result: Record<string, unknown> }>>`
            select reclassify_document_authority(${tx.json(rollbackCommand)}::jsonb) as result`
        )[0]!.result,
    );
    expect(rollbackReplay).toEqual(rollback);
    const [rolledBack] = await admin<
      Array<{
        documentKind: string;
        documentWorkspace: string | null;
        documentAuthorityId: string | null;
        chunkKind: string;
        chunkWorkspace: string | null;
        authorityStatus: string;
        authorityGeneration: number;
        grantStatus: string;
        grantGeneration: number;
      }>
    >`
      select document.authority_kind as "documentKind",
        document.authority_workspace_id as "documentWorkspace",
        document.authority_id as "documentAuthorityId",
        chunk.authority_kind as "chunkKind",
        chunk.authority_workspace_id as "chunkWorkspace",
        authority.status as "authorityStatus",
        authority.generation::int as "authorityGeneration",
        grant_value.status as "grantStatus",
        grant_value.generation::int as "grantGeneration"
      from documents document
      join document_chunks chunk on chunk.document_id = document.id
      join organization_user_resource_authorities authority
        on authority.id = ${stored!.documentAuthorityId}::uuid
      join organization_user_resource_grants grant_value on grant_value.id = ${grant!.id}::uuid
      where document.id = ${document!.id}`;
    expect(rolledBack).toEqual({
      documentKind: "workspace",
      documentWorkspace: workspaceId,
      documentAuthorityId: null,
      chunkKind: "workspace",
      chunkWorkspace: workspaceId,
      authorityStatus: "revoked",
      authorityGeneration: 2,
      grantStatus: "revoked",
      grantGeneration: 2,
    });

    const firstPage = await withScope(
      { accountId, workspaceId, subjectId },
      async (tx) =>
        await tx<Array<{ result: { createdAt: string; operationId: string } }>>`
          select list_document_authority_reclassifications(
            ${accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, ${document!.id}::uuid,
            1, null, null
          ) as result`,
    );
    expect(firstPage).toHaveLength(1);
    const firstCursor = firstPage[0]!.result;
    const secondPage = await withScope(
      { accountId, workspaceId, subjectId },
      async (tx) =>
        await tx<Array<{ result: { createdAt: string; operationId: string } }>>`
          select list_document_authority_reclassifications(
            ${accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, ${document!.id}::uuid,
            1, ${firstCursor.createdAt}::timestamptz, ${firstCursor.operationId}::uuid
          ) as result`,
    );
    expect(secondPage).toHaveLength(1);
    expect(secondPage[0]!.result.operationId).not.toBe(firstCursor.operationId);
  });

  test("backfills exactly one Default collection per workspace with resumable evidence", async () => {
    if (!admin || !app) return;
    const requestWorkspaceId = workspaceIds[1]!;
    const runId = crypto.randomUUID();
    const operationIds: string[] = [];
    let result: Record<string, unknown> | null = null;
    do {
      const operationId = crypto.randomUUID();
      operationIds.push(operationId);
      const command = {
        accountId,
        workspaceId: requestWorkspaceId,
        actorSubjectId: subjectId,
        runId,
        operationId,
        batchSize: 1,
        accountAdminAuthorization: accountAdminAuthorization(),
      };
      result = await withScope(
        { accountId, workspaceId: requestWorkspaceId, subjectId },
        async (tx) =>
          (
            await tx<Array<{ result: Record<string, unknown> }>>`
              select run_document_default_collection_backfill(
                ${tx.json(command)}::jsonb
              ) as result`
          )[0]!.result,
      );
      if (operationIds.length === 1) {
        const replay = await withScope(
          { accountId, workspaceId: requestWorkspaceId, subjectId },
          async (tx) =>
            (
              await tx<Array<{ result: Record<string, unknown> }>>`
                select run_document_default_collection_backfill(
                  ${tx.json(command)}::jsonb
                ) as result`
            )[0]!.result,
        );
        expect(replay).toEqual(result);
        await expect(
          withScope({ accountId, workspaceId: requestWorkspaceId, subjectId }, async (tx) => {
            await tx`select run_document_default_collection_backfill(${tx.json({
              ...command,
              batchSize: 2,
              accountAdminAuthorization: accountAdminAuthorization(),
            })}::jsonb)`;
          }),
        ).rejects.toThrow("document Default backfill operation id was reused with different input");
      }
    } while (result!.status === "running");

    expect(result).toMatchObject({
      runId,
      status: "completed",
      processedCount: workspaceIds.length,
      createdCount: workspaceIds.length - 1,
      adoptedCount: 1,
    });
    const defaults = await admin<Array<{ workspaceId: string; count: number }>>`
      select workspace_id as "workspaceId", count(*)::int as count
      from document_bases
      where account_id = ${accountId} and lower(btrim(name)) = 'default'
      group by workspace_id order by workspace_id`;
    expect(defaults).toHaveLength(workspaceIds.length);
    expect(defaults.every((row) => row.count === 1)).toBe(true);
    const [evidence] = await admin<Array<{ receipts: number; operations: number }>>`
      select
        (select count(*)::int from document_default_collection_backfill_receipts
          where run_id = ${runId}) as receipts,
        (select count(*)::int from document_default_collection_backfill_operations
          where run_id = ${runId}) as operations`;
    expect(evidence).toEqual({ receipts: workspaceIds.length, operations: operationIds.length });
  });

  test("accepts an exact API-stamped account administrator without organization membership", async () => {
    if (!admin || !app) return;
    const actorSubjectId = `configured-admin:${crypto.randomUUID()}`;
    const workspaceId = workspaceIds[1]!;
    await admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${accountId}, ${workspaceId}, ${actorSubjectId}, 'admin')`;
    const [membershipCount] = await admin<Array<{ count: number }>>`
      select count(*)::int as count from organization_memberships
      where account_id = ${accountId} and subject_id = ${actorSubjectId}`;
    expect(membershipCount?.count).toBe(0);

    const [file] = await admin<Array<{ id: string }>>`
      insert into files (
        account_id, workspace_id, status, filename, safe_filename, content_type,
        size_bytes, bucket, object_key
      ) values (
        ${accountId}, ${workspaceId}, 'ready', 'configured-admin.txt',
        'configured-admin.txt', 'text/plain', 1, 'test',
        ${`documents/${crypto.randomUUID()}`}
      ) returning id`;
    const [base] = await admin<Array<{ id: string }>>`
      insert into document_bases (account_id, workspace_id, name)
      values (${accountId}, ${workspaceId}, ${`configured-${crypto.randomUUID()}`})
      returning id`;
    const [document] = await admin<Array<{ id: string }>>`
      insert into documents (
        account_id, workspace_id, base_id, file_id, status, title, created_by,
        authority_kind, authority_workspace_id, visibility
      ) values (
        ${accountId}, ${workspaceId}, ${base!.id}, ${file!.id}, 'ready',
        'configured admin', ${actorSubjectId}, 'workspace', ${workspaceId}, 'workspace'
      ) returning id`;
    const command = {
      accountId,
      workspaceId,
      documentId: document!.id,
      operationId: crypto.randomUUID(),
      actorSubjectId,
      expectedAuthority: {
        kind: "workspace",
        workspaceId,
        subjectId: null,
        authorityId: null,
      },
      targetAuthorityKind: "organization",
      accountAdminAuthorization: null,
    };
    await expect(
      withScope({ accountId, workspaceId, subjectId: actorSubjectId }, async (tx) => {
        await tx`select reclassify_document_authority(${tx.json(command)}::jsonb)`;
      }),
    ).rejects.toThrow("organization document reclassification requires exact account authority");
    await expect(
      withScope({ accountId, workspaceId, subjectId: actorSubjectId }, async (tx) => {
        await tx`select reclassify_document_authority(${tx.json({
          ...command,
          accountAdminAuthorization: accountAdminAuthorization(
            accountId,
            `${actorSubjectId}:wrong`,
          ),
        })}::jsonb)`;
      }),
    ).rejects.toThrow("organization document reclassification requires exact account authority");

    const accepted = await withScope(
      { accountId, workspaceId, subjectId: actorSubjectId },
      async (tx) =>
        (
          await tx<Array<{ result: Record<string, unknown> }>>`
            select reclassify_document_authority(${tx.json({
              ...command,
              accountAdminAuthorization: accountAdminAuthorization(accountId, actorSubjectId),
            })}::jsonb) as result`
        )[0]!.result,
    );
    expect(accepted).toMatchObject({
      documentId: document!.id,
      authority: { kind: "organization", workspaceId: null, subjectId: null },
    });

    const backfillCommand = {
      accountId,
      workspaceId,
      actorSubjectId,
      runId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      batchSize: 1,
      accountAdminAuthorization: accountAdminAuthorization(accountId, actorSubjectId),
    };
    const backfill = await withScope(
      { accountId, workspaceId, subjectId: actorSubjectId },
      async (tx) =>
        (
          await tx<Array<{ result: Record<string, unknown> }>>`
            select run_document_default_collection_backfill(
              ${tx.json(backfillCommand)}::jsonb
            ) as result`
        )[0]!.result,
    );
    expect(backfill).toMatchObject({ runId: backfillCommand.runId, processedCount: 1 });
  });

  test("keeps lifecycle tables immutable and inaccessible to direct runtime DML", async () => {
    if (!app) return;
    const workspaceId = workspaceIds[1]!;
    await expect(
      withScope({ accountId, workspaceId, subjectId }, async (tx) => {
        await tx`insert into document_default_collection_backfill_runs (
          run_id, account_id, actor_subject_id
        ) values (${crypto.randomUUID()}, ${accountId}, ${subjectId})`;
      }),
    ).rejects.toThrow();
    const privileges = await withScope(
      { accountId, workspaceId, subjectId },
      async (tx) =>
        (
          await tx<
            Array<{
              receiptSelect: boolean;
              receiptInsert: boolean;
              runSelect: boolean;
              capabilityInsert: boolean;
            }>
          >`
            select
              has_table_privilege(current_user, 'document_authority_reclassifications', 'SELECT')
                as "receiptSelect",
              has_table_privilege(current_user, 'document_authority_reclassifications', 'INSERT')
                as "receiptInsert",
              has_table_privilege(current_user, 'document_default_collection_backfill_runs', 'SELECT')
                as "runSelect",
              has_table_privilege(current_user, 'opengeni_private.document_migration_capabilities', 'INSERT')
                as "capabilityInsert"`
        )[0]!,
    );
    expect(privileges).toEqual({
      receiptSelect: true,
      receiptInsert: false,
      runSelect: false,
      capabilityInsert: false,
    });
  });
});
