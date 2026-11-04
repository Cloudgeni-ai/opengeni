// Regression (DC-G2): a zero-holder drain used one value both as its own wait
// and as the provider's hard snapshot timeout. Production waited 60 s and
// Modal's snapshot deadline was the same 60 s, so a workspace whose snapshot
// needed longer was cut off by the provider on every attempt. The box retried
// about every 1.5 minutes, with no backoff and no limit, and stayed draining
// until Modal's 24 h kill; the next turn then restored an older snapshot.
//
// These tests run the real drain activity and the real provider teardown
// against PostgreSQL. Only the Modal client is a fake, and it behaves like
// Modal: a snapshot that needs longer than the provider deadline it was given
// fails at that deadline.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Context } from "@temporalio/activity";
import { createDb, readLease, type Database, type DbClient } from "@opengeni/db";
import { sandboxDeadlineMandatoryCaptureLeadMs } from "@opengeni/config";
import { createObservability } from "@opengeni/observability";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createSandboxLeaseActivities } from "../src/activities/sandbox-lease";
import type { ActivityServices } from "../src/activities/types";

const TEST_WORKSPACE_FINGERPRINT =
  "OPENGENI_WORKSPACE_FINGERPRINT_V1 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 3 2 17\n";

/** The drain's own wait, frozen into its durable child input. */
const WAIT_MS = 50;
/** How long this workspace's snapshot really takes: longer than the wait. */
const SNAPSHOT_MS = 400;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | undefined;
let db: Database;
let available = true;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-drain-snapshot-provider-timeout");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[worker-drain-snapshot-provider-timeout] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
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

let currentAttempt = 1;
const context = spyOn(Context, "current").mockImplementation(
  () => ({ info: { attempt: currentAttempt }, heartbeat() {} }) as never,
);
afterAll(() => context.mockRestore());
afterEach(() => {
  currentAttempt = 1;
});

