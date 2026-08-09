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
  claimSessionWorkForAttempt,
  completeFileUpload,
  createDb,
  createFileUpload,
  createSession,
  initializeSessionStartAtomically,
  markFileUploadFailed,
  prepareGeneratedImageArtifact,
  prepareRetainedScreenshotArtifact,
  settleGeneratedImageArtifactReady,
  settleRetainedScreenshotArtifactReady,
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
  const existenceCalls: string[] = [];
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
    async fileExists(file) {
      existenceCalls.push(file.id);
      return objects.has(file.objectKey);
    },
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
  return { storage, objects, calls, existenceCalls };
}

function routeApp(objectStorage: ObjectStorage | null, db = client.db): Hono {
  const app = new Hono();
  registerFileRoutes(app, {
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: SECRET,
    }),
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
      principalKind: "human_session",
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

function sessionArtifactUrl(
  workspaceId: string,
  sessionId: string,
  artifactId: string,
  content = false,
): string {
  return `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/artifacts/${artifactId}${content ? "/content" : ""}`;
}

async function createScreenshotArtifact(
  workspace: Awaited<ReturnType<typeof workspaceFixture>>,
  input: { bytes: Uint8Array; expiresAt?: Date; ready?: boolean },
) {
  const session = await createSession(client.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    initialMessage: "retain this screenshot",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, workspace.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `retained-artifact-api-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") {
    throw new Error(`Could not claim retained screenshot API fixture: ${claim.reason}`);
  }

  const artifactId = crypto.randomUUID();
  const settlementKey = `api:${crypto.randomUUID()}`;
  const objectKey = `workspaces/${workspace.workspaceId}/files/${artifactId}/retained/computer-screenshot.png`;
  await prepareRetainedScreenshotArtifact(client.db, {
    artifactId,
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    sessionId: session.id,
    turnId: claim.turn.id,
    attemptId,
    settlementKey,
    toolCallId: `call-${artifactId}`,
    toolOutputId: `output-${artifactId}`,
    mediaType: "image/png",
    sizeBytes: input.bytes.byteLength,
    sha256: "b".repeat(64),
    width: 1,
    height: 1,
    retentionExpiresAt: input.expiresAt ?? new Date(Date.now() + 60_000),
    bucket: "retained-test-bucket",
    objectKey,
    workspaceQuotaBytes: 100 * 1024 * 1024,
  });
  if (input.ready !== false) {
    await settleRetainedScreenshotArtifactReady(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      artifactId,
      settlementKey,
    });
  }
  return { sessionId: session.id, artifactId, objectKey };
}

async function createGeneratedImageArtifact(
  workspace: Awaited<ReturnType<typeof workspaceFixture>>,
  input: { bytes: Uint8Array; ready?: boolean },
) {
  const session = await createSession(client.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    initialMessage: "generate an image",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, workspace.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `generated-image-api-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") {
    throw new Error(`Could not claim generated image API fixture: ${claim.reason}`);
  }

  const artifactId = crypto.randomUUID();
  const uploadId = crypto.randomUUID();
  const settlementKey = crypto.randomUUID().replaceAll("-", "").repeat(2);
  const filename = `generated-image-${artifactId}.png`;
  const objectKey = `workspaces/${workspace.workspaceId}/files/${artifactId}/generated/${filename}`;
  await prepareGeneratedImageArtifact(client.db, {
    artifactId,
    uploadId,
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    sessionId: session.id,
    turnId: claim.turn.id,
    attemptId,
    settlementKey,
    toolCallId: `call-${artifactId}`,
    sourceStrategy: "provider_adapter",
    providerId: "test-image-provider",
    providerBindingHash: "b".repeat(64),
    providerItemId: null,
    mediaType: "image/png",
    sizeBytes: input.bytes.byteLength,
    sha256: "c".repeat(64),
    width: 1,
    height: 1,
    sandboxPath: `/workspace/generated-images/${filename}`,
    filename,
    safeFilename: filename,
    bucket: "retained-test-bucket",
    objectKey,
    uploadExpiresAt: new Date(Date.now() + 60_000),
  });
  if (input.ready !== false) {
    await completeFileUpload(client.db, workspace.workspaceId, uploadId);
    await settleGeneratedImageArtifactReady(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      artifactId,
      settlementKey,
    });
  }
  return { artifactId, objectKey };
}

