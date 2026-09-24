import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  applyCreditLedgerEntry,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getBillingBalance,
  initializeSessionStartAtomically,
  listOpenUsageReservations,
  openUsageReservationQuantity,
  recordUsageEvent,
  recordUsageEventsAndApplyCreditDebit,
  sumUsageQuantity,
  tryReserveUsageBudget,
  type DbClient,
} from "../src";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

setDefaultTimeout(60_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("billing-usage-reservations");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("PostgreSQL is required for billing reservation regression");
    }
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  if (!shared || !client) throw new Error("test database unavailable");
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Billing reservation test",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Billing reservation test",
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
  const started = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  if (!started.turn) throw new Error("initial turn was not created");
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`could not claim fixture: ${claim.reason}`);
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    turn: claim.turn,
    attemptId,
  };
}

function monthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function reservationRequest(
  fix: Awaited<ReturnType<typeof fixture>>,
  input: { ordinal: number; quantity: number; cap: number; suffix: string },
) {
  return {
    eventType: "model.cost",
    reservedEventType: "model.cost.reserved",
    scope: "account" as const,
    cap: input.cap,
    quantity: input.quantity,
    unit: "usd_micros",
    idempotencyKey: `usage:model.cost.reserved:${fix.turn.id}:${fix.attemptId}:${input.ordinal}:${input.suffix}`,
    sourceResourceId: `model_call_reservation:${fix.turn.id}:${fix.attemptId}:${input.ordinal}`,
  };
}

describe("monthly usage window boundary (BILL-05)", () => {
  test("an event occurring exactly at the window start counts toward the sum", async () => {
    if (!shared || !client) return;
    const fix = await fixture();
    const since = monthStart();
    await recordUsageEvent(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      eventType: "model.cost",
      quantity: 42,
      unit: "usd_micros",
      idempotencyKey: `boundary:${crypto.randomUUID()}`,
      occurredAt: since,
    });
    // The callers pass the exact UTC month start: an event AT that instant is
    // inside the billing window. A strict `>` comparison drops it.
    expect(
      await sumUsageQuantity(client.db, {
        accountId: fix.accountId,
        eventType: "model.cost",
        since,
      }),
    ).toBe(42);
    expect(
      await sumUsageQuantity(client.db, {
        accountId: fix.accountId,
        eventType: "model.cost",
        since: new Date(since.getTime() + 1),
      }),
    ).toBe(0);
  });
});

