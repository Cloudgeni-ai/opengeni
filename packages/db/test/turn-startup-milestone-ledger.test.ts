import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  appendSessionEventsForTurnAttempt,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionTurn,
  registerDbBinding,
  requestSessionTurnRecovery,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  type CanonicalTurnStartupMilestoneReceipt,
  type Database,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

// Real PostgreSQL control plane; a long append loop under the repository-wide
// run can exceed Bun's five-second default.
setDefaultTimeout(120_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("turn-startup-milestone-ledger");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Startup milestone ledger test",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Startup milestone ledger test",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  return { grant, session };
}

async function send(
  grant: { accountId: string; workspaceId: string; subjectId: string },
  sessionId: string,
  text: string,
) {
  const accepted = await withWorkspaceSubjectSessionActivityRls(
    client.db,
    grant.workspaceId,
    grant.subjectId,
    (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId,
          subjectId: grant.subjectId,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: `send-${text}-${crypto.randomUUID()}`,
          delivery: "send",
          text,
          resources: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
  );
  const turn = await getSessionTurn(client.db, grant.workspaceId, accepted.turnId);
  if (!turn) throw new Error(`Accepted turn missing: ${accepted.turnId}`);
  return { ...accepted, turn };
}

async function claim(workspaceId: string, sessionId: string, attemptId: string) {
  const result = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (result.action !== "claimed") throw new Error(`turn was not claimed: ${result.action}`);
  return result.turn;
}

async function settleStarted(
  workspaceId: string,
  sessionId: string,
  turn: { id: string; triggerEventId: string },
  attemptId: string,
  occurredAt: Date,
) {
  return applySessionTurnSettlement(client.db, workspaceId, {
    sessionId,
    turnId: turn.id,
    triggerEventId: turn.triggerEventId,
    attemptId,
    turnStatus: "running",
    sessionStatus: "running",
    activeTurnId: turn.id,
    events: [
      { type: "session.status.changed", payload: { status: "running" } },
      { type: "turn.started", payload: { triggerEventId: turn.triggerEventId }, occurredAt },
    ],
  });
}

async function ledgerRows(workspaceId: string, turnId: string) {
  const rows = await shared.admin<
    Array<{
      milestone: string;
      outcome: string;
      canonical_source: string;
      event_id: string | null;
      occurred_at: Date | null;
    }>
  >`
    select milestone, outcome, canonical_source, event_id, occurred_at
    from session_turn_startup_milestones
    where workspace_id = ${workspaceId} and turn_id = ${turnId}
    order by milestone, outcome`;
  return rows.map((row) => ({ ...row }));
}

/**
 * A statement-capturing application handle. postgres-js reports every
 * executed statement through `debug`, so the test can prove the append path's
 * per-append statement pattern no longer re-reads the turn's `session_events`
 * rows for the milestone decision.
 */
function instrumentedDb(statements: string[]): { db: Database; close: () => Promise<void> } {
  const raw = postgres(shared.appUrl, {
    max: 2,
    prepare: false,
    debug: (_connection, query) => {
      statements.push(query);
    },
  });
  const db = drizzle(raw, { schema }) as unknown as Database;
  registerDbBinding(db, { rlsStrategy: "force" });
  return { db, close: () => raw.end() };
}

const MILESTONE_SCAN_PATTERN =
  /session_events[\s\S]*('phase'|turn\.started|order by[\s\S]*sequence)/iu;

describe("turn startup milestone ledger", () => {
  test("a long turn claims each startup checkpoint exactly once in O(1) per append, and replay is a no-op", async () => {
    const { grant, session } = await fixture();
    const workspaceId = grant.workspaceId!;
    await send(grant, session.id, "measure a long orchestrator turn");
    const attemptId = crypto.randomUUID();
    const turn = await claim(workspaceId, session.id, attemptId);
    const queuedAt = Date.parse(turn.createdAt);

    const started = await settleStarted(
      workspaceId,
      session.id,
      turn,
      attemptId,
      new Date(queuedAt + 50),
    );
    expect(started).toMatchObject({
      action: "settled",
      canonicalStartupMilestones: [{ milestone: "queue", outcome: "completed", durationMs: 50 }],
    });

    const statements: string[] = [];
    const instrumented = instrumentedDb(statements);
    const receipts: CanonicalTurnStartupMilestoneReceipt[] = [];
    const sessionEventStatementsPerAppend: number[] = [];
    const firstEventIds: string[] = [];
    try {
      for (let request = 1; request <= 300; request += 1) {
        const before = statements.length;
        const appended = await appendSessionEventsForTurnAttempt(
          instrumented.db,
          workspaceId,
          session.id,
          turn.id,
          turn.executionGeneration,
          attemptId,
          [
            {
              type: "agent.model.request",
              payload: { phase: "started", requestId: `request-${request}`, transportAttempt: 1 },
              occurredAt: new Date(queuedAt + 100 * request),
            },
            {
              type: "agent.model.request",
              payload: {
                phase: "first_byte",
                requestId: `request-${request}`,
                transportAttempt: 1,
              },
              occurredAt: new Date(queuedAt + 100 * request + 40),
            },
            {
              type: "agent.model.request",
              payload: { phase: "completed", requestId: `request-${request}`, transportAttempt: 1 },
              occurredAt: new Date(queuedAt + 100 * request + 80),
            },
          ],
        );
        expect(appended.accepted).toBe(true);
        if (request === 1) firstEventIds.push(...appended.events.map((event) => event.id));
        receipts.push(...appended.canonicalStartupMilestones);
        const appendStatements = statements.slice(before);
        sessionEventStatementsPerAppend.push(
          appendStatements.filter((statement) => /session_events/u.test(statement)).length,
        );
        // The former implementation re-read the turn's agent.model.request rows
        // (payload ->> 'phase' ... order by sequence) inside this transaction.
        expect(appendStatements.filter((s) => MILESTONE_SCAN_PATTERN.test(s))).toEqual([]);
      }
    } finally {
      await instrumented.close();
    }

    // Exactly one receipt per milestone across the whole run, measured from the
    // durable turn queue timestamp to the canonical event's own occurred_at.
    expect(receipts).toEqual([
      {
        milestone: "provider_dispatch",
        outcome: "completed",
        durationMs: 100,
        eventId: firstEventIds[0]!,
      },
      {
        milestone: "first_byte",
        outcome: "completed",
        durationMs: 140,
        eventId: firstEventIds[1]!,
      },
    ]);
    // The per-append statement pattern against session_events is flat: the
    // 300th append touches the table exactly as often as the first.
    expect(new Set(sessionEventStatementsPerAppend).size).toBe(1);

    // Replaying the same checkpoints (recovery/callback replay) returns nothing.
    const replay = await appendSessionEventsForTurnAttempt(
      client.db,
      workspaceId,
      session.id,
      turn.id,
      turn.executionGeneration,
      attemptId,
      [
        { type: "agent.model.request", payload: { phase: "started", requestId: "request-1" } },
        { type: "agent.model.request", payload: { phase: "first_byte", requestId: "request-1" } },
      ],
    );
    expect(replay).toMatchObject({ accepted: true, canonicalStartupMilestones: [] });

    // A recovered attempt re-emits turn.started; the ledger already holds the
    // canonical queue checkpoint, so that is not a second queue sample.
    expect(
      await requestSessionTurnRecovery(client.db, workspaceId, {
        sessionId: session.id,
        turnId: turn.id,
        triggerEventId: turn.triggerEventId,
        attemptId,
        reason: "worker_shutdown",
      }),
    ).toMatchObject({ action: "recovering" });
    const secondAttemptId = crypto.randomUUID();
    const recovered = await claim(workspaceId, session.id, secondAttemptId);
    expect(recovered.id).toBe(turn.id);
    const restarted = await settleStarted(
      workspaceId,
      session.id,
      recovered,
      secondAttemptId,
      new Date(queuedAt + 60_000),
    );
    expect(restarted).toMatchObject({ action: "settled", canonicalStartupMilestones: [] });

    expect(await ledgerRows(workspaceId, turn.id)).toEqual([
      {
        milestone: "first_byte",
        outcome: "completed",
        canonical_source: "inserted_event",
        event_id: firstEventIds[1]!,
        occurred_at: new Date(queuedAt + 140),
      },
      {
        milestone: "provider_dispatch",
        outcome: "completed",
        canonical_source: "inserted_event",
        event_id: firstEventIds[0]!,
        occurred_at: new Date(queuedAt + 100),
      },
      {
        milestone: "queue",
        outcome: "completed",
        canonical_source: "inserted_event",
        event_id: expect.any(String),
        occurred_at: new Date(queuedAt + 50),
      },
    ]);
    const [eventCount] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from session_events
      where workspace_id = ${workspaceId} and turn_id = ${turn.id}
        and type = 'agent.model.request'`;
    expect(eventCount!.count).toBe(902);
  });

  test("the terminal failed first-byte outcome is fenced on ledger state, not on an event scan", async () => {
    const { grant, session } = await fixture();
    const workspaceId = grant.workspaceId!;
    await send(grant, session.id, "fail before first byte");
    const attemptId = crypto.randomUUID();
    const turn = await claim(workspaceId, session.id, attemptId);
    await settleStarted(workspaceId, session.id, turn, attemptId, new Date());
    const dispatched = await appendSessionEventsForTurnAttempt(
      client.db,
      workspaceId,
      session.id,
      turn.id,
      turn.executionGeneration,
      attemptId,
      [
        { type: "agent.model.request", payload: { phase: "started" } },
        { type: "agent.model.request", payload: { phase: "timed_out" } },
      ],
    );
    expect(dispatched.canonicalStartupMilestones).toEqual([
      expect.objectContaining({ milestone: "provider_dispatch", outcome: "completed" }),
    ]);
    const statements: string[] = [];
    const instrumented = instrumentedDb(statements);
    try {
      const failed = await applySessionTurnSettlement(instrumented.db, workspaceId, {
        sessionId: session.id,
        turnId: turn.id,
        triggerEventId: turn.triggerEventId,
        attemptId,
        turnStatus: "failed",
        sessionStatus: "idle",
        activeTurnId: null,
        events: [
          { type: "turn.failed", payload: { error: "provider timed out before first byte" } },
          { type: "session.status.changed", payload: { status: "idle" } },
        ],
      });
      expect(failed).toMatchObject({
        action: "settled",
        canonicalStartupMilestones: [
          expect.objectContaining({ milestone: "first_byte", outcome: "failed" }),
        ],
      });
    } finally {
      await instrumented.close();
    }
    expect(statements.filter((s) => MILESTONE_SCAN_PATTERN.test(s))).toEqual([]);
    expect(await ledgerRows(workspaceId, turn.id)).toMatchObject([
      { milestone: "first_byte", outcome: "failed", canonical_source: "inserted_event" },
      { milestone: "provider_dispatch", outcome: "completed", canonical_source: "inserted_event" },
      { milestone: "queue", outcome: "completed", canonical_source: "inserted_event" },
    ]);
  });

  test("a turn whose startup predates the ledger is sealed once and never re-observes a checkpoint", async () => {
    const { grant, session } = await fixture();
    const workspaceId = grant.workspaceId!;
    await send(grant, session.id, "in flight across the ledger rollout");
    const attemptId = crypto.randomUUID();
    const turn = await claim(workspaceId, session.id, attemptId);
    await settleStarted(workspaceId, session.id, turn, attemptId, new Date());
    await appendSessionEventsForTurnAttempt(
      client.db,
      workspaceId,
      session.id,
      turn.id,
      turn.executionGeneration,
      attemptId,
      [
        { type: "agent.model.request", payload: { phase: "started" } },
        { type: "agent.model.request", payload: { phase: "first_byte" } },
        { type: "agent.model.request", payload: { phase: "completed" } },
      ],
    );
    // Simulate a pre-ledger writer: the turn's startup events are durable but
    // no ledger-aware transaction ever claimed them.
    await shared.admin`
      delete from session_turn_startup_milestones
      where workspace_id = ${workspaceId} and turn_id = ${turn.id}`;
    expect(await ledgerRows(workspaceId, turn.id)).toEqual([]);

    expect(
      await requestSessionTurnRecovery(client.db, workspaceId, {
        sessionId: session.id,
        turnId: turn.id,
        triggerEventId: turn.triggerEventId,
        attemptId,
        reason: "worker_shutdown",
      }),
    ).toMatchObject({ action: "recovering" });
    const secondAttemptId = crypto.randomUUID();
    const recovered = await claim(workspaceId, session.id, secondAttemptId);
    // The recovery claim re-emits turn.started. The ledger detects the earlier
    // current turn.started through one bounded probe and seals the turn
    // instead of re-observing "queue" with a duration equal to the turn's age.
    const restarted = await settleStarted(
      workspaceId,
      session.id,
      recovered,
      secondAttemptId,
      new Date(Date.now() + 3_600_000),
    );
    expect(restarted).toMatchObject({ action: "settled", canonicalStartupMilestones: [] });
    expect(await ledgerRows(workspaceId, turn.id)).toEqual([
      {
        milestone: "first_byte",
        outcome: "completed",
        canonical_source: "pre_ledger_history",
        event_id: null,
        occurred_at: null,
      },
      {
        milestone: "provider_dispatch",
        outcome: "completed",
        canonical_source: "pre_ledger_history",
        event_id: null,
        occurred_at: null,
      },
      {
        milestone: "queue",
        outcome: "completed",
        canonical_source: "pre_ledger_history",
        event_id: null,
        occurred_at: null,
      },
    ]);

    const redispatched = await appendSessionEventsForTurnAttempt(
      client.db,
      workspaceId,
      session.id,
      recovered.id,
      recovered.executionGeneration,
      secondAttemptId,
      [
        { type: "agent.model.request", payload: { phase: "started" } },
        { type: "agent.model.request", payload: { phase: "first_event" } },
      ],
    );
    expect(redispatched).toMatchObject({ accepted: true, canonicalStartupMilestones: [] });
    const failed = await applySessionTurnSettlement(client.db, workspaceId, {
      sessionId: session.id,
      turnId: recovered.id,
      triggerEventId: recovered.triggerEventId,
      attemptId: secondAttemptId,
      turnStatus: "failed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        { type: "turn.failed", payload: { error: "later failure" } },
        { type: "session.status.changed", payload: { status: "idle" } },
      ],
    });
    expect(failed).toMatchObject({ action: "settled", canonicalStartupMilestones: [] });
    expect((await ledgerRows(workspaceId, turn.id)).map((row) => row.canonical_source)).toEqual([
      "pre_ledger_history",
      "pre_ledger_history",
      "pre_ledger_history",
    ]);
  });
});
