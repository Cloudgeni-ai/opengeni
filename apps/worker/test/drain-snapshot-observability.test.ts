// Regression (DC-G6): production had 45 leases stuck draining for up to 79 h
// while their workspace snapshots failed about every 1.5 minutes, and nothing
// alerted on one lease failing again and again or showed how large the
// workspace that could not be saved was. These tests run the real drain
// activity against PostgreSQL with a Modal-like fake client and check the
// failure and size metrics that the new alerts read.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Context } from "@temporalio/activity";
import { sandboxDeadlineMandatoryCaptureLeadMs } from "@opengeni/config";
import { createDb, type Database, type DbClient } from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createSandboxLeaseActivities } from "../src/activities/sandbox-lease";
import {
  recordSandboxDrainCaptureFailure,
  recordSandboxWorkspaceSnapshotSize,
} from "../src/observability-metrics";
import type { ActivityServices } from "../src/activities/types";

const TEST_WORKSPACE_FINGERPRINT =
  "OPENGENI_WORKSPACE_FINGERPRINT_V1 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 3 2 17\n";
const TEST_WORKSPACE_SIZE = "OPENGENI_WORKSPACE_SIZE_V1 182733 9123456789\n";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | undefined;
let db: Database;
let available = true;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-drain-snapshot-observability");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[worker-drain-snapshot-observability] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
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

const SETTINGS = testSettings({
  sandboxBackend: "modal",
  webSearchEnabled: false,
  sandboxOwnershipEnabled: true,
  observabilityMetricsEnabled: true,
  sandboxSnapshotTimeoutMs: 5_000,
});

type Observed = { name: string; labels?: Record<string, unknown>; value?: number };

function recordingServices() {
  const observability = createObservability(SETTINGS, { component: "worker-test" });
  const counters: Observed[] = [];
  const histograms: Observed[] = [];
  const increment = observability.incrementCounter.bind(observability);
  const observe = observability.observeHistogram.bind(observability);
  observability.incrementCounter = (input) => {
    counters.push({ name: input.name, labels: input.labels });
    increment(input);
  };
  observability.observeHistogram = (input) => {
    histograms.push({ name: input.name, labels: input.labels, value: input.value });
    observe(input);
  };
  const services = async (): Promise<ActivityServices> => ({
    settings: SETTINGS,
    db,
    bus: null as never,
    runtime: null as never,
    objectStorage: null,
    documentServices: null as never,
    observability,
    wakeSessionWorkflow: null,
  });
  return { services, counters, histograms };
}

async function drainingModalLease(epoch: number, instanceId: string) {
  const admin = shared!.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  const ids = { accountId: account!.id, workspaceId: workspace!.id, groupId: crypto.randomUUID() };
  const resumeState = {
    backendId: "modal",
    sessionState: { providerState: { sandboxId: instanceId } },
  };
  await admin`
    insert into sandbox_leases (
      account_id, workspace_id, sandbox_group_id, liveness, refcount,
      turn_holders, viewer_holders, instance_id, backend, lease_epoch,
      resume_backend_id, resume_state, expires_at
    ) values (
      ${ids.accountId}, ${ids.workspaceId}, ${ids.groupId}, 'draining', 0, 0, 0,
      ${instanceId}, 'modal', ${epoch}, 'modal',
      ${JSON.stringify(resumeState)}::text::jsonb,
      now() - interval '1 second'
    )`;
  return ids;
}

function modalLikeClient(persist: () => Promise<Uint8Array>) {
  const commands: string[] = [];
  const resume = async (state: { sandboxId?: unknown }) => ({
    state: { sandboxId: state.sandboxId },
    exec: async ({ cmd }: { cmd: string }) => {
      commands.push(cmd);
      return {
        stdout: cmd.includes("OPENGENI_WORKSPACE_SIZE_V1")
          ? TEST_WORKSPACE_SIZE
          : TEST_WORKSPACE_FINGERPRINT,
      };
    },
    persistWorkspace: persist,
    kill: async () => {},
    closed: false,
    modal: { images: { delete: async () => {} } },
  });
  return {
    commands,
    client: {
      backendId: "modal",
      async deserializeSessionState(state: Record<string, unknown>) {
        return { ...state };
      },
      resume,
      resumeExact: resume,
      async delete() {},
    },
  };
}