describe("bounded usage reservations (BILL-01/BILL-02)", () => {
  test("concurrent reservations cannot spend the same remaining balance", async () => {
    if (!shared || !client) return;
    const fix = await fixture();
    const since = monthStart();
    const cap = 1_000;
    // 900 already committed this month; 100 remain.
    await recordUsageEvent(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      eventType: "model.cost",
      quantity: 900,
      unit: "usd_micros",
      idempotencyKey: `committed:${crypto.randomUUID()}`,
    });
    const openSince = new Date(Date.now() - 60_000);
    const reserve = (ordinal: number, suffix: string) =>
      tryReserveUsageBudget(client!.db, {
        accountId: fix.accountId,
        workspaceId: fix.workspaceId,
        sessionId: fix.sessionId,
        turnId: fix.turn.id,
        turnAttemptId: fix.attemptId,
        since,
        openReservationSince: openSince,
        reservations: [reservationRequest(fix, { ordinal, quantity: 80, cap, suffix })],
      });
    const [first, second] = await Promise.all([reserve(1, "a"), reserve(2, "b")]);
    const outcomes = [first, second];
    const allowed = outcomes.filter((o) => o.allowed);
    const denied = outcomes.filter((o) => !o.allowed);
    // The account reservation lock serializes the two reads: one commits its
    // full 80-quantity hold, the other sees only 20 remaining and is refused —
    // admission is all-or-nothing, never clamped.
    expect(allowed).toHaveLength(1);
    expect(denied).toHaveLength(1);
    expect(allowed[0]!.holds[0]!.quantity).toBe(80);
    if (!denied[0]!.allowed && !("attemptClosed" in denied[0]!)) {
      expect(denied[0]!.eventType).toBe("model.cost");
      expect(denied[0]!.cap).toBe(cap);
    }
  });

  test("a request larger than the remaining window is refused without a partial hold", async () => {
    if (!shared || !client) return;
    const fix = await fixture();
    const since = monthStart();
    const cap = 1_000;
    // 900 already committed this month; 100 remain.
    await recordUsageEvent(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      eventType: "model.cost",
      quantity: 900,
      unit: "usd_micros",
      idempotencyKey: `committed:${crypto.randomUUID()}`,
    });
    const request = reservationRequest(fix, {
      ordinal: 1,
      quantity: 500,
      cap,
      suffix: "big",
    });
    const denied = await tryReserveUsageBudget(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      sessionId: fix.sessionId,
      turnId: fix.turn.id,
      turnAttemptId: fix.attemptId,
      since,
      openReservationSince: new Date(Date.now() - 60_000),
      reservations: [request],
    });
    // Strict admission: clamping to 100 while the unchanged 500-quantity call
    // ran anyway would recreate the overshoot the reservation exists to stop.
    expect(denied.allowed).toBe(false);
    // And no partial hold row was left behind for the refused call.
    const rows = await shared!.admin<Array<{ count: string }>>`
      select count(*)::text as count from usage_events
      where idempotency_key = ${request.idempotencyKey}`;
    expect(Number(rows[0]?.count)).toBe(0);
    expect(
      await openUsageReservationQuantity(client.db, {
        accountId: fix.accountId,
        workspaceId: fix.workspaceId,
        eventType: "model.cost.reserved",
        since,
        holdSince: new Date(Date.now() - 60_000),
      }),
    ).toBe(0);
  });

  test("a retried reservation reuses its hold instead of double-counting", async () => {
    if (!shared || !client) return;
    const fix = await fixture();
    const since = monthStart();
    const openSince = new Date(Date.now() - 60_000);
    const input = {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      sessionId: fix.sessionId,
      turnId: fix.turn.id,
      turnAttemptId: fix.attemptId,
      since,
      openReservationSince: openSince,
      reservations: [
        reservationRequest(fix, { ordinal: 1, quantity: 500, cap: 1_000, suffix: "r" }),
      ],
    };
    const first = await tryReserveUsageBudget(client.db, input);
    const second = await tryReserveUsageBudget(client.db, input);
    expect(first.allowed && second.allowed).toBe(true);
    if (first.allowed && second.allowed) {
      expect(second.holds).toEqual(first.holds);
    }
    const open = await listOpenUsageReservations(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      turnId: fix.turn.id,
      turnAttemptId: fix.attemptId,
      since: openSince,
    });
    // One logical hold of 500 — not 1000 — after the replayed reservation.
    expect(open.get(1)?.costMicros).toBe(500);
  });

  test("stale holds older than the TTL cutoff do not block admission", async () => {
    if (!shared || !client) return;
    const fix = await fixture();
    const since = monthStart();
    const cap = 1_000;
    // A crashed turn left a 1000-quantity hold last week; its TTL has lapsed.
    const staleAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await recordUsageEvent(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      eventType: "model.cost.reserved",
      quantity: 1_000,
      unit: "usd_micros",
      sourceResourceType: "model_call_reservation",
      sourceResourceId: `model_call_reservation:${fix.turn.id}:${fix.attemptId}:9`,
      sessionId: fix.sessionId,
      turnId: fix.turn.id,
      turnAttemptId: fix.attemptId,
      idempotencyKey: `stale-hold:${crypto.randomUUID()}`,
      occurredAt: staleAt,
    });
    const result = await tryReserveUsageBudget(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      sessionId: fix.sessionId,
      turnId: fix.turn.id,
      turnAttemptId: fix.attemptId,
      since,
      openReservationSince: new Date(Date.now() - 60 * 60 * 1000),
      reservations: [reservationRequest(fix, { ordinal: 1, quantity: 800, cap, suffix: "s" })],
    });
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.holds[0]!.quantity).toBe(800);
    }
  });

  test("an expired hold's release cannot net against another call's live hold", async () => {
    if (!shared || !client) return;
    const fix = await fixture();
    const since = monthStart();
    const holdSince = new Date(Date.now() - 60 * 60 * 1000);
    const staleSourceId = `model_call_reservation:${fix.turn.id}:${fix.attemptId}:7`;
    const staleHoldKey = `usage:model.cost.reserved:${fix.turn.id}:${fix.attemptId}:7`;
    // A hold from last week (TTL lapsed) whose reconcile release only landed
    // now. If holds and releases were summed independently by timestamp, this
    // release would subtract from the unrelated live hold below.
    await recordUsageEvent(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      eventType: "model.cost.reserved",
      quantity: 500,
      unit: "usd_micros",
      sourceResourceType: "model_call_reservation",
      sourceResourceId: staleSourceId,
      sessionId: fix.sessionId,
      turnId: fix.turn.id,
      turnAttemptId: fix.attemptId,
      idempotencyKey: staleHoldKey,
      occurredAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    });
    await recordUsageEvent(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      eventType: "model.cost.reserved",
      quantity: -500,
      unit: "usd_micros",
      sourceResourceType: "model_call_reservation",
      sourceResourceId: staleSourceId,
      sessionId: fix.sessionId,
      turnId: fix.turn.id,
      turnAttemptId: fix.attemptId,
      idempotencyKey: `${staleHoldKey}:release`,
    });
    // A different call's still-live hold.
    const live = await tryReserveUsageBudget(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      sessionId: fix.sessionId,
      turnId: fix.turn.id,
      turnAttemptId: fix.attemptId,
      since,
      openReservationSince: holdSince,
      reservations: [
        reservationRequest(fix, { ordinal: 8, quantity: 400, cap: 1_000, suffix: "live" }),
      ],
    });
    expect(live.allowed).toBe(true);
    // Per-reservation pairing discards the stale group wholesale: only the
    // live 400 counts, in BOTH the workspace and account scopes.
    expect(
      await openUsageReservationQuantity(client.db, {
        accountId: fix.accountId,
        workspaceId: fix.workspaceId,
        eventType: "model.cost.reserved",
        since,
        holdSince,
      }),
    ).toBe(400);
    expect(
      await openUsageReservationQuantity(client.db, {
        accountId: fix.accountId,
        eventType: "model.cost.reserved",
        since,
        holdSince,
      }),
    ).toBe(400);
    // End-to-end: cap 500 leaves 100 remaining against the live hold — a 200
    // request is refused. Aggregate netting would have computed -100 open
    // and admitted it.
    const denied = await tryReserveUsageBudget(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      sessionId: fix.sessionId,
      turnId: fix.turn.id,
      turnAttemptId: fix.attemptId,
      since,
      openReservationSince: holdSince,
      reservations: [
        reservationRequest(fix, { ordinal: 9, quantity: 200, cap: 500, suffix: "over" }),
      ],
    });
    expect(denied.allowed).toBe(false);
  });

  test("a negative release nets the hold to zero", async () => {
    if (!shared || !client) return;
    const fix = await fixture();
    const since = monthStart();
    const openSince = new Date(Date.now() - 60_000);
    const request = reservationRequest(fix, {
      ordinal: 1,
      quantity: 500,
      cap: 1_000,
      suffix: "rel",
    });
    const reserved = await tryReserveUsageBudget(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      sessionId: fix.sessionId,
      turnId: fix.turn.id,
      turnAttemptId: fix.attemptId,
      since,
      openReservationSince: openSince,
      reservations: [request],
    });
    expect(reserved.allowed).toBe(true);
    await recordUsageEvent(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      eventType: "model.cost.reserved",
      quantity: -500,
      unit: "usd_micros",
      sourceResourceType: "model_call_reservation",
      sourceResourceId: request.sourceResourceId,
      sessionId: fix.sessionId,
      turnId: fix.turn.id,
      turnAttemptId: fix.attemptId,
      idempotencyKey: `${request.idempotencyKey}:release`,
    });
    const open = await listOpenUsageReservations(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      turnId: fix.turn.id,
      turnAttemptId: fix.attemptId,
      since: openSince,
    });
    expect(open.has(1)).toBe(false);
    // The released budget admits a full follow-up reservation.
    const again = await tryReserveUsageBudget(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      sessionId: fix.sessionId,
      turnId: fix.turn.id,
      turnAttemptId: fix.attemptId,
      since,
      openReservationSince: openSince,
      reservations: [
        reservationRequest(fix, { ordinal: 2, quantity: 1_000, cap: 1_000, suffix: "rel2" }),
      ],
    });
    expect(again.allowed).toBe(true);
  });
});

