import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  acquireLease,
  commitWarmingToWarm,
  createDb,
  createSession,
  insertFailedWorkspaceCapture,
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
});

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('workspace-capture-account') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'workspace-capture-workspace') returning id`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

describe("workspace capture degraded revisions (real PostgreSQL + FORCE RLS)", () => {
  test("failed discovery marker is epoch-fenced, monotonic, and blob-free", async () => {
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
    expect(await insertFailedWorkspaceCapture(db, { ...input, expectedEpoch: liveEpoch })).toEqual({
      revision: 0,
    });

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
  }, 60_000);
});
