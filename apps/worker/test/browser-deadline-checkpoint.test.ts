import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  browserDeadlineCheckpoint,
  createDb,
  createSession,
  getBrowserPrivateCheckpointAuthority,
  listRetainedBrowserDownloads,
  migrate,
} from "@opengeni/db";
import { BROWSER_PROFILE_ARTIFACT_FORMAT } from "@opengeni/contracts";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import {
  BrowserControlRequestError,
  type BrowserControlClient,
  type CapturePlacementBrowserStateInput,
  type PlacementBrowserStateCaptureReceipt,
} from "@opengeni/runtime";
import type { RetainedDownloadSource } from "@opengeni/core";
import type { ObjectStorage } from "@opengeni/storage";
import { seedBrowserDeadlineCheckpoint } from "../../../test/fixtures/browser-deadline-checkpoint";
import { createBrowserDeadlineCheckpointActivities } from "../src/activities/browser-deadline-checkpoint";
import type { ControlActivityServices } from "../src/activities/types";

let owned: OwnerMigratedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const database = await acquireOwnerMigratedTestDatabase("browser-deadline-worker");
  if (!database) throw new Error("real database required for browser checkpoint recovery");
  owned = database;
  await migrate(owned.ownerUrl);
  client = createDb(owned.ownerUrl, { max: 3 });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await owned?.release();
}, 120_000);

function receipt(input: CapturePlacementBrowserStateInput): PlacementBrowserStateCaptureReceipt {
  return {
    browserSessionId: input.browserSessionId,
    controllerGeneration: input.controllerGeneration,
    operationId: input.operationId,
    objectKey: input.objectKey,
    format: BROWSER_PROFILE_ARTIFACT_FORMAT,
    artifactDigest: "a".repeat(64),
    contentDigest: "b".repeat(64),
    sizeBytes: 4096,
    fileCount: 1,
    profileBytes: 2048,
    manifest: {
      schemaVersion: 1,
      browserSessionId: input.browserSessionId,
      controllerGeneration: input.controllerGeneration,
      capturedAt: new Date().toISOString(),
      engine: "chromium",
      engineVersion: "151.0.7922.108",
      driverId: "opengeni.cdp.v1",
      driverSchemaVersion: 1,
      profileCrypto: "chromium_basic",
      platform: "linux",
      architecture: "x64",
      tabs: [{ url: "https://example.test/", selected: true }],
    },
  };
}

function activities(
  controller: Pick<BrowserControlClient, "captureState" | "endSession"> & {
    downloads?: (tokens: { controlToken: string; viewToken: string }) => RetainedDownloadSource;
  },
  objects: Map<string, { size: number; sha256: string }> = new Map(),
) {
  const settings = testSettings({
    sandboxOwnershipEnabled: true,
    environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
  });
  const storage = {
    bucket: "test-files",
    maxSinglePutSizeBytes: 5 * 1024 ** 3,
    createPutUrl: async ({ key }: { key: string }) => ({
      url: `https://storage.example.test/${key}`,
      requiredHeaders: {},
      expiresAt: new Date(Date.now() + 60_000),
    }),
    fileExists: async (file: { objectKey: string }) => objects.has(file.objectKey),
    headFile: async (file: { objectKey: string }) => {
      const object = objects.get(file.objectKey)!;
      return {
        ContentLength: object.size,
        ContentType: "application/octet-stream",
        Metadata: { sha256: object.sha256 },
      };
    },
  } as unknown as ObjectStorage;
  return createBrowserDeadlineCheckpointActivities(
    async () => ({ settings, db: client.db, objectStorage: storage }) as ControlActivityServices,
    async ({ target, lease }) => {
      expect(lease.instanceId).toBe(target.instanceId);
      expect(lease.leaseEpoch).toBe(target.leaseEpoch);
      return controller;
    },
  );
}

test("cleanup failure reuses the committed encrypted artifact without capturing twice", async () => {
  const target = await seedBrowserDeadlineCheckpoint(owned);
  let captures = 0;
  let cleanups = 0;
  let key: Uint8Array | undefined;
  const worker = activities({
    captureState: async (input) => {
      captures++;
      key = input.dataKey;
      expect(input.afterCapture).toBe("stop");
      expect(key.byteLength).toBe(32);
      expect(key.some((byte) => byte !== 0)).toBe(true);
      return receipt(input);
    },
    endSession: async () => {
      cleanups++;
      if (cleanups === 1) throw new Error("synthetic cleanup transport failure");
    },
  });
  await expect(worker.checkpointBrowserBeforeDeadline(target)).rejects.toThrow("synthetic cleanup");
  expect(key?.every((byte) => byte === 0)).toBe(true);
  expect((await browserDeadlineCheckpoint(client.db, target))?.state).toBe("completed");
  const saved = await getBrowserPrivateCheckpointAuthority(client.db, target);
  expect(saved).not.toBeNull();
  expect(await worker.checkpointBrowserBeforeDeadline(target)).toEqual({ status: "suspended" });
  expect(captures).toBe(1);
  expect(cleanups).toBe(2);
  expect(await getBrowserPrivateCheckpointAuthority(client.db, target)).toEqual(saved);
  const [state] =
    await owned.admin`select lifecycle, controller_id from browser_sessions where id = ${target.browserSessionId}`;
  expect(state).toEqual({ lifecycle: "suspended", controller_id: null });
  const [holders] =
    await owned.admin`select count(*)::int as count from sandbox_lease_holders where lease_id = ${target.leaseId}`;
  expect(holders?.count).toBe(0);
});

