import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  browserDeadlineCheckpoint,
  createDb,
  getBrowserPrivateCheckpointAuthority,
  migrate,
} from "@opengeni/db";
import { BROWSER_PROFILE_ARTIFACT_FORMAT } from "@opengeni/contracts";
import {
  acquireOwnerMigratedTestDatabase,
  testSettings,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import {
  BrowserControlRequestError,
  type BrowserControlClient,
  type CapturePlacementBrowserStateInput,
  type PlacementBrowserStateCaptureReceipt,
} from "@opengeni/runtime";
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

function activities(controller: Pick<BrowserControlClient, "captureState" | "endSession">) {
  const settings = testSettings({
    sandboxOwnershipEnabled: true,
    environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
  });
  const storage = {
    createPutUrl: async () => ({
      url: "https://storage.example.test/checkpoint",
      requiredHeaders: {},
      expiresAt: new Date(Date.now() + 60_000),
    }),
  } as ObjectStorage;
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
