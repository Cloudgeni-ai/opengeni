import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  getDocumentDefaultCollectionBackfillAudit,
  listDocumentDefaultCollectionBackfillRuns,
  listOrganizationDocumentAuthorityReclassifications,
  runDocumentDefaultCollectionBackfill,
} from "@opengeni/documents";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createDb } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let owned: OwnerMigratedTestDatabase | null = null;
let appDb: ReturnType<typeof createDb> | null = null;

function nestedErrorMessages(error: unknown): string {
  const messages: string[] = [];
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < 8) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as { cause?: unknown; message?: unknown };
    if (typeof record.message === "string") messages.push(record.message);
    if (record.cause !== undefined) queue.push(record.cause);
  }
  return messages.join("\n");
}

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-0346-document-audit");
  if (!owned) {
    if (requireRealDatabase) throw new Error("Document migration audit PostgreSQL is required");
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
  appDb = createDb(appUrl.toString(), { max: 2 });
}, 900_000);

afterAll(async () => {
  await appDb?.close().catch(() => undefined);
  await owned?.release();
}, 180_000);

describe("migration 0346 Document migration audit surface", () => {
  test("pages retained account evidence and excludes foreign accounts", async () => {
    if (!owned || !appDb) return;
    const database = owned;
    const client = appDb;
    const accountId = crypto.randomUUID();
    const otherAccountId = crypto.randomUUID();
    const workspaceA = crypto.randomUUID();
    const workspaceB = crypto.randomUUID();
    const otherWorkspace = crypto.randomUUID();
    const actorSubjectId = `user:${crypto.randomUUID()}`;
    const otherActorSubjectId = `user:${crypto.randomUUID()}`;

    await database.admin`insert into managed_accounts (id, name) values
      (${accountId}, 'audit account'), (${otherAccountId}, 'other audit account')`;
    await database.admin`insert into workspaces (id, account_id, name) values
      (${workspaceA}, ${accountId}, 'Audit A'),
      (${workspaceB}, ${accountId}, 'Audit B'),
      (${otherWorkspace}, ${otherAccountId}, 'Other audit')`;
    await database.admin`insert into workspace_inference_controls (workspace_id, account_id) values
      (${workspaceA}, ${accountId}), (${workspaceB}, ${accountId}),
      (${otherWorkspace}, ${otherAccountId})`;

    const authorization = {
      authorizationId: crypto.randomUUID(),
      accountId,
      actorSubjectId,
      permission: "account:admin" as const,
    };
    const runId = crypto.randomUUID();
    const operationA = crypto.randomUUID();
    const operationB = crypto.randomUUID();
    const first = await runDocumentDefaultCollectionBackfill(client.db, {
      accountId,
      workspaceId: workspaceA,
      actorSubjectId,
      accountAdminAuthorization: authorization,
      runId,
      operationId: operationA,
      batchSize: 1,
    });
    expect(first).toMatchObject({
      runId,
      operationId: operationA,
      status: "running",
    });
    const completed = await runDocumentDefaultCollectionBackfill(client.db, {
      accountId,
      workspaceId: workspaceA,
      actorSubjectId,
      accountAdminAuthorization: authorization,
      runId,
      operationId: operationB,
      batchSize: 10,
    });
    expect(completed).toMatchObject({
      runId,
      operationId: operationB,
      status: "completed",
      processedCount: 2,
    });

    const runPage = await listDocumentDefaultCollectionBackfillRuns(client.db, {
      accountId,
      workspaceId: workspaceA,
      actorSubjectId,
      accountAdminAuthorization: authorization,
      limit: 1,
    });
    expect(runPage).toMatchObject({ hasMore: false, nextCursor: null });
    expect(runPage.runs).toEqual([
      expect.objectContaining({
        runId,
        actorSubjectId,
        processedCount: 2,
        status: "completed",
      }),
    ]);

    const auditOne = await getDocumentDefaultCollectionBackfillAudit(client.db, {
      accountId,
      workspaceId: workspaceA,
      actorSubjectId,
      accountAdminAuthorization: authorization,
      runId,
      limit: 1,
    });
    expect(auditOne.operations).toHaveLength(1);
    expect(auditOne.receipts).toHaveLength(1);
    expect(auditOne.operationsHasMore).toBe(true);
    expect(auditOne.receiptsHasMore).toBe(true);
    expect(auditOne.operationsNextCursor).not.toBeNull();
    expect(auditOne.receiptsNextCursor).not.toBeNull();

    const auditTwo = await getDocumentDefaultCollectionBackfillAudit(client.db, {
      accountId,
      workspaceId: workspaceA,
      actorSubjectId,
      accountAdminAuthorization: authorization,
      runId,
      limit: 1,
      operationCursor: auditOne.operationsNextCursor ?? undefined,
      receiptCursor: auditOne.receiptsNextCursor ?? undefined,
    });
    expect(auditTwo.operations).toHaveLength(1);
    expect(auditTwo.receipts).toHaveLength(1);
    expect(auditTwo.operations[0]?.operationId).not.toBe(auditOne.operations[0]?.operationId);
    expect(auditTwo.receipts[0]?.workspaceId).not.toBe(auditOne.receipts[0]?.workspaceId);
    expect(
      new Set([...auditOne.operations, ...auditTwo.operations].map((item) => item.operationId)),
    ).toEqual(new Set([operationA, operationB]));
    expect(
      new Set([...auditOne.receipts, ...auditTwo.receipts].map((item) => item.workspaceId)),
    ).toEqual(new Set([workspaceA, workspaceB]));

    const receiptAtA = "2026-08-24T20:00:00.000Z";
    const receiptAtB = "2026-08-24T19:00:00.000Z";
    const receiptAtOther = "2026-08-24T21:00:00.000Z";
    const documentA = crypto.randomUUID();
    const documentB = crypto.randomUUID();
    const documentOther = crypto.randomUUID();
    const reclassificationA = crypto.randomUUID();
    const reclassificationB = crypto.randomUUID();
    const reclassificationOther = crypto.randomUUID();
    const tupleA = {
      kind: "workspace",
      workspaceId: workspaceA,
      subjectId: null,
      authorityId: null,
    };
    const tupleB = {
      kind: "workspace",
      workspaceId: workspaceB,
      subjectId: null,
      authorityId: null,
    };
    const tupleOther = {
      kind: "workspace",
      workspaceId: otherWorkspace,
      subjectId: null,
      authorityId: null,
    };
    await database.admin`insert into document_authority_reclassifications (
      operation_id, input_hash, account_id, request_workspace_id, document_id,
      actor_subject_id, previous_authority_kind, previous_authority_workspace_id,
      resulting_authority_kind, resulting_authority_workspace_id, result, created_at
    ) values
      (${reclassificationA}, ${"a".repeat(64)}, ${accountId}, ${workspaceA}, ${documentA},
        ${otherActorSubjectId}, 'workspace', ${workspaceA}, 'workspace', ${workspaceA},
        ${database.admin.json({
          operationId: reclassificationA,
          documentId: documentA,
          previousAuthority: tupleA,
          authority: tupleA,
          createdAt: receiptAtA,
        })}, ${receiptAtA}),
      (${reclassificationB}, ${"b".repeat(64)}, ${accountId}, ${workspaceB}, ${documentB},
        ${actorSubjectId}, 'workspace', ${workspaceB}, 'workspace', ${workspaceB},
        ${database.admin.json({
          operationId: reclassificationB,
          documentId: documentB,
          previousAuthority: tupleB,
          authority: tupleB,
          createdAt: receiptAtB,
        })}, ${receiptAtB}),
      (${reclassificationOther}, ${"c".repeat(64)}, ${otherAccountId}, ${otherWorkspace},
        ${documentOther}, 'user:foreign', 'workspace', ${otherWorkspace}, 'workspace',
        ${otherWorkspace}, ${database.admin.json({
          operationId: reclassificationOther,
          documentId: documentOther,
          previousAuthority: tupleOther,
          authority: tupleOther,
          createdAt: receiptAtOther,
        })}, ${receiptAtOther})`;

    const receiptPageOne = await listOrganizationDocumentAuthorityReclassifications(client.db, {
      accountId,
      workspaceId: workspaceA,
      actorSubjectId,
      accountAdminAuthorization: authorization,
      limit: 1,
    });
    expect(receiptPageOne.receipts).toEqual([
      expect.objectContaining({
        operationId: reclassificationA,
        documentId: documentA,
        actorSubjectId: otherActorSubjectId,
        requestWorkspaceId: workspaceA,
      }),
    ]);
    expect(receiptPageOne.hasMore).toBe(true);
    const receiptPageTwo = await listOrganizationDocumentAuthorityReclassifications(client.db, {
      accountId,
      workspaceId: workspaceA,
      actorSubjectId,
      accountAdminAuthorization: authorization,
      limit: 1,
      cursor: receiptPageOne.nextCursor ?? undefined,
    });
    expect(receiptPageTwo.receipts).toEqual([
      expect.objectContaining({
        operationId: reclassificationB,
        documentId: documentB,
        actorSubjectId,
        requestWorkspaceId: workspaceB,
      }),
    ]);
    expect(receiptPageTwo.hasMore).toBe(false);

    const authorityError = await listDocumentDefaultCollectionBackfillRuns(client.db, {
      accountId,
      workspaceId: workspaceA,
      actorSubjectId,
      accountAdminAuthorization: {
        ...authorization,
        accountId: otherAccountId,
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(nestedErrorMessages(authorityError)).toMatch(/requires organization administration/iu);
    const unavailableError = await getDocumentDefaultCollectionBackfillAudit(client.db, {
      accountId,
      workspaceId: workspaceA,
      actorSubjectId,
      accountAdminAuthorization: authorization,
      runId: crypto.randomUUID(),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(nestedErrorMessages(unavailableError)).toMatch(/audit run is unavailable/iu);
    await expect(
      getDocumentDefaultCollectionBackfillAudit(client.db, {
        accountId,
        workspaceId: workspaceA,
        actorSubjectId,
        accountAdminAuthorization: authorization,
        runId,
        operationCursor: auditOne.receiptsNextCursor ?? undefined,
      }),
    ).rejects.toThrow("invalid document migration audit cursor");

    const [capabilityCount] = await database.admin<Array<{ count: number }>>`
      select count(*)::int as count from document_migration_audit_capabilities`;
    expect(capabilityCount).toEqual({ count: 0 });
  }, 900_000);

  test("keeps audit capabilities SELECT-only, target-local, opaque, and nest-safe", async () => {
    if (!owned) return;
    const database = owned;
    const [ownerPosture] = await database.admin<
      Array<{ superuser: boolean; bypassRls: boolean }>
    >`select rolsuper as superuser, rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${database.ownerRole}`;
    expect(ownerPosture).toEqual({ superuser: false, bypassRls: false });

    const policies = await database.admin<
      Array<{ tableName: string; command: string; withCheck: string | null }>
    >`select relation.relname as "tableName", policy.polcmd::text as command,
        pg_get_expr(policy.polwithcheck, policy.polrelid) as "withCheck"
      from pg_policy policy
      join pg_class relation on relation.oid = policy.polrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and policy.polname = 'document_migration_audit_read'
      order by relation.relname`;
    expect([...policies]).toEqual(
      [
        "document_authority_reclassifications",
        "document_default_collection_backfill_operations",
        "document_default_collection_backfill_receipts",
        "document_default_collection_backfill_runs",
      ].map((tableName) => ({ tableName, command: "r", withCheck: null })),
    );

    const helpers = await database.admin<
      Array<{
        name: string;
        schema: string;
        securityDefiner: boolean;
        settings: string[] | null;
        appExecute: boolean;
        publicExecute: boolean;
      }>
    >`select procedure.proname as name, namespace.nspname as schema,
        procedure.prosecdef as "securityDefiner", procedure.proconfig as settings,
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as "appExecute",
        has_function_privilege('public', procedure.oid, 'EXECUTE') as "publicExecute"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where procedure.proname in (
        'document_migration_audit_capability_active',
        'assert_document_migration_audit_authority'
      ) order by procedure.proname`;
    expect(helpers).toHaveLength(2);
    expect(helpers.every((helper) => helper.schema === "public")).toBe(true);
    expect(helpers.every((helper) => helper.securityDefiner)).toBe(true);
    expect(helpers.every((helper) => helper.appExecute === false)).toBe(true);
    expect(helpers.every((helper) => helper.publicExecute === false)).toBe(true);
    expect(
      helpers.every((helper) =>
        helper.settings?.includes("search_path=pg_catalog, public, pg_temp"),
      ),
    ).toBe(true);
    const [globalHelper] = await database.admin<Array<{ present: boolean }>>`
      select to_regprocedure(
        'opengeni_private.assert_document_migration_audit_authority(jsonb)'
      ) is not null as present`;
    expect(globalHelper).toEqual({ present: false });

    const [runtimePrivileges] = await database.admin<
      Array<{
        select: boolean;
        insert: boolean;
        update: boolean;
        delete: boolean;
      }>
    >`select
        has_table_privilege('opengeni_app', 'document_migration_audit_capabilities', 'SELECT')
          as select,
        has_table_privilege('opengeni_app', 'document_migration_audit_capabilities', 'INSERT')
          as insert,
        has_table_privilege('opengeni_app', 'document_migration_audit_capabilities', 'UPDATE')
          as update,
        has_table_privilege('opengeni_app', 'document_migration_audit_capabilities', 'DELETE')
          as delete`;
    expect(runtimePrivileges).toEqual({
      select: false,
      insert: false,
      update: false,
      delete: false,
    });

    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const actorSubjectId = `user:${crypto.randomUUID()}`;
    const outerCapabilityId = crypto.randomUUID();
    await database.admin`insert into managed_accounts (id, name)
      values (${accountId}, 'nested audit account')`;
    await database.admin`insert into workspaces (id, account_id, name)
      values (${workspaceId}, ${accountId}, 'Nested audit workspace')`;
    const ownerClient = postgres(database.ownerUrl, { max: 1 });
    try {
      await ownerClient.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${accountId}, true),
          set_config('opengeni.workspace_id', ${workspaceId}, true),
          set_config('opengeni.subject_id', ${actorSubjectId}, true)`;
        await tx`insert into document_migration_audit_capabilities (
          capability_id, backend_pid, transaction_id, capability_kind
        ) values (${outerCapabilityId}, pg_backend_pid(), pg_current_xact_id(),
          'default_backfill_audit')`;
        await tx`select set_config(
          'opengeni.document_migration_audit_token', ${outerCapabilityId}, true
        )`;
        await tx`select list_document_default_collection_backfill_runs(
          ${tx.json({
            accountId,
            workspaceId,
            actorSubjectId,
            accountAdminAuthorization: {
              authorizationId: crypto.randomUUID(),
              accountId,
              actorSubjectId,
              permission: "account:admin",
            },
            limit: 1,
            beforeStartedAt: null,
            beforeRunId: null,
          })}::jsonb
        )`;
        const [nestedState] = await tx<Array<{ token: string; count: number }>>`
          select current_setting('opengeni.document_migration_audit_token', true) as token,
            count(*)::int as count
          from document_migration_audit_capabilities`;
        expect(nestedState).toEqual({ token: outerCapabilityId, count: 1 });
        await tx`delete from document_migration_audit_capabilities
          where capability_id = ${outerCapabilityId}`;
      });
    } finally {
      await ownerClient.end();
    }
    const [capabilityCount] = await database.admin<Array<{ count: number }>>`
      select count(*)::int as count from document_migration_audit_capabilities`;
    expect(capabilityCount).toEqual({ count: 0 });
  }, 900_000);
});