test("transport retry retains one capture operation and encryption authority", async () => {
  const target = await seedBrowserDeadlineCheckpoint(owned);
  const operations: Array<{ id: string; key: string; dataKey: string }> = [];
  const worker = activities({
    captureState: async (input) => {
      operations.push({
        id: input.operationId,
        key: input.objectKey,
        dataKey: Buffer.from(input.dataKey).toString("hex"),
      });
      if (operations.length === 1) throw new Error("synthetic capture transport failure");
      return receipt(input);
    },
    endSession: async () => undefined,
  });
  await expect(worker.checkpointBrowserBeforeDeadline(target)).rejects.toThrow("synthetic capture");
  expect(await worker.checkpointBrowserBeforeDeadline(target)).toEqual({ status: "suspended" });
  expect(operations).toHaveLength(2);
  expect(operations[1]).toEqual(operations[0]);
});

test("unknown controller outcome is terminal and cannot recapture on activity retry", async () => {
  const target = await seedBrowserDeadlineCheckpoint(owned);
  let captures = 0;
  let cleanups = 0;
  const worker = activities({
    captureState: async () => {
      captures++;
      throw new BrowserControlRequestError(409, {
        code: "outcome_unknown",
        message: "synthetic unknown capture",
        retryable: false,
      });
    },
    endSession: async () => {
      cleanups++;
    },
  });
  await expect(worker.checkpointBrowserBeforeDeadline(target)).rejects.toThrow("synthetic unknown");
  expect(await worker.checkpointBrowserBeforeDeadline(target)).toEqual({ status: "skipped" });
  expect(captures).toBe(1);
  expect(cleanups).toBe(0);
  expect(await getBrowserPrivateCheckpointAuthority(client.db, target)).toBeNull();
});

test("lease replacement during capture cannot publish or remove the only source profile", async () => {
  const target = await seedBrowserDeadlineCheckpoint(owned);
  let cleanups = 0;
  const worker = activities({
    captureState: async (input) => {
      await owned.admin`update sandbox_leases set lease_epoch = 2 where id = ${target.leaseId}`;
      return receipt(input);
    },
    endSession: async () => {
      cleanups++;
    },
  });
  await expect(worker.checkpointBrowserBeforeDeadline(target)).rejects.toThrow("authority changed");
  expect(await getBrowserPrivateCheckpointAuthority(client.db, target)).toBeNull();
  expect(cleanups).toBe(0);
});

test("a completed download is kept as a workspace file before the browser is saved", async () => {
  const target = await seedBrowserDeadlineCheckpoint(owned);
  // Every real browser was created by a session; retention reads that record.
  const source = await createSession(client.db, {
    accountId: target.accountId,
    workspaceId: target.workspaceId,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  await owned.admin`insert into browser_session_associations (
    account_id, workspace_id, browser_session_id, session_id, relationship, actor_subject_id
  ) values (${target.accountId}, ${target.workspaceId}, ${target.browserSessionId},
    ${source.id}, 'created', 'fixture-human')`;
  const objects = new Map<string, { size: number; sha256: string }>();
  const order: string[] = [];
  const download = {
    id: crypto.randomUUID(),
    browserSessionId: target.browserSessionId,
    controllerGeneration: target.controllerGeneration,
    targetId: "target-1",
    filename: "report.pdf",
    status: "completed" as const,
    receivedBytes: 42,
    totalBytes: 42,
    sha256: "c".repeat(64),
    version: 2,
    startedAt: "2026-10-17T10:00:00.000Z",
    settledAt: "2026-10-17T10:00:01.000Z",
    failureCode: null,
  };
  const worker = activities(
    {
      captureState: async (input) => {
        order.push("capture");
        return receipt(input);
      },
      endSession: async () => {
        order.push("end");
      },
      downloads: (tokens) => {
        expect(tokens.controlToken.length).toBeGreaterThan(0);
        return {
          listDownloads: async () => ({
            browserSessionId: target.browserSessionId,
            controllerGeneration: target.controllerGeneration,
            downloads: [download, { ...download, id: crypto.randomUUID(), status: "failed" }],
          }),
          exportDownload: async (downloadId, request) => {
            expect(downloadId).toBe(download.id);
            order.push("export");
            const key = new URL(request.upload.url).pathname.slice(1);
            objects.set(key, { size: download.receivedBytes, sha256: download.sha256 });
            return { sizeBytes: download.receivedBytes, sha256: download.sha256 };
          },
        };
      },
    },
    objects,
  );
  expect(await worker.checkpointBrowserBeforeDeadline(target)).toEqual({ status: "suspended" });
  expect(order).toEqual(["export", "capture", "end"]);
  const kept = await listRetainedBrowserDownloads(client.db, target);
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatchObject({ download: { id: download.id }, safeFilename: "report.pdf" });
});