describe("atomic usage facts and credit debit (BILL-03)", () => {
  test("usage events and the debit commit together and replay idempotently", async () => {
    if (!shared || !client) return;
    const fix = await fixture();
    await applyCreditLedgerEntry(client.db, {
      accountId: fix.accountId,
      type: "test_topup",
      amountMicros: 10_000,
      idempotencyKey: `topup:${crypto.randomUUID()}`,
    });
    const sourceKey = `${fix.turn.id}:call-1`;
    const batch = {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      usageEvents: [
        {
          eventType: "model.cost",
          quantity: 400,
          unit: "usd_micros",
          sourceResourceType: "model_response",
          sourceResourceId: sourceKey,
          sessionId: fix.sessionId,
          turnId: fix.turn.id,
          turnAttemptId: fix.attemptId,
          idempotencyKey: `usage:model.cost:${sourceKey}`,
        },
        {
          eventType: "model.tokens",
          quantity: 250,
          unit: "tokens",
          sourceResourceType: "model_response",
          sourceResourceId: sourceKey,
          sessionId: fix.sessionId,
          turnId: fix.turn.id,
          turnAttemptId: fix.attemptId,
          idempotencyKey: `usage:model.tokens:${sourceKey}`,
        },
      ],
      creditDebit: {
        type: "model_usage_debit",
        requestedAmountMicros: 400,
        sourceType: "model_response",
        sourceId: sourceKey,
        idempotencyKey: `credit:model_usage_debit:${sourceKey}`,
      },
    };
    const first = await recordUsageEventsAndApplyCreditDebit(client.db, batch);
    expect(first.debit?.debitedMicros).toBe(400);
    expect((await getBillingBalance(client.db, fix.accountId)).balanceMicros).toBe(9_600);
    // Replay: the same idempotency keys land exactly once — no second ledger
    // entry, no duplicated usage facts.
    const retry = await recordUsageEventsAndApplyCreditDebit(client.db, batch);
    expect(retry.debit?.debitedMicros).toBe(0);
    expect((await getBillingBalance(client.db, fix.accountId)).balanceMicros).toBe(9_600);
    expect(
      await sumUsageQuantity(client.db, {
        accountId: fix.accountId,
        eventType: "model.cost",
        since: monthStart(),
      }),
    ).toBe(400);
    expect(
      await sumUsageQuantity(client.db, {
        accountId: fix.accountId,
        workspaceId: fix.workspaceId,
        eventType: "model.tokens",
        since: monthStart(),
      }),
    ).toBe(250);
  });
});

