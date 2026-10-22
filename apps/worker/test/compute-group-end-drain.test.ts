// Opengeni compute keeps a sandbox's memory and disk, so its workspace is
// never captured to keep it. When its group ends (the chat or workspace was
// deleted) the drain deletes the sandbox without a capture, still under the
// exact capture fence; a rotation of the same lease still captures first.
// Drives the real drain activity and lease ledger against PostgreSQL; only the
// provider teardown is faked.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import type { Settings } from "@opengeni/config";
import { createDb, createSession, readLease, type Database, type DbClient } from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import {
  createSandboxLeaseActivities,
  type DrainCaptureDisposition,
  type TerminateBoxFn,
} from "../src/activities/sandbox-lease";
import type { ActivityServices } from "../src/activities/types";

const EPOCH = 7;
const SETTINGS = testSettings({
  webSearchEnabled: false,
  sandboxOwnershipEnabled: true,
  sandboxLeaseReaperPeriodMs: 30_000,
});

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-compute-group-end-drain");
  if (!shared) throw new Error("Real PostgreSQL required for compute group-end drains");
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

function services(settings: Settings = SETTINGS): () => Promise<ActivityServices> {
  return async () => ({
    settings,
    db,
    bus: null as never,
    runtime: null as never,
    objectStorage: null,
    documentServices: null as never,
    observability: createObservability(settings, { component: "worker-test" }),
    wakeSessionWorkflow: null,
  });
}

/** A holderless compute lease already draining, as a deletion or rotation
 * leaves it. */
async function drainingComputeLease(reason: "group_end" | "rotation") {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('compute-group-end') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'compute-group-end')
    returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const ids = { accountId: account!.id, workspaceId: workspace!.id };
  const session = await createSession(db, {
    ...ids,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "compute",
  });
  const instanceId = `sbx-${crypto.randomUUID()}`;
  const [lease] = await admin<{ id: string }[]>`
    insert into sandbox_leases (account_id, workspace_id, sandbox_group_id, liveness, refcount,
      turn_holders, viewer_holders, instance_id, backend, lease_epoch, resume_backend_id,
      resume_state, expires_at, group_end_requested_at, rotation_requested_at, rotation_reason)
    values (${ids.accountId}, ${ids.workspaceId}, ${session.sandboxGroupId}, 'draining', 0, 0, 0,
      ${instanceId}, 'compute', ${EPOCH}, 'compute',
      ${JSON.stringify({
        backendId: "compute",
        sessionState: { sandboxId: instanceId, enrollmentId: crypto.randomUUID() },
      })}::text::jsonb,
      now() - interval '1 second',
      ${reason === "group_end" ? new Date() : null},
      ${reason === "rotation" ? new Date() : null},
      ${reason === "rotation" ? "operator" : null})
    returning id`;
  return { ...ids, sandboxGroupId: session.sandboxGroupId, instanceId, leaseId: lease!.id };
}

/** The provider seam: records the disposition it was asked for and does what
 * production does with it (fence check only, or a verified capture). */
function terminateSpy(beforeDelete?: () => Promise<void>) {
  const dispositions: Array<DrainCaptureDisposition | undefined> = [];
  const fn: TerminateBoxFn = async (
    _settings,
    _lease,
    _observability,
    persistArchive,
    _requestId,
    captureDisposition,
  ) => {
    dispositions.push(captureDisposition);
    if (captureDisposition === "discard") {
      await beforeDelete?.();
      const { wrote } = await persistArchive(null);
      return wrote;
    }
    return false;
  };
  return { fn, dispositions };
}

async function drain(
  fixture: Awaited<ReturnType<typeof drainingComputeLease>>,
  beforeDelete?: () => Promise<void>,
) {
  const spy = terminateSpy(beforeDelete);
  const activities = createSandboxLeaseActivities(services(), {
    terminateBox: spy.fn,
    probeDrainableProvider: async () => "alive" as never,
  });
  const result = await activities.drainSandboxLease({
    target: {
      workspaceId: fixture.workspaceId,
      sandboxGroupId: fixture.sandboxGroupId,
      instanceId: fixture.instanceId,
      leaseEpoch: EPOCH,
    },
    timeoutClass: "fast",
    snapshotTimeoutMs: 60_000,
    captureTimeoutMs: 120_000,
    operationId: crypto.randomUUID(),
  });
  return { result, dispositions: spy.dispositions };
}

describe("compute group end", () => {
  test("deletes the sandbox without a capture and settles the lease cold", async () => {
    const fixture = await drainingComputeLease("group_end");
    const drained = await drain(fixture);
    expect(drained.dispositions).toEqual(["discard"]);
    expect(drained.result.status).toBe("terminated");
    expect(await readLease(db, fixture.workspaceId, fixture.sandboxGroupId)).toMatchObject({
      liveness: "cold",
      groupEndRequestedAt: null,
    });
  }, 60_000);

  test("a rotating compute lease still captures before its sandbox goes", async () => {
    const fixture = await drainingComputeLease("rotation");
    const drained = await drain(fixture);
    expect(drained.dispositions).toEqual(["capture_required"]);
  }, 60_000);

  test("a rotation that commits just before the capture claim still gets its capture", async () => {
    const fixture = await drainingComputeLease("group_end");
    // An arrival with another image rotates the lease after the reaper read it
    // and before its capture claim took the row lock. The trigger plays that
    // arrival inside the claim's own row update, ahead of the claim's fence.
    await admin.unsafe(`
      create or replace function test_rotate_before_claim() returns trigger as $$
      begin
        if new.id = '${fixture.leaseId}'::uuid and old.archive_capture_id is null
          and new.archive_capture_id is not null then
          new.rotation_requested_at := now();
          new.rotation_reason := 'operator';
        end if;
        return new;
      end $$ language plpgsql`);
    await admin.unsafe(`
      create trigger a_test_rotate_before_claim before update on sandbox_leases
      for each row execute function test_rotate_before_claim()`);
    try {
      const raced = await drain(fixture);
      expect(raced.dispositions).toEqual(["capture_required"]);
    } finally {
      await admin.unsafe("drop trigger a_test_rotate_before_claim on sandbox_leases");
      await admin.unsafe("drop function test_rotate_before_claim()");
    }
  }, 60_000);

  test("the delete re-checks discard eligibility under the lease lock", async () => {
    const fixture = await drainingComputeLease("group_end");
    // Defence in depth: should a real rotation ever reach a claimed lease, the
    // null-archive fence refuses the delete and gives the claim back.
    const raced = await drain(fixture, async () => {
      await admin`update sandbox_leases
        set rotation_requested_at = now(), rotation_reason = 'operator'
        where id = ${fixture.leaseId}`;
    });
    expect(raced.dispositions).toEqual(["discard"]);
    expect(raced.result.status).not.toBe("terminated");
    const [held] = await admin<{ liveness: string; archive_capture_id: string | null }[]>`
      select liveness, archive_capture_id from sandbox_leases where id = ${fixture.leaseId}`;
    expect(held).toEqual({ liveness: "draining", archive_capture_id: null });

    // The next sweep captures instead of deleting.
    const next = await drain(fixture);
    expect(next.dispositions).toEqual(["capture_required"]);
  }, 60_000);
});
