import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  withWorkspaceRls,
} from "../src/index";
import { lockSessionEventWriteRows } from "../src/session-control";
import { submitTestHumanPrompt } from "../../../test/integration/helpers/session-control";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let observer: postgres.Sql;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("event-lock-pipeline");
  if (!acquired) throw new Error("Real PostgreSQL required");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 1 });
  observer = postgres(shared.adminUrl, { max: 1 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await observer?.end();
  await shared?.release();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture() {
  const id = crypto.randomUUID();
  const grant = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: id,
      accountName: "Lock pipeline",
      workspaceExternalSource: "test",
      workspaceExternalId: id,
      workspaceName: "Lock pipeline",
      subjectId: id,
    })
  ).workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "lock pipeline",
    metadata: {},
    resources: [],
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await submitTestHumanPrompt(client.db, {
    ...grant,
    sessionId: session.id,
    text: "probe",
    resources: [],
    tools: [],
    reasoningEffortFallback: "medium",
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    attemptId,
    workflowId: id,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("No attempt");
  return {
    workspaceId: grant.workspaceId,
    sessionIds: [session.id],
    turnIds: [claim.turn.id],
    attemptIds: [attemptId],
  };
}

async function waitForLock(pid: number) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const [row] = await observer`select wait_event_type from pg_stat_activity where pid = ${pid}`;
    if (row?.wait_event_type === "Lock") return;
    await Bun.sleep(5);
  }
  throw new Error("Expected controlled lock wait");
}

test("queued attempt read waits for the canonical turn lock", async () => {
  const input = await fixture();
  // Administrator locks below create the controlled concurrency boundary;
  // the helper under test executes as the ordinary restricted application role.
  const held = gate(),
    release = gate();
  const holder = shared.admin.begin(async (tx) => {
    await tx`select id from session_turns where id = ${input.turnIds[0]!} for update`;
    held.release();
    await release.promise;
  });
  await held.promise;
  const started = gate();
  let pid = 0;
  const pending = withWorkspaceRls(client.db, input.workspaceId, async (tx) => {
    await tx.execute(sql`select set_config('statement_timeout', '10000', true)`);
    const rows = await tx.execute(sql`select pg_backend_pid() as pid`);
    pid = Number(rows[0].pid);
    started.release();
    return await lockSessionEventWriteRows(tx, { ...input, controlLock: "none" });
  });
  try {
    await started.promise;
    await waitForLock(pid);
    await observer.begin(async (tx) => {
      await tx`select id from session_turn_attempts where id = ${input.attemptIds[0]!} for update nowait`;
    });
    release.release();
    await holder;
    const result = await pending;
    expect(result.attempts[0]!.id).toBe(input.attemptIds[0]!);
    expect(result.turns[0]!.id).toBe(input.turnIds[0]!);
  } finally {
    release.release();
    await holder;
    await pending.catch(() => {});
  }
});

test("database failure preserves first SQLSTATE and enclosing scope remains usable", async () => {
  const input = await fixture();
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const queries: string[] = [];
  driver.options.debug = (_connection, query) => queries.push(query);
  try {
    await withWorkspaceRls(client.db, input.workspaceId, async (parent) => {
      let caught: unknown;
      try {
        await withWorkspaceRls(parent, input.workspaceId, (tx) =>
          lockSessionEventWriteRows(tx, {
            ...input,
            controlLock: "none",
            turnIds: ["invalid-uuid"],
          }),
        );
      } catch (error) {
        caught = error;
      }
      let nested: any = caught;
      while (nested?.cause) nested = nested.cause;
      expect(nested?.code).toBe("22P02");
      const rows = await parent.execute(
        sql`select current_setting('opengeni.workspace_id') as workspace`,
      );
      expect(rows[0].workspace).toBe(input.workspaceId);
      const result = await lockSessionEventWriteRows(parent, { ...input, controlLock: "none" });
      expect(result.attempts[0]!.id).toBe(input.attemptIds[0]!);
    });
    const firstTurn = queries.findIndex((query) => query.includes('from "session_turns"'));
    const firstAttempt = queries.findIndex((query) =>
      query.includes('from "session_turn_attempts"'),
    );
    expect(firstTurn).toBeGreaterThan(-1);
    expect(firstAttempt).toBeGreaterThan(firstTurn);
  } finally {
    driver.options.debug = false;
  }
});

test("pipelined statements retain READ COMMITTED snapshots after a blocked predecessor", async () => {
  // A separate plain table isolates driver snapshot timing from lifecycle
  // triggers, whose ordinary attempt updates also lock the parent session.
  await shared.admin`create table lock_pipeline_snapshot_fixture (value integer not null)`;
  await shared.admin`insert into lock_pipeline_snapshot_fixture values (0)`;
  await shared.admin`grant select on lock_pipeline_snapshot_fixture to opengeni_app`;
  const input = await fixture();
  for (const value of [1, 2]) {
    const held = gate(),
      release = gate(),
      started = gate();
    const key = Math.floor(Math.random() * 1_000_000_000);
    const holder = shared.admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${key})`;
      held.release();
      await release.promise;
    });
    await held.promise;
    let pid = 0;
    const pending = withWorkspaceRls(client.db, input.workspaceId, async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', '5000', true)`);
      const rows = await tx.execute(sql`select pg_backend_pid() as pid`);
      pid = Number(rows[0].pid);
      started.release();
      return await Promise.all([
        tx.execute(sql`select pg_advisory_xact_lock(${key})`),
        tx.execute(sql`select value from lock_pipeline_snapshot_fixture`),
      ]);
    });
    // Observe rejection immediately even if a fixture assertion fails first.
    void pending.catch(() => {});
    try {
      await started.promise;
      await waitForLock(pid);
      await observer`update lock_pipeline_snapshot_fixture set value = ${value}`;
      release.release();
      await holder;
      const result = await pending;
      expect(result[1][0].value).toBe(value);
    } finally {
      release.release();
      await holder;
      await pending.catch(() => {});
    }
  }
});
