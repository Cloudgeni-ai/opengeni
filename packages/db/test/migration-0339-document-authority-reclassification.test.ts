// This file runs against `acquireOwnerMigratedTestDatabase`, NOT the shared or
// blank superuser database. `docs/force-rls-migration-backfills.md` designates
// that harness as the production boundary: its owner role is
// `NOSUPERUSER NOBYPASSRLS`, which is the documented posture of
// `OPENGENI_MIGRATIONS_DATABASE_URL` on every managed Postgres. It matters here
// because `reclassify_document_authority` is SECURITY DEFINER: inside it,
// `current_user` is the schema owner, and `FORCE ROW LEVEL SECURITY` binds the
// owner too. A superuser-migrated database silently passes the personal
// authority activation that a real deployment silently SKIPS.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const migrationUrl = new URL(
  "../drizzle/0339_document_authority_reclassification.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const subjectId = `human:${crypto.randomUUID()}`;
const otherSubjectId = `human:${crypto.randomUUID()}`;

let owned: OwnerMigratedTestDatabase | null = null;
let admin: postgres.Sql | null = null;
let app: postgres.Sql | null = null;
let ownerIdentity: { superuser: boolean; bypassRls: boolean } | null = null;
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
  owned = await acquireOwnerMigratedTestDatabase("migration-0339-document-authority");
  if (!owned) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0339-document-authority] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    return;
  }
  const password = `app-${crypto.randomUUID()}`;
  // Migrate as the NOSUPERUSER/NOBYPASSRLS owner; provision roles over the
  // superuser admin connection, which is the only identity allowed to CREATE
  // ROLE (exactly how a deployment separates its migration and bootstrap
  // credentials).
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, { appPassword: password, rlsStrategy: "force" });
  [ownerIdentity = null] = await owned.admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
    select rolsuper as "superuser", rolbypassrls as "bypassRls"
    from pg_roles where rolname = ${owned.ownerRole}`;
  admin = postgres(owned.adminUrl, { max: 3, prepare: false, onnotice: () => undefined });
  const appUrl = new URL(owned.adminUrl);
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
  await owned?.release();
}, 180_000);

describe("migration 0339 Document authority reclassification", () => {
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

  // The exact production boundary the reclassification lifecycle depends on.
  // `organization_memberships` is FORCE-RLS with no GUC-only read policy, so the
  // SECURITY DEFINER owner sees it only inside the personal-document capability
  // window - and only through a SELECT with NO locking clause, because Postgres
  // applies a relation's UPDATE policies to any locking SELECT and every read
  // policy here is `FOR SELECT` only. Both halves are silent when wrong: the
  // read matches zero rows and the activation is skipped without an error.
  test("the definer owner reads organization memberships only inside an unlocked capability window", async () => {
    if (!owned || !admin) return;
    expect(ownerIdentity).toEqual({ superuser: false, bypassRls: false });

    const owner = postgres(owned.ownerUrl, { max: 1, prepare: false, onnotice: () => undefined });
    try {
      const blinded = await owner<Array<{ id: string }>>`
        select id from organization_memberships
        where account_id = ${accountId} and subject_id = ${subjectId}`;
      expect([...blinded]).toEqual([]);

      const observed = await owner.begin(async (tx) => {
        await tx`
          insert into opengeni_private.personal_document_authority_capabilities (
            backend_pid, transaction_id, capability_kind
          ) values (pg_backend_pid(), pg_current_xact_id(), 'write')
          on conflict do nothing`;
        const unlocked = await tx<Array<{ id: string }>>`
          select id from organization_memberships
          where account_id = ${accountId} and subject_id = ${subjectId}`;
        const locked: Record<string, number> = {};
        for (const clause of ["for share", "for key share", "for update"]) {
          const rows = await tx.unsafe(
            `select id from organization_memberships where account_id = $1 and subject_id = $2 ${clause}`,
            [accountId, subjectId],
          );
          locked[clause] = rows.length;
        }
        return { unlocked: unlocked.length, locked };
      });
      expect(observed).toEqual({
        unlocked: 1,
        locked: { "for share": 0, "for key share": 0, "for update": 0 },
      });
    } finally {
      await owner.end({ timeout: 5 });
    }

    const source = await readFile(migrationUrl, "utf8");
    const activationStart = source.indexOf(
      "IF target_kind = 'personal' AND target_authority_id IS NULL THEN",
    );
    const activationEnd = source.indexOf("result_value := jsonb_build_object", activationStart);
    expect(activationStart).toBeGreaterThan(-1);
    expect(activationEnd).toBeGreaterThan(activationStart);
    const activation = source.slice(activationStart, activationEnd);
    // Ordering, not merely presence: the window must be established BEFORE the
    // membership read, and that read must carry no locking clause.
    const windowAt = activation.indexOf("personal_document_authority_capabilities");
    const readAt = activation.indexOf("FROM organization_memberships");
    expect(windowAt).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(-1);
    expect(windowAt).toBeLessThan(readAt);
    expect(activation).not.toMatch(/FROM organization_memberships[\s\S]*?FOR (SHARE|UPDATE|KEY)/iu);
  }, 60_000);

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
    const portableResult = await withScope(
      { accountId, workspaceId: workspaceIds[2]!, subjectId },
      async (tx) =>
        (
          await tx<Array<{ result: Record<string, unknown> }>>`
            select reclassify_document_authority(${tx.json(portableCommand)}::jsonb) as result`
        )[0]!.result,
    );
    // `workspaceId` is asserted EXACTLY, not through `toMatchObject`'s partial
    // shape. `apply_document_authority` normalizes `authority_workspace_id` to
    // NULL for every personal row with a non-null `authority_id`, and the
    // trigger's receipt match compares the PRE-normalization NEW row - so a
    // response or receipt naming the origin workspace here is an immutable
    // audit record asserting an anchoring the database does not hold.
    expect(portableResult).toMatchObject({
      documentId: document!.id,
      authority: {
        kind: "personal",
        workspaceId: null,
        subjectId,
        authorityId: stored!.documentAuthorityId,
      },
    });
    const [portableTruth] = await admin<
      Array<{
        documentWorkspace: string | null;
        documentAuthorityId: string | null;
        receiptWorkspace: string | null;
        receiptAuthorityId: string | null;
        receiptResultWorkspace: string | null;
        receiptCreatedAt: string;
        resultCreatedAt: string;
      }>
    >`
      select document.authority_workspace_id as "documentWorkspace",
        document.authority_id as "documentAuthorityId",
        receipt.resulting_authority_workspace_id as "receiptWorkspace",
        receipt.resulting_authority_id as "receiptAuthorityId",
        receipt.result #>> '{authority,workspaceId}' as "receiptResultWorkspace",
        to_char(receipt.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as "receiptCreatedAt",
        to_char(
          (receipt.result ->> 'createdAt')::timestamptz at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US'
        ) as "resultCreatedAt"
      from documents document
      join document_authority_reclassifications receipt
        on receipt.operation_id = ${portableCommand.operationId}::uuid
      where document.id = ${document!.id}`;
    expect(portableTruth).toEqual({
      documentWorkspace: null,
      documentAuthorityId: stored!.documentAuthorityId,
      receiptWorkspace: null,
      receiptAuthorityId: stored!.documentAuthorityId,
      receiptResultWorkspace: null,
      // The stored column and the receipt's own `createdAt` must be the SAME
      // instant, or the `created_at = cursor` tie-break in
      // `list_document_authority_reclassifications` is unreachable and can skip
      // a receipt whose column sorts before the cursor the client echoed back.
      receiptCreatedAt: portableTruth!.resultCreatedAt,
      resultCreatedAt: portableTruth!.resultCreatedAt,
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

    // Retry the activation after the documented rollback. The identity index
    // `organization_user_resource_authorities_resource_identity_idx` carries no
    // status predicate and the rollback above only revokes the row, so a blind
    // INSERT here made the round trip fail permanently with 23505 - surfaced by
    // the Documents route as an untyped 500. The reactivation must reuse the
    // SAME authority row, bump its generation, and clear `revoked_at`, and it
    // must preserve `origin_workspace_id` as provenance.
    const retryCommand = {
      ...command,
      operationId: crypto.randomUUID(),
      expectedAuthority: { kind: "workspace", workspaceId, subjectId: null, authorityId: null },
      targetAuthorityKind: "personal",
    };
    const retried = await withScope({ accountId, workspaceId, subjectId }, async (tx) => {
      const [row] = await tx<Array<{ result: Record<string, unknown> }>>`
        select reclassify_document_authority(${tx.json(retryCommand)}::jsonb) as result`;
      return row!.result;
    });
    expect(retried).toMatchObject({
      authority: { kind: "personal", workspaceId: null, subjectId },
    });
    const [reactivated] = await admin<
      Array<{
        documentKind: string;
        documentWorkspace: string | null;
        documentAuthorityId: string | null;
        authorityStatus: string;
        authorityGeneration: number;
        authorityRevokedAt: string | null;
        authorityOrigin: string | null;
      }>
    >`
      select document.authority_kind as "documentKind",
        document.authority_workspace_id as "documentWorkspace",
        document.authority_id as "documentAuthorityId",
        authority.status as "authorityStatus",
        authority.generation::int as "authorityGeneration",
        authority.revoked_at as "authorityRevokedAt",
        authority.origin_workspace_id as "authorityOrigin"
      from documents document
      join organization_user_resource_authorities authority
        on authority.id = ${stored!.documentAuthorityId}::uuid
      where document.id = ${document!.id}`;
    expect(reactivated).toEqual({
      documentKind: "personal",
      documentWorkspace: null,
      // the SAME row, reused rather than duplicated
      documentAuthorityId: stored!.documentAuthorityId,
      authorityStatus: "active",
      authorityGeneration: 3,
      authorityRevokedAt: null,
      authorityOrigin: workspaceId,
    });
    // Exactly one authority row exists for this identity tuple.
    const [authorityCount] = await admin<Array<{ total: number }>>`
      select count(*)::int as total from organization_user_resource_authorities
      where account_id = ${accountId}::uuid and resource_kind = 'document'
        and resource_id = ${document!.id}::uuid`;
    expect(authorityCount!.total).toBe(1);

    // Restore the rolled-back shape so the pagination assertions below still
    // describe the same receipt history they were written against.
    await withScope({ accountId, workspaceId, subjectId }, async (tx) => {
      await tx`select reclassify_document_authority(${tx.json({
        ...command,
        operationId: crypto.randomUUID(),
        expectedAuthority: {
          kind: "personal",
          workspaceId: null,
          subjectId,
          authorityId: stored!.documentAuthorityId,
        },
        targetAuthorityKind: "workspace",
      })}::jsonb)`;
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

  // A missing `expectedAuthority.kind` used to slip through the input guard,
  // because `NULL NOT IN (...)` is NULL rather than TRUE. It then surfaced as
  // the compare-and-set 40001 the API renders as a 409 conflict, telling the
  // caller their document had changed under them when in fact their request was
  // malformed.
  test("rejects an absent authority kind as malformed input, not as a stale-tuple conflict", async () => {
    if (!app) return;
    const workspaceId = workspaceIds[1]!;
    // `expectedAuthority` deliberately omits `kind`.
    type MalformedCommand = {
      accountId: string;
      workspaceId: string;
      documentId: string;
      operationId: string;
      actorSubjectId: string;
      expectedAuthority: { workspaceId: string; subjectId: null; authorityId: null };
      targetAuthorityKind: string | null;
      accountAdminAuthorization: null;
    };
    const base: MalformedCommand = {
      accountId,
      workspaceId,
      documentId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      actorSubjectId: subjectId,
      expectedAuthority: { workspaceId, subjectId: null, authorityId: null },
      targetAuthorityKind: "personal",
      accountAdminAuthorization: null,
    };
    const failureFor = async (command: MalformedCommand) => {
      try {
        await withScope({ accountId, workspaceId, subjectId }, async (tx) => {
          await tx`select reclassify_document_authority(${tx.json(command)}::jsonb)`;
        });
        return null;
      } catch (error) {
        const found: Array<{ code: unknown; message: unknown }> = [];
        const queue: unknown[] = [error];
        const seen = new Set<unknown>();
        while (queue.length > 0 && seen.size < 16) {
          const current = queue.shift();
          if (!current || typeof current !== "object" || seen.has(current)) continue;
          seen.add(current);
          const record = current as Record<string, unknown>;
          if (typeof record.code === "string")
            found.push({ code: record.code, message: record.message });
          if (record.cause !== undefined) queue.push(record.cause);
        }
        return found[0] ?? null;
      }
    };
    expect(await failureFor(base)).toMatchObject({
      code: "22023",
      message: "document reclassification input is invalid",
    });
    expect(
      await failureFor({ ...base, operationId: crypto.randomUUID(), targetAuthorityKind: null }),
    ).toMatchObject({
      code: "22023",
      message: "document reclassification input is invalid",
    });
  }, 60_000);

  // One admin-triggered Default backfill writes a receipt for EVERY workspace in
  // the account. With `ON DELETE RESTRICT` those receipts pinned every workspace
  // as permanently undeletable: `deleteWorkspaceIfQuiescent` relies on cascades
  // and has no quiescence branch for these tables, so `DELETE
  // /v1/workspaces/:workspaceId` raised an untyped Postgres error (HTTP 500)
  // rather than a typed status. The receipts are workspace-owned evidence and
  // must die with their workspace, while staying immutable against every direct
  // rewrite.
  test("workspace deletion cascades the migration receipts instead of being pinned by them", async () => {
    if (!admin || !app) return;
    const [deletable] = await admin<Array<{ id: string }>>`
      insert into workspaces (account_id, name)
      values (${accountId}, ${`document-migration-deletable-${crypto.randomUUID()}`})
      returning id`;
    const deletableId = deletable!.id;
    await admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${accountId}, ${deletableId}, ${subjectId}, 'admin')`;

    // Backfill until it completes, so the account-wide run reaches the new
    // workspace and writes its receipt exactly as an operator run would.
    const runId = crypto.randomUUID();
    let backfill: Record<string, unknown> | undefined;
    do {
      backfill = await withScope({ accountId, workspaceId: deletableId, subjectId }, async (tx) => {
        const [row] = await tx<Array<{ result: Record<string, unknown> }>>`
          select run_document_default_collection_backfill(${tx.json({
            accountId,
            workspaceId: deletableId,
            actorSubjectId: subjectId,
            runId,
            operationId: crypto.randomUUID(),
            batchSize: 50,
            accountAdminAuthorization: accountAdminAuthorization(),
          })}::jsonb) as result`;
        return row!.result;
      });
    } while (backfill!.status === "running");

    const [file] = await admin<Array<{ id: string }>>`
      insert into files (
        account_id, workspace_id, status, filename, safe_filename, content_type,
        size_bytes, bucket, object_key
      ) values (
        ${accountId}, ${deletableId}, 'ready', 'deletable.txt', 'deletable.txt',
        'text/plain', 1, 'test', ${`documents/${crypto.randomUUID()}`}
      ) returning id`;
    const [base] = await admin<Array<{ id: string }>>`
      insert into document_bases (account_id, workspace_id, name)
      values (${accountId}, ${deletableId}, ${`deletable-${crypto.randomUUID()}`}) returning id`;
    const [document] = await admin<Array<{ id: string }>>`
      insert into documents (
        account_id, workspace_id, base_id, file_id, status, title, created_by,
        authority_kind, authority_workspace_id, visibility
      ) values (
        ${accountId}, ${deletableId}, ${base!.id}, ${file!.id}, 'ready', 'deletable',
        ${subjectId}, 'workspace', ${deletableId}, 'workspace'
      ) returning id`;
    await withScope({ accountId, workspaceId: deletableId, subjectId }, async (tx) => {
      await tx`select reclassify_document_authority(${tx.json({
        accountId,
        workspaceId: deletableId,
        documentId: document!.id,
        operationId: crypto.randomUUID(),
        actorSubjectId: subjectId,
        expectedAuthority: {
          kind: "workspace",
          workspaceId: deletableId,
          subjectId: null,
          authorityId: null,
        },
        targetAuthorityKind: "personal",
        accountAdminAuthorization: null,
      })}::jsonb)`;
    });

    const countsFor = async (workspaceId: string) =>
      (
        await admin!<Array<{ receipts: number; reclassifications: number }>>`
          select
            (select count(*)::int from document_default_collection_backfill_receipts
              where workspace_id = ${workspaceId}) as receipts,
            (select count(*)::int from document_authority_reclassifications
              where request_workspace_id = ${workspaceId}) as reclassifications`
      )[0]!;
    expect(await countsFor(deletableId)).toEqual({ receipts: 1, reclassifications: 1 });
    const survivorBefore = await countsFor(workspaceIds[1]!);
    expect(survivorBefore.receipts).toBeGreaterThan(0);

    // Immutability is unchanged: a direct rewrite or removal is still refused.
    for (const statement of [
      `update document_default_collection_backfill_receipts set outcome = 'adopted' where workspace_id = '${deletableId}'`,
      `delete from document_default_collection_backfill_receipts where workspace_id = '${deletableId}'`,
      `delete from document_authority_reclassifications where request_workspace_id = '${deletableId}'`,
    ]) {
      // Wrapped in an async call rather than passed directly: `postgres`'
      // `Query` is a lazy Promise subclass that only dispatches on its own
      // `.then`/`.catch`, and handing it to `expect(...).rejects` leaves it
      // undispatched, so the assertion waits forever instead of failing.
      await expect(
        (async () => {
          await admin!.unsafe(statement);
        })(),
      ).rejects.toThrow("document migration receipts are immutable");
    }

    // The cascade the delete route depends on now completes.
    const deleted = await admin<Array<{ id: string }>>`
      delete from workspaces
      where id = ${deletableId} and account_id = ${accountId}
      returning id`;
    expect([...deleted]).toEqual([{ id: deletableId }]);
    expect(await countsFor(deletableId)).toEqual({ receipts: 0, reclassifications: 0 });
    expect(await countsFor(workspaceIds[1]!)).toEqual(survivorBefore);
    const [run] = await admin<Array<{ status: string }>>`
      select status from document_default_collection_backfill_runs where run_id = ${runId}`;
    expect(run).toEqual({ status: "completed" });
  }, 120_000);
});