function drainInput(ids: { workspaceId: string; groupId: string }, epoch: number, id: string) {
  return {
    target: {
      workspaceId: ids.workspaceId,
      sandboxGroupId: ids.groupId,
      instanceId: id,
      leaseEpoch: epoch,
    },
    timeoutClass: "fast" as const,
    snapshotTimeoutMs: 5_000,
    captureTimeoutMs: 15_000,
    operationId: crypto.randomUUID(),
  };
}

describe("drain snapshot observability", () => {
  test("each settled failure is observed with the lease's consecutive count and workspace size", async () => {
    if (!available) return;
    const epoch = 4;
    const instanceId = "sb-observed-failures";
    const ids = await drainingModalLease(epoch, instanceId);
    const provider = modalLikeClient(async () => {
      throw new Error("Modal snapshot_directory persistence timed out.");
    });
    const recorded = recordingServices();
    const { drainSandboxLease } = createSandboxLeaseActivities(recorded.services, {
      createClientForBackend: (() => provider.client) as never,
      probeDrainableProvider: async () => "ready",
    });
    const input = drainInput(ids, epoch, instanceId);
    // Four in a row crosses the OpenGeniSandboxDrainSnapshotFailing boundary.
    for (let failure = 1; failure <= 4; failure++) {
      currentAttempt += 1;
      await expect(drainSandboxLease(input)).rejects.toThrow("persistence timed out");
      // Let the backoff elapse so the next attempt snapshots again.
      await shared!.admin`
        update sandbox_leases
        set drain_capture_last_failed_at = now() - interval '1 hour'
        where sandbox_group_id = ${ids.groupId}`;
    }
    // The size walk runs in the background, so the drain never waits for it.
    await Bun.sleep(50);
    expect(
      recorded.counters.filter(
        (entry) => entry.name === "opengeni_sandbox_drain_capture_failures_total",
      ),
    ).toEqual(Array(4).fill({ name: expect.any(String), labels: { backend: "modal" } }));
    expect(
      recorded.histograms
        .filter((entry) => entry.name === "opengeni_sandbox_drain_capture_consecutive_failures")
        .map((entry) => entry.value),
    ).toEqual([1, 2, 3, 4]);
    // A provider snapshot carries no tree size, so a failure measures it once.
    const sizes = recorded.histograms.filter((entry) =>
      entry.name.startsWith("opengeni_sandbox_workspace_snapshot_"),
    );
    expect(sizes).toContainEqual({
      name: "opengeni_sandbox_workspace_snapshot_files",
      labels: { backend: "modal", outcome: "failed" },
      value: 182_733,
    });
    expect(sizes).toContainEqual({
      name: "opengeni_sandbox_workspace_snapshot_bytes",
      labels: { backend: "modal", outcome: "failed" },
      value: 9_123_456_789,
    });
    expect(
      provider.commands.filter((cmd) => cmd.includes("OPENGENI_WORKSPACE_SIZE_V1")),
    ).toHaveLength(4);
    // The probe is bounded inside the box as well as by the caller.
    expect(provider.commands.find((cmd) => cmd.includes("OPENGENI_WORKSPACE_SIZE_V1"))).toContain(
      "timeout 15 find",
    );
  }, 60_000);

  test("near the pre-deadline save window a failure is not measured, so no walk competes with the last save", async () => {
    if (!available) return;
    const epoch = 7;
    const instanceId = "sb-window-no-walk";
    const ids = await drainingModalLease(epoch, instanceId);
    const leadMs = sandboxDeadlineMandatoryCaptureLeadMs(SETTINGS);
    // The window opens in 5 s: a walk now could still be running then.
    await shared!.admin`
      update sandbox_leases
      set provider_created_at = now() - interval '23 hours',
          provider_deadline_at = now() + ${`${leadMs + 5_000} milliseconds`}::interval
      where sandbox_group_id = ${ids.groupId}`;
    const provider = modalLikeClient(async () => {
      throw new Error("Modal snapshot_directory persistence timed out.");
    });
    const recorded = recordingServices();
    const { drainSandboxLease } = createSandboxLeaseActivities(recorded.services, {
      createClientForBackend: (() => provider.client) as never,
      probeDrainableProvider: async () => "ready",
    });
    currentAttempt += 1;
    await expect(drainSandboxLease(drainInput(ids, epoch, instanceId))).rejects.toThrow(
      "persistence timed out",
    );
    await Bun.sleep(50);
    expect(
      recorded.counters.filter(
        (entry) => entry.name === "opengeni_sandbox_drain_capture_failures_total",
      ),
    ).toHaveLength(1);
    expect(provider.commands.some((cmd) => cmd.includes("OPENGENI_WORKSPACE_SIZE_V1"))).toBe(false);
  }, 60_000);

  test("a portable archive's own tree size is observed when the drain captures it", async () => {
    if (!available) return;
    const epoch = 2;
    const instanceId = "sb-observed-capture";
    const ids = await drainingModalLease(epoch, instanceId);
    const provider = modalLikeClient(async () => new TextEncoder().encode("workspace tar bytes"));
    const recorded = recordingServices();
    const { drainSandboxLease } = createSandboxLeaseActivities(recorded.services, {
      createClientForBackend: (() => provider.client) as never,
      probeDrainableProvider: async () => "ready",
    });
    currentAttempt += 1;
    expect(await drainSandboxLease(drainInput(ids, epoch, instanceId))).toEqual({
      status: "terminated",
    });
    const sizes = recorded.histograms.filter((entry) =>
      entry.name.startsWith("opengeni_sandbox_workspace_snapshot_"),
    );
    expect(sizes).toEqual([
      {
        name: "opengeni_sandbox_workspace_snapshot_bytes",
        labels: { backend: "modal", outcome: "captured" },
        value: 17,
      },
      {
        name: "opengeni_sandbox_workspace_snapshot_files",
        labels: { backend: "modal", outcome: "captured" },
        value: 2,
      },
    ]);
    // Success needs no extra walk of the workspace.
    expect(provider.commands.some((cmd) => cmd.includes("OPENGENI_WORKSPACE_SIZE_V1"))).toBe(false);
    expect(
      recorded.counters.some(
        (entry) => entry.name === "opengeni_sandbox_drain_capture_failures_total",
      ),
    ).toBe(false);
  }, 60_000);

  test("a snapshot slower than the wait that later fails is counted and measured", async () => {
    if (!available) return;
    const epoch = 3;
    const instanceId = "sb-observed-late-failure";
    const ids = await drainingModalLease(epoch, instanceId);
    const provider = modalLikeClient(async () => {
      await Bun.sleep(6_000);
      throw new Error("Modal snapshot_directory persistence timed out.");
    });
    const recorded = recordingServices();
    const { drainSandboxLease } = createSandboxLeaseActivities(recorded.services, {
      createClientForBackend: (() => provider.client) as never,
      probeDrainableProvider: async () => "ready",
    });
    currentAttempt += 1;
    // The 5 s wait ends first; the snapshot keeps running and fails later.
    await drainSandboxLease(drainInput(ids, epoch, instanceId)).catch(() => undefined);
    const failed = () =>
      recorded.histograms.filter(
        (entry) =>
          entry.name === "opengeni_sandbox_workspace_snapshot_files" &&
          entry.labels.outcome === "failed",
      );
    const counted = () =>
      recorded.histograms
        .filter((entry) => entry.name === "opengeni_sandbox_drain_capture_consecutive_failures")
        .map((entry) => entry.value);
    for (
      let waited = 0;
      waited < 20_000 && (failed().length === 0 || counted().length === 0);
      waited += 100
    ) {
      await Bun.sleep(100);
    }
    expect(failed()).toEqual([
      {
        name: "opengeni_sandbox_workspace_snapshot_files",
        labels: { backend: "modal", outcome: "failed" },
        value: 182_733,
      },
    ]);
    expect(counted()).toEqual([1]);
  }, 60_000);
});

test("a metrics sink without histograms, or one that throws, never breaks a drain", () => {
  const counted: string[] = [];
  const partial = {
    incrementCounter: (input: { name: string }) => counted.push(input.name),
  } as unknown as Parameters<typeof recordSandboxDrainCaptureFailure>[0];
  expect(() =>
    recordSandboxDrainCaptureFailure(partial, { backend: "modal", consecutiveFailures: 2 }),
  ).not.toThrow();
  expect(counted).toEqual(["opengeni_sandbox_drain_capture_failures_total"]);
  expect(() =>
    recordSandboxWorkspaceSnapshotSize(partial, {
      backend: "modal",
      outcome: "captured",
      fileCount: 10,
      totalFileBytes: 100,
    }),
  ).not.toThrow();
  const throwing = {
    incrementCounter() {
      throw new Error("sink down");
    },
    observeHistogram() {
      throw new Error("sink down");
    },
  } as unknown as Parameters<typeof recordSandboxDrainCaptureFailure>[0];
  expect(() =>
    recordSandboxDrainCaptureFailure(throwing, { backend: "modal", consecutiveFailures: 1 }),
  ).not.toThrow();
});
