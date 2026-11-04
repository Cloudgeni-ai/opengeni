// Regression (DC-G3): a box whose Modal snapshots kept failing stayed draining
// until Modal's 24 h kill. Nothing tried a smaller save, nothing ended the box
// deliberately, and nobody was told that its latest files were not kept.
//
// These tests run the real drain activity and the real provider teardown
// against PostgreSQL. Only the Modal client is a fake: its native snapshot
// always fails, and its portable tar (the path a save that leaves folders out
// takes) succeeds or fails as each test needs.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { Context } from "@temporalio/activity";
import {
  acquireLease,
  bootstrapWorkspace,
  createDb,
  createSession,
  readLease,
  readSandboxReducedSave,
  reArmDrainingLease,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { sandboxDeadlineMandatoryCaptureLeadMs } from "@opengeni/config";
import { createObservability } from "@opengeni/observability";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createSandboxLeaseActivities } from "../src/activities/sandbox-lease";
import { reducedWorkspaceSaveNote } from "../src/activities/run-input";
import type { ActivityServices } from "../src/activities/types";

const TEST_WORKSPACE_FINGERPRINT =
  "OPENGENI_WORKSPACE_FINGERPRINT_V1 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 3 2 17\n";
const REBUILDABLE = "OPENGENI_REBUILDABLE_V1 12 3456 2 0\nD node_modules\nD apps/web/.next\n";
const WAIT_MS = 5_000;

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | undefined;
let db: Database;
let available = true;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-drain-snapshot-fallback");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[worker-drain-snapshot-fallback] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
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

/** A complete earlier save of this workspace, as a published drain leaves it. */
function priorSave(capturedAt: string) {
  const bytes = Buffer.from(`earlier workspace ${crypto.randomUUID()}`);
  const archiveSha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    workspaceArchive: bytes.toString("base64"),
    workspaceArchiveMeta: {
      version: 1 as const,
      revision: `wa1:${Date.parse(capturedAt)}:${archiveSha256}`,
      archiveSha256,
      archiveBytes: bytes.length,
      capturedAt,
      workspace: {
        algorithm: "sha256" as const,
        sha256: archiveSha256,
        entryCount: 1,
        fileCount: 1,
        totalFileBytes: bytes.length,
      },
    },
  };
}