const SETTINGS = testSettings({
  sandboxBackend: "modal",
  webSearchEnabled: false,
  sandboxOwnershipEnabled: true,
  sandboxSnapshotTimeoutMs: WAIT_MS,
  sandboxDrainProviderSnapshotTimeoutMs: 600_000,
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

/** A Modal client whose snapshot behaves like Modal's: the session was built
 * with the drain's wait as its snapshot timeout (exactly what the drain used
 * to configure), and a per-capture provider timeout replaces it. */
function modalLikeClient(snapshot: (deadlineMs: number) => Promise<Uint8Array>) {
  const calls: Array<{ requestId: string; providerTimeoutMs: number | undefined }> = [];
  let deletes = 0;
  const resume = async (state: { sandboxId?: unknown }) => ({
    state: { sandboxId: state.sandboxId, snapshotFilesystemTimeoutMs: WAIT_MS },
    exec: async () => ({ stdout: TEST_WORKSPACE_FINGERPRINT }),
    persistWorkspace: async (options?: { requestId: string; providerTimeoutMs?: number }) => {
      calls.push({
        requestId: options?.requestId ?? "",
        providerTimeoutMs: options?.providerTimeoutMs,
      });
      return await snapshot(options?.providerTimeoutMs ?? WAIT_MS);
    },
    kill: async () => {},
    closed: false,
    modal: { images: { delete: async () => {} } },
  });
  return {
    calls,
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
    snapshotTimeoutMs: WAIT_MS,
    captureTimeoutMs: WAIT_MS + 10_000,
    operationId: crypto.randomUUID(),
  };
}

async function slowSnapshot(deadlineMs: number): Promise<Uint8Array> {
  if (deadlineMs < SNAPSHOT_MS) {
    await sleep(deadlineMs);
    throw new Error("Modal snapshot_directory persistence timed out.");
  }
  await sleep(SNAPSHOT_MS);
  return new TextEncoder().encode("workspace tar bytes");
}

describe("drain snapshot provider timeout", () => {
  test("a snapshot slower than the drain wait still finishes, publishes and drains the box", async () => {
    if (!available) return;
    const epoch = 3;
    const instanceId = "sb-slow-snapshot";
    const ids = await drainingModalLease(epoch, instanceId);
    const provider = modalLikeClient(slowSnapshot);
    const { drainSandboxLease } = createSandboxLeaseActivities(services(), {
      createClientForBackend: (() => provider.client) as never,
      probeDrainableProvider: async () => "ready",
    });
    const input = drainInput(ids, epoch, instanceId);
    const outcomes: string[] = [];
    let result: unknown = null;
    // Temporal's retries, compressed: every attempt waits only WAIT_MS.
    for (let attempt = 1; attempt <= 20 && result === null; attempt++) {
      currentAttempt = attempt;
      try {
        result = await drainSandboxLease(input);
        outcomes.push("returned");
      } catch (error) {
        outcomes.push((error as { name?: string }).name ?? "Error");
        await sleep(100);
      }
    }
    expect(result).toEqual({ status: "terminated" });
    // One physical snapshot, given the drain's own provider budget rather
    // than the wait, published late under its claim.
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.providerTimeoutMs).toBe(600_000);
    expect(outcomes[0]).toBe("SandboxProviderCaptureTimeoutError");
    const lease = await readLease(db, ids.workspaceId, ids.groupId);
    expect(lease?.liveness).toBe("cold");
    expect(lease?.recovery.archive.status).toBe("available");
    expect(lease?.drainCaptureFailures?.count ?? 0).toBe(0);
  }, 60_000);

  test("repeated settled snapshot failures back off exponentially up to a cap", async () => {
    if (!available) return;
    const epoch = 5;
    const instanceId = "sb-failing-snapshot";
    const ids = await drainingModalLease(epoch, instanceId);
    const provider = modalLikeClient(async () => {
      throw new Error("provider capture failed");
    });
    const { drainSandboxLease } = createSandboxLeaseActivities(services(), {
      createClientForBackend: (() => provider.client) as never,
      probeDrainableProvider: async () => "ready",
    });
    const input = drainInput(ids, epoch, instanceId);
    const delays: number[] = [];
    for (let failure = 1; failure <= 7; failure++) {
      currentAttempt += 1;
      const error = await drainSandboxLease(input).then(
        () => null,
        (caught: unknown) => caught as { nextRetryDelay?: unknown; message?: string },
      );
      expect(error?.message).toContain("provider capture failed");
      expect(provider.calls).toHaveLength(failure);
      const lease = await readLease(db, ids.workspaceId, ids.groupId);
      expect(lease?.liveness).toBe("draining");
      expect(lease?.archiveCapture).toBeNull();
      expect(lease?.drainCaptureFailures?.count).toBe(failure);
      delays.push(Number(error?.nextRetryDelay));

      // A retry inside the backoff starts no new snapshot.
      currentAttempt += 1;
      const deferred = await drainSandboxLease(input).then(
        () => null,
        (caught: unknown) => caught as { type?: string; nextRetryDelay?: unknown },
      );
      expect(deferred?.type).toBe("SandboxDrainCaptureBackoffError");
      expect(Number(deferred?.nextRetryDelay)).toBeGreaterThan(0);
      expect(provider.calls).toHaveLength(failure);

      // Let the backoff elapse.
      await shared!.admin`
        update sandbox_leases
        set drain_capture_last_failed_at = now() - interval '1 hour'
        where sandbox_group_id = ${ids.groupId}`;
    }
    const rounded = delays.map((ms) => Math.round(ms / 1_000));
    expect(rounded.slice(0, 5)).toEqual([30, 60, 120, 240, 480]);
    expect(rounded.slice(5)).toEqual([600, 600]);

    // Inside the mandatory pre-deadline save window there is no backoff:
    // waiting would only let the provider end the box uncaptured.
    await shared!.admin`
      update sandbox_leases
      set drain_capture_last_failed_at = now(),
          provider_created_at = now() - interval '23 hours',
          provider_deadline_at = now() + interval '1 minute'
      where sandbox_group_id = ${ids.groupId}`;
    currentAttempt += 1;
    await expect(drainSandboxLease(input)).rejects.toThrow("provider capture failed");
    expect(provider.calls).toHaveLength(8);
  }, 60_000);

  test("a backoff never runs past the start of the pre-deadline save window", async () => {
    if (!available) return;
    const epoch = 6;
    const instanceId = "sb-backoff-window";
    const ids = await drainingModalLease(epoch, instanceId);
    const provider = modalLikeClient(async () => {
      throw new Error("provider capture failed");
    });
    const { drainSandboxLease } = createSandboxLeaseActivities(services(), {
      createClientForBackend: (() => provider.client) as never,
      probeDrainableProvider: async () => "ready",
    });
    // Five failures earn a 480 s backoff, but the save window opens in 60 s.
    const leadMs = sandboxDeadlineMandatoryCaptureLeadMs(SETTINGS);
    await shared!.admin`
      update sandbox_leases
      set drain_capture_failures = 5,
          drain_capture_failure_epoch = ${epoch},
          drain_capture_first_failed_at = now() - interval '1 hour',
          drain_capture_last_failed_at = now(),
          provider_created_at = now() - interval '23 hours',
          provider_deadline_at = now() + ${`${leadMs + 60_000} milliseconds`}::interval
      where sandbox_group_id = ${ids.groupId}`;
    currentAttempt += 1;
    const deferred = await drainSandboxLease(drainInput(ids, epoch, instanceId)).then(
      () => null,
      (caught: unknown) => caught as { type?: string; nextRetryDelay?: unknown },
    );
    expect(deferred?.type).toBe("SandboxDrainCaptureBackoffError");
    const delayMs = Number(deferred?.nextRetryDelay);
    expect(delayMs).toBeGreaterThan(50_000);
    expect(delayMs).toBeLessThanOrEqual(60_000);
    expect(provider.calls).toHaveLength(0);
  }, 60_000);

  test("a successful save ends the run of failures", async () => {
    if (!available) return;
    const epoch = 7;
    const instanceId = "sb-failures-then-save";
    const ids = await drainingModalLease(epoch, instanceId);
    await shared!.admin`
      update sandbox_leases
      set drain_capture_failures = 3,
          drain_capture_failure_epoch = ${epoch},
          drain_capture_first_failed_at = now() - interval '2 hours',
          drain_capture_last_failed_at = now() - interval '1 hour'
      where sandbox_group_id = ${ids.groupId}`;
    const provider = modalLikeClient(async () => new TextEncoder().encode("workspace tar bytes"));
    const { drainSandboxLease } = createSandboxLeaseActivities(services(), {
      createClientForBackend: (() => provider.client) as never,
      probeDrainableProvider: async () => "ready",
    });
    currentAttempt += 1;
    expect(await drainSandboxLease(drainInput(ids, epoch, instanceId))).toEqual({
      status: "terminated",
    });
    const [row] = await shared!.admin<
      { drain_capture_failures: number; drain_capture_last_failed_at: Date | null }[]
    >`select drain_capture_failures, drain_capture_last_failed_at
      from sandbox_leases where sandbox_group_id = ${ids.groupId}`;
    expect(row).toEqual({ drain_capture_failures: 0, drain_capture_last_failed_at: null });
  }, 60_000);

  test("a new lease epoch starts counting from zero", async () => {
    if (!available) return;
    const ids = await drainingModalLease(9, "sb-epoch-reset");
    await shared!.admin`
      update sandbox_leases
      set drain_capture_failures = 6,
          drain_capture_failure_epoch = 8,
          drain_capture_last_failed_at = now()
      where sandbox_group_id = ${ids.groupId}`;
    const lease = await readLease(db, ids.workspaceId, ids.groupId);
    expect(lease?.drainCaptureFailures).toEqual({
      count: 0,
      firstFailedAt: null,
      lastFailedAt: null,
    });
  }, 60_000);
});
