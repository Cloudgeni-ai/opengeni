// Regression: a zero-holder drain started one more full workspace capture on
// every retry while earlier captures of the same box were still running. The
// drain wait gives up at the snapshot budget, but the capture keeps reading and
// spooling the whole workspace so it can still publish late. A parallel-read
// provider (Docker) let each retry replace that claim at once and start another
// full read, so a capture slower than the retry interval multiplied. On a
// benchmark host, 7-8 GB workspaces accumulated about 140 GB of concurrent
// spools for a handful of idle boxes.
//
// Everything runs the real drain activity against PostgreSQL. The Docker group
// keeps the real claim, host-backed spool capture, publication and teardown
// ordering; only the provider client is a fake over a host directory whose
// capture is slow but finite. The Modal group spies the provider stop, while
// the earlier attempt's capture is the real terminateProviderBox.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@temporalio/activity";
import {
  claimWorkspaceArchiveCapture,
  createDb,
  readLease,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import type { ObjectStorage } from "@opengeni/storage";
import {
  acquireSharedTestDatabase,
  type SharedTestDatabase,
  testSettings,
} from "@opengeni/testing";
import {
  SandboxProviderCaptureTimeoutError,
  createSandboxLeaseActivities,
  terminateProviderBox,
  type TerminateBoxFn,
} from "../src/activities/sandbox-lease";
import type { ActivityServices } from "../src/activities/types";

const observability = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as never;

const TEST_WORKSPACE_FINGERPRINT =
  "OPENGENI_WORKSPACE_FINGERPRINT_V1 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 3 2 17\n";

function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle in ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A provider-native capture this test settles explicitly. The drain signal
 * cannot interrupt it once started. */
function pendingModalClient(capture: Promise<Uint8Array>) {
  let deletes = 0;
  const resume = async (state: { sandboxId?: unknown }) => ({
    state: { sandboxId: state.sandboxId },
    exec: async () => ({ stdout: TEST_WORKSPACE_FINGERPRINT }),
    persistWorkspace: async () => await capture,
    kill: async () => {},
    closed: false,
    modal: { images: { delete: async () => {} } },
  });
  return {
    get deletes() {
      return deletes;
    },
    client: {
      backendId: "modal",
      async deserializeSessionState(state: Record<string, unknown>) {
        return { ...state };
      },
      resume,
      resumeExact: resume,
      async delete() {
        deletes += 1;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Retry while an earlier capture is still settling (real PostgreSQL)
// ---------------------------------------------------------------------------

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | undefined;
let db: Database;
let available = true;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-drain-capture-budget");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[worker-drain-capture-budget] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

const SETTINGS = testSettings({
  sandboxBackend: "modal",
  webSearchEnabled: false,
  sandboxOwnershipEnabled: true,
  sandboxSnapshotTimeoutMs: 10,
});

function services(): () => Promise<ActivityServices> {
  return async () => ({
    settings: SETTINGS,
    db,
    bus: null as never,
    runtime: null as never,
    objectStorage: null,
    documentServices: null as never,
    observability: createObservability(SETTINGS, { component: "worker-test" }),
    wakeSessionWorkflow: null,
  });
}

function archiveDescriptor(archive: string, capturedAtMs: number) {
  const bytes = Buffer.from(archive, "base64");
  const archiveSha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return {
    version: 1 as const,
    revision: `wa1:${capturedAtMs}:${archiveSha256}`,
    archiveSha256,
    archiveBytes: bytes.length,
    capturedAt: new Date(capturedAtMs).toISOString(),
    workspace: {
      algorithm: "sha256" as const,
      sha256: archiveSha256,
      entryCount: 1,
      fileCount: 1,
      totalFileBytes: bytes.length,
    },
  };
}

function modalResumeState(instanceId: string) {
  return { backendId: "modal", sessionState: { providerState: { sandboxId: instanceId } } };
}

async function drainingModalLease(epoch: number, instanceId: string) {
  const admin = shared!.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  const ids = { accountId: account!.id, workspaceId: workspace!.id, groupId: crypto.randomUUID() };
  await admin`
    insert into sandbox_leases (
      account_id, workspace_id, sandbox_group_id, liveness, refcount,
      turn_holders, viewer_holders, instance_id, backend, lease_epoch,
      resume_backend_id, resume_state, expires_at
    ) values (
      ${ids.accountId}, ${ids.workspaceId}, ${ids.groupId}, 'draining', 0, 0, 0,
      ${instanceId}, 'modal', ${epoch}, 'modal',
      ${JSON.stringify(modalResumeState(instanceId))}::text::jsonb,
      now() - interval '1 second'
    )`;
  return ids;
}

/** The earlier attempt's capture: the real provider drain whose own wait has
 * timed out while the provider-native capture keeps running. */
async function startTimedOutCapture(
  ids: { groupId: string },
  epoch: number,
  instanceId: string,
  capture: Promise<Uint8Array>,
) {
  const late = deferred();
  const { client: provider } = pendingModalClient(capture);
  let latePublications = 0;
  let releases = 0;
  const operation = terminateProviderBox(
    SETTINGS,
    {
      sandboxGroupId: ids.groupId,
      leaseEpoch: epoch,
      backend: "modal",
      instanceId,
      resumeBackendId: "modal",
      resumeState: modalResumeState(instanceId),
    } as never,
    observability,
    async () => {
      latePublications += 1;
      late.resolve();
      return { wrote: true };
    },
    (() => provider) as never,
    undefined,
    undefined,
    "capture_required",
    undefined,
    false,
    async () => {
      releases += 1;
      late.resolve();
    },
  );
  await expect(operation).rejects.toBeInstanceOf(SandboxProviderCaptureTimeoutError);
  return {
    settled: late.promise,
    get latePublications() {
      return latePublications;
    },
    get releases() {
      return releases;
    },
  };
}

function stopSpy() {
  const stopped: string[] = [];
  const fn: TerminateBoxFn = async (_settings, lease, _observability, persistArchive) => {
    const archive = Buffer.from(`archive ${lease.sandboxGroupId}`).toString("base64");
    const { wrote } = await persistArchive(archive, archiveDescriptor(archive, Date.now()));
    if (wrote) stopped.push(lease.sandboxGroupId);
    return wrote;
  };
  return { fn, stopped };
}

function drainInput(
  ids: { workspaceId: string; groupId: string },
  epoch: number,
  instanceId: string,
) {
  return {
    target: {
      workspaceId: ids.workspaceId,
      sandboxGroupId: ids.groupId,
      instanceId,
      leaseEpoch: epoch,
    },
    timeoutClass: "fast" as const,
    snapshotTimeoutMs: 10,
    captureTimeoutMs: 10_010,
    operationId: crypto.randomUUID(),
  };
}

describe("drain retry while an earlier capture is settling", () => {
  test.each(["late success", "late failure"])(
    "a retry neither replaces the claim nor captures again until the earlier capture settles (%s)",
    async (outcome) => {
      if (!available) return;
      const epoch = 4;
      const instanceId = `sb-settling-${outcome.replace(" ", "-")}`;
      const ids = await drainingModalLease(epoch, instanceId);
      // The earlier attempt's durable claim, as a takeover-safe provider records it.
      const priorOperationId = crypto.randomUUID();
      const prior = await claimWorkspaceArchiveCapture(db, {
        accountId: ids.accountId,
        workspaceId: ids.workspaceId,
        sandboxGroupId: ids.groupId,
        captureId: priorOperationId,
        operationId: priorOperationId,
        attempt: 1,
        expectedEpoch: epoch,
        expectedInstanceId: instanceId,
        liveness: "draining",
        captureTimeoutMs: 10_010,
        minIntervalMs: 0,
        providerReplaySafe: false,
        takeoverSafe: true,
      });
      expect(prior.status).toBe("claimed");
      const capture = deferred<Uint8Array>();
      const earlier = await startTimedOutCapture(ids, epoch, instanceId, capture.promise);

      const spy = stopSpy();
      const { drainSandboxLease } = createSandboxLeaseActivities(services(), {
        terminateBox: spy.fn,
        probeDrainableProvider: async () => "ready",
      });
      // The retry is deferred: no second capture, and the earlier claim stays
      // in place so its late publication is not fenced.
      await expect(drainSandboxLease(drainInput(ids, epoch, instanceId))).rejects.toMatchObject({
        name: "SandboxDrainRecoveryDeferredError",
      });
      expect(spy.stopped).toEqual([]);
      const waiting = await readLease(db, ids.workspaceId, ids.groupId);
      expect(waiting?.liveness).toBe("draining");
      expect(waiting?.archiveCapture?.id).toBe(priorOperationId);

      // Another lease is never held back by this one.
      const otherInstance = `${instanceId}-other`;
      const other = await drainingModalLease(epoch, otherInstance);
      expect(await drainSandboxLease(drainInput(other, epoch, otherInstance))).toEqual({
        status: "terminated",
      });
      expect(spy.stopped).toEqual([other.groupId]);

      if (outcome === "late success") {
        capture.resolve(
          new TextEncoder().encode('MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-late"}'),
        );
      } else {
        capture.reject(new Error("provider capture failed"));
      }
      await within(earlier.settled, 5_000, "earlier capture");
      expect(earlier.latePublications).toBe(outcome === "late success" ? 1 : 0);
      expect(earlier.releases).toBe(outcome === "late success" ? 0 : 1);
      // Settlement bookkeeping runs right after the late path; let it land.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(await drainSandboxLease(drainInput(ids, epoch, instanceId))).toEqual({
        status: "terminated",
      });
      expect(spy.stopped).toEqual([other.groupId, ids.groupId]);
      expect((await readLease(db, ids.workspaceId, ids.groupId))?.liveness).toBe("cold");
    },
    60_000,
  );

  test("a capture that failed inside its budget never defers the retry", async () => {
    if (!available) return;
    const epoch = 6;
    const instanceId = "sb-failed-in-budget";
    const ids = await drainingModalLease(epoch, instanceId);
    const capture = deferred<Uint8Array>();
    const { client: provider } = pendingModalClient(capture.promise);
    capture.reject(new Error("provider capture failed"));
    let releases = 0;
    await expect(
      terminateProviderBox(
        testSettings({
          sandboxBackend: "modal",
          sandboxOwnershipEnabled: true,
          sandboxSnapshotTimeoutMs: 30_000,
        }),
        {
          sandboxGroupId: ids.groupId,
          leaseEpoch: epoch,
          backend: "modal",
          instanceId,
          resumeBackendId: "modal",
          resumeState: modalResumeState(instanceId),
        } as never,
        observability,
        async () => ({ wrote: true }),
        (() => provider) as never,
        undefined,
        undefined,
        "capture_required",
        undefined,
        false,
        async () => {
          releases += 1;
        },
      ),
    ).rejects.toThrow("provider capture failed");
    expect(releases).toBe(1);

    const spy = stopSpy();
    const { drainSandboxLease } = createSandboxLeaseActivities(services(), {
      terminateBox: spy.fn,
      probeDrainableProvider: async () => "ready",
    });
    expect(await drainSandboxLease(drainInput(ids, epoch, instanceId))).toEqual({
      status: "terminated",
    });
    expect(spy.stopped).toEqual([ids.groupId]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Slow but finite Docker capture under fast retries (real PostgreSQL)
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Local-file object storage with the streaming and range primitives the
 * disk-backed archive publication requires. */
function fileObjectStorage(directory: string): ObjectStorage {
  mkdirSync(directory, { recursive: true });
  const keyOf = (input: unknown) =>
    typeof input === "string" ? input : (input as { key: string }).key;
  const pathOf = (input: unknown) =>
    join(directory, createHash("sha256").update(keyOf(input)).digest("hex"));
  return {
    backend: "s3-compatible",
    async putObjectStream(input: { key: string; chunks: AsyncIterable<Uint8Array> }) {
      const handle = await open(pathOf(input), "w");
      try {
        for await (const chunk of input.chunks) await handle.write(chunk);
      } finally {
        await handle.close();
      }
    },
    async headObject(input: unknown) {
      return { ContentLength: statSync(pathOf(input)).size, VersionToken: "fixture-v1" };
    },
    async getObjectRange(input: { key: string; start: number; endInclusive: number }) {
      const bytes = Buffer.alloc(input.endInclusive - input.start + 1);
      const handle = await open(pathOf(input), "r");
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(
            bytes,
            offset,
            bytes.length - offset,
            input.start + offset,
          );
          if (!bytesRead) throw new Error("fixture range truncated");
          offset += bytesRead;
        }
      } finally {
        await handle.close();
      }
      return { bytes, versionToken: "fixture-v1" };
    },
    async deleteObject(input: unknown) {
      rmSync(pathOf(input), { force: true });
    },
    async getObjectBytes(): Promise<never> {
      throw new Error("whole-object download forbidden");
    },
    async putObject(): Promise<never> {
      throw new Error("whole-object upload forbidden");
    },
  } as unknown as ObjectStorage;
}

/** A Docker drain attachment over a real host directory. Each attachment is
 * one physical capture, which spends `captureMs` before reading (a slow disk);
 * like the real attachment, it re-proves the exact claim and refuses teardown
 * before durable publication. */
function slowDockerHost(captureMs: number) {
  const stats = { started: 0, reading: 0, peakReading: 0, deletes: [] as boolean[] };
  const client = {
    backendId: "docker",
    async deserializeSessionState(state: Record<string, unknown>) {
      return { ...state };
    },
    async attachWorkspaceForDrain(
      state: { providerState?: { workspaceRootPath?: string } } & Record<string, unknown>,
      assertCurrentCapture: () => Promise<{ archivePublished: boolean }>,
    ) {
      await assertCurrentCapture();
      let started = false;
      return {
        state: {
          workspaceRootPath: state.providerState?.workspaceRootPath ?? state.workspaceRootPath,
        },
        async assertWorkspaceCaptureAuthority() {
          await assertCurrentCapture();
          if (started) return;
          started = true;
          stats.started += 1;
          stats.reading += 1;
          stats.peakReading = Math.max(stats.peakReading, stats.reading);
          try {
            await sleep(captureMs);
          } finally {
            stats.reading -= 1;
          }
        },
        persistWorkspace: async () => {
          throw new Error("whole-archive capture is not the host-spool drain path");
        },
        async delete() {
          const fence = await assertCurrentCapture();
          stats.deletes.push(fence.archivePublished);
          if (!fence.archivePublished) throw new Error("exact capture is not durably published");
        },
      };
    },
  };
  return { client, stats };
}

function spoolDirs(base: string): number {
  return readdirSync(base).filter((name) => name.startsWith("opengeni-host-archive-")).length;
}

async function drainingDockerLease(epoch: number, instanceId: string, root: string) {
  const admin = shared!.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  const ids = { accountId: account!.id, workspaceId: workspace!.id, groupId: crypto.randomUUID() };
  const envelope = {
    backendId: "docker",
    sessionState: {
      providerState: { containerId: instanceId, workspaceRootPath: root, workspaceRootOwned: false },
    },
  };
  await admin`
    insert into sandbox_leases (
      account_id, workspace_id, sandbox_group_id, liveness, refcount,
      turn_holders, viewer_holders, instance_id, backend, lease_epoch,
      resume_backend_id, resume_state, expires_at
    ) values (
      ${ids.accountId}, ${ids.workspaceId}, ${ids.groupId}, 'draining', 0, 0, 0,
      ${instanceId}, 'docker', ${epoch}, 'docker',
      ${JSON.stringify(envelope)}::text::jsonb,
      now() - interval '1 second'
    )`;
  return ids;
}

const DOCKER_BUDGET_MS = 250;
const DOCKER_CAPTURE_MS = 1_500;
const DOCKER_RETRY_MS = 100;

/** Replays Temporal attempts of one drain activity input (fixed retry
 * interval, faster than the capture) across the given workers in turn, until
 * an attempt returns, then waits for every capture and spool to settle. */
async function runSlowDockerDrain(workerCount: 1 | 2, label: string) {
  const runDir = mkdtempSync(join(tmpdir(), `opengeni-drain-slow-${label}-`));
  const root = join(runDir, "workspace");
  const spoolBase = join(runDir, "spools");
  mkdirSync(root);
  mkdirSync(spoolBase);
  for (let index = 0; index < 4; index++) {
    writeFileSync(join(root, `blob-${index}`), randomBytes(256 * 1024));
  }
  const previousTemp = process.env.TMPDIR;
  process.env.TMPDIR = spoolBase;
  let currentAttempt = 1;
  const context = spyOn(Context, "current").mockImplementation(
    () => ({ info: { attempt: currentAttempt }, heartbeat() {} }) as never,
  );
  try {
    const settings = testSettings({
      sandboxBackend: "docker",
      webSearchEnabled: false,
      sandboxOwnershipEnabled: true,
      sandboxSnapshotTimeoutMs: DOCKER_BUDGET_MS,
    });
    const storage = fileObjectStorage(join(runDir, "objects"));
    const docker = slowDockerHost(DOCKER_CAPTURE_MS);
    const services = async () =>
      ({
        settings,
        db,
        bus: null,
        runtime: null,
        objectStorage: storage,
        documentServices: null,
        observability: createObservability(settings, { component: "worker-test" }),
        wakeSessionWorkflow: null,
      }) as never;
    // A second evaluation of the module owns its own in-process state, as a
    // second worker process would.
    const secondWorker = "../src/activities/sandbox-lease.ts?drain-worker=b";
    const factories: Array<typeof createSandboxLeaseActivities> = [createSandboxLeaseActivities];
    if (workerCount === 2) {
      const second = (await import(secondWorker)) as {
        createSandboxLeaseActivities: typeof createSandboxLeaseActivities;
      };
      expect(second.createSandboxLeaseActivities).not.toBe(createSandboxLeaseActivities);
      factories.push(second.createSandboxLeaseActivities);
    }
    const workers = factories.map((create) =>
      create(services, {
        probeDrainableProvider: async () => "ready",
        createClientForBackend: (() => docker.client) as never,
      }),
    );
    const instanceId = `docker-slow-${label}`;
    const ids = await drainingDockerLease(7, instanceId, root);
    const input = {
      target: {
        workspaceId: ids.workspaceId,
        sandboxGroupId: ids.groupId,
        instanceId,
        leaseEpoch: 7,
      },
      timeoutClass: "fast" as const,
      snapshotTimeoutMs: DOCKER_BUDGET_MS,
      captureTimeoutMs: DOCKER_BUDGET_MS + 10_000,
      operationId: crypto.randomUUID(),
    };
    let peakSpools = 0;
    const sampler = setInterval(() => {
      peakSpools = Math.max(peakSpools, spoolDirs(spoolBase));
    }, 10);
    const outcomes: string[] = [];
    let result: unknown = null;
    for (let attempt = 1; attempt <= 60 && result === null; attempt++) {
      currentAttempt = attempt;
      try {
        result = await workers[(attempt - 1) % workers.length]!.drainSandboxLease(input);
        outcomes.push("returned");
      } catch (error) {
        outcomes.push((error as { name?: string }).name ?? "Error");
        await sleep(DOCKER_RETRY_MS);
      }
    }
    // Let any capture another worker started finish and remove its spool.
    const settleBy = Date.now() + 4 * DOCKER_CAPTURE_MS;
    while (Date.now() < settleBy && (docker.stats.reading > 0 || spoolDirs(spoolBase) > 0)) {
      await sleep(20);
    }
    await sleep(50);
    clearInterval(sampler);
    return {
      result,
      outcomes,
      stats: docker.stats,
      peakSpools,
      leftoverSpools: spoolDirs(spoolBase),
      lease: await readLease(db, ids.workspaceId, ids.groupId),
    };
  } finally {
    context.mockRestore();
    if (previousTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTemp;
    rmSync(runDir, { recursive: true, force: true });
  }
}

describe("slow but finite Docker drain capture under fast retries", () => {
  test.skipIf(process.platform !== "linux")(
    "one worker runs one physical capture, publishes it late and then drains",
    async () => {
      if (!available) return;
      const run = await runSlowDockerDrain(1, "one-worker");
      // The capture outlived several budgets, yet the box drained from it.
      expect(run.result).toEqual({ status: "terminated" });
      expect(run.outcomes.filter((outcome) => outcome !== "returned").length).toBeGreaterThan(2);
      expect(run.lease?.liveness).toBe("cold");
      expect(run.lease?.archiveComplete).toBe(true);
      // Every retry during the capture deferred to it instead of reading again.
      expect(run.stats.started).toBe(1);
      expect(run.stats.peakReading).toBe(1);
      expect(run.peakSpools).toBeLessThanOrEqual(1);
      expect(run.leftoverSpools).toBe(0);
      // Teardown only ever happened after durable publication.
      expect(run.stats.deletes).toEqual([true]);
    },
    60_000,
  );

  test.skipIf(process.platform !== "linux")(
    "alternating workers each run at most one physical capture and still drain",
    async () => {
      if (!available) return;
      const run = await runSlowDockerDrain(2, "two-workers");
      expect(run.result).toEqual({ status: "terminated" });
      expect(run.lease?.liveness).toBe("cold");
      expect(run.lease?.archiveComplete).toBe(true);
      // The in-process deferral bounds physical captures by the worker count.
      expect(run.stats.started).toBeLessThanOrEqual(2);
      expect(run.stats.peakReading).toBeLessThanOrEqual(2);
      expect(run.leftoverSpools).toBe(0);
      expect(run.stats.deletes.every(Boolean)).toBe(true);
    },
    60_000,
  );
});
