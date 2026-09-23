import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  claimExpiredFileUploadCleanup,
  completeExpiredFileUploadCleanup,
  createDb,
  createFileUpload,
  getFile,
  withSessionRlsActorContext,
} from "../src";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const database = await acquireSharedTestDatabase("private-upload-cleanup");
  if (!database) throw new Error("Private upload cleanup requires PostgreSQL");
  shared = database;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

test.each([false, true])(
  "expiry cleanup settles the file and preserves ownership (private=%s)",
  async (personal) => {
    const id = crypto.randomUUID();
    const subjectId = `user:${id}`;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: id,
      accountName: "Upload cleanup",
      workspaceExternalSource: "test",
      workspaceExternalId: id,
      workspaceName: "Workspace",
      subjectId,
    });
    const grant = access.workspaceGrants[0]!;
    const owner = { subjectId, privateFileOwnerSubjectId: personal ? subjectId : null };
    const uploaded = await withSessionRlsActorContext(owner, () =>
      createFileUpload(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        fileId: id,
        privateOwnerSubjectId: personal ? subjectId : null,
        filename: "expired.pdf",
        safeFilename: "expired.pdf",
        contentType: "application/pdf",
        sizeBytes: 100,
        bucket: "test",
        objectKey: `uploads/${id}`,
        expiresAt: new Date(Date.now() - 3_600_000),
      }),
    );
    const claims = await claimExpiredFileUploadCleanup(client.db, {
      graceMs: 0,
      claimTimeoutMs: 60_000,
      limit: 100,
    });
    const claim = claims.find((item) => item.uploadId === uploaded.uploadId);
    if (!claim) throw new Error("Expected expiry cleanup claim");
    await expect(
      Promise.resolve(
        shared.admin`UPDATE file_uploads SET private_file_owner_subject_id='user:other' WHERE id=${claim.uploadId}`,
      ),
    ).rejects.toMatchObject({ code: "55000" });
    expect(
      await completeExpiredFileUploadCleanup(client.db, { ...claim, fileId: crypto.randomUUID() }),
    ).toBe(false);
    // A maintenance worker has no original user's ambient context.
    expect(await completeExpiredFileUploadCleanup(client.db, claim)).toBe(true);
    expect(await completeExpiredFileUploadCleanup(client.db, claim)).toBe(true);
    expect(
      await withSessionRlsActorContext(owner, () => getFile(client.db, grant.workspaceId, id)),
    ).toMatchObject({ status: "failed" });
    if (personal) expect(await getFile(client.db, grant.workspaceId, id)).toBeNull();
  },
);