/** A draining Modal box using native directory snapshots, in a real session. */
async function drainingNativeModalBox(
  epoch: number,
  instanceId: string,
  failures: { count: number; failingForMinutes: number },
  prior?: ReturnType<typeof priorSave>,
) {
  const unique = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "test",
    accountExternalId: unique,
    accountName: "drain fallback",
    workspaceExternalSource: "test",
    workspaceExternalId: unique,
    workspaceName: "drain fallback",
    subjectId: `subject-${unique}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "modal",
  });
  const ids = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    groupId: session.sandboxGroupId,
    sessionId: session.id,
  };
  const resumeState = {
    backendId: "modal",
    sessionState: {
      providerState: { sandboxId: instanceId },
      workspacePersistence: "snapshot_directory",
      ...(prior ?? {}),
    },
  };
  await shared!.admin`
    insert into sandbox_leases (
      account_id, workspace_id, sandbox_group_id, liveness, refcount,
      turn_holders, viewer_holders, instance_id, backend, lease_epoch,
      resume_backend_id, resume_state, expires_at,
      drain_capture_failures, drain_capture_failure_epoch,
      drain_capture_first_failed_at, drain_capture_last_failed_at
    ) values (
      ${ids.accountId}, ${ids.workspaceId}, ${ids.groupId}, 'draining', 0, 0, 0,
      ${instanceId}, 'modal', ${epoch}, 'modal',
      ${JSON.stringify(resumeState)}::text::jsonb,
      now() - interval '1 second',
      ${failures.count}, ${epoch},
      now() - ${`${failures.failingForMinutes} minutes`}::interval,
      now() - interval '10 minutes'
    )`;
  return ids;
}

/** Modal-like client: native snapshots always fail; a capture that leaves
 * folders out goes through the portable tar, which `tar` decides. */
function nativeSnapshotsFailingClient(
  tar: "succeeds" | "fails",
  rebuildable: string = REBUILDABLE,
) {
  const captures: string[][] = [];
  const sessions: Array<{ state: { manifest: { ephemeralPersistencePaths(): Set<string> } } }> = [];
  let deletes = 0;
  const resume = async (state: { sandboxId?: unknown }) => {
    const session = {
      state: {
        sandboxId: state.sandboxId,
        workspacePersistence: "snapshot_directory",
        snapshotFilesystemTimeoutMs: WAIT_MS,
        manifest: {
          root: "/workspace",
          ephemeralPersistencePaths: () => new Set<string>(),
        },
      },
      exec: async ({ cmd }: { cmd: string }) => ({
        stdout: cmd.includes("OPENGENI_REBUILDABLE_V1") ? rebuildable : TEST_WORKSPACE_FINGERPRINT,
      }),
      persistWorkspace: async () => {
        const excluded = [...session.state.manifest.ephemeralPersistencePaths()];
        captures.push(excluded);
        if (excluded.length === 0) throw new Error("Modal snapshot_directory persistence failed.");
        if (tar === "fails") throw new Error("reduced tar failed");
        return new TextEncoder().encode("reduced workspace tar bytes");
      },
      kill: async () => {},
      closed: false,
      modal: {
        images: { delete: async () => {} },
        profile: { serverUrl: "https://modal.test" },
        environmentName: (environment?: string) => environment ?? "",
        cpClient: { workspaceNameLookup: async () => ({ workspaceName: "drain-fallback-test" }) },
      },
    };
    sessions.push(session);
    return session;
  };
  return {
    captures,
    sessions,
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

async function terminatedEvents(sessionId: string) {
  const rows = await shared!.admin<{ payload: Record<string, unknown> }[]>`
    select payload from session_events
    where session_id = ${sessionId} and type = 'sandbox.box.terminated'`;
  return rows.map((row) => row.payload);
}

describe("drain snapshot fallback", () => {
  test("after repeated failed snapshots, a save without rebuildable folders drains the box", async () => {
    if (!available) return;
    const epoch = 3;
    const instanceId = "sb-reduced-save";
    const ids = await drainingNativeModalBox(epoch, instanceId, {
      count: 3,
      failingForMinutes: 20,
    });
    const provider = nativeSnapshotsFailingClient("succeeds");
    const { drainSandboxLease } = createSandboxLeaseActivities(services(), {
      createClientForBackend: (() => provider.client) as never,
      probeDrainableProvider: async () => "ready",
    });
    currentAttempt = 2;
    expect(await drainSandboxLease(drainInput(ids, epoch, instanceId))).toEqual({
      status: "terminated",
    });
    // One capture, leaving out exactly the rebuildable folders; the live
    // session's own exclusions are restored afterwards.
    expect(provider.captures).toEqual([["apps/web/.next", "node_modules"]]);
    expect([...provider.sessions[0]!.state.manifest.ephemeralPersistencePaths()]).toEqual([]);
    expect(provider.deletes).toBe(1);
    const lease = await readLease(db, ids.workspaceId, ids.groupId);
    expect(lease?.liveness).toBe("cold");
    expect(lease?.recovery.archive.status).toBe("available");
    const saved = lease?.recovery.archive.current;
    expect(saved?.version === 1 ? saved.omittedPaths : null).toEqual([
      "apps/web/.next",
      "node_modules",
    ]);
    expect(await terminatedEvents(ids.sessionId)).toEqual([
      expect.objectContaining({
        persisted: true,
        omittedPaths: ["apps/web/.next", "node_modules"],
      }),
    ]);
    // The model is told on its next turn which folders to rebuild.
    const reduced = await readSandboxReducedSave(db, ids.workspaceId, ids.sessionId);
    expect(reduced).toEqual({
      capturedAt: saved!.capturedAt,
      omittedPaths: ["apps/web/.next", "node_modules"],
    });
    expect(reducedWorkspaceSaveNote(reduced!)).toBe(
      `Workspace note: this workspace was last saved at ${saved!.capturedAt} without these folders, which can be rebuilt: apps/web/.next, node_modules. If they are missing, reinstall dependencies or rebuild before relying on them.`,
    );
  }, 60_000);

  test("when the reduced save fails after an hour of failures, the box is stopped and the loss recorded", async () => {
    if (!available) return;
    const epoch = 4;
    const instanceId = "sb-abandoned-save";
    const prior = priorSave("2026-11-04T00:56:00.000Z");
    const ids = await drainingNativeModalBox(
      epoch,
      instanceId,
      { count: 4, failingForMinutes: 90 },
      prior,
    );
    const provider = nativeSnapshotsFailingClient("fails");
    const { drainSandboxLease } = createSandboxLeaseActivities(services(), {
      createClientForBackend: (() => provider.client) as never,
      probeDrainableProvider: async () => "ready",
    });
    currentAttempt = 2;
    expect(await drainSandboxLease(drainInput(ids, epoch, instanceId))).toEqual({
      status: "terminated",
    });
    expect(provider.captures).toEqual([["apps/web/.next", "node_modules"]]);
    expect(provider.deletes).toBe(1);
    const lease = await readLease(db, ids.workspaceId, ids.groupId);
    expect(lease?.liveness).toBe("cold");
    expect(lease?.recovery.provider.status).toBe("missing");
    const [row] = await shared!.admin<{ loss: Record<string, unknown> | null }[]>`
      select resume_state -> 'opengeniProviderLoss' as loss
      from sandbox_leases where sandbox_group_id = ${ids.groupId}`;
    expect(row?.loss).toMatchObject({ source: "drain_probe", captureAbandoned: true });
    expect(await terminatedEvents(ids.sessionId)).toEqual([
      expect.objectContaining({
        persisted: false,
        captureAbandoned: true,
        unsavedSince: prior.workspaceArchiveMeta.capturedAt,
      }),
    ]);
  }, 60_000);

  test("a reduced save that fails before an hour of failures leaves the box draining", async () => {
    if (!available) return;
    const epoch = 5;
    const instanceId = "sb-reduced-retry";
    const ids = await drainingNativeModalBox(epoch, instanceId, {
      count: 3,
      failingForMinutes: 20,
    });
    const provider = nativeSnapshotsFailingClient("fails");
    const { drainSandboxLease } = createSandboxLeaseActivities(services(), {
      createClientForBackend: (() => provider.client) as never,
      probeDrainableProvider: async () => "ready",
    });
    currentAttempt = 2;
    await expect(drainSandboxLease(drainInput(ids, epoch, instanceId))).rejects.toThrow(
      "reduced tar failed",
    );
    expect(provider.captures).toEqual([["apps/web/.next", "node_modules"]]);
    expect(provider.deletes).toBe(0);
    const lease = await readLease(db, ids.workspaceId, ids.groupId);
    expect(lease?.liveness).toBe("draining");
    expect(lease?.archiveCapture).toBeNull();
    expect(lease?.drainCaptureFailures?.count).toBe(4);
  }, 60_000);

  test("inside the pre-deadline save window one failure is enough for the reduced save", async () => {
    if (!available) return;
    const epoch = 6;
    const instanceId = "sb-window-reduced";
    const ids = await drainingNativeModalBox(epoch, instanceId, {
      count: 1,
      failingForMinutes: 5,
    });
    const leadMs = sandboxDeadlineMandatoryCaptureLeadMs(SETTINGS);
    await shared!.admin`
      update sandbox_leases
      set provider_created_at = now() - interval '23 hours',
          provider_deadline_at = now() + ${`${Math.max(1_000, leadMs - 60_000)} milliseconds`}::interval
      where sandbox_group_id = ${ids.groupId}`;
    const provider = nativeSnapshotsFailingClient("succeeds");
    const { drainSandboxLease } = createSandboxLeaseActivities(services(), {
      createClientForBackend: (() => provider.client) as never,
      probeDrainableProvider: async () => "ready",
    });
    currentAttempt = 2;
    expect(await drainSandboxLease(drainInput(ids, epoch, instanceId))).toEqual({
      status: "terminated",
    });
    expect(provider.captures).toEqual([["apps/web/.next", "node_modules"]]);
  }, 60_000);
  test("three quick failures are not enough: the drain retries a full snapshot", async () => {
    if (!available) return;
    const epoch = 7;
    const instanceId = "sb-quick-failures";
    const ids = await drainingNativeModalBox(epoch, instanceId, {
      count: 3,
      failingForMinutes: 5,
    });
    const provider = nativeSnapshotsFailingClient("succeeds");
    const { drainSandboxLease } = createSandboxLeaseActivities(services(), {
      createClientForBackend: (() => provider.client) as never,
      probeDrainableProvider: async () => "ready",
    });
    currentAttempt = 2;
    await expect(drainSandboxLease(drainInput(ids, epoch, instanceId))).rejects.toThrow(
      "snapshot_directory persistence failed",
    );
    // A full snapshot, nothing left out, and the box keeps draining.
    expect(provider.captures).toEqual([[]]);
    expect(provider.deletes).toBe(0);
  }, 60_000);

  test("with nothing a reduced save could leave out, the box is not stopped before the save window", async () => {
    if (!available) return;
    const epoch = 8;
    const instanceId = "sb-unavailable-outside-window";
    const ids = await drainingNativeModalBox(
      epoch,
      instanceId,
      { count: 4, failingForMinutes: 90 },
      priorSave("2026-11-04T00:56:00.000Z"),
    );
    const provider = nativeSnapshotsFailingClient(
      "succeeds",
      "OPENGENI_REBUILDABLE_V1 12 3456 0 0\n",
    );
    const { drainSandboxLease } = createSandboxLeaseActivities(services(), {
      createClientForBackend: (() => provider.client) as never,
      probeDrainableProvider: async () => "ready",
    });
    currentAttempt = 2;
    await expect(drainSandboxLease(drainInput(ids, epoch, instanceId))).rejects.toThrow(
      "snapshot_directory persistence failed",
    );
    expect(provider.captures).toEqual([[]]);
    expect(provider.deletes).toBe(0);
    expect((await readLease(db, ids.workspaceId, ids.groupId))?.liveness).toBe("draining");
    expect(await terminatedEvents(ids.sessionId)).toEqual([]);
  }, 60_000);

  test("inside the save window with no reduced save possible, the box is stopped and the loss explained", async () => {
    if (!available) return;
    const epoch = 9;
    const instanceId = "sb-unavailable-in-window";
    const prior = priorSave("2026-11-04T01:10:00.000Z");
    const ids = await drainingNativeModalBox(
      epoch,
      instanceId,
      { count: 1, failingForMinutes: 5 },
      prior,
    );
    const leadMs = sandboxDeadlineMandatoryCaptureLeadMs(SETTINGS);
    await shared!.admin`
      update sandbox_leases
      set provider_created_at = now() - interval '23 hours',
          provider_deadline_at = now() + ${`${Math.max(1_000, leadMs - 60_000)} milliseconds`}::interval
      where sandbox_group_id = ${ids.groupId}`;
    const provider = nativeSnapshotsFailingClient(
      "succeeds",
      "OPENGENI_REBUILDABLE_V1 12 3456 0 0\n",
    );
    const { drainSandboxLease } = createSandboxLeaseActivities(services(), {
      createClientForBackend: (() => provider.client) as never,
      probeDrainableProvider: async () => "ready",
    });
    currentAttempt = 2;
    expect(await drainSandboxLease(drainInput(ids, epoch, instanceId))).toEqual({
      status: "terminated",
    });
    expect(provider.captures).toEqual([]);
    expect(provider.deletes).toBe(1);
    const [row] = await shared!.admin<{ loss: Record<string, unknown> | null }[]>`
      select resume_state -> 'opengeniProviderLoss' as loss
      from sandbox_leases where sandbox_group_id = ${ids.groupId}`;
    expect(row?.loss).toMatchObject({
      captureAbandoned: true,
      unsavedSince: prior.workspaceArchiveMeta.capturedAt,
    });
    // Written in the cold commit itself, together with the loss.
    expect(await terminatedEvents(ids.sessionId)).toEqual([
      expect.objectContaining({
        captureAbandoned: true,
        unsavedSince: prior.workspaceArchiveMeta.capturedAt,
      }),
    ]);
  }, 60_000);

  for (const rearm of ["arrival", "reArmDrainingLease"] as const) {
    test(`a re-arm (${rearm}) clears the drain's failures, so a later drain starts with a full snapshot`, async () => {
      if (!available) return;
      const epoch = rearm === "arrival" ? 10 : 11;
      const instanceId = `sb-rearm-${rearm}`;
      const ids = await drainingNativeModalBox(epoch, instanceId, {
        count: 5,
        failingForMinutes: 90,
      });
      const group = {
        accountId: ids.accountId,
        workspaceId: ids.workspaceId,
        sandboxGroupId: ids.groupId,
      };
      if (rearm === "arrival") {
        const acquired = await acquireLease(db, {
          ...group,
          kind: "turn",
          holderId: `turn-${crypto.randomUUID()}`,
          backend: "modal",
          leaseTtlMs: 60_000,
        });
        expect(acquired.role).toBe("rearmed");
      } else {
        expect(await reArmDrainingLease(db, { ...group, leaseTtlMs: 60_000 })).toEqual({
          rearmed: true,
        });
      }
      const lease = await readLease(db, ids.workspaceId, ids.groupId);
      expect(lease?.liveness).toBe("warm");
      expect(lease?.drainCaptureFailures).toEqual({
        count: 0,
        firstFailedAt: null,
        lastFailedAt: null,
      });
    }, 60_000);
  }
});
