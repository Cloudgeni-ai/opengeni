import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  acquireLease,
  commitWarmingToWarm,
  createDb,
  createSession,
  insertFailedWorkspaceCapture,
  insertWorkspaceCapture,
  listSessionEvents,
  latestWorkspaceCapture,
  type Database,
  type DbClient,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("workspace-captures");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[workspace-captures] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
    console.warn("[workspace-captures] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('workspace-capture-account') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'workspace-capture-workspace') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

describe("workspace capture revisions (real PostgreSQL + FORCE RLS)", () => {
  test("capture rows and announcements commit together behind the lease epoch fence", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const session = await createSession(db, {
      ...workspace,
      initialMessage: "capture repositories",
      resources: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "none",
    });
    const sandboxGroupId = session.sandboxGroupId;
    const acquired = await acquireLease(db, {
      ...workspace,
      sandboxGroupId,
      kind: "turn",
      holderId: "turn-capture",
      backend: "none",
      leaseTtlMs: 45_000,
    });
    expect(acquired.role).toBe("spawner");
    const committed = await commitWarmingToWarm(db, {
      ...workspace,
      sandboxGroupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId: "box-capture",
      leaseTtlMs: 45_000,
    });
    expect(committed.committed).toBe(true);
    const liveEpoch = committed.lease!.leaseEpoch;

    const [trigger] = await admin<{ id: string }[]>`
      insert into session_events
        (account_id, workspace_id, session_id, sequence, type, payload)
      values
        (${workspace.accountId}, ${workspace.workspaceId}, ${session.id}, 1,
         'user.message', ${JSON.stringify({ text: "capture repositories" })}::jsonb)
      returning id`;
    expect(trigger).toBeDefined();
    await admin`
      update sessions set last_sequence = 1
      where workspace_id = ${workspace.workspaceId} and id = ${session.id}`;
    const [turn] = await admin<{ id: string; execution_generation: number }[]>`
      insert into session_turns
        (account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
         status, source, position, prompt, resources, tools, model, reasoning_effort,
         sandbox_backend, metadata, lineage)
      values
        (${workspace.accountId}, ${workspace.workspaceId}, ${session.id}, ${trigger!.id},
         ${`session-${session.id}`}, 'completed', 'user', 0, 'capture repositories',
         '[]'::jsonb, '[]'::jsonb, 'test-model', 'medium', 'none', '{}'::jsonb, '{}'::jsonb)
      returning id, execution_generation`;
    expect(turn).toBeDefined();
    const attemptId = randomUUID();
    await admin`
      insert into session_turn_attempts
        (id, account_id, workspace_id, session_id, turn_id, execution_generation,
         state, outcome, temporal_workflow_id, temporal_workflow_run_id,
         temporal_activity_id, verified_control_revision, mcp_approval_policies, closed_at)
      values
        (${attemptId}, ${workspace.accountId}, ${workspace.workspaceId}, ${session.id},
         ${turn!.id}, ${turn!.execution_generation}, 'closed', 'completed',
         ${`session-${session.id}`}, 'capture-test-run', 'capture-test-activity', 0,
         '{}'::jsonb, now())`;

    const input = {
      ...workspace,
      sessionId: session.id,
      turnId: turn!.id,
      attemptId,
      sandboxGroupId,
      revision: 0,
      stats: {
        degradedReason: "repository_discovery_timed_out",
        discoveredRepoCount: 0,
        durationMs: 15_000,
      },
    };
    expect(
      await insertFailedWorkspaceCapture(db, {
        ...input,
        expectedEpoch: liveEpoch + 1,
      }),
    ).toBeNull();
    const captureCommit = await insertFailedWorkspaceCapture(db, {
      ...input,
      expectedEpoch: liveEpoch,
    });
    expect(captureCommit).not.toBeNull();
    expect(captureCommit!.revision).toBe(0);
    expect(captureCommit!.events).toEqual([
      expect.objectContaining({
        type: "workspace.revision.degraded",
        turnId: turn!.id,
        turnGeneration: turn!.execution_generation,
        turnAttemptId: attemptId,
        turnAssociation: null,
        clientEventId: "opengeni:workspace-capture:0",
        payload: expect.objectContaining({
          revision: 0,
          leaseEpoch: liveEpoch,
          reason: "repository_discovery_timed_out",
        }),
      }),
    ]);

    const latest = await latestWorkspaceCapture(db, workspace.workspaceId, session.id);
    expect(latest).toMatchObject({
      revision: 0,
      leaseEpoch: liveEpoch,
      state: "failed",
      manifestKey: null,
      treeIndexKey: null,
      blobKeys: [],
      sizeBytes: 0,
      stats: input.stats,
    });
    const [count] = await admin<{ count: number }[]>`
      select count(*)::int as count from workspace_captures where session_id = ${session.id}`;
    expect(count?.count).toBe(1);
    const events = await listSessionEvents(db, workspace.workspaceId, session.id);
    expect(events.filter((event) => event.type === "workspace.revision.degraded")).toEqual(
      captureCommit!.events,
    );

    const capturedAt = new Date("2026-07-15T16:40:22.580Z");
    const availableCommit = await insertWorkspaceCapture(db, {
      ...workspace,
      sessionId: session.id,
      turnId: turn!.id,
      attemptId,
      sandboxGroupId,
      expectedEpoch: liveEpoch,
      revision: 1,
      manifestKey: "workspace/manifests/1.json",
      treeIndexKey: "workspace/trees/1.json",
      blobKeys: ["workspace/blobs/sha256/content"],
      sizeBytes: 123,
      stats: {
        fingerprint: "capture-1",
        discoveredRepoCount: 1,
        changedFileCount: 1,
        durationMs: 850,
      },
      capturedAt,
    });
    expect(availableCommit).not.toBeNull();
    expect(availableCommit!.events).toEqual([
      expect.objectContaining({
        sequence: captureCommit!.events[0]!.sequence + 1,
        type: "workspace.revision.captured",
        turnId: turn!.id,
        turnGeneration: turn!.execution_generation,
        turnAttemptId: attemptId,
        turnAssociation: null,
        clientEventId: "opengeni:workspace-capture:1",
        payload: expect.objectContaining({
          revision: 1,
          capturedAt: capturedAt.toISOString(),
          leaseEpoch: liveEpoch,
          stats: expect.objectContaining({ fingerprint: "capture-1" }),
        }),
      }),
    ]);
    expect(await latestWorkspaceCapture(db, workspace.workspaceId, session.id)).toMatchObject({
      revision: 1,
      state: "available",
      manifestKey: "workspace/manifests/1.json",
      treeIndexKey: "workspace/trees/1.json",
      blobKeys: ["workspace/blobs/sha256/content"],
      sizeBytes: 123,
      capturedAt: capturedAt.toISOString(),
    });
    expect(
      (await listSessionEvents(db, workspace.workspaceId, session.id)).filter((event) =>
        event.type.startsWith("workspace.revision."),
      ),
    ).toEqual([...captureCommit!.events, ...availableCommit!.events]);

    await admin`
      update session_turn_attempts
      set outcome = 'lease_lost_recoverable'
      where id = ${attemptId}`;
    await admin`
      update session_turns
      set status = 'recovering'
      where id = ${turn!.id}`;
    expect(
      await insertWorkspaceCapture(db, {
        ...workspace,
        sessionId: session.id,
        turnId: turn!.id,
        attemptId,
        sandboxGroupId,
        expectedEpoch: liveEpoch,
        revision: 2,
        manifestKey: "workspace/manifests/recovery.json",
        treeIndexKey: "workspace/trees/recovery.json",
        blobKeys: [],
        sizeBytes: 1,
        stats: { fingerprint: "recovery-must-not-commit" },
      }),
    ).toBeNull();
    await admin`
      update session_turn_attempts
      set outcome = 'completed'
      where id = ${attemptId}`;
    await admin`
      update session_turns
      set status = 'completed'
      where id = ${turn!.id}`;

    const [receipt] = await admin<{ id: string }[]>`
      insert into session_command_receipts
        (account_id, workspace_id, actor_type, actor_subject_id, action,
         target_session_id, target_turn_id, operation_key, canonical_request_hash)
      values
        (${workspace.accountId}, ${workspace.workspaceId}, 'human', 'capture-fence-test',
         'session.queue.steer', ${session.id}, ${turn!.id}, ${randomUUID()}, 'capture-fence')
      returning id`;
    let markControlLocked: (() => void) | undefined;
    const controlLocked = new Promise<void>((resolve) => {
      markControlLocked = resolve;
    });
    let allowControlCommit: (() => void) | undefined;
    const controlMayCommit = new Promise<void>((resolve) => {
      allowControlCommit = resolve;
    });
    const controlTransaction = admin.begin(async (controlDb) => {
      await controlDb`
        select workspace_id from workspace_inference_controls
        where workspace_id = ${workspace.workspaceId}
        for update`;
      markControlLocked?.();
      await controlMayCommit;
      await controlDb`
        insert into session_attempt_interruptions
          (account_id, workspace_id, session_id, operation_id, attempt_id,
           kind, control_revision)
        values
          (${workspace.accountId}, ${workspace.workspaceId}, ${session.id}, ${receipt!.id},
           ${attemptId}, 'steer', 1)`;
    });
    await controlLocked;
    let captureSettled = false;
    const captureBehindControl = insertWorkspaceCapture(db, {
      ...workspace,
      sessionId: session.id,
      turnId: turn!.id,
      attemptId,
      sandboxGroupId,
      expectedEpoch: liveEpoch,
      revision: 2,
      manifestKey: "workspace/manifests/2.json",
      treeIndexKey: "workspace/trees/2.json",
      blobKeys: [],
      sizeBytes: 1,
      stats: { fingerprint: "must-not-commit" },
    }).finally(() => {
      captureSettled = true;
    });
    await Bun.sleep(25);
    expect(captureSettled).toBe(false);
    allowControlCommit?.();
    await controlTransaction;
    expect(await captureBehindControl).toBeNull();
    expect(
      await insertWorkspaceCapture(db, {
        ...workspace,
        sessionId: session.id,
        turnId: turn!.id,
        attemptId,
        sandboxGroupId,
        expectedEpoch: liveEpoch,
        revision: 2,
        manifestKey: "workspace/manifests/2.json",
        treeIndexKey: "workspace/trees/2.json",
        blobKeys: [],
        sizeBytes: 1,
        stats: { fingerprint: "must-not-commit" },
      }),
    ).toBeNull();
    const [afterInterruption] = await admin<{ count: number }[]>`
      select count(*)::int as count from workspace_captures where session_id = ${session.id}`;
    expect(afterInterruption?.count).toBe(2);
  }, 60_000);
});
