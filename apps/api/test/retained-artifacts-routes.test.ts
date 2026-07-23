import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  RETAINED_OUTPUT_DEFAULT_PAGE_BYTES,
  RETAINED_OUTPUT_MAX_PAGE_BYTES,
  signDelegatedAccessToken,
  type Permission,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  completeFileUpload,
  createDb,
  createFileUpload,
  markFileUploadFailed,
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

const SECRET = "retained-artifacts-route-test-secret";
const explicitDatabaseUrl = process.env.OPENGENI_RETAINED_ARTIFACTS_TEST_DATABASE_URL;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

type StorageCall = { fileId: string; start: number; end: number };

beforeAll(async () => {
  if (explicitDatabaseUrl) {
    client = createDb(explicitDatabaseUrl, { max: 2 });
    return;
  }
  shared = await acquireSharedTestDatabase("retained-artifacts-routes");
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

function storageFixture() {
  const objects = new Map<string, Uint8Array>();
  const calls: StorageCall[] = [];
  const unavailable = async (): Promise<never> => {
    throw new Error("unexpected object-storage operation");
  };
  const storage: ObjectStorage = {
    bucket: "retained-test-bucket",
    backend: "s3-compatible",
    maxSinglePutSizeBytes: 5_000_000_000,
    createPutUrl: unavailable,
    createGetUrl: unavailable,
    headFile: unavailable,
    getFileBytes: unavailable,
    async getFileRange(file, range) {
      calls.push({ fileId: file.id, ...range });
      const bytes = objects.get(file.objectKey);
      return bytes ? bytes.slice(range.start, range.end + 1) : null;
    },
    getObjectBytes: unavailable,
    putObject: unavailable,
    deleteObject: unavailable,
  };
  return { storage, objects, calls };
}

function routeApp(objectStorage: ObjectStorage | null, db = client.db): Hono {
  const app = new Hono();
  registerFileRoutes(app, {
    settings: testSettings({ productAccessMode: "managed", delegationSecret: SECRET }),
    db,
    objectStorage,
    managedAuth: null,
  } as unknown as ApiRouteDeps);
  return app;
}

async function workspaceFixture(permissions: Permission[] = ["files:read"]) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `retained-account-${suffix}`,
    accountName: "Retained artifact test account",
    workspaceExternalSource: "test",
    workspaceExternalId: `retained-workspace-${suffix}`,
    workspaceName: "Retained artifact test workspace",
    subjectId: `retained-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    ...grant,
    authorization: `Bearer ${await signDelegatedAccessToken(SECRET, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      permissions,
      exp: Math.floor(Date.now() / 1000) + 3_600,
    })}`,
  };
}

async function createArtifact(
  workspace: Awaited<ReturnType<typeof workspaceFixture>>,
  input: {
    bytes: Uint8Array;
    expiresAt?: Date;
    sha256?: string | null;
    contentType?: string;
    ready?: boolean;
  },
) {
  const fileId = crypto.randomUUID();
  const objectKey = `workspaces/${workspace.workspaceId}/files/${fileId}/retained.bin`;
  const upload = await createFileUpload(client.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    fileId,
    filename: "retained.bin",
    safeFilename: "retained.bin",
    contentType: input.contentType ?? "application/octet-stream",
    sizeBytes: input.bytes.byteLength,
    sha256: input.sha256 === undefined ? "a".repeat(64) : input.sha256,
    bucket: "retained-test-bucket",
    objectKey,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 60_000),
  });
  if (input.ready !== false) {
    await completeFileUpload(client.db, workspace.workspaceId, upload.uploadId);
  }
  return { fileId, objectKey, uploadId: upload.uploadId };
}

function artifactUrl(workspaceId: string, artifactId: string, content = false): string {
  return `http://x/v1/workspaces/${workspaceId}/artifacts/${artifactId}${content ? "/content" : ""}`;
}