describe("terminal settlement usage facts (BILL-04)", () => {
  test("completion fact and hold releases commit inside the settlement transaction", async () => {
    if (!shared || !client) return;
    const fix = await fixture();
    const settled = await applySessionTurnSettlement(client.db, fix.workspaceId, {
      sessionId: fix.sessionId,
      turnId: fix.turn.id,
      triggerEventId: fix.turn.triggerEventId,
      attemptId: fix.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        { type: "turn.completed", payload: { output: "done" } },
        { type: "session.status.changed", payload: { status: "idle" } },
      ],
      usageEvents: [
        {
          eventType: "agent_run.completed",
          quantity: 1,
          unit: "run",
          sourceResourceType: "session_turn",
          sourceResourceId: fix.turn.id,
          idempotencyKey: `usage:agent_run.completed:${fix.turn.id}`,
        },
      ],
    });
    expect(settled.action).toBe("settled");
    const completed = await sumUsageQuantity(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      eventType: "agent_run.completed",
      since: monthStart(),
    });
    expect(completed).toBe(1);
    // The settlement defaults attach this turn's execution context.
    const events = await shared!.admin<
      Array<{ session_id: string; turn_id: string; turn_attempt_id: string }>
    >`
      select session_id, turn_id, turn_attempt_id from usage_events
      where idempotency_key = ${`usage:agent_run.completed:${fix.turn.id}`}`;
    expect(events[0]?.session_id).toBe(fix.sessionId);
    expect(events[0]?.turn_id).toBe(fix.turn.id);
    expect(events[0]?.turn_attempt_id).toBe(fix.attemptId);
  });

  test("closing an attempt on a terminal path releases its open holds", async () => {
    if (!shared || !client) return;
    const fix = await fixture();
    const since = monthStart();
    const holdSince = new Date(Date.now() - 60_000);
    const request = reservationRequest(fix, {
      ordinal: 1,
      quantity: 400,
      cap: 1_000,
      suffix: "cancel",
    });
    const reserved = await tryReserveUsageBudget(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      sessionId: fix.sessionId,
      turnId: fix.turn.id,
      turnAttemptId: fix.attemptId,
      since,
      openReservationSince: holdSince,
      reservations: [request],
    });
    expect(reserved.allowed).toBe(true);
    expect(
      await openUsageReservationQuantity(client.db, {
        accountId: fix.accountId,
        workspaceId: fix.workspaceId,
        eventType: "model.cost.reserved",
        since,
        holdSince,
      }),
    ).toBe(400);
    // A cancelled turn closes its attempt through the same settlement seam
    // every terminal path uses; the close must release the hold in the same
    // transaction, not wait out the TTL.
    const settled = await applySessionTurnSettlement(client.db, fix.workspaceId, {
      sessionId: fix.sessionId,
      turnId: fix.turn.id,
      triggerEventId: fix.turn.triggerEventId,
      attemptId: fix.attemptId,
      turnStatus: "cancelled",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        { type: "turn.cancelled", payload: {} },
        { type: "session.status.changed", payload: { status: "idle" } },
      ],
    });
    expect(settled.action).toBe("settled");
    // The release row lands under the hold's own `<key>:release` idempotency
    // key, so it is compatible with any worker-side release already written.
    const releases = await shared!.admin<Array<{ quantity: string; source_resource_id: string }>>`
      select quantity, source_resource_id from usage_events
      where idempotency_key = ${`${request.idempotencyKey}:release`}`;
    expect(releases).toHaveLength(1);
    expect(Number(releases[0]!.quantity)).toBe(-400);
    expect(releases[0]!.source_resource_id).toBe(request.sourceResourceId);
    // The budget is immediately available again — no TTL wait.
    expect(
      await openUsageReservationQuantity(client.db, {
        accountId: fix.accountId,
        workspaceId: fix.workspaceId,
        eventType: "model.cost.reserved",
        since,
        holdSince,
      }),
    ).toBe(0);
    expect(
      await listOpenUsageReservations(client.db, {
        accountId: fix.accountId,
        workspaceId: fix.workspaceId,
        turnId: fix.turn.id,
        turnAttemptId: fix.attemptId,
        since: holdSince,
      }),
    ).toEqual(new Map());
  });
});

