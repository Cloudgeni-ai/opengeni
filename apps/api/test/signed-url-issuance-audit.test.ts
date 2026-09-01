// Every principal-facing signed object-storage URL issuance is a
// metadata-only audit fact, recorded before the bearer URL leaves the
// platform. The fact carries the subject, target file, and expiry - never the
// signed URL or the object key.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  completeFileUpload,
  createDb,
  createFileUpload,
  type DbClient,
} from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { registerFileRoutes } from "../src/routes/files";

const SECRET = "signed-url-audit-test-secret";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("signed-url-issuance-audit");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const SIGNED_URL = "https://storage.example.test/opaque?signature=do-not-record";

function storageStub(
  onCreateGetUrl?: (args: Parameters<ObjectStorage["createGetUrl"]>[0]) => void,
): ObjectStorage {
  const unavailable = async (): Promise<never> => {
    throw new Error("unexpected object-storage operation");
  };
  return {
    bucket: "signed-url-test-bucket",
    backend: "s3-compatible",
    maxSinglePutSizeBytes: 5_000_000_000,
    async createPutUrl() {
      return {
        url: SIGNED_URL,
        requiredHeaders: { "content-type": "application/octet-stream" },
        expiresAt: new Date(Date.now() + 900_000),
      };
    },
    async createGetUrl(args) {
      onCreateGetUrl?.(args);
      return { url: SIGNED_URL, expiresAt: new Date(Date.now() + 300_000) };
    },
    headFile: unavailable,
    fileExists: async () => true,
    getFileBytes: unavailable,
    getFileRange: unavailable,
    getObjectBytes: unavailable,
    putObject: unavailable,
    deleteObject: unavailable,
  } as unknown as ObjectStorage;
}

function routeApp(objectStorage: ObjectStorage = storageStub()): Hono {
  const app = new Hono();
  registerFileRoutes(app, {
    settings: testSettings({ productAccessMode: "managed", delegationSecret: SECRET }),
    db: client.db,
    objectStorage,
    managedAuth: null,
  } as unknown as ApiRouteDeps);
  return app;
}

