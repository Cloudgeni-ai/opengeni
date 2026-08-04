import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  addDocumentToBase,
  deleteDocumentFromBase,
  getDocumentChunk,
  moveDocumentToBase,
  queueDocumentForReindex,
  reclassifyDocumentAuthority,
  searchEffectiveDocuments,
  searchDocuments,
} from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let available = true;
let shared: SharedTestDatabase | null = null;
let forced: ReturnType<typeof createDb>;
let scoped: ReturnType<typeof createDb>;

type Workspace = { accountId: string; workspaceId: string };
type StoredDocument = {
  documentId: string;
  chunkId: string;
  workspaceId: string;
  baseId: string;
  fileId: string;
};

async function freshWorkspace(label: string, accountId?: string): Promise<Workspace> {
  const resolvedAccountId =
    accountId ??
    (
      await shared!.admin<{ id: string }[]>`
        insert into managed_accounts (name) values (${`document-search-${label}`}) returning id`
    )[0]!.id;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${resolvedAccountId}, ${`document-search-${label}`}) returning id`;
  return { accountId: resolvedAccountId, workspaceId: workspace!.id };
}

async function createReadyDocument(
  workspace: Workspace,
  input: {
    label: string;
    kind: "organization" | "workspace" | "personal";
    subjectId?: string;
    text?: string;
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
  const [document] = await shared!.admin<{ id: string }[]>`
    insert into documents (
      account_id, workspace_id, base_id, file_id, status, title, created_by,
      authority_kind, authority_workspace_id, authority_subject_id, visibility
    ) values (
      ${workspace.accountId}, ${workspace.workspaceId}, ${base!.id}, ${file!.id},
      'ready', ${input.label}, ${input.subjectId ?? "user:alice"}, ${input.kind},
      ${input.kind === "organization" ? null : workspace.workspaceId}, ${subjectId},
      ${input.kind === "personal" ? "private" : "workspace"}
    ) returning id`;
  const zeroVector = `[${Array.from({ length: 3072 }, () => "0").join(",")}]`;
  const [chunk] = await shared!.admin<{ id: string }[]>`
    insert into document_chunks (
      account_id, workspace_id, document_id, base_id, file_id, chunk_index,
      text, metadata, embedding, embedding_model
    ) values (
      ${workspace.accountId}, ${workspace.workspaceId}, ${document!.id}, ${base!.id},
      ${file!.id}, 0, ${input.text ?? `authoritycommon ${input.label}`}, '{}'::jsonb,
      ${zeroVector}::vector, 'authority-test'
    ) returning id`;
  return {
    documentId: document!.id,
    chunkId: chunk!.id,
    workspaceId: workspace.workspaceId,
    baseId: base!.id,
    fileId: file!.id,
  };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("document-authority-search");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[document-authority-search] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    available = false;
    console.warn("[document-authority-search] docker unavailable, skipping");
    return;
  }
  forced = createDb(shared.appUrl, { max: 2, rlsStrategy: "force" });
  // The scoped/admin handle deliberately bypasses FORCE RLS. Its assertions
  // prove the application predicate is independently account- and tuple-safe.
  scoped = createDb(shared.adminUrl, { max: 2, rlsStrategy: "scoped" });
}, 180_000);

afterAll(async () => {
  await forced?.close().catch(() => undefined);
  await scoped?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("document retrieval authority (real PostgreSQL + pgvector)", () => {
  test("searches and fetches by account plus immutable authority before ranking", async () => {
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
      label: "personal",
      kind: "personal",
      subjectId: "user:alice",
    });
    const otherPersonal = await createReadyDocument(origin, {
      label: "legacy-private-bob",
      kind: "personal",
      subjectId: "user:bob",
      text: "authoritycommon authoritycommon authoritycommon legacy private bob",
    });
    const otherOrganization = await createReadyDocument(other, {
      label: "other-organization",
      kind: "organization",
    });

    let mismatchedEmbedderCalled = false;
    await expect(
      searchDocuments(
        scoped.db,
        {
          accountId: other.accountId,
          workspaceId: origin.workspaceId,
          query: "authoritycommon",
          mode: "vector",
        },
        {
          embedder: {
            model: "authority-test",
            dimensions: 3,
            embedMany: async () => [],
            embedQuery: async () => {
              mismatchedEmbedderCalled = true;
              return [0, 0, 0];
            },
          },
        },
      ),
    ).rejects.toThrow("document account/workspace authority mismatch");
    expect(mismatchedEmbedderCalled).toBe(false);

    await expect(
      addDocumentToBase(forced.db, {
        accountId: origin.accountId,
        workspaceId: origin.workspaceId,
        baseId: organization.baseId,
        fileId: organization.fileId,
        authorityKind: "organization",
        createdBy: "user:alice",
        initiatingSubjectId: "user:alice",
        access: { viewerSubjectId: "user:alice" },
      }),
    ).rejects.toThrow("organization document writes require exact account authority");
    await expect(
      moveDocumentToBase(forced.db, {
        accountId: origin.accountId,
        workspaceId: origin.workspaceId,
        documentId: organization.documentId,
        targetBaseId: workspace.baseId,
        access: { viewerSubjectId: "user:alice" },
      }),
    ).rejects.toThrow("organization document mutations require exact account authority");
    await expect(
      queueDocumentForReindex(forced.db, origin.workspaceId, organization.documentId, {
        viewerSubjectId: "user:alice",
      }),
    ).rejects.toThrow("organization document mutations require exact account authority");
    await expect(
      deleteDocumentFromBase(forced.db, {
        accountId: origin.accountId,
        workspaceId: origin.workspaceId,
        baseId: organization.baseId,
        documentId: organization.documentId,
        access: { viewerSubjectId: "user:alice" },
      }),
    ).rejects.toThrow("organization document mutations require exact account authority");

    for (const client of [forced, scoped]) {
      const originResults = await searchDocuments(client.db, {
        accountId: origin.accountId,
        workspaceId: origin.workspaceId,
        query: "authoritycommon",
        mode: "keyword",
        limit: 50,
        access: { viewerSubjectId: "user:alice" },
      });
      expect(originResults.map((result) => result.documentId).sort()).toEqual(
        [organization.documentId, workspace.documentId, personal.documentId].sort(),
      );

      const effective = await searchEffectiveDocuments(client.db, {
        accountId: origin.accountId,
        workspaceId: origin.workspaceId,
        query: "authoritycommon",
        mode: "keyword",
        limit: 1,
        initiatingSubjectId: "user:alice",
        surface: "agent",
        // Runtime hardening: even an untyped caller cannot replace the frozen
        // initiating subject through the lower-level access shape.
        access: { viewerSubjectId: "user:bob", agentOnly: false },
      } as never);
      expect(effective).toHaveLength(1);
      expect(effective[0]?.documentId).not.toBe(otherPersonal.documentId);
      expect(["organization", "workspace", "personal"]).toContain(effective[0]?.authorityKind);
      const effectiveAll = await searchEffectiveDocuments(client.db, {
        accountId: origin.accountId,
        workspaceId: origin.workspaceId,
        query: "authoritycommon",
        mode: "keyword",
        limit: 50,
        initiatingSubjectId: "user:alice",
        surface: "agent",
      });
      expect(effectiveAll.map((result) => result.documentId).sort()).toEqual(
        [organization.documentId, workspace.documentId, personal.documentId].sort(),
      );

      const siblingResults = await searchDocuments(client.db, {
        accountId: sibling.accountId,
        workspaceId: sibling.workspaceId,
        query: "authoritycommon",
        mode: "keyword",
        limit: 50,
        access: { viewerSubjectId: "user:alice" },
      });
      expect(siblingResults).toHaveLength(1);
      expect(siblingResults[0]).toMatchObject({
        documentId: organization.documentId,
        workspaceId: origin.workspaceId,
        authorityKind: "organization",
        authorityWorkspaceId: null,
        authoritySubjectId: null,
      });
      const siblingEffective = await searchEffectiveDocuments(client.db, {
        accountId: sibling.accountId,
        workspaceId: sibling.workspaceId,
        query: "legacy private bob",
        mode: "keyword",
        limit: 50,
        initiatingSubjectId: "user:bob",
        surface: "agent",
      });
      expect(siblingEffective.map((result) => result.documentId)).not.toContain(
        otherPersonal.documentId,
      );

      await expect(
        getDocumentChunk(client.db, sibling.accountId, sibling.workspaceId, organization.chunkId, {
          viewerSubjectId: "user:alice",
        }),
      ).resolves.toMatchObject({
        documentId: organization.documentId,
        workspaceId: origin.workspaceId,
      });
      await expect(
        getDocumentChunk(client.db, sibling.accountId, sibling.workspaceId, personal.chunkId, {
          viewerSubjectId: "user:alice",
        }),
      ).resolves.toBeNull();

      const otherResults = await searchDocuments(client.db, {
        accountId: other.accountId,
        workspaceId: other.workspaceId,
        query: "authoritycommon",
        mode: "keyword",
        limit: 50,
        access: { viewerSubjectId: "user:alice" },
      });
      expect(otherResults.map((result) => result.documentId)).toEqual([
        otherOrganization.documentId,
      ]);
      await expect(
        getDocumentChunk(client.db, other.accountId, other.workspaceId, organization.chunkId, {
          viewerSubjectId: "user:alice",
        }),
      ).resolves.toBeNull();
    }
  });

  test("reclassifies authority only through an idempotent exact receipt", async () => {
    if (!available) return;
    const origin = await freshWorkspace("reclassification-origin");
    const sibling = await freshWorkspace("reclassification-sibling", origin.accountId);
    const workspaceDocument = await createReadyDocument(origin, {
      label: "reclassification-workspace",
      kind: "workspace",
      subjectId: "user:alice",
      text: "reclassification-needle",
    });
    const [targetBase] = await shared!.admin<{ id: string }[]>`
      insert into document_bases (account_id, workspace_id, name)
      values (${origin.accountId}, ${origin.workspaceId}, 'Reclassification target')
      returning id`;
    const operationId = crypto.randomUUID();

    const receipt = await reclassifyDocumentAuthority(forced.db, {
      ...origin,
      documentId: workspaceDocument.documentId,
      operationId,
      actorSubjectId: "user:alice",
      expectedAuthority: {
        kind: "workspace",
        workspaceId: origin.workspaceId,
        subjectId: null,
      },
      targetAuthorityKind: "personal",
    });
    expect(receipt).toMatchObject({
      operationId,
      documentId: workspaceDocument.documentId,
      baseIdSnapshot: workspaceDocument.baseId,
      actorSubjectId: "user:alice",
      sourceAuthority: {
        kind: "workspace",
        workspaceId: origin.workspaceId,
        subjectId: null,
      },
      targetAuthority: {
        kind: "personal",
        workspaceId: origin.workspaceId,
        subjectId: "user:alice",
      },
    });

    const replayed = await reclassifyDocumentAuthority(forced.db, {
      ...origin,
      documentId: workspaceDocument.documentId,
      operationId,
      actorSubjectId: "user:alice",
      expectedAuthority: {
        kind: "workspace",
        workspaceId: origin.workspaceId,
        subjectId: null,
      },
      targetAuthorityKind: "personal",
    });
    expect(replayed).toEqual(receipt);
    const [receiptCount] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count
      from document_authority_reclassifications
      where workspace_id = ${origin.workspaceId} and operation_id = ${operationId}`;
    expect(receiptCount).toEqual({ count: 1 });

    await expect(
      reclassifyDocumentAuthority(forced.db, {
        ...origin,
        documentId: workspaceDocument.documentId,
        operationId,
        actorSubjectId: "user:alice",
        expectedAuthority: {
          kind: "personal",
          workspaceId: origin.workspaceId,
          subjectId: "user:alice",
        },
        targetAuthorityKind: "workspace",
      }),
    ).rejects.toThrow("operationId was reused");

    const [stored] = await shared!.admin<
      Array<{
        documentKind: string;
        documentSubject: string | null;
        chunkKind: string;
        chunkSubject: string | null;
      }>
    >`
      select
        document.authority_kind as "documentKind",
        document.authority_subject_id as "documentSubject",
        chunk.authority_kind as "chunkKind",
        chunk.authority_subject_id as "chunkSubject"
      from documents document
      join document_chunks chunk on chunk.document_id = document.id
      where document.id = ${workspaceDocument.documentId}`;
    expect(stored).toEqual({
      documentKind: "personal",
      documentSubject: "user:alice",
      chunkKind: "personal",
      chunkSubject: "user:alice",
    });

    // Collection changes remain organization-only metadata and cannot widen
    // the personal authority tuple.
    await moveDocumentToBase(forced.db, {
      ...origin,
      documentId: workspaceDocument.documentId,
      targetBaseId: targetBase!.id,
      access: { viewerSubjectId: "user:alice" },
    });
    const [afterMove] = await shared!.admin<
      Array<{ baseId: string; kind: string; subjectId: string | null }>
    >`
      select base_id as "baseId", authority_kind as kind,
        authority_subject_id as "subjectId"
      from documents where id = ${workspaceDocument.documentId}`;
    expect(afterMove).toEqual({
      baseId: targetBase!.id,
      kind: "personal",
      subjectId: "user:alice",
    });

    const bobResults = await searchDocuments(forced.db, {
      ...origin,
      query: "reclassification-needle",
      mode: "keyword",
      limit: 10,
      access: { viewerSubjectId: "user:bob" },
    });
    expect(bobResults).toHaveLength(0);
    const siblingResults = await searchDocuments(forced.db, {
      ...sibling,
      query: "reclassification-needle",
      mode: "keyword",
      limit: 10,
      access: { viewerSubjectId: "user:alice" },
    });
    expect(siblingResults).toHaveLength(0);

    await expect(
      reclassifyDocumentAuthority(forced.db, {
        ...origin,
        documentId: workspaceDocument.documentId,
        operationId: crypto.randomUUID(),
        actorSubjectId: "user:alice",
        expectedAuthority: {
          kind: "personal",
          workspaceId: sibling.workspaceId,
          subjectId: "user:alice",
        },
        targetAuthorityKind: "workspace",
      }),
    ).rejects.toThrow("must remain in the originating workspace");

    const widenReceipt = await reclassifyDocumentAuthority(forced.db, {
      ...origin,
      documentId: workspaceDocument.documentId,
      operationId: crypto.randomUUID(),
      actorSubjectId: "user:alice",
      expectedAuthority: {
        kind: "personal",
        workspaceId: origin.workspaceId,
        subjectId: "user:alice",
      },
      targetAuthorityKind: "workspace",
    });
    expect(widenReceipt.targetAuthority).toEqual({
      kind: "workspace",
      workspaceId: origin.workspaceId,
      subjectId: null,
    });
    const bobAfterExplicitWiden = await searchDocuments(forced.db, {
      ...origin,
      query: "reclassification-needle",
      mode: "keyword",
      limit: 10,
      access: { viewerSubjectId: "user:bob" },
    });
    expect(bobAfterExplicitWiden.map((result) => result.documentId)).toEqual([
      workspaceDocument.documentId,
    ]);
    const siblingAfterExplicitWiden = await searchDocuments(forced.db, {
      ...sibling,
      query: "reclassification-needle",
      mode: "keyword",
      limit: 10,
      access: { viewerSubjectId: "user:alice" },
    });
    expect(siblingAfterExplicitWiden).toHaveLength(0);

    await expect(
      shared!.admin`
        update documents
        set authority_kind = 'organization', authority_workspace_id = null
        where id = ${workspaceDocument.documentId}`,
    ).rejects.toThrow("document authority is immutable outside an explicit reclassification");
  });
});
