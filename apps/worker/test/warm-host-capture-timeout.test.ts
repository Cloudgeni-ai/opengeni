// Regression (OPE-776): a slow host-backed (Docker/local) warm capture must not
// hold the durable capture claim, and therefore the workspace write fence, for
// its full physical duration. The local spool read is stopped at the snapshot
// timeout and the exact claim is released once those reads have ended. Drives
// the real warm-snapshot path against PostgreSQL; only file reads are slowed.

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs/promises";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  type Database,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  type SharedTestDatabase,
  testSettings,
} from "@opengeni/testing";
import {
  maybePersistWarmWorkspaceSnapshot,
  sandboxLeaseHolderIdForAttempt,
} from "../src/sandbox-resume";

const EPOCH = 7;
const SNAPSHOT_TIMEOUT_MS = 200;
const FILE_COUNT = 60;
const READ_DELAY_MS = 25;

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
const roots: string[] = [];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-warm-host-capture-timeout");
  if (!shared) throw new Error("Real PostgreSQL required for warm capture regressions");
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}, 180_000);

/** One running turn holding a warm Docker box whose workspace changed since
 * its last archive. */
async function runningTurnOnDirtyDockerBox() {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('warm-host-capture') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'warm-host-capture')
    returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const ids = { accountId: account!.id, workspaceId: workspace!.id };
  const session = await createSession(db, {
    ...ids,
    initialMessage: "keep editing files",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(db, {
    ...ids,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db, ids.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `warm-host-capture-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`fixture turn not claimed: ${claim.reason}`);
  const holderId = sandboxLeaseHolderIdForAttempt(attemptId);
  const instanceId = `container-${crypto.randomUUID()}`;
  const [lease] = await admin<{ id: string }[]>`
    insert into sandbox_leases (account_id, workspace_id, sandbox_group_id, liveness, refcount,
      turn_holders, viewer_holders, instance_id, backend, lease_epoch, resume_backend_id,
      resume_state, expires_at, workspace_generation)
    values (${ids.accountId}, ${ids.workspaceId}, ${session.sandboxGroupId}, 'warm', 1, 1, 0,
      ${instanceId}, 'docker', ${EPOCH}, 'docker',
      ${JSON.stringify({ backendId: "docker", sessionState: {} })}::text::jsonb,
      now() + interval '10 minutes', 1)
    returning id`;
  await admin`insert into sandbox_lease_holders
    (account_id, lease_id, workspace_id, kind, holder_id, subject_id, last_heartbeat_at)
    values (${ids.accountId}, ${lease!.id}, ${ids.workspaceId}, 'turn', ${holderId},
      ${session.id}, now())`;
  return {
    ...ids,
    sessionId: session.id,
    turnId: claim.turn.id,
    attemptId,
    sandboxGroupId: session.sandboxGroupId,
    leaseId: lease!.id,
  };
}

test.skipIf(process.platform !== "linux")(
  "a slow host-backed warm capture is stopped at the snapshot timeout and releases its exact claim",
  async () => {
    const fixture = await runningTurnOnDirtyDockerBox();
    const root = await realpath(await mkdtemp(join(tmpdir(), "warm-host-capture-")));
    roots.push(root);
    for (let index = 0; index < FILE_COUNT; index++) {
      await writeFile(join(root, `file-${String(index).padStart(3, "0")}`), `bytes ${index}`);
    }
    const session = {
      state: { workspaceRootPath: root },
      persistWorkspace: async () => {
        throw new Error("a host-backed workspace is captured from the host directory");
      },
    };
    const originalOpen = filesystem.open;
    let readsAfterSettlement = 0;
    let settledAt: number | null = null;
    const slowReads = spyOn(filesystem, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if ((await realpath(String(args[0])).catch(() => "")).startsWith(`${root}/file-`)) {
        const originalRead = handle.read;
        Object.defineProperty(handle, "read", {
          value: async (...readArgs: Parameters<typeof originalRead>) => {
            if (settledAt !== null) readsAfterSettlement++;
            await Bun.sleep(READ_DELAY_MS);
            return await Reflect.apply(originalRead, handle, readArgs);
          },
        });
      }
      return handle;
    });
    try {
      const startedAt = performance.now();
      const result = maybePersistWarmWorkspaceSnapshot(
        {
          db,
          settings: testSettings({
            sandboxSnapshotIntervalMs: 1,
            sandboxSnapshotTimeoutMs: SNAPSHOT_TIMEOUT_MS,
          }),
          // Present so the host spool path is selected; never reached.
          objectStorage: {} as never,
        },
        {
          accountId: fixture.accountId,
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          turnId: fixture.turnId,
          attemptId: fixture.attemptId,
          sandboxGroupId: fixture.sandboxGroupId,
        },
        session,
        EPOCH,
      );
      expect(await result).toBe(false);
      await result.settled;
      settledAt = performance.now();
      // An uninterrupted capture reads every file at least twice.
      const uninterruptedMs = 2 * FILE_COUNT * READ_DELAY_MS;
      expect(settledAt - startedAt).toBeLessThan(uninterruptedMs / 2);

      const [lease] = await admin<
        { archive_capture_id: string | null; archive_generation: number | null }[]
      >`select archive_capture_id, archive_generation from sandbox_leases
        where id = ${fixture.leaseId}`;
      expect(lease).toEqual({ archive_capture_id: null, archive_generation: null });

      await Bun.sleep(4 * READ_DELAY_MS);
      expect(readsAfterSettlement).toBe(0);
    } finally {
      slowReads.mockRestore();
    }
  },
  60_000,
);
