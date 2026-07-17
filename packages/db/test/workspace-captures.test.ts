import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
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

    const input = {
      ...workspace,
      sessionId: session.id,
      turnId: null,
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
        turnId: null,
        turnGeneration: null,
        turnAttemptId: null,
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
      turnId: null,
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
        turnId: null,
        turnGeneration: null,
        turnAttemptId: null,
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
  }, 60_000);
});
