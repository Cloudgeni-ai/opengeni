import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

import {
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
} from "../src/index";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0238_recover_unclaimed_session_turns.sql",
);

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let migration = "";

beforeAll(async () => {
  migration = await readFile(migrationPath, "utf8");
  const acquired = await acquireSharedTestDatabase("migration-0238-unclaimed-session-recovery");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function createInitializedSession(initialMessage: string) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "migration-0238-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Unclaimed recovery migration test",
    workspaceExternalSource: "migration-0238-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Unclaimed recovery migration test",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage,
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  const initialized = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  if (!initialized.turn) throw new Error("Expected an initialized session turn");
  return { grant, session, turn: initialized.turn };
}

async function applyMigration() {
  await shared.admin.begin(async (tx) => {
    await tx.unsafe(migration);
  });
}

async function readWake(sessionId: string) {
  const [row] = await shared.admin<
    Array<{
      wakeRevision: string;
      deliveredRevision: string;
      reason: string;
      nextAttemptAt: Date;
      attempts: number;
      lastError: string | null;
    }>
  >`
    select
      wake_revision as "wakeRevision",
      delivered_revision as "deliveredRevision",
      reason,
      next_attempt_at as "nextAttemptAt",
      attempts,
      last_error as "lastError"
    from session_workflow_wake_outbox
    where session_id = ${sessionId}`;
  if (!row) throw new Error(`Workflow wake missing for session ${sessionId}`);
  return row;
}

async function readRecoveryPredicate(sessionId: string) {
  const [row] = await shared.admin<
    Array<{
      sessionStatus: string;
      activeTurnId: string | null;
      turnStatus: string | null;
      activeAttemptId: string | null;
    }>
  >`
    select
      session_row.status as "sessionStatus",
      session_row.active_turn_id as "activeTurnId",
      turn_row.status as "turnStatus",
      turn_row.active_attempt_id as "activeAttemptId"
    from sessions session_row
    left join session_turns turn_row
      on turn_row.workspace_id = session_row.workspace_id
     and turn_row.session_id = session_row.id
     and turn_row.id = session_row.active_turn_id
    where session_row.id = ${sessionId}`;
  if (!row) throw new Error(`Session missing: ${sessionId}`);
  return row;
}

describe("migration 0238 unclaimed session recovery", () => {
  test("seeds only orphaned recovering turns and preserves an earlier pending delivery", async () => {
    const orphaned = await createInitializedSession("recover this orphaned turn");
    const healthy = await createInitializedSession("leave this queued turn alone");
    const pendingAt = new Date(Date.now() - 5_000);

    await shared.admin`
      update sessions
      set status = 'recovering', active_turn_id = ${orphaned.turn.id}
      where workspace_id = ${orphaned.grant.workspaceId!}
        and id = ${orphaned.session.id}`;
    await shared.admin`
      update session_turns
      set status = 'recovering', active_attempt_id = null
      where workspace_id = ${orphaned.grant.workspaceId!}
        and id = ${orphaned.turn.id}`;
    await shared.admin`
      update session_workflow_wake_outbox
      set next_attempt_at = ${pendingAt}, attempts = 4, last_error = 'transient delivery error'
      where session_id = ${orphaned.session.id}`;

    expect(await readRecoveryPredicate(orphaned.session.id)).toEqual({
      sessionStatus: "recovering",
      activeTurnId: orphaned.turn.id,
      turnStatus: "recovering",
      activeAttemptId: null,
    });

    const orphanedBefore = await readWake(orphaned.session.id);
    const healthyBefore = await readWake(healthy.session.id);
    await applyMigration();
    const orphanedAfter = await readWake(orphaned.session.id);
    const healthyAfter = await readWake(healthy.session.id);

    expect(orphanedAfter).toMatchObject({
      wakeRevision: String(Number(orphanedBefore.wakeRevision) + 1),
      deliveredRevision: orphanedBefore.deliveredRevision,
      reason: "unclaimed_attempt_recovery_cutover",
      attempts: 0,
      lastError: null,
    });
    expect(orphanedAfter.nextAttemptAt.getTime()).toBe(pendingAt.getTime());
    expect(healthyAfter).toEqual(healthyBefore);

    const [audit] = await shared.admin<Array<{ count: number; wakeRevision: number }>>`
      select
        count(*)::integer as count,
        max((metadata ->> 'wakeRevision')::integer) as "wakeRevision"
      from audit_events
      where workspace_id = ${orphaned.grant.workspaceId!}
        and target_id = ${orphaned.session.id}
        and action = 'session.workflow.unclaimed_attempt_wake_seeded'`;
    expect(audit).toEqual({ count: 1, wakeRevision: Number(orphanedAfter.wakeRevision) });
  });

  test("creates a delayed pending revision when the previous wake was delivered", async () => {
    const orphaned = await createInitializedSession("recover after delivered wake");
    await shared.admin`
      update sessions
      set status = 'recovering', active_turn_id = ${orphaned.turn.id}
      where workspace_id = ${orphaned.grant.workspaceId!}
        and id = ${orphaned.session.id}`;
    await shared.admin`
      update session_turns
      set status = 'recovering', active_attempt_id = null
      where workspace_id = ${orphaned.grant.workspaceId!}
        and id = ${orphaned.turn.id}`;
    await shared.admin`
      update session_workflow_wake_outbox
      set delivered_revision = wake_revision,
          next_attempt_at = now() - interval '1 hour',
          attempts = 3,
          last_error = 'already delivered'
      where session_id = ${orphaned.session.id}`;

    expect(await readRecoveryPredicate(orphaned.session.id)).toEqual({
      sessionStatus: "recovering",
      activeTurnId: orphaned.turn.id,
      turnStatus: "recovering",
      activeAttemptId: null,
    });

    const before = await readWake(orphaned.session.id);
    const startedAt = Date.now();
    await applyMigration();
    const finishedAt = Date.now();
    const after = await readWake(orphaned.session.id);

    expect(after).toMatchObject({
      wakeRevision: String(Number(before.wakeRevision) + 1),
      deliveredRevision: before.wakeRevision,
      reason: "unclaimed_attempt_recovery_cutover",
      attempts: 0,
      lastError: null,
    });
    expect(after.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(startedAt + 59_000);
    expect(after.nextAttemptAt.getTime()).toBeLessThanOrEqual(finishedAt + 61_000);
  });
});
