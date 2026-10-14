// Regression: a zero-holder drain retried its workspace capture forever while
// earlier captures of the same box were still running. The drain wait gave up
// at the snapshot budget, but a host-backed spool capture kept reading and
// spooling the whole workspace for late publication. A parallel-read provider
// (Docker) let the next attempt replace that claim at once and start another
// full capture. On a benchmark host, 7-8 GB workspaces accumulated about 140 GB
// of concurrent spools for a handful of idle boxes.
//
// The first group drives the real terminateProviderBox against a real host
// workspace and fake providers (no Docker daemon, no database). The second
// group drives the real drain activity against PostgreSQL; the provider stop is
// a spy, while the earlier attempt's capture is the real terminateProviderBox.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimWorkspaceArchiveCapture,
  createDb,
  readLease,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
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

/** A Docker drain attachment over a real host workspace directory, so the real
 * host-backed spool capture reads it. */
function dockerHostClient() {
  let deletes = 0;
  return {
    get deletes() {
      return deletes;
    },
    client: {
      backendId: "docker",
      async deserializeSessionState(state: Record<string, unknown>) {
        return { ...state };
      },
      async attachWorkspaceForDrain(
        state: Record<string, unknown>,
        assertCurrentCapture: () => Promise<unknown>,
      ) {
        await assertCurrentCapture();
        return {
          state,
          persistWorkspace: async () => {
            throw new Error("whole archive capture forbidden");
          },
          delete: async () => {
            deletes += 1;
          },
        };
      },
    },
  };
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

describe("drain workspace capture budget", () => {
  test.skipIf(process.platform !== "linux")(
    "a host-backed drain capture that outlives its budget stops reading and removes its spool",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "opengeni-drain-budget-workspace-"));
      const spoolBase = mkdtempSync(join(tmpdir(), "opengeni-drain-budget-spools-"));
      // Large enough that four passes over it cannot finish inside the budget.
      const chunk = Buffer.alloc(1024 * 1024, 7);
      for (let index = 0; index < 32; index++) writeFileSync(join(root, `blob-${index}`), chunk);
      const previousTemp = process.env.TMPDIR;
      process.env.TMPDIR = spoolBase;
      const { client, ...provider } = dockerHostClient();
      let publications = 0;
      const published = deferred();
      let releases = 0;
      const released = deferred();
      try {
        const operation = terminateProviderBox(
          testSettings({
            sandboxBackend: "docker",
            sandboxOwnershipEnabled: true,
            sandboxSnapshotTimeoutMs: 5,
          }),
          {
            sandboxGroupId: "drain-budget-host",
            leaseEpoch: 9,
            backend: "docker",
            instanceId: "docker-drain-budget",
            resumeBackendId: "docker",
            resumeState: {
              backendId: "docker",
              sessionState: {
                providerState: {
                  containerId: "docker-drain-budget",
                  workspaceRootPath: root,
                  workspaceRootOwned: true,
                },
              },
            },
          } as never,
          observability,
          async () => {
            publications += 1;
            published.resolve();
            return { wrote: true };
          },
          (() => client) as never,
          undefined,
          "stable-provider-request",
          "capture_required",
          undefined,
          true,
          async () => {
            releases += 1;
            released.resolve();
          },
          undefined,
          undefined,
          async () => ({ archivePublished: false }),
        );
        // Never terminated: the box keeps its files and stays draining.
        await expect(operation).rejects.toBeDefined();
        await within(Promise.race([published.promise, released.promise]), 30_000, "drain capture");
        // The capture was stopped, not completed late: nothing is published,
        // the exact claim is released for a fresh retry, and the spool is gone.
        expect(publications).toBe(0);
        expect(releases).toBe(1);
        expect(readdirSync(spoolBase)).toEqual([]);
        expect(provider.deletes).toBe(0);
      } finally {
        if (previousTemp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTemp;
        rmSync(root, { recursive: true, force: true });
        rmSync(spoolBase, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

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
