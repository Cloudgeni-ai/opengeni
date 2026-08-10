import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { listEffectiveIndexedDocuments } from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let available = true;
let shared: SharedTestDatabase | null = null;
let forced: ReturnType<typeof createDb>;

type Workspace = { accountId: string; workspaceId: string };
type StoredDocument = {
  documentId: string;
  indexSequence: bigint;
  indexedAt: Date;
};

async function freshWorkspace(label: string, accountId?: string): Promise<Workspace> {
  const resolvedAccountId =
    accountId ??
    (
      await shared!.admin<{ id: string }[]>`
        insert into managed_accounts (name) values (${`document-checkpoint-${label}`}) returning id`
    )[0]!.id;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${resolvedAccountId}, ${`document-checkpoint-${label}`}) returning id`;
  return { accountId: resolvedAccountId, workspaceId: workspace!.id };
}

async function createReadyDocument(
  workspace: Workspace,
  input: {
    label: string;
    kind: "organization" | "workspace" | "personal";
    subjectId?: string;
    agentAccess?: boolean;
  },
): Promise<StoredDocument> {
  const [file] = await shared!.admin<{ id: string }[]>`
    insert into files (
      account_id, workspace_id, status, filename, safe_filename, content_type,
      size_bytes, bucket, object_key
    ) values (
      ${workspace.accountId}, ${workspace.workspaceId}, 'ready', ${`${input.label}.txt`},
      ${`${input.label}.txt`}, 'text/plain', 1, 'test', ${`documents/${crypto.randomUUID()}`}
    ) returning id`;
  const [base] = await shared!.admin<{ id: string }[]>`
    insert into document_bases (account_id, workspace_id, name)
    values (${workspace.accountId}, ${workspace.workspaceId}, ${`base-${input.label}`})
    returning id`;
  const subjectId = input.kind === "personal" ? (input.subjectId ?? "user:alice") : null;
  const [document] = await shared!.admin<
    Array<{ id: string; index_sequence: bigint; indexed_at: Date }>
  >`
    insert into documents (
      account_id, workspace_id, base_id, file_id, status, title, parser, chunk_count,
      source_kind, source_uri, source_external_id, source_title, source_author,
      source_created_at, source_updated_at, source_version, created_by, agent_access,
      summary, topics, authority_kind, authority_workspace_id, authority_subject_id, visibility
    ) values (
      ${workspace.accountId}, ${workspace.workspaceId}, ${base!.id}, ${file!.id}, 'ready',
      ${input.label}, 'checkpoint-test', 1, 'repository', ${`https://example.test/${input.label}`},
      ${`external-${input.label}`}, ${`Source ${input.label}`}, 'Source Author',
      '2026-08-01T00:00:00Z'::timestamptz, '2026-08-02T00:00:00Z'::timestamptz,
      'v1', ${input.subjectId ?? "user:alice"}, ${input.agentAccess ?? true},
      ${`Summary ${input.label}`}, ${shared!.admin.json(["checkpoint", input.label])}, ${input.kind},
      ${input.kind === "organization" ? null : workspace.workspaceId}, ${subjectId},
      ${input.kind === "personal" ? "private" : "workspace"}
    ) returning id, index_sequence, indexed_at`;
  return {
    documentId: document!.id,
    indexSequence: document!.index_sequence,
    indexedAt: document!.indexed_at,
  };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("document-index-checkpoints");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[document-index-checkpoints] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    available = false;
    console.warn("[document-index-checkpoints] docker unavailable, skipping");
    return;
  }
  forced = createDb(shared.appUrl, { max: 2, rlsStrategy: "force" });
}, 180_000);

afterAll(async () => {
  await forced?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("document index checkpoints (real PostgreSQL)", () => {
  test("pages effective agent scope without repeats and advances only on ready transitions", async () => {
    if (!available) return;
    const origin = await freshWorkspace("origin");
    const sibling = await freshWorkspace("sibling", origin.accountId);
    const other = await freshWorkspace("other");

    const organization = await createReadyDocument(origin, {
      label: "organization",
      kind: "organization",
    });
    const workspace = await createReadyDocument(origin, {
      label: "workspace",
      kind: "workspace",
    });
    const personal = await createReadyDocument(origin, {
      label: "personal-alice",
      kind: "personal",
      subjectId: "user:alice",
    });
    await createReadyDocument(origin, {
      label: "personal-bob",
      kind: "personal",
      subjectId: "user:bob",
    });
    await createReadyDocument(origin, {
      label: "agent-disabled",
      kind: "workspace",
      agentAccess: false,
    });
    await createReadyDocument(other, {
      label: "other-account",
      kind: "organization",
    });

    const first = await listEffectiveIndexedDocuments(forced.db, {
      accountId: origin.accountId,
      workspaceId: origin.workspaceId,
      initiatingSubjectId: "user:alice",
      limit: 2,
    });
    expect(first.hasMore).toBe(true);
    expect(first.documents.map((document) => document.id)).toEqual([
      organization.documentId,
      workspace.documentId,
    ]);
    expect(first.documents[0]).toMatchObject({
      title: "organization",
      parser: "checkpoint-test",
      chunkCount: 1,
      summary: "Summary organization",
      topics: ["checkpoint", "organization"],
      source: {
        kind: "repository",
        uri: "https://example.test/organization",
        externalId: "external-organization",
        title: "Source organization",
        author: "Source Author",
        version: "v1",
      },
      provenance: {
        ingestionWorkspaceId: origin.workspaceId,
        authorityKind: "organization",
        authorityWorkspaceId: null,
        authoritySubjectId: null,
        createdBy: "user:alice",
      },
    });

    const second = await listEffectiveIndexedDocuments(forced.db, {
      accountId: origin.accountId,
      workspaceId: origin.workspaceId,
      initiatingSubjectId: "user:alice",
      checkpoint: first.nextCheckpoint,
      limit: 2,
    });
    expect(second.hasMore).toBe(false);
    expect(second.documents.map((document) => document.id)).toEqual([personal.documentId]);

    const exhausted = await listEffectiveIndexedDocuments(forced.db, {
      accountId: origin.accountId,
      workspaceId: origin.workspaceId,
      initiatingSubjectId: "user:alice",
      checkpoint: second.nextCheckpoint,
      limit: 10,
    });
    expect(exhausted).toEqual({
      documents: [],
      nextCheckpoint: second.nextCheckpoint,
      hasMore: false,
    });

    await shared!.admin`
      update documents set title = 'metadata-only-title', source_version = 'v2'
      where id = ${organization.documentId}`;
    const metadataOnly = await listEffectiveIndexedDocuments(forced.db, {
      accountId: origin.accountId,
      workspaceId: origin.workspaceId,
      initiatingSubjectId: "user:alice",
      checkpoint: second.nextCheckpoint,
    });
    expect(metadataOnly.documents).toEqual([]);

    await shared!
      .admin`update documents set status = 'indexing' where id = ${organization.documentId}`;
    await shared!
      .admin`update documents set status = 'ready' where id = ${organization.documentId}`;
    const reindexed = await listEffectiveIndexedDocuments(forced.db, {
      accountId: origin.accountId,
      workspaceId: origin.workspaceId,
      initiatingSubjectId: "user:alice",
      checkpoint: second.nextCheckpoint,
    });
    expect(reindexed.documents.map((document) => document.id)).toEqual([organization.documentId]);
    expect(reindexed.documents[0]?.title).toBe("metadata-only-title");
    expect(reindexed.documents[0]?.source.version).toBe("v2");
    expect(reindexed.nextCheckpoint).not.toBe(second.nextCheckpoint);

    await expect(
      listEffectiveIndexedDocuments(forced.db, {
        accountId: sibling.accountId,
        workspaceId: sibling.workspaceId,
        initiatingSubjectId: "user:alice",
        checkpoint: reindexed.nextCheckpoint,
      }),
    ).rejects.toThrow("different workspace or subject");
    await expect(
      listEffectiveIndexedDocuments(forced.db, {
        accountId: origin.accountId,
        workspaceId: origin.workspaceId,
        initiatingSubjectId: "user:bob",
        checkpoint: reindexed.nextCheckpoint,
      }),
    ).rejects.toThrow("different workspace or subject");
    await expect(
      listEffectiveIndexedDocuments(forced.db, {
        accountId: origin.accountId,
        workspaceId: origin.workspaceId,
        initiatingSubjectId: "user:alice",
        checkpoint: "not-a-checkpoint",
      }),
    ).rejects.toThrow("invalid document index checkpoint");

    expect(organization.indexSequence).toBeLessThan(workspace.indexSequence);
    expect(workspace.indexSequence).toBeLessThan(personal.indexSequence);
    expect(organization.indexedAt).toBeInstanceOf(Date);
  });
});
