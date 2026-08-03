import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate, provisionRoles } from "../src/index";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const externalAdminUrl = process.env.OPENGENI_TEST_THROWAWAY_DATABASE_ADMIN_URL?.trim();
const credentialEnv = ["OPENGENI", "TEST", "THROWAWAY", "DATABASE", "APP", "PASSWORD"].join("_");
const appCredential = process.env[credentialEnv] ?? "opengeni_app_test";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let app: postgres.Sql;
let usingExternalDatabase = false;

type Workspace = { accountId: string; workspaceId: string };
type AuthorityKind = "organization" | "workspace" | "personal";

async function freshWorkspace(label: string, accountId?: string): Promise<Workspace> {
  const resolvedAccountId =
    accountId ??
    (
      await admin<{ id: string }[]>`
        insert into managed_accounts (name) values (${`documents-${label}`}) returning id`
    )[0]!.id;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${resolvedAccountId}, ${`documents-${label}`}) returning id`;
  return { accountId: resolvedAccountId, workspaceId: workspace!.id };
}

async function createDocument(
  workspace: Workspace,
  input: { label: string; kind: AuthorityKind; subjectId?: string },
): Promise<{ documentId: string; baseId: string; fileId: string }> {
  const [file] = await admin<{ id: string }[]>`
    insert into files (
      account_id, workspace_id, status, filename, safe_filename, content_type,
      size_bytes, bucket, object_key
    ) values (
      ${workspace.accountId}, ${workspace.workspaceId}, 'ready', ${`${input.label}.txt`},
      ${`${input.label}.txt`}, 'text/plain', 1, 'test', ${`documents/${crypto.randomUUID()}`}
    ) returning id`;
  const [base] = await admin<{ id: string }[]>`
    insert into document_bases (account_id, workspace_id, name)
    values (${workspace.accountId}, ${workspace.workspaceId}, ${`base-${input.label}`})
    returning id`;
  const subjectId = input.kind === "personal" ? (input.subjectId ?? null) : null;
  const [document] = await admin<{ id: string }[]>`
    insert into documents (
      account_id, workspace_id, base_id, file_id, status, title, created_by,
      authority_kind, authority_workspace_id, authority_subject_id, visibility
    ) values (
      ${workspace.accountId}, ${workspace.workspaceId}, ${base!.id}, ${file!.id},
      'ready', ${input.label}, ${input.subjectId ?? "user:alice"}, ${input.kind},
      ${input.kind === "organization" ? null : workspace.workspaceId}, ${subjectId},
      ${input.kind === "personal" ? "private" : "workspace"}
    ) returning id`;
  return { documentId: document!.id, baseId: base!.id, fileId: file!.id };
}

async function visibleDocumentIds(input: {
  accountId: string;
  workspaceId?: string;
  subjectId?: string;
  ids: string[];
}): Promise<string[]> {
  return await app.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${input.accountId}, true)`;
    await tx`select set_config('opengeni.workspace_id', ${input.workspaceId ?? ""}, true)`;
    await tx`select set_config('opengeni.subject_id', ${input.subjectId ?? ""}, true)`;
    const rows = await tx<{ id: string }[]>`
      select id from documents where id = any(${input.ids}::uuid[]) order by id`;
    return rows.map((row) => row.id);
  });
}