async function workspaceFixture(permissions: Permission[]) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `signed-url-account-${suffix}`,
    accountName: "Signed URL audit account",
    workspaceExternalSource: "test",
    workspaceExternalId: `signed-url-workspace-${suffix}`,
    workspaceName: "Signed URL audit workspace",
    subjectId: `user:signed-url-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    ...grant,
    authorization: `Bearer ${await signDelegatedAccessToken(SECRET, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      permissions,
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3_600,
    })}`,
  };
}

async function readyFile(workspace: Awaited<ReturnType<typeof workspaceFixture>>) {
  const fileId = crypto.randomUUID();
  const objectKey = `workspaces/${workspace.workspaceId}/files/${fileId}/original/data.bin`;
  const upload = await createFileUpload(client.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    fileId,
    filename: "data.bin",
    safeFilename: "data.bin",
    contentType: "application/octet-stream",
    sizeBytes: 12,
    sha256: "a".repeat(64),
    bucket: "signed-url-test-bucket",
    objectKey,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await completeFileUpload(client.db, workspace.workspaceId, upload.uploadId);
  return { fileId, objectKey };
}

describe("signed-URL issuance audit facts", () => {
  test("download-url records file.signed_url.issued for the exact subject before returning the URL", async () => {
    if (!available) return;
    const workspace = await workspaceFixture(["files:read"]);
    const { fileId, objectKey } = await readyFile(workspace);
    const app = routeApp();

    const response = await app.request(
      `http://x/v1/workspaces/${workspace.workspaceId}/files/${fileId}/download-url`,
      { method: "POST", headers: { authorization: workspace.authorization } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string; expiresAt: string };
    expect(body.url).toBe(SIGNED_URL);

    const [audit] = await shared!.admin<
      Array<{ subject_id: string; target_id: string; metadata: Record<string, unknown> }>
    >`
      select subject_id, target_id, metadata from audit_events
      where workspace_id = ${workspace.workspaceId}
        and action = 'file.signed_url.issued'
      order by occurred_at desc limit 1`;
    expect(audit).toBeDefined();
    expect(audit!.subject_id).toBe(workspace.subjectId);
    expect(audit!.target_id).toBe(fileId);
    expect(audit!.metadata).toMatchObject({
      fileId,
      kind: "download",
      expiresAt: body.expiresAt,
    });
    // The fact is metadata only: never the bearer URL, never the object key.
    const serialized = JSON.stringify(audit!.metadata);
    expect(serialized).not.toContain("signature=do-not-record");
    expect(serialized).not.toContain(objectKey);
  });

  test("attachment download URLs use the durable server filename in the signed response", async () => {
    if (!available) return;
    const workspace = await workspaceFixture(["files:read"]);
    const { fileId, objectKey } = await readyFile(workspace);
    const createGetUrlCalls: Array<Parameters<ObjectStorage["createGetUrl"]>[0]> = [];
    const app = routeApp(storageStub((args) => createGetUrlCalls.push(args)));

    const response = await app.request(
      `http://x/v1/workspaces/${workspace.workspaceId}/files/${fileId}/download-url?disposition=attachment`,
      { method: "POST", headers: { authorization: workspace.authorization } },
    );

    expect(response.status).toBe(200);
    expect(createGetUrlCalls).toEqual([
      {
        key: objectKey,
        contentDisposition: 'attachment; filename="data.bin"',
      },
    ]);

    const [audit] = await shared!.admin<Array<{ metadata: Record<string, unknown> }>>`
      select metadata from audit_events
      where workspace_id = ${workspace.workspaceId}
        and action = 'file.signed_url.issued'
      order by occurred_at desc limit 1`;
    expect(audit?.metadata).toMatchObject({
      fileId,
      kind: "download",
      disposition: "attachment",
    });
  });

  test("download-url rejects unsupported dispositions before signing or auditing", async () => {
    if (!available) return;
    const workspace = await workspaceFixture(["files:read"]);
    const { fileId } = await readyFile(workspace);
    const createGetUrlCalls: Array<Parameters<ObjectStorage["createGetUrl"]>[0]> = [];
    const app = routeApp(storageStub((args) => createGetUrlCalls.push(args)));

    const response = await app.request(
      `http://x/v1/workspaces/${workspace.workspaceId}/files/${fileId}/download-url?disposition=download`,
      { method: "POST", headers: { authorization: workspace.authorization } },
    );

    expect(response.status).toBe(400);
    expect(createGetUrlCalls).toEqual([]);
    const [audit] = await shared!.admin<Array<{ present: number }>>`
      select 1 as present from audit_events
      where workspace_id = ${workspace.workspaceId}
        and action = 'file.signed_url.issued'
      limit 1`;
    expect(audit).toBeUndefined();
  });

  test("an upload mint records file.signed_upload.issued (size + type, never key/URL)", async () => {
    if (!available) return;
    const workspace = await workspaceFixture(["files:upload"]);
    const app = routeApp();

    const response = await app.request(
      `http://x/v1/workspaces/${workspace.workspaceId}/files/uploads`,
      {
        method: "POST",
        headers: { authorization: workspace.authorization, "content-type": "application/json" },
        body: JSON.stringify({
          filename: "notes.txt",
          contentType: "text/plain",
          sizeBytes: 42,
        }),
      },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { fileId: string };

    const [audit] = await shared!.admin<
      Array<{ subject_id: string; target_id: string; metadata: Record<string, unknown> }>
    >`
      select subject_id, target_id, metadata from audit_events
      where workspace_id = ${workspace.workspaceId}
        and action = 'file.signed_upload.issued'
      order by occurred_at desc limit 1`;
    expect(audit).toBeDefined();
    expect(audit!.subject_id).toBe(workspace.subjectId);
    expect(audit!.target_id).toBe(body.fileId);
    expect(audit!.metadata).toMatchObject({
      fileId: body.fileId,
      contentType: "text/plain",
      sizeBytes: 42,
    });
    const serialized = JSON.stringify(audit!.metadata);
    expect(serialized).not.toContain("signature=do-not-record");
    expect(serialized).not.toContain("/original/");
  });
});