describe("retained artifact metadata and bounded content", () => {
  test("returns provider-neutral metadata and exact/default bounded ranges", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const fixture = storageFixture();
    const bytes = new Uint8Array(3 * 1024 * 1024);
    for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = index % 251;
    const artifact = await createArtifact(workspace, {
      bytes,
      contentType: "Application/JSON; charset=utf-8",
    });
    fixture.objects.set(artifact.objectKey, bytes);
    const app = routeApp(fixture.storage);

    const metadataResponse = await app.request(
      artifactUrl(workspace.workspaceId, artifact.fileId),
      {
        headers: { authorization: workspace.authorization },
      },
    );
    expect(metadataResponse.status).toBe(200);
    const metadata = (await metadataResponse.json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      available: true,
      artifactId: artifact.fileId,
      contentType: "application/json",
      originalBytes: bytes.byteLength,
      sha256: "a".repeat(64),
      retention: { policy: "workspace_file", expiresAt: null },
      retrieval: {
        path: `/v1/workspaces/${workspace.workspaceId}/artifacts/${artifact.fileId}/content`,
        maxRangeBytes: RETAINED_OUTPUT_MAX_PAGE_BYTES,
      },
    });
    expect(JSON.stringify(metadata)).not.toContain("retained-test-bucket");
    expect(JSON.stringify(metadata)).not.toContain(artifact.objectKey);
    expect(JSON.stringify(metadata)).not.toContain("http");
    expect(fixture.calls).toHaveLength(0);

    const exact = await app.request(artifactUrl(workspace.workspaceId, artifact.fileId, true), {
      headers: { authorization: workspace.authorization, range: "bytes=1000-1999" },
    });
    expect(exact.status).toBe(206);
    expect(exact.headers.get("content-range")).toBe(`bytes 1000-1999/${bytes.byteLength}`);
    expect(exact.headers.get("content-length")).toBe("1000");
    expect(exact.headers.get("accept-ranges")).toBe("bytes");
    expect(exact.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await exact.arrayBuffer())).toEqual(bytes.slice(1000, 2000));

    const firstPage = await app.request(artifactUrl(workspace.workspaceId, artifact.fileId, true), {
      headers: { authorization: workspace.authorization },
    });
    expect(firstPage.status).toBe(206);
    expect(firstPage.headers.get("content-length")).toBe(
      String(RETAINED_OUTPUT_DEFAULT_PAGE_BYTES),
    );
    expect(fixture.calls).toEqual([
      { fileId: artifact.fileId, start: 1000, end: 1999 },
      { fileId: artifact.fileId, start: 0, end: RETAINED_OUTPUT_DEFAULT_PAGE_BYTES - 1 },
    ]);
  });

  test("rejects malformed, multipart, oversized, and unsatisfiable ranges before storage", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const fixture = storageFixture();
    const bytes = new Uint8Array(2 * 1024 * 1024);
    const artifact = await createArtifact(workspace, { bytes });
    fixture.objects.set(artifact.objectKey, bytes);
    const app = routeApp(fixture.storage);

    for (const range of [
      "items=0-1",
      "bytes=0-1,4-5",
      `bytes=0-${RETAINED_OUTPUT_MAX_PAGE_BYTES}`,
      "bytes=99999999999999999-",
    ]) {
      const response = await app.request(
        artifactUrl(workspace.workspaceId, artifact.fileId, true),
        { headers: { authorization: workspace.authorization, range } },
      );
      expect(response.status).toBe(400);
    }
    expect(fixture.calls).toHaveLength(0);

    const unsatisfiable = await app.request(
      artifactUrl(workspace.workspaceId, artifact.fileId, true),
      {
        headers: {
          authorization: workspace.authorization,
          range: `bytes=${bytes.byteLength}-`,
        },
      },
    );
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${bytes.byteLength}`);
    expect(fixture.calls).toHaveLength(0);
  });

  test("reports missing, pending, failed, expired, and unsupported evidence explicitly", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const fixture = storageFixture();
    const app = routeApp(fixture.storage);
    const bytes = new Uint8Array(32);

    const missing = await createArtifact(workspace, { bytes });
    const missingResponse = await app.request(
      artifactUrl(workspace.workspaceId, missing.fileId, true),
      { headers: { authorization: workspace.authorization } },
    );
    expect(missingResponse.status).toBe(410);
    expect(await missingResponse.json()).toMatchObject({
      available: false,
      artifactId: missing.fileId,
      reason: "missing_storage",
    });

    const pending = await createArtifact(workspace, { bytes, ready: false });
    const pendingResponse = await app.request(
      artifactUrl(workspace.workspaceId, pending.fileId, true),
      { headers: { authorization: workspace.authorization } },
    );
    expect(pendingResponse.status).toBe(409);
    expect(await pendingResponse.json()).toMatchObject({ reason: "pending" });

    const failed = await createArtifact(workspace, { bytes, ready: false });
    await markFileUploadFailed(
      client.db,
      workspace.workspaceId,
      failed.uploadId,
      failed.fileId,
      "failed",
    );
    const failedResponse = await app.request(
      artifactUrl(workspace.workspaceId, failed.fileId, true),
      { headers: { authorization: workspace.authorization } },
    );
    expect(failedResponse.status).toBe(409);
    expect(await failedResponse.json()).toMatchObject({ reason: "failed" });

    const expired = await createArtifact(workspace, {
      bytes,
      ready: false,
      expiresAt: new Date(Date.now() - 1_000),
    });
    const expiredResponse = await app.request(
      artifactUrl(workspace.workspaceId, expired.fileId, true),
      { headers: { authorization: workspace.authorization } },
    );
    expect(expiredResponse.status).toBe(410);
    expect(await expiredResponse.json()).toMatchObject({ reason: "expired" });

    const unsupported = await createArtifact(workspace, { bytes, sha256: null });
    const unsupportedResponse = await app.request(
      artifactUrl(workspace.workspaceId, unsupported.fileId, true),
      { headers: { authorization: workspace.authorization } },
    );
    expect(unsupportedResponse.status).toBe(422);
    expect(await unsupportedResponse.json()).toMatchObject({ reason: "unsupported" });
    expect(fixture.calls).toEqual([{ fileId: missing.fileId, start: 0, end: 31 }]);
  });

  test("enforces signed grants and app-role FORCE-RLS isolation before storage access", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const other = await workspaceFixture();
    const fixture = storageFixture();
    const bytes = new Uint8Array(64);
    const foreignArtifact = await createArtifact(other, { bytes });
    fixture.objects.set(foreignArtifact.objectKey, bytes);
    const app = routeApp(fixture.storage);

    const crossTenant = await app.request(
      artifactUrl(workspace.workspaceId, foreignArtifact.fileId, true),
      { headers: { authorization: workspace.authorization } },
    );
    expect(crossTenant.status).toBe(404);
    expect(await crossTenant.json()).toMatchObject({ reason: "deleted" });
    expect(fixture.calls).toHaveLength(0);

    const deniedWorkspace = await workspaceFixture(["sessions:read"]);
    let dbTouched = false;
    const poisonedDb = new Proxy(
      {},
      {
        get() {
          dbTouched = true;
          throw new Error("database must not be touched before permission denial");
        },
      },
    );
    const deniedApp = routeApp(fixture.storage, poisonedDb as never);
    const denied = await deniedApp.request(
      artifactUrl(deniedWorkspace.workspaceId, crypto.randomUUID(), true),
      { headers: { authorization: deniedWorkspace.authorization } },
    );
    expect(denied.status).toBe(403);
    expect(dbTouched).toBeFalse();
    expect(fixture.calls).toHaveLength(0);
  });
});
