// The text a model is shown for a document attachment is stored once per file:
// the first stored extraction wins, so every request renders the same bytes.
// Rows stay inside their account and go with their file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  createDb,
  getFileModelTexts,
  recordFileModelText,
  type DbClient,
  type FileModelText,
} from "../src/index";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("file-model-texts");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fileFixture(): Promise<{ accountId: string; fileId: string }> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `model-text-account-${suffix}`,
    accountName: "Model text account",
    workspaceExternalSource: "test",
    workspaceExternalId: `model-text-workspace-${suffix}`,
    workspaceName: "Model text workspace",
    subjectId: `user:model-text-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const [file] = await shared!.admin<{ id: string }[]>`
    insert into files (account_id, workspace_id, status, filename, safe_filename, content_type,
      size_bytes, sha256, bucket, object_key)
    values (${grant.accountId}, ${grant.workspaceId}, 'ready', 'report.pdf', 'report.pdf',
      'application/pdf', 10, ${"a".repeat(64)}, 'bucket', ${`workspaces/${grant.workspaceId}/${suffix}`})
    returning id`;
  return { accountId: grant.accountId, fileId: file!.id };
}

const extraction = (fileId: string, text: string): FileModelText => ({
  fileId,
  extractor: "anydoc@0.1.8",
  status: "extracted",
  format: "markdown",
  text,
  totalChars: text.length,
});

describe("file model texts", () => {
  test("concurrent writers converge on the first stored extraction", async () => {
    if (!available) return;
    const { accountId, fileId } = await fileFixture();
    const results = await Promise.all(
      ["first", "second", "third"].map((text) =>
        recordFileModelText(client.db, { accountId, ...extraction(fileId, text) }),
      ),
    );
    expect(new Set(results.map((result) => result.text)).size).toBe(1);
    const later = await recordFileModelText(client.db, {
      accountId,
      ...extraction(fileId, "a later extractor"),
    });
    expect(later).toEqual(results[0]!);
    expect(await getFileModelTexts(client.db, { accountId, fileIds: [fileId, fileId] })).toEqual([
      results[0]!,
    ]);
  });

  test("a failure is stored as final, and stored text never carries a failure", async () => {
    if (!available) return;
    const { accountId, fileId } = await fileFixture();
    const failed = await recordFileModelText(client.db, {
      accountId,
      fileId,
      extractor: "anydoc@0.1.8",
      status: "encrypted",
      format: "markdown",
      text: "",
      totalChars: 0,
    });
    expect(failed.status).toBe("encrypted");
    expect(
      (await recordFileModelText(client.db, { accountId, ...extraction(fileId, "x") })).status,
    ).toBe("encrypted");
    const other = await fileFixture();
    await expect(
      recordFileModelText(client.db, {
        accountId: other.accountId,
        fileId: other.fileId,
        extractor: "anydoc@0.1.8",
        status: "failed",
        format: "markdown",
        text: "leftover",
        totalChars: 8,
      }),
    ).rejects.toThrow();
  });

  test("another account cannot read a file's text, and the text goes with its file", async () => {
    if (!available) return;
    const owner = await fileFixture();
    const stranger = await fileFixture();
    await recordFileModelText(client.db, {
      accountId: owner.accountId,
      ...extraction(owner.fileId, "private"),
    });
    expect(
      await getFileModelTexts(client.db, {
        accountId: stranger.accountId,
        fileIds: [owner.fileId],
      }),
    ).toEqual([]);
    const [visibleToApp] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from file_model_texts where file_id = ${owner.fileId}`;
    expect(visibleToApp!.count).toBe(1);
    await shared!.admin`delete from files where id = ${owner.fileId}`;
    const [afterDelete] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from file_model_texts where file_id = ${owner.fileId}`;
    expect(afterDelete!.count).toBe(0);
  });
});