describe("retained artifact metadata and bounded content", () => {
  test("serves generated images as permanent provider-neutral workspace artifacts", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const fixture = storageFixture();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const generated = await createGeneratedImageArtifact(workspace, { bytes });
    fixture.objects.set(generated.objectKey, bytes);
    const app = routeApp(fixture.storage);

    const metadataResponse = await app.request(
      artifactUrl(workspace.workspaceId, generated.artifactId),
      { headers: { authorization: workspace.authorization } },
    );
    expect(metadataResponse.status).toBe(200);
    expect(await metadataResponse.json()).toMatchObject({
      available: true,
      artifactId: generated.artifactId,
      kind: "generated_image",
      contentType: "image/png",
      originalBytes: bytes.byteLength,
      sha256: "c".repeat(64),
      dimensions: { width: 1, height: 1 },
      retention: { policy: "workspace_file", expiresAt: null },
      retrieval: {
        path: `/v1/workspaces/${workspace.workspaceId}/artifacts/${generated.artifactId}/content`,
      },
    });

    const content = await app.request(
      artifactUrl(workspace.workspaceId, generated.artifactId, true),
      {
        headers: {
          authorization: workspace.authorization,
          range: "bytes=1-2",
        },
      },
    );
    expect(content.status).toBe(206);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes.slice(1, 3));
  });

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
      headers: {
        authorization: workspace.authorization,
        range: "bytes=1000-1999",
      },
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
      {
        fileId: artifact.fileId,
        start: 0,
        end: RETAINED_OUTPUT_DEFAULT_PAGE_BYTES - 1,
      },
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

  test("verifies provider existence for present and missing zero-byte evidence", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const fixture = storageFixture();
    const empty = await createArtifact(workspace, { bytes: new Uint8Array(0) });
    fixture.objects.set(empty.objectKey, new Uint8Array(0));
    const app = routeApp(fixture.storage);

    const present = await app.request(artifactUrl(workspace.workspaceId, empty.fileId, true), {
      headers: { authorization: workspace.authorization },
    });
    expect(present.status).toBe(200);
    expect(present.headers.get("content-length")).toBe("0");
    expect(present.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await present.arrayBuffer())).toHaveLength(0);

    const missing = await createArtifact(workspace, {
      bytes: new Uint8Array(0),
    });
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
    expect(fixture.existenceCalls).toEqual([empty.fileId, missing.fileId]);
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

    const unsupported = await createArtifact(workspace, {
      bytes,
      sha256: null,
    });
    const unsupportedResponse = await app.request(
      artifactUrl(workspace.workspaceId, unsupported.fileId, true),
      { headers: { authorization: workspace.authorization } },
    );
    expect(unsupportedResponse.status).toBe(422);
    expect(await unsupportedResponse.json()).toMatchObject({
      reason: "unsupported",
    });
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

  test("serves session-qualified screenshots with bounded ranges and no storage leakage", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const fixture = storageFixture();
    const bytes = new Uint8Array(2 * 1024 * 1024);
    for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = index % 239;
    const artifact = await createScreenshotArtifact(workspace, { bytes });
    fixture.objects.set(artifact.objectKey, bytes);
    const app = routeApp(fixture.storage);

    const metadataResponse = await app.request(
      sessionArtifactUrl(workspace.workspaceId, artifact.sessionId, artifact.artifactId),
      { headers: { authorization: workspace.authorization } },
    );
    expect(metadataResponse.status).toBe(200);
    const metadata = (await metadataResponse.json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      available: true,
      artifactId: artifact.artifactId,
      kind: "computer_screenshot",
      contentType: "image/png",
      originalBytes: bytes.byteLength,
      sha256: "b".repeat(64),
      dimensions: { width: 1, height: 1 },
      retention: { policy: "session_screenshot" },
      retrieval: {
        path: `/v1/workspaces/${workspace.workspaceId}/sessions/${artifact.sessionId}/artifacts/${artifact.artifactId}/content`,
        maxRangeBytes: RETAINED_OUTPUT_MAX_PAGE_BYTES,
      },
    });
    expect(JSON.stringify(metadata)).not.toContain("retained-test-bucket");
    expect(JSON.stringify(metadata)).not.toContain(artifact.objectKey);

    const range = await app.request(
      sessionArtifactUrl(workspace.workspaceId, artifact.sessionId, artifact.artifactId, true),
      {
        headers: {
          authorization: workspace.authorization,
          range: "bytes=1048576-1572863",
        },
      },
    );
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(`bytes 1048576-1572863/${bytes.byteLength}`);
    expect(range.headers.get("content-length")).toBe("524288");
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(bytes.slice(1_048_576, 1_572_864));
    expect(fixture.calls).toEqual([
      { fileId: artifact.artifactId, start: 1_048_576, end: 1_572_863 },
    ]);
  });

  test("session screenshot lookups deny wrong-session and cross-workspace IDs before storage", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const other = await workspaceFixture();
    const fixture = storageFixture();
    const bytes = new Uint8Array(64);
    const local = await createScreenshotArtifact(workspace, { bytes });
    const foreign = await createScreenshotArtifact(other, { bytes });
    fixture.objects.set(local.objectKey, bytes);
    fixture.objects.set(foreign.objectKey, bytes);
    const app = routeApp(fixture.storage);

    const wrongSession = await app.request(
      sessionArtifactUrl(workspace.workspaceId, crypto.randomUUID(), local.artifactId, true),
      { headers: { authorization: workspace.authorization } },
    );
    expect(wrongSession.status).toBe(404);
    expect(await wrongSession.json()).toMatchObject({ reason: "deleted" });

    const crossWorkspace = await app.request(
      sessionArtifactUrl(workspace.workspaceId, foreign.sessionId, foreign.artifactId, true),
      { headers: { authorization: workspace.authorization } },
    );
    expect(crossWorkspace.status).toBe(404);
    expect(await crossWorkspace.json()).toMatchObject({ reason: "deleted" });
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.existenceCalls).toHaveLength(0);
  });

  test("session screenshot content reports pending and expired evidence without provider access", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const fixture = storageFixture();
    const bytes = new Uint8Array(64);
    const pending = await createScreenshotArtifact(workspace, {
      bytes,
      ready: false,
    });
    const expired = await createScreenshotArtifact(workspace, {
      bytes,
      expiresAt: new Date(Date.now() - 1_000),
    });
    fixture.objects.set(expired.objectKey, bytes);
    const app = routeApp(fixture.storage);

    const pendingResponse = await app.request(
      sessionArtifactUrl(workspace.workspaceId, pending.sessionId, pending.artifactId, true),
      { headers: { authorization: workspace.authorization } },
    );
    expect(pendingResponse.status).toBe(409);
    expect(await pendingResponse.json()).toMatchObject({ reason: "pending" });

    const expiredResponse = await app.request(
      sessionArtifactUrl(workspace.workspaceId, expired.sessionId, expired.artifactId, true),
      { headers: { authorization: workspace.authorization } },
    );
    expect(expiredResponse.status).toBe(410);
    expect(await expiredResponse.json()).toMatchObject({ reason: "expired" });
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.existenceCalls).toHaveLength(0);
  });
});