describe("reconcile/admission serialization (P1-b)", () => {
  test("the hold→usage conversion writer holds the account reservation lock", async () => {
    if (!shared || !client) return;
    const fix = await fixture();
    const since = monthStart();
    const cap = 1_000;
    await recordUsageEvent(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      eventType: "model.cost",
      quantity: 600,
      unit: "usd_micros",
      idempotencyKey: `committed:${crypto.randomUUID()}`,
    });
    const hold = reservationRequest(fix, {
      ordinal: 1,
      quantity: 300,
      cap,
      suffix: "conv",
    });
    const reserved = await tryReserveUsageBudget(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      sessionId: fix.sessionId,
      turnId: fix.turn.id,
      turnAttemptId: fix.attemptId,
      since,
      openReservationSince: new Date(Date.now() - 60_000),
      reservations: [hold],
    });
    expect(reserved.allowed).toBe(true);

    // Hold the account reservation advisory lock on a raw connection while the
    // reconcile writer runs: if the writer did not take the same lock, its
    // release+usage pair could commit between tryReserveUsageBudget's two
    // reads and be invisible to BOTH sums.
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((resolve) => (releaseLock = resolve));
    let lockHeld!: () => void;
    const heldGate = new Promise<void>((resolve) => (lockHeld = resolve));
    const lockTxn = shared!.admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${"usage-budget-reserve:" + fix.accountId}, 0))`;
      lockHeld();
      await lockGate;
    });
    await heldGate;

    let reconcileFinished = false;
    const reconcile = recordUsageEventsAndApplyCreditDebit(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      usageEvents: [
        {
          eventType: "model.cost.reserved",
          quantity: -300,
          unit: "usd_micros",
          sourceResourceType: "model_call_reservation",
          sourceResourceId: hold.sourceResourceId,
          sessionId: fix.sessionId,
          turnId: fix.turn.id,
          turnAttemptId: fix.attemptId,
          idempotencyKey: `${hold.idempotencyKey}:release`,
        },
        {
          eventType: "model.cost",
          quantity: 300,
          unit: "usd_micros",
          sourceResourceType: "model_response",
          sourceResourceId: `${fix.turn.id}:call-1`,
          sessionId: fix.sessionId,
          turnId: fix.turn.id,
          turnAttemptId: fix.attemptId,
          idempotencyKey: `usage:model.cost:${fix.turn.id}:call-1`,
        },
      ],
    }).then((result) => {
      reconcileFinished = true;
      return result;
    });
    // The writer must be parked on the advisory lock, not committing freely.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(reconcileFinished).toBe(false);

    releaseLock();
    await lockTxn;
    await reconcile;
    expect(reconcileFinished).toBe(true);

    // After the conversion commits, admission sees committed 900 + open 0:
    // a 300-quantity request does not fit in the remaining 100.
    const denied = await tryReserveUsageBudget(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      sessionId: fix.sessionId,
      turnId: fix.turn.id,
      turnAttemptId: fix.attemptId,
      since,
      openReservationSince: new Date(Date.now() - 60_000),
      reservations: [reservationRequest(fix, { ordinal: 2, quantity: 300, cap, suffix: "after" })],
    });
    expect(denied.allowed).toBe(false);
    expect(
      await sumUsageQuantity(client.db, {
        accountId: fix.accountId,
        eventType: "model.cost",
        since,
      }),
    ).toBe(900);
    expect(
      await openUsageReservationQuantity(client.db, {
        accountId: fix.accountId,
        workspaceId: fix.workspaceId,
        eventType: "model.cost.reserved",
        since,
        holdSince: new Date(Date.now() - 60_000),
      }),
    ).toBe(0);
  });
});

describe("attempt-close fencing (P2-c)", () => {
  test("a reservation that loses the close race is refused instead of pinning budget", async () => {
    if (!shared || !client) return;
    const fix = await fixture();
    const since = monthStart();

    // The attempt closes inside a transaction that is already holding the
    // account reservation advisory lock. A concurrently started reservation
    // parks on that lock, then must observe the closed attempt when it runs —
    // never inserting a hold that outlives the close release scan.
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((resolve) => (releaseLock = resolve));
    let lockHeld!: () => void;
    const heldGate = new Promise<void>((resolve) => (lockHeld = resolve));
    const lockTxn = shared!.admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${"usage-budget-reserve:" + fix.accountId}, 0))`;
      await tx`
        update session_turn_attempts
        set state = 'closed', outcome = 'cancelled', closed_at = now()
        where workspace_id = ${fix.workspaceId} and id = ${fix.attemptId}`;
      lockHeld();
      await lockGate;
    });
    await heldGate;

    const racing = tryReserveUsageBudget(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      sessionId: fix.sessionId,
      turnId: fix.turn.id,
      turnAttemptId: fix.attemptId,
      since,
      openReservationSince: new Date(Date.now() - 60_000),
      reservations: [
        reservationRequest(fix, { ordinal: 1, quantity: 100, cap: 1_000, suffix: "race" }),
      ],
    });
    releaseLock();
    await lockTxn;
    const result = await racing;
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect("attemptClosed" in result && result.attemptClosed).toBe(true);
    }

    // And once close has committed, a fresh reservation is refused too.
    const after = await tryReserveUsageBudget(client.db, {
      accountId: fix.accountId,
      workspaceId: fix.workspaceId,
      sessionId: fix.sessionId,
      turnId: fix.turn.id,
      turnAttemptId: fix.attemptId,
      since,
      openReservationSince: new Date(Date.now() - 60_000),
      reservations: [
        reservationRequest(fix, { ordinal: 2, quantity: 100, cap: 1_000, suffix: "post" }),
      ],
    });
    expect(after.allowed).toBe(false);
    if (!after.allowed) {
      expect("attemptClosed" in after && after.attemptClosed).toBe(true);
    }
    // Neither attempt left a hold row behind.
    const rows = await shared!.admin<Array<{ count: string }>>`
      select count(*)::text as count from usage_events
      where turn_attempt_id = ${fix.attemptId}
        and event_type = 'model.cost.reserved'`;
    expect(Number(rows[0]?.count)).toBe(0);
  });
});
