// Inline model delivery of an attachment needs a sha256 that pins its bytes.
// Upload completion records a server-computed digest when the client sent
// none, so a plain REST upload reaches the model exactly like an SDK upload.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  MAX_INLINE_MODEL_ATTACHMENT_BYTES,
  signDelegatedAccessToken,
  type FileAsset,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { bootstrapWorkspace, createDb, type DbClient } from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import { registerFileRoutes } from "../src/routes/files";

const SECRET = "file-upload-digest-test-secret";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("file-upload-completion-digest");
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

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** One stored object; `stored` may differ from the declared bytes to simulate corruption. */
function storageStub(stored: { bytes: Uint8Array; sizeBytes: number; sha256?: string }) {
  const calls = { getFileBytes: 0, deleteObject: 0 };
  const storage = {
    bucket: "digest-test-bucket",
    backend: "s3-compatible",
    maxSinglePutSizeBytes: 5_000_000_000,
    async createPutUrl() {
      return {
        url: "https://storage.example.test/put",
        requiredHeaders: { "content-type": "image/png" },
        expiresAt: new Date(Date.now() + 900_000),
      };
    },
    fileExists: async () => true,
    headFile: async () => ({
      ContentLength: stored.sizeBytes,
      ContentType: "image/png",
      ...(stored.sha256 ? { Metadata: { sha256: stored.sha256 } } : {}),
    }),
    getFileBytes: async () => {
      calls.getFileBytes += 1;
      return stored.bytes;
    },
    deleteObject: async () => {
      calls.deleteObject += 1;
    },
  } as unknown as ObjectStorage;
  return { storage, calls };
}

function routeApp(objectStorage: ObjectStorage): Hono {
  const app = new Hono();
  registerFileRoutes(app, {
    settings: testSettings({ productAccessMode: "managed", delegationSecret: SECRET }),
    db: client.db,
    objectStorage,
    managedAuth: null,
  } as unknown as ApiRouteDeps);
  return app;
}

async function workspaceFixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `digest-account-${suffix}`,
    accountName: "Digest account",
    workspaceExternalSource: "test",
    workspaceExternalId: `digest-workspace-${suffix}`,
    workspaceName: "Digest workspace",
    subjectId: `user:digest-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    workspaceId: grant.workspaceId,
    authorization: `Bearer ${await signDelegatedAccessToken(SECRET, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      permissions: ["files:upload", "files:read"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3_600,
    })}`,
  };
}

async function uploadAndComplete(
  app: Hono,
  workspace: Awaited<ReturnType<typeof workspaceFixture>>,
  body: { sizeBytes: number; sha256?: string },
): Promise<{ status: number; file?: FileAsset }> {
  const created = await app.request(
    `http://x/v1/workspaces/${workspace.workspaceId}/files/uploads`,
    {
      method: "POST",
      headers: { authorization: workspace.authorization, "content-type": "application/json" },
      body: JSON.stringify({ filename: "photo.png", contentType: "image/png", ...body }),
    },
  );
  expect(created.status).toBe(201);
  const { uploadId } = (await created.json()) as { uploadId: string };
  const completed = await app.request(
    `http://x/v1/workspaces/${workspace.workspaceId}/files/uploads/${uploadId}/complete`,
    { method: "POST", headers: { authorization: workspace.authorization } },
  );
  if (completed.status !== 200) return { status: completed.status };
  return { status: 200, file: ((await completed.json()) as { file: FileAsset }).file };
}

describe("upload completion digest", () => {
  const bytes = new TextEncoder().encode("not really a png, but bytes all the same");

  test("an upload without a client digest gets the sha256 of its stored bytes", async () => {
    if (!available) return;
    const { storage, calls } = storageStub({ bytes, sizeBytes: bytes.byteLength });
    const result = await uploadAndComplete(routeApp(storage), await workspaceFixture(), {
      sizeBytes: bytes.byteLength,
    });
    expect(result.status).toBe(200);
    expect(result.file?.status).toBe("ready");
    expect(result.file?.sha256).toBe(sha256(bytes));
    expect(calls.getFileBytes).toBe(1);
  });

  test("a client digest is kept and the stored bytes are not read", async () => {
    if (!available) return;
    const clientDigest = sha256(bytes);
    const { storage, calls } = storageStub({
      bytes,
      sizeBytes: bytes.byteLength,
      sha256: clientDigest,
    });
    const result = await uploadAndComplete(routeApp(storage), await workspaceFixture(), {
      sizeBytes: bytes.byteLength,
      sha256: clientDigest,
    });
    expect(result.status).toBe(200);
    expect(result.file?.sha256).toBe(clientDigest);
    expect(calls.getFileBytes).toBe(0);
  });

  test("a file too large to be inlined is completed without reading its bytes", async () => {
    if (!available) return;
    const sizeBytes = MAX_INLINE_MODEL_ATTACHMENT_BYTES + 1;
    const { storage, calls } = storageStub({ bytes: new Uint8Array(0), sizeBytes });
    const result = await uploadAndComplete(routeApp(storage), await workspaceFixture(), {
      sizeBytes,
    });
    expect(result.status).toBe(200);
    expect(result.file?.sha256 ?? null).toBeNull();
    expect(calls.getFileBytes).toBe(0);
  });

  test("stored bytes that disagree with the declared size reject the upload", async () => {
    if (!available) return;
    const { storage, calls } = storageStub({ bytes, sizeBytes: bytes.byteLength + 1 });
    const result = await uploadAndComplete(routeApp(storage), await workspaceFixture(), {
      sizeBytes: bytes.byteLength + 1,
    });
    expect(result.status).toBe(422);
    expect(calls.deleteObject).toBe(1);
  });
});