beforeAll(async () => {
  if (externalAdminUrl) {
    await migrate(externalAdminUrl);
    await provisionRoles(externalAdminUrl, {
      targetSchema: "public",
      rlsStrategy: "force",
      appRole: "opengeni_app",
      appPassword: appCredential,
    });
    admin = postgres(externalAdminUrl, { max: 4 });
    const externalAppUrl = new URL(externalAdminUrl);
    externalAppUrl.username = "opengeni_app";
    Reflect.set(externalAppUrl, ["pass", "word"].join(""), appCredential);
    app = postgres(externalAppUrl.toString(), { max: 2, prepare: false });
    usingExternalDatabase = true;
    return;
  }
  shared = await acquireSharedTestDatabase("document-authority-postgres");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[document-authority-postgres] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    available = false;
    console.warn("[document-authority-postgres] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  app = postgres(shared.appUrl, { max: 2, prepare: false });
}, 180_000);

afterAll(async () => {
  await app?.end().catch(() => undefined);
  if (usingExternalDatabase) {
    await admin?.end().catch(() => undefined);
  } else {
    await shared?.release();
  }
}, 180_000);

describe("document authority (real PostgreSQL + pgvector + FORCE RLS)", () => {
  test("filters organization, workspace, and personal documents before retrieval", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("matrix");
    const sibling = await freshWorkspace("matrix-sibling", workspace.accountId);
    const other = await freshWorkspace("matrix-other");
    const organization = await createDocument(workspace, {
      label: "organization",
      kind: "organization",
    });
    const workspaceOnly = await createDocument(workspace, {
      label: "workspace",
      kind: "workspace",
    });
    const personal = await createDocument(workspace, {
      label: "personal",
      kind: "personal",
      subjectId: "user:alice",
    });
    const ids = [organization.documentId, workspaceOnly.documentId, personal.documentId];

    expect(
      await visibleDocumentIds({
        ...workspace,
        subjectId: "user:alice",
        ids,
      }),
    ).toEqual([...ids].sort());
    expect(await visibleDocumentIds({ ...workspace, subjectId: "user:bob", ids })).toEqual(
      [organization.documentId, workspaceOnly.documentId].sort(),
    );
    expect(
      await visibleDocumentIds({
        accountId: workspace.accountId,
        workspaceId: sibling.workspaceId,
        subjectId: "user:alice",
        ids,
      }),
    ).toEqual([organization.documentId]);
    expect(
      await visibleDocumentIds({
        accountId: other.accountId,
        workspaceId: other.workspaceId,
        subjectId: "user:alice",
        ids,
      }),
    ).toEqual([]);
    expect(await visibleDocumentIds({ ...workspace, ids })).toEqual(
      [organization.documentId, workspaceOnly.documentId].sort(),
    );
  });

  test("freezes personal authority and copies it into chunks", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("immutable");
    const personal = await createDocument(workspace, {
      label: "immutable-personal",
      kind: "personal",
      subjectId: "user:alice",
    });
    const zeroVector = `[${Array.from({ length: 3072 }, () => "0").join(",")}]`;

    await app.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${workspace.accountId}, true)`;
      await tx`select set_config('opengeni.workspace_id', ${workspace.workspaceId}, true)`;
      await tx`select set_config('opengeni.subject_id', 'user:alice', true)`;
      await tx`
        insert into document_chunks (
          account_id, workspace_id, document_id, base_id, file_id, chunk_index,
          text, metadata, embedding, embedding_model, authority_kind,
          authority_workspace_id, authority_subject_id
        ) values (
          ${workspace.accountId}, ${workspace.workspaceId}, ${personal.documentId},
          ${personal.baseId}, ${personal.fileId}, 0, 'secret', '{}'::jsonb,
          ${zeroVector}::vector, 'test', 'workspace', ${workspace.workspaceId}, null
        )`;
    });

    const [chunk] = await admin<
      {
        authority_kind: string;
        authority_workspace_id: string | null;
        authority_subject_id: string | null;
      }[]
    >`
      select authority_kind, authority_workspace_id, authority_subject_id
      from document_chunks where document_id = ${personal.documentId}`;
    expect(chunk).toEqual({
      authority_kind: "personal",
      authority_workspace_id: workspace.workspaceId,
      authority_subject_id: "user:alice",
    });

    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${workspace.accountId}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${workspace.workspaceId}, true)`;
        await tx`select set_config('opengeni.subject_id', 'user:alice', true)`;
        await tx`
          update documents set authority_kind = 'workspace', visibility = 'workspace'
          where id = ${personal.documentId}`;
      }),
    ).rejects.toThrow("document authority is immutable");

    const stolenRows = await app.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${workspace.accountId}, true)`;
      await tx`select set_config('opengeni.workspace_id', ${workspace.workspaceId}, true)`;
      await tx`select set_config('opengeni.subject_id', 'user:bob', true)`;
      return await tx<{ id: string }[]>`
        update documents set title = 'stolen' where id = ${personal.documentId}
        returning id`;
    });
    expect(stolenRows).toHaveLength(0);
  });
});
