import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  addDocumentToBase,
  browseEffectiveKnowledge,
  deleteDocumentFromBase,
  getEffectiveKnowledgeRecord,
  getDocument,
  getDocumentChunk,
  getDocumentOriginalFile,
  listAccessibleDocuments,
  listDocumentAuthorityReclassifications,
  moveDocumentToBase,
  queueDocumentForReindex,
  reclassifyDocumentAuthority,
  searchEffectiveKnowledge,
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

function nestedErrorMessages(error: unknown): string {
  const messages: string[] = [];
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < 16) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record.message === "string") messages.push(record.message);
    if (record.cause !== undefined) queue.push(record.cause);
  }
  return messages.join("\n");
}

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
    sourceUpdatedAt?: Date;
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
      authority_kind, authority_workspace_id, authority_subject_id, visibility,
      source_updated_at
    ) values (
      ${workspace.accountId}, ${workspace.workspaceId}, ${base!.id}, ${file!.id},
      'ready', ${input.label}, ${input.subjectId ?? "user:alice"}, ${input.kind},
      ${input.kind === "organization" ? null : workspace.workspaceId}, ${subjectId},
      ${input.kind === "personal" ? "private" : "workspace"},
      ${input.sourceUpdatedAt ?? null}
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
  test("owner manages an activated personal document after losing origin workspace access", async () => {
    if (!available) return;
    const subjectId = `human:${crypto.randomUUID()}`;
    const otherSubjectId = `human:${crypto.randomUUID()}`;
    const personal = await freshWorkspace("portable-personal");
    const origin = await freshWorkspace("portable-origin", personal.accountId);
    const sibling = await freshWorkspace("portable-sibling", personal.accountId);
    const otherOrganization = await freshWorkspace("portable-other-organization");
    await shared!.admin`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id, authorization_revision
      ) values (${personal.accountId}, ${subjectId}, 'active', ${personal.workspaceId}, 1)`;
    await shared!.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id) values
        (${origin.accountId}, ${origin.workspaceId}, ${subjectId}),
        (${sibling.accountId}, ${sibling.workspaceId}, ${subjectId}),
        (${sibling.accountId}, ${sibling.workspaceId}, ${otherSubjectId})`;
    const [file] = await shared!.admin<{ id: string }[]>`
      insert into files (
        account_id, workspace_id, status, filename, safe_filename, content_type,
        size_bytes, bucket, object_key
      ) values (
        ${origin.accountId}, ${origin.workspaceId}, 'ready', 'portable.txt',
        'portable.txt', 'text/plain', 1, 'test', ${`documents/${crypto.randomUUID()}`}
      ) returning id`;
    const bases = await shared!.admin<{ id: string }[]>`
      insert into document_bases (account_id, workspace_id, name) values
        (${origin.accountId}, ${origin.workspaceId}, ${`portable-a-${crypto.randomUUID()}`}),
        (${origin.accountId}, ${origin.workspaceId}, ${`portable-b-${crypto.randomUUID()}`})
      returning id`;
    const created = await addDocumentToBase(forced.db, {
      accountId: origin.accountId,
      workspaceId: origin.workspaceId,
      baseId: bases[0]!.id,
      fileId: file!.id,
      authorityKind: "personal",
      createdBy: subjectId,
      initiatingSubjectId: subjectId,
      access: { viewerSubjectId: subjectId },
    });
    expect(created.authorityId).toEqual(expect.any(String));
    expect(created.authorityWorkspaceId).toBeNull();

    await shared!.admin`
      delete from workspace_memberships
      where account_id = ${origin.accountId} and workspace_id = ${origin.workspaceId}
        and subject_id = ${subjectId}`;

    const ownerAccess = { viewerSubjectId: subjectId };
    expect(
      (await listAccessibleDocuments(forced.db, sibling.workspaceId, ownerAccess)).map(
        (document) => document.id,
      ),
    ).toContain(created.id);
    await expect(
      getDocument(forced.db, sibling.workspaceId, created.id, ownerAccess),
    ).resolves.toMatchObject({
      id: created.id,
      workspaceId: origin.workspaceId,
      baseId: bases[0]!.id,
    });
    await expect(
      getDocument(forced.db, sibling.workspaceId, created.id, {
        viewerSubjectId: otherSubjectId,
      }),
    ).resolves.toBeNull();
    await expect(
      getDocument(forced.db, otherOrganization.workspaceId, created.id, ownerAccess),
    ).resolves.toBeNull();
    const originalFile = await getDocumentOriginalFile(forced.db, {
      accountId: origin.accountId,
      workspaceId: sibling.workspaceId,
      documentId: created.id,
      access: ownerAccess,
    });
    expect(originalFile).toMatchObject({ id: file!.id, workspaceId: origin.workspaceId });
    await expect(
      getDocumentOriginalFile(forced.db, {
        accountId: origin.accountId,
        workspaceId: sibling.workspaceId,
        documentId: created.id,
        access: { viewerSubjectId: otherSubjectId },
      }),
    ).resolves.toBeNull();
    await expect(
      getDocumentOriginalFile(forced.db, {
        accountId: otherOrganization.accountId,
        workspaceId: otherOrganization.workspaceId,
        documentId: created.id,
        access: ownerAccess,
      }),
    ).resolves.toBeNull();

    const queued = await queueDocumentForReindex(
      forced.db,
      sibling.workspaceId,
      created.id,
      ownerAccess,
    );
    expect(queued).toMatchObject({
      id: created.id,
      workspaceId: origin.workspaceId,
      status: "queued",
    });
    const moved = await moveDocumentToBase(forced.db, {
      accountId: origin.accountId,
      workspaceId: sibling.workspaceId,
      documentId: created.id,
      targetBaseId: bases[1]!.id,
      access: ownerAccess,
    });
    expect(moved).toMatchObject({
      id: created.id,
      workspaceId: origin.workspaceId,
      baseId: bases[1]!.id,
    });
    await shared!.admin`
      update organization_user_resource_authorities
      set status = 'revoked', generation = generation + 1, revoked_at = now(), updated_at = now()
      where account_id = ${origin.accountId} and id = ${created.authorityId!}`;
    await expect(
      getDocumentOriginalFile(forced.db, {
        accountId: origin.accountId,
        workspaceId: sibling.workspaceId,
        documentId: created.id,
        access: ownerAccess,
      }),
    ).resolves.toBeNull();
    await deleteDocumentFromBase(forced.db, {
      accountId: origin.accountId,
      workspaceId: sibling.workspaceId,
      baseId: bases[1]!.id,
      documentId: created.id,
      access: ownerAccess,
    });
    await expect(
      getDocument(forced.db, sibling.workspaceId, created.id, ownerAccess),
    ).resolves.toBeNull();
  });

  // NOTE: `acquireSharedTestDatabase` hands out the container SUPERUSER, for whom
  // `FORCE ROW LEVEL SECURITY` never engages. This file therefore covers the
  // domain contract, not the production FORCE-RLS boundary: the personal
  // authority activation asserted below is exercised against a
  // NOSUPERUSER/NOBYPASSRLS owner in
  // `packages/db/test/migration-0338-document-authority-reclassification.test.ts`.
  test("reclassification preserves portable personal get, search, and browse isolation", async () => {
    if (!available) return;
    const subjectId = `human:${crypto.randomUUID()}`;
    const otherSubjectId = `human:${crypto.randomUUID()}`;
    const personal = await freshWorkspace("reclass-personal");
    const origin = await freshWorkspace("reclass-origin", personal.accountId);
    const sibling = await freshWorkspace("reclass-sibling", personal.accountId);
    const otherOrganization = await freshWorkspace("reclass-other");
    await shared!.admin`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id, authorization_revision
      ) values (${personal.accountId}, ${subjectId}, 'active', ${personal.workspaceId}, 1)`;
    await shared!.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role) values
        (${origin.accountId}, ${origin.workspaceId}, ${subjectId}, 'admin'),
        (${sibling.accountId}, ${sibling.workspaceId}, ${subjectId}, 'member'),
        (${sibling.accountId}, ${sibling.workspaceId}, ${otherSubjectId}, 'member')`;
    const stored = await createReadyDocument(origin, {
      label: `transition-${crypto.randomUUID()}`,
      kind: "workspace",
      subjectId,
      text: "transitionprobe exact personal authority evidence",
    });
    const promoted = await reclassifyDocumentAuthority(forced.db, {
      accountId: origin.accountId,
      workspaceId: origin.workspaceId,
      documentId: stored.documentId,
      operationId: crypto.randomUUID(),
      actorSubjectId: subjectId,
      expectedAuthority: {
        kind: "workspace",
        workspaceId: origin.workspaceId,
        subjectId: null,
        authorityId: null,
      },
      targetAuthorityKind: "personal",
      accountAdminAuthorization: null,
    });
    const promotedAuthorityId = promoted.authority.authorityId;
    if (!promotedAuthorityId) throw new Error("personal reclassification omitted authority id");
    expect(promoted.authority).toEqual({
      kind: "personal",
      workspaceId: null,
      subjectId,
      authorityId: promotedAuthorityId,
    });

    await shared!.admin`
      delete from workspace_memberships
      where account_id = ${origin.accountId} and workspace_id = ${origin.workspaceId}
        and subject_id = ${subjectId}`;

    const ownerAccess = { viewerSubjectId: subjectId };
    await expect(
      getDocument(forced.db, sibling.workspaceId, stored.documentId, ownerAccess),
    ).resolves.toMatchObject({ id: stored.documentId, workspaceId: origin.workspaceId });
    const search = await searchEffectiveKnowledge(forced.db, {
      accountId: origin.accountId,
      workspaceId: sibling.workspaceId,
      initiatingSubjectId: subjectId,
      surface: "human",
      query: "transitionprobe",
      mode: "keyword",
      limit: 10,
    });
    expect(search.results.map((result) => result.record.id)).toContain(
      `document_chunk:${stored.chunkId}`,
    );
    const browse = await browseEffectiveKnowledge(forced.db, {
      accountId: origin.accountId,
      workspaceId: sibling.workspaceId,
      initiatingSubjectId: subjectId,
      surface: "human",
      limit: 50,
    });
    expect(browse.records.map((record) => record.id)).toContain(`document:${stored.documentId}`);
    await expect(
      getEffectiveKnowledgeRecord(forced.db, {
        accountId: origin.accountId,
        workspaceId: sibling.workspaceId,
        initiatingSubjectId: subjectId,
        surface: "human",
        id: `document:${stored.documentId}`,
      }),
    ).resolves.toMatchObject({ id: `document:${stored.documentId}` });

    const deniedSearch = await searchEffectiveKnowledge(forced.db, {
      accountId: origin.accountId,
      workspaceId: sibling.workspaceId,
      initiatingSubjectId: otherSubjectId,
      surface: "human",
      query: "transitionprobe",
      mode: "keyword",
      limit: 10,
    });
    expect(deniedSearch.results.map((result) => result.record.id)).not.toContain(
      `document_chunk:${stored.chunkId}`,
    );
    await expect(
      getDocument(forced.db, otherOrganization.workspaceId, stored.documentId, ownerAccess),
    ).resolves.toBeNull();

    let siblingWorkspaceTargetError: unknown;
    try {
      await reclassifyDocumentAuthority(forced.db, {
        accountId: origin.accountId,
        workspaceId: sibling.workspaceId,
        documentId: stored.documentId,
        operationId: crypto.randomUUID(),
        actorSubjectId: subjectId,
        expectedAuthority: {
          kind: "personal",
          workspaceId: null,
          subjectId,
          authorityId: promotedAuthorityId,
        },
        targetAuthorityKind: "workspace",
        accountAdminAuthorization: null,
      });
    } catch (error) {
      siblingWorkspaceTargetError = error;
    }
    expect(nestedErrorMessages(siblingWorkspaceTargetError)).toContain(
      "workspace document target requires the immutable origin workspace route",
    );

    // `personal(portable) -> personal` from the sibling route. `workspaceId` is
    // asserted EXACTLY: `apply_document_authority` normalizes
    // `authority_workspace_id` to NULL for every personal row that carries an
    // `authority_id`, and the trigger's receipt match compares the
    // PRE-normalization NEW row - so a response or an immutable receipt naming
    // the origin workspace here would assert an anchoring the database does not
    // hold, which is exactly what acceptance criterion 6 ("preserves ...
    // provenance") forbids.
    const portableOperationId = crypto.randomUUID();
    const repeated = await reclassifyDocumentAuthority(forced.db, {
      accountId: origin.accountId,
      workspaceId: sibling.workspaceId,
      documentId: stored.documentId,
      operationId: portableOperationId,
      actorSubjectId: subjectId,
      expectedAuthority: {
        kind: "personal",
        workspaceId: null,
        subjectId,
        authorityId: promotedAuthorityId,
      },
      targetAuthorityKind: "personal",
      accountAdminAuthorization: null,
    });
    expect(repeated.authority).toEqual({
      kind: "personal",
      workspaceId: null,
      subjectId,
      authorityId: promotedAuthorityId,
    });
    const [portableTruth] = await shared!.admin<
      Array<{
        documentWorkspace: string | null;
        receiptWorkspace: string | null;
        receiptResultWorkspace: string | null;
      }>
    >`
      select document.authority_workspace_id as "documentWorkspace",
        receipt.resulting_authority_workspace_id as "receiptWorkspace",
        receipt.result #>> '{authority,workspaceId}' as "receiptResultWorkspace"
      from documents document
      join document_authority_reclassifications receipt
        on receipt.operation_id = ${portableOperationId}::uuid
      where document.id = ${stored.documentId}`;
    expect(portableTruth).toEqual({
      documentWorkspace: null,
      receiptWorkspace: null,
      receiptResultWorkspace: null,
    });

    await shared!.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${origin.accountId}, ${origin.workspaceId}, ${subjectId}, 'admin')`;
    await reclassifyDocumentAuthority(forced.db, {
      accountId: origin.accountId,
      workspaceId: origin.workspaceId,
      documentId: stored.documentId,
      operationId: crypto.randomUUID(),
      actorSubjectId: subjectId,
      expectedAuthority: {
        kind: "personal",
        workspaceId: null,
        subjectId,
        authorityId: promotedAuthorityId,
      },
      targetAuthorityKind: "workspace",
      accountAdminAuthorization: null,
    });

    await expect(
      getDocument(forced.db, sibling.workspaceId, stored.documentId, ownerAccess),
    ).resolves.toBeNull();
    const isolatedSearch = await searchEffectiveKnowledge(forced.db, {
      accountId: origin.accountId,
      workspaceId: sibling.workspaceId,
      initiatingSubjectId: subjectId,
      surface: "human",
      query: "transitionprobe",
      mode: "keyword",
      limit: 10,
    });
    expect(isolatedSearch.results.map((result) => result.record.id)).not.toContain(
      `document_chunk:${stored.chunkId}`,
    );
    const isolatedBrowse = await browseEffectiveKnowledge(forced.db, {
      accountId: origin.accountId,
      workspaceId: sibling.workspaceId,
      initiatingSubjectId: subjectId,
      surface: "human",
      limit: 50,
    });
    expect(isolatedBrowse.records.map((record) => record.id)).not.toContain(
      `document:${stored.documentId}`,
    );
    await expect(
      getEffectiveKnowledgeRecord(forced.db, {
        accountId: origin.accountId,
        workspaceId: sibling.workspaceId,
        initiatingSubjectId: subjectId,
        surface: "human",
        id: `document:${stored.documentId}`,
      }),
    ).resolves.toBeNull();
    await expect(
      getDocument(forced.db, origin.workspaceId, stored.documentId, ownerAccess),
    ).resolves.toMatchObject({ id: stored.documentId, authorityKind: "workspace" });

    const receiptPageOne = await listDocumentAuthorityReclassifications(forced.db, {
      accountId: origin.accountId,
      workspaceId: origin.workspaceId,
      documentId: stored.documentId,
      actorSubjectId: subjectId,
      limit: 1,
    });
    const receiptPageOneCursor = receiptPageOne.nextCursor;
    expect(typeof receiptPageOneCursor).toBe("string");
    expect(receiptPageOne).toMatchObject({
      receipts: [{ authority: { kind: "workspace" } }],
      hasMore: true,
      nextCursor: receiptPageOneCursor,
    });
    const receiptPageTwo = await listDocumentAuthorityReclassifications(forced.db, {
      accountId: origin.accountId,
      workspaceId: origin.workspaceId,
      documentId: stored.documentId,
      actorSubjectId: subjectId,
      limit: 1,
      cursor: receiptPageOneCursor!,
    });
    expect(receiptPageTwo).toMatchObject({
      receipts: [{ authority: { kind: "personal" } }],
      hasMore: false,
      nextCursor: null,
    });
    await expect(
      listDocumentAuthorityReclassifications(forced.db, {
        accountId: origin.accountId,
        workspaceId: sibling.workspaceId,
        documentId: stored.documentId,
        actorSubjectId: subjectId,
        limit: 1,
        cursor: receiptPageOneCursor!,
      }),
    ).rejects.toThrow("invalid document authority receipt cursor");
  });

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
      const subjectlessOrganizationResults = await searchDocuments(client.db, {
        accountId: origin.accountId,
        workspaceId: origin.workspaceId,
        query: "organization",
        mode: "keyword",
        limit: 50,
      });
      expect(subjectlessOrganizationResults.map((result) => result.documentId)).toContain(
        organization.documentId,
      );

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
      expect([organization.documentId, workspace.documentId, personal.documentId]).toContain(
        effective[0]?.documentId,
      );
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
      const knowledge = await searchEffectiveKnowledge(client.db, {
        accountId: origin.accountId,
        workspaceId: origin.workspaceId,
        query: "authoritycommon",
        mode: "keyword",
        limit: 50,
        initiatingSubjectId: "user:alice",
        surface: "agent",
      });
      expect(knowledge.results.map((result) => result.record.id).sort()).toEqual(
        [organization.chunkId, workspace.chunkId, personal.chunkId]
          .map((id) => `document_chunk:${id}`)
          .sort(),
      );
      expect(JSON.stringify(knowledge)).not.toContain("user:alice");
      expect(knowledge.results[0]?.record).toMatchObject({
        kind: "document_chunk",
        content: { format: "markdown" },
        lifecycle: { state: "active" },
      });

      await expect(
        getEffectiveKnowledgeRecord(client.db, {
          accountId: origin.accountId,
          workspaceId: origin.workspaceId,
          initiatingSubjectId: "user:alice",
          id: `document_chunk:${personal.chunkId}`,
        }),
      ).resolves.toMatchObject({ id: `document_chunk:${personal.chunkId}` });
      await expect(
        getEffectiveKnowledgeRecord(client.db, {
          accountId: origin.accountId,
          workspaceId: origin.workspaceId,
          initiatingSubjectId: "user:bob",
          id: `document_chunk:${personal.chunkId}`,
        }),
      ).resolves.toBeNull();

      const browse = await browseEffectiveKnowledge(client.db, {
        accountId: origin.accountId,
        workspaceId: origin.workspaceId,
        initiatingSubjectId: "user:alice",
        limit: 50,
      });
      expect(browse.records.map((record) => record.id).sort()).toEqual(
        [organization.documentId, workspace.documentId, personal.documentId]
          .map((id) => `document:${id}`)
          .sort(),
      );
      expect(JSON.stringify(browse)).not.toContain("user:alice");
      const contents = await browseEffectiveKnowledge(client.db, {
        accountId: origin.accountId,
        workspaceId: origin.workspaceId,
        initiatingSubjectId: "user:alice",
        parentId: `document:${personal.documentId}`,
        limit: 50,
      });
      expect(contents.records.map((record) => record.id)).toEqual([
        `document_chunk:${personal.chunkId}`,
      ]);

      const wrongSubjectLegacy = await searchEffectiveDocuments(client.db, {
        accountId: origin.accountId,
        workspaceId: origin.workspaceId,
        query: "personal",
        mode: "keyword",
        limit: 50,
        initiatingSubjectId: "user:bob",
        surface: "agent",
      });
      expect(wrongSubjectLegacy.map((result) => result.documentId)).not.toContain(
        personal.documentId,
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
      const siblingBrowse = await browseEffectiveKnowledge(client.db, {
        accountId: sibling.accountId,
        workspaceId: sibling.workspaceId,
        initiatingSubjectId: "user:alice",
        limit: 50,
      });
      expect(siblingBrowse.records.map((record) => record.id)).toEqual([
        `document:${organization.documentId}`,
      ]);
      const inaccessibleTraversal = await browseEffectiveKnowledge(client.db, {
        accountId: sibling.accountId,
        workspaceId: sibling.workspaceId,
        initiatingSubjectId: "user:alice",
        parentId: `document:${personal.documentId}`,
        limit: 50,
      });
      expect(inaccessibleTraversal).toMatchObject({
        records: [],
        nextCursor: null,
        hasMore: false,
        selection: { omitted: { forResponseBudget: 0 }, compactedRecordCount: 0 },
      });

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

  test("rechecks traversal, lifecycle, quality, dedupe, and response bounds under FORCE RLS", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("knowledge-selection");
    const traversal = await createReadyDocument(workspace, {
      label: "private-traversal",
      kind: "personal",
      subjectId: "user:alice",
      text: "traversal-zero",
    });
    const zeroVector = `[${Array.from({ length: 3072 }, () => "0").join(",")}]`;
    const extraChunks = await shared!.admin<{ id: string; chunkIndex: number }[]>`
      insert into document_chunks (
        account_id, workspace_id, document_id, base_id, file_id, chunk_index,
        text, metadata, embedding, embedding_model
      ) values
        (${workspace.accountId}, ${workspace.workspaceId}, ${traversal.documentId},
         ${traversal.baseId}, ${traversal.fileId}, 1, 'traversal-one', '{}'::jsonb,
         ${zeroVector}::vector, 'authority-test'),
        (${workspace.accountId}, ${workspace.workspaceId}, ${traversal.documentId},
         ${traversal.baseId}, ${traversal.fileId}, 2, 'traversal-two', '{}'::jsonb,
         ${zeroVector}::vector, 'authority-test')
      returning id, chunk_index as "chunkIndex"`;
    extraChunks.sort((left, right) => left.chunkIndex - right.chunkIndex);

    const documentRecord = await getEffectiveKnowledgeRecord(forced.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      initiatingSubjectId: "user:alice",
      id: `document:${traversal.documentId}`,
    });
    expect(documentRecord?.links).toContainEqual({
      relation: "contents",
      target: { kind: "knowledge", id: `document_chunk:${traversal.chunkId}` },
    });
    const first = await getEffectiveKnowledgeRecord(forced.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      initiatingSubjectId: "user:alice",
      id: `document_chunk:${traversal.chunkId}`,
    });
    expect(first?.links).toContainEqual({
      relation: "next",
      target: { kind: "knowledge", id: `document_chunk:${extraChunks[0]!.id}` },
    });
    const middle = await getEffectiveKnowledgeRecord(forced.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      initiatingSubjectId: "user:alice",
      id: `document_chunk:${extraChunks[0]!.id}`,
    });
    expect(middle?.links).toEqual(
      expect.arrayContaining([
        {
          relation: "previous",
          target: {
            kind: "knowledge",
            id: `document_chunk:${traversal.chunkId}`,
          },
        },
        {
          relation: "next",
          target: {
            kind: "knowledge",
            id: `document_chunk:${extraChunks[1]!.id}`,
          },
        },
      ]),
    );

    const versioned = await createReadyDocument(workspace, {
      label: "versioned-cursor",
      kind: "workspace",
      text: "version-zero",
    });
    await shared!.admin`
      insert into document_chunks (
        account_id, workspace_id, document_id, base_id, file_id, chunk_index,
        text, metadata, embedding, embedding_model
      ) values (
        ${workspace.accountId}, ${workspace.workspaceId}, ${versioned.documentId},
        ${versioned.baseId}, ${versioned.fileId}, 1, 'version-one', '{}'::jsonb,
        ${zeroVector}::vector, 'authority-test'
      )`;
    const versionedPage = await browseEffectiveKnowledge(forced.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      initiatingSubjectId: "user:alice",
      parentId: `document:${versioned.documentId}`,
      limit: 1,
    });
    expect(versionedPage.nextCursor).not.toBeNull();
    await shared!
      .admin`update documents set status = 'indexing' where id = ${versioned.documentId}`;
    await shared!.admin`delete from document_chunks where document_id = ${versioned.documentId}`;
    await shared!.admin`
      insert into document_chunks (
        account_id, workspace_id, document_id, base_id, file_id, chunk_index,
        text, metadata, embedding, embedding_model
      ) values
        (${workspace.accountId}, ${workspace.workspaceId}, ${versioned.documentId},
         ${versioned.baseId}, ${versioned.fileId}, 0, 'replacement-zero', '{}'::jsonb,
         ${zeroVector}::vector, 'authority-test'),
        (${workspace.accountId}, ${workspace.workspaceId}, ${versioned.documentId},
         ${versioned.baseId}, ${versioned.fileId}, 1, 'replacement-one', '{}'::jsonb,
         ${zeroVector}::vector, 'authority-test')`;
    await shared!.admin`update documents set status = 'ready' where id = ${versioned.documentId}`;
    await expect(
      browseEffectiveKnowledge(forced.db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        initiatingSubjectId: "user:alice",
        parentId: `document:${versioned.documentId}`,
        cursor: versionedPage.nextCursor!,
        limit: 1,
      }),
    ).rejects.toThrow("different scope");

    await expect(
      getEffectiveKnowledgeRecord(forced.db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        initiatingSubjectId: "user:bob",
        id: `document_chunk:${extraChunks[0]!.id}`,
      }),
    ).resolves.toBeNull();

    // Revocation is effective for exact get, traversal, and ranking. The empty
    // response contains no neighboring ids or other record metadata.
    await shared!.admin`
      update documents set agent_access = false where id = ${traversal.documentId}`;
    await expect(
      getEffectiveKnowledgeRecord(forced.db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        initiatingSubjectId: "user:alice",
        id: `document_chunk:${extraChunks[0]!.id}`,
      }),
    ).resolves.toBeNull();
    const revokedTraversal = await browseEffectiveKnowledge(forced.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      initiatingSubjectId: "user:alice",
      parentId: `document:${traversal.documentId}`,
    });
    expect(revokedTraversal).toMatchObject({
      records: [],
      nextCursor: null,
      hasMore: false,
      selection: { omitted: { forResponseBudget: 0 }, compactedRecordCount: 0 },
    });
    const revokedSearch = await searchEffectiveKnowledge(forced.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      query: "traversal-one",
      mode: "keyword",
      limit: 10,
      initiatingSubjectId: "user:alice",
      surface: "agent",
    });
    expect(revokedSearch.results).toEqual([]);
    const revokedSearchJson = JSON.stringify(revokedSearch);
    expect(revokedSearchJson).not.toContain(extraChunks[0]!.id);
    expect(revokedSearchJson).not.toContain("private-traversal");
    expect(revokedSearchJson).not.toContain("traversal-one");

    const stale = await createReadyDocument(workspace, {
      label: "stale-evidence",
      kind: "workspace",
      text: "stalemarker durable architecture",
      sourceUpdatedAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const staleSearch = await searchEffectiveKnowledge(forced.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      query: "stalemarker",
      mode: "keyword",
      limit: 10,
      initiatingSubjectId: "user:alice",
      surface: "agent",
    });
    expect(staleSearch.results).toHaveLength(1);
    expect(staleSearch.results[0]).toMatchObject({
      record: {
        id: `document_chunk:${stale.chunkId}`,
        quality: { trust: "sourced", conflict: "not_evaluated" },
      },
      retrieval: { freshness: "stale", qualityAdjustment: 0 },
    });

    const duplicateA = await createReadyDocument(workspace, {
      label: "duplicate-a",
      kind: "workspace",
      text: "dedupemarker identical sourced fact",
    });
    const duplicateB = await createReadyDocument(workspace, {
      label: "duplicate-b",
      kind: "workspace",
      text: "dedupemarker identical sourced fact",
    });
    await shared!.admin`
      update documents set title = 'Duplicate fact'
      where id in (${duplicateA.documentId}, ${duplicateB.documentId})`;
    const deduped = await searchEffectiveKnowledge(forced.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      query: "dedupemarker",
      mode: "keyword",
      limit: 10,
      initiatingSubjectId: "user:alice",
      surface: "agent",
    });
    expect(deduped.results).toHaveLength(1);
    expect(deduped.results[0]?.retrieval.duplicateCount).toBe(1);
    expect(deduped.selection.omitted.asDuplicate).toBe(1);
    const deterministicKeyword = await searchDocuments(forced.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      query: "dedupemarker",
      mode: "keyword",
      limit: 10,
      access: { agentOnly: true, viewerSubjectId: "user:alice" },
    });
    expect(deterministicKeyword.map((result) => result.chunkId)).toEqual(
      [duplicateA.chunkId, duplicateB.chunkId].sort(),
    );

    const queryVector = [1, ...Array.from({ length: 3_071 }, () => 0)];
    const incidentalVector = [
      0.04,
      Math.sqrt(1 - 0.04 ** 2),
      ...Array.from({ length: 3_070 }, () => 0),
    ];
    const oppositeVector = [-1, ...Array.from({ length: 3_071 }, () => 0)];
    const incidentalVectorSql = `[${incidentalVector.join(",")}]`;
    for (let index = 0; index < 17; index += 1) {
      const distractor = await createReadyDocument(workspace, {
        label: `hybrid-distractor-${index}`,
        kind: "workspace",
        text: `orthogonal evidence ${index}`,
      });
      await shared!.admin`
        update document_chunks set embedding = ${incidentalVectorSql}::vector
        where id = ${distractor.chunkId}`;
    }
    const qualifyingKeyword = await createReadyDocument(workspace, {
      label: "hybrid-keyword",
      kind: "workspace",
      text: "hybridneedle exact lexical evidence",
    });
    await shared!.admin`
      update document_chunks set embedding = ${`[${oppositeVector.join(",")}]`}::vector
      where id = ${qualifyingKeyword.chunkId}`;
    const hybrid = await searchEffectiveKnowledge(
      forced.db,
      {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        query: "hybridneedle",
        mode: "hybrid",
        limit: 1,
        initiatingSubjectId: "user:alice",
        surface: "agent",
      },
      {
        embedder: {
          model: "authority-test",
          dimensions: 3_072,
          embedMany: async () => [],
          embedQuery: async () => queryVector,
        },
      },
    );
    expect(hybrid.results.map((result) => result.record.id)).toEqual([
      `document_chunk:${qualifyingKeyword.chunkId}`,
    ]);
    expect(hybrid.selection.omitted.belowRelevanceFloor).toBe(16);

    for (let index = 0; index < 7; index += 1) {
      await createReadyDocument(workspace, {
        label: `large-${index}`,
        kind: "workspace",
        text: `budgetmarker ${index} ${"å ".repeat(7_000)}`,
      });
    }
    const bounded = await searchEffectiveKnowledge(forced.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      query: "budgetmarker",
      mode: "keyword",
      limit: 20,
      initiatingSubjectId: "user:alice",
      surface: "agent",
    });
    const responseBytes = Buffer.byteLength(JSON.stringify(bounded), "utf8");
    expect(responseBytes).toBeLessThanOrEqual(bounded.selection.budget.maxResponseBytes);
    expect(bounded.selection.budget.responseBytes).toBe(responseBytes);
    expect(bounded.selection.omitted.forResponseBudget).toBeGreaterThan(0);

    const browseBudget = await createReadyDocument(workspace, {
      label: "browse-budget",
      kind: "workspace",
      text: `browse-budget-0 ${"å ".repeat(7_000)}`,
    });
    const browseChunkIds = [browseBudget.chunkId];
    for (let index = 1; index < 7; index += 1) {
      const [chunk] = await shared!.admin<{ id: string }[]>`
        insert into document_chunks (
          account_id, workspace_id, document_id, base_id, file_id, chunk_index,
          text, metadata, embedding, embedding_model
        ) values (
          ${workspace.accountId}, ${workspace.workspaceId}, ${browseBudget.documentId},
          ${browseBudget.baseId}, ${browseBudget.fileId}, ${index},
          ${`browse-budget-${index} ${"å ".repeat(7_000)}`}, '{}'::jsonb,
          ${zeroVector}::vector, 'authority-test'
        ) returning id`;
      browseChunkIds.push(chunk!.id);
    }
    const browseFirstPage = await browseEffectiveKnowledge(forced.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      initiatingSubjectId: "user:alice",
      parentId: `document:${browseBudget.documentId}`,
      limit: 7,
    });
    expect(Buffer.byteLength(JSON.stringify(browseFirstPage), "utf8")).toBeLessThanOrEqual(
      browseFirstPage.selection.budget.maxResponseBytes,
    );
    expect(browseFirstPage.selection.omitted.forResponseBudget).toBeGreaterThan(0);
    expect(browseFirstPage.nextCursor).not.toBeNull();
    const browseSecondPage = await browseEffectiveKnowledge(forced.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      initiatingSubjectId: "user:alice",
      parentId: `document:${browseBudget.documentId}`,
      cursor: browseFirstPage.nextCursor!,
      limit: 7,
    });
    expect(browseSecondPage.records[0]?.id).toBe(
      `document_chunk:${browseChunkIds[browseFirstPage.records.length]}`,
    );
  });
});
