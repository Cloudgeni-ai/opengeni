import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  countSessionRecoveryBacklog,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  markSessionAttemptQuiesced,
  requestSessionTurnRecovery,
  summarizeSessionRecoveryBacklog,
} from "../src/index";

// The recovery summary is a global, cross-workspace aggregate. This file owns
// its database, so every assertion below is an exact absolute value.
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-0633-recovery-overdue");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const HOUR_MS = 3_600_000;

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Recovery overdue",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Recovery overdue",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
    initialMessage: "root",
  });
  return { grant, workspaceId: grant.workspaceId!, sessionId: session.id };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function claim(value: Fixture, initialize = true) {
  if (initialize) {
    await initializeSessionStartAtomically(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.workspaceId,
      sessionId: value.sessionId,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
  }
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, value.workspaceId, {
    sessionId: value.sessionId,
    workflowId: `session-${value.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`could not claim fixture: ${claimed.reason}`);
  return { attemptId, turn: claimed.turn };
}

/** Close the exact attempt recoverably with the given recorded backoff. */
async function recover(
  value: Fixture,
  input: { reason: string; detail?: Record<string, unknown>; quiesce: boolean },
) {
  const { attemptId, turn } = await claim(value);
  const recovery = await requestSessionTurnRecovery(client.db, value.workspaceId, {
    sessionId: value.sessionId,
    turnId: turn.id,
    triggerEventId: turn.triggerEventId,
    attemptId,
    reason: input.reason,
    ...(input.detail ? { detail: input.detail } : {}),
  });
  expect(recovery.action).toBe("recovering");
  if (input.quiesce) {
    await markSessionAttemptQuiesced(client.db, {
      workspaceId: value.workspaceId,
      sessionId: value.sessionId,
      attemptId,
      temporalWorkflowId: `session-${value.sessionId}`,
    });
  }
  return { attemptId, turnId: turn.id };
}

/** Move only the exact attempt's close instant into the past. */
async function backdateClose(attemptId: string, seconds: number) {
  await shared.admin`
    update session_turn_attempts
    set closed_at = closed_at - make_interval(secs => ${seconds})
    where id = ${attemptId}
  `;
}

async function summary() {
  return await summarizeSessionRecoveryBacklog(client.db);
}

describe("session recovery overdue age (migration 0633)", () => {
  test("a session sleeping in its recorded backoff is scheduled, never overdue", async () => {
    expect(await summary()).toEqual({
      quiescence_missing: { count: 0, scheduled: 0, oldestOverdueSeconds: 0 },
      projection_stale: { count: 0, scheduled: 0, oldestOverdueSeconds: 0 },
    });

    // A provider Retry-After of an hour: in the backlog, but not due yet.
    const sleeping = await fixture();
    const sleepingAttempt = await recover(sleeping, {
      reason: "provider_rate_limited",
      detail: { code: "provider_rate_limited", continueDelayMs: HOUR_MS },
      quiesce: true,
    });
    expect(await summary()).toEqual({
      quiescence_missing: { count: 0, scheduled: 0, oldestOverdueSeconds: 0 },
      projection_stale: { count: 1, scheduled: 1, oldestOverdueSeconds: 0 },
    });
    // The legacy count is the same candidate set.
    expect(await countSessionRecoveryBacklog(client.db)).toEqual({
      quiescence_missing: 0,
      projection_stale: 1,
    });

    // Fifty minutes into the hour it is still legitimately waiting.
    await backdateClose(sleepingAttempt.attemptId, 50 * 60);
    expect((await summary()).projection_stale).toEqual({
      count: 1,
      scheduled: 1,
      oldestOverdueSeconds: 0,
    });

    // Seventy minutes after the close it is twenty minutes past due.
    await backdateClose(sleepingAttempt.attemptId, 20 * 60);
    const overdue = (await summary()).projection_stale;
    expect(overdue.count).toBe(1);
    expect(overdue.scheduled).toBe(0);
    expect(overdue.oldestOverdueSeconds).toBeGreaterThanOrEqual(10 * 60);
    expect(overdue.oldestOverdueSeconds).toBeLessThan(11 * 60);

    // The woken workflow re-claims the same turn and clears the obligation.
    const reclaimed = await claim(sleeping, false);
    expect(reclaimed.turn.id).toBe(sleepingAttempt.turnId);
    expect(await summary()).toEqual({
      quiescence_missing: { count: 0, scheduled: 0, oldestOverdueSeconds: 0 },
      projection_stale: { count: 0, scheduled: 0, oldestOverdueSeconds: 0 },
    });
  }, 180_000);

  test("reports the single oldest overdue session, not the backlog size", async () => {
    // Many sessions cycling through short connectivity backoff are not overdue.
    const cycling = await Promise.all([fixture(), fixture(), fixture()]);
    for (const value of cycling) {
      await recover(value, {
        reason: "provider_unavailable",
        detail: { code: "provider_unavailable", continueDelayMs: 15_000 },
        quiesce: true,
      });
    }
    expect((await summary()).projection_stale).toEqual({
      count: 3,
      scheduled: 3,
      oldestOverdueSeconds: 0,
    });

    // A worker-shutdown recovery records no delay and is due at the close.
    const lost = await fixture();
    const lostAttempt = await recover(lost, { reason: "worker_shutdown", quiesce: true });
    await backdateClose(lostAttempt.attemptId, 15 * 60);
    const stale = (await summary()).projection_stale;
    expect(stale.count).toBe(4);
    expect(stale.scheduled).toBe(3);
    expect(stale.oldestOverdueSeconds).toBeGreaterThanOrEqual(15 * 60);
    expect(stale.oldestOverdueSeconds).toBeLessThan(16 * 60);
    for (const value of [...cycling, lost]) await claim(value, false);
  }, 180_000);

  test("missing physical quiescence is due at the close regardless of backoff", async () => {
    const unquiesced = await fixture();
    const attempt = await recover(unquiesced, {
      reason: "provider_rate_limited",
      detail: { code: "provider_rate_limited", continueDelayMs: HOUR_MS },
      quiesce: false,
    });
    await backdateClose(attempt.attemptId, 12 * 60);
    const missing = (await summary()).quiescence_missing;
    expect(missing.count).toBe(1);
    expect(missing.scheduled).toBe(0);
    expect(missing.oldestOverdueSeconds).toBeGreaterThanOrEqual(12 * 60);
    await markSessionAttemptQuiesced(client.db, {
      workspaceId: unquiesced.workspaceId,
      sessionId: unquiesced.sessionId,
      attemptId: attempt.attemptId,
      temporalWorkflowId: `session-${unquiesced.sessionId}`,
    });
    // Once quiesced the recorded hour applies: still inside its backoff.
    expect(await summary()).toEqual({
      quiescence_missing: { count: 0, scheduled: 0, oldestOverdueSeconds: 0 },
      projection_stale: { count: 1, scheduled: 1, oldestOverdueSeconds: 0 },
    });
    await claim(unquiesced, false);
  }, 180_000);

  test("a malformed recorded delay is read as no delay without failing the aggregate", async () => {
    const malformed = await fixture();
    const attempt = await recover(malformed, {
      reason: "provider_unavailable",
      detail: { code: "provider_unavailable", continueDelayMs: "soon" },
      quiesce: true,
    });
    await backdateClose(attempt.attemptId, 60);
    const stale = (await summary()).projection_stale;
    expect(stale).toMatchObject({ count: 1, scheduled: 0 });
    expect(stale.oldestOverdueSeconds).toBeGreaterThanOrEqual(60);
    await claim(malformed, false);
    expect((await summary()).projection_stale.count).toBe(0);
  }, 180_000);

  test("keeps the least-privilege content-free function contract", async () => {
    const definitions = await shared.admin<
      {
        name: string;
        security_definer: boolean;
        config: string[] | null;
        public_execute: boolean;
        result: string;
      }[]
    >`
      select p.proname as name,
             p.prosecdef as security_definer,
             p.proconfig as config,
             has_function_privilege('public', p.oid, 'EXECUTE') as public_execute,
             pg_get_function_result(p.oid) as result
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'opengeni_private'
        and p.proname in ('summarize_session_recovery_backlog', 'count_session_recovery_backlog')
      order by p.proname
    `;
    expect(definitions.map((definition) => definition.name)).toEqual([
      "count_session_recovery_backlog",
      "summarize_session_recovery_backlog",
    ]);
    for (const definition of definitions) {
      expect(definition.security_definer).toBe(true);
      expect(definition.config?.some((setting) => setting.startsWith("search_path="))).toBe(true);
      expect(definition.public_execute).toBe(false);
      expect(definition.result).not.toMatch(/(session|workspace|attempt|account)_id/i);
    }
    const rows = await shared.admin<{ state: string }[]>`
      select state from opengeni_private.summarize_session_recovery_backlog()
    `;
    expect(rows.map((row) => row.state)).toEqual(["projection_stale", "quiescence_missing"]);
  }, 60_000);
});
