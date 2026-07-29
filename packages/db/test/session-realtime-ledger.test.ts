import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { and, asc, eq, sql } from "drizzle-orm";

import {
  addSessionSystemUpdate,
  appendSessionRealtimeOutboundInTransaction,
  beginSessionRealtimeInTransaction,
  bootstrapWorkspace,
  claimSessionRealtimeConnectionInTransaction,
  completeSessionRealtimeConnectionInTransaction,
  createDb,
  createSession,
  endSessionRealtimeInTransaction,
  failSessionRealtimeConnectionInTransaction,
  getActiveSessionHistoryItems,
  listOutstandingSessionSystemUpdates,
  SessionRealtimeConflictError,
  syncSessionRealtimeLedgerInTransaction,
  withWorkspaceRls,
  type Database,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(30_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-realtime-ledger");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 16 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `realtime-ledger-account-${suffix}`,
    accountName: "Realtime ledger",
    workspaceExternalSource: "test",
    workspaceExternalId: `realtime-ledger-workspace-${suffix}`,
    workspaceName: "Realtime ledger",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "ordinary history before voice",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  const owner = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    operationId: crypto.randomUUID(),
    ownerSubjectId: grant.subjectId,
    browserInstanceId: `browser-${crypto.randomUUID()}`,
    ownerKey: `owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
    model: "gpt-live-1-boulder-alpha" as const,
  };
  const started = await transaction(owner.workspaceId, (tx) =>
    beginSessionRealtimeInTransaction(tx, owner),
  );
  return { grant, session, owner, started };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function transaction<T>(workspaceId: string, fn: (db: Database) => Promise<T>): Promise<T> {
  return await withWorkspaceRls(client.db, workspaceId, (db) =>
    db.transaction((tx) => fn(tx as unknown as Database)),
  );
}

function ownerProof(value: Fixture, expectedVersion = value.started.mode.version) {
  return {
    workspaceId: value.owner.workspaceId,
    sessionId: value.owner.sessionId,
    realtimeId: value.started.mode.id,
    ownerSubjectId: value.owner.ownerSubjectId,
    browserInstanceId: value.owner.browserInstanceId,
    ownerKey: value.owner.ownerKey,
    expectedVersion,
  };
}

async function claimInitial(value: Fixture) {
  const operationId = crypto.randomUUID();
  const input = {
    ...ownerProof(value),
    operationId,
    expectedConnectionEpoch: 1,
    rotate: false,
  };
  const claimed = await transaction(value.owner.workspaceId, (tx) =>
    claimSessionRealtimeConnectionInTransaction(tx, input),
  );
  return { claimed, input };
}

async function complete(
  value: Fixture,
  connection: { id: string; operationId: string; connectionEpoch: number },
  sdpAnswer = "v=0\r\na=answer:durable\r\n",
) {
  return await transaction(value.owner.workspaceId, (tx) =>
    completeSessionRealtimeConnectionInTransaction(tx, {
      workspaceId: value.owner.workspaceId,
      sessionId: value.owner.sessionId,
      realtimeId: value.started.mode.id,
      connectionId: connection.id,
      operationId: connection.operationId,
      connectionEpoch: connection.connectionEpoch,
      sdpAnswer,
    }),
  );
}

async function proveProviderStarted(
  value: Fixture,
  connection: { id: string; connectionEpoch: number },
  expectedVersion = value.started.mode.version,
) {
  return await transaction(value.owner.workspaceId, (tx) =>
    syncSessionRealtimeLedgerInTransaction(tx, {
      ...ownerProof(value, expectedVersion),
      connectionId: connection.id,
      connectionEpoch: connection.connectionEpoch,
      providerStarted: {
        providerSessionId: `provider-session-${connection.connectionEpoch}`,
        providerEventId: `provider-started-${connection.connectionEpoch}`,
      },
    }),
  );
}

function delegationSyncInput(
  value: Fixture,
  connection: { id: string; connectionEpoch: number },
  operationId = crypto.randomUUID(),
) {
  return {
    ...ownerProof(value),
    connectionId: connection.id,
    connectionEpoch: connection.connectionEpoch,
    entries: [
      {
        operationId,
        kind: "delegation_call" as const,
        providerEventId: `delegation-created-${operationId}`,
        delegationItemId: `delegation-item-${operationId}`,
        text: "Complete one ordinary delegated task on this same session",
        payload: { offsetMs: 125 },
      },
    ],
  };
}

async function expectConflict(
  promise: Promise<unknown>,
  code: SessionRealtimeConflictError["code"],
) {
  try {
    await promise;
    throw new Error(`Expected realtime conflict ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SessionRealtimeConflictError);
    expect((error as SessionRealtimeConflictError).code).toBe(code);
  }
}

describe("session realtime ledger", () => {
  test("idempotently fails only the exact negotiating connection", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    const input = {
      workspaceId: value.owner.workspaceId,
      sessionId: value.owner.sessionId,
      realtimeId: value.started.mode.id,
      connectionId: first.claimed.connection.id,
      operationId: first.claimed.connection.operationId,
      connectionEpoch: first.claimed.connection.connectionEpoch,
      failureCode: "provider_error",
    };
    const failed = await transaction(value.owner.workspaceId, (tx) =>
      failSessionRealtimeConnectionInTransaction(tx, input),
    );
    expect(failed).toMatchObject({
      replay: false,
      connection: { state: "failed", failureCode: "provider_error" },
    });
    const replay = await transaction(value.owner.workspaceId, (tx) =>
      failSessionRealtimeConnectionInTransaction(tx, input),
    );
    expect(replay).toMatchObject({ replay: true, connection: { id: failed.connection.id } });
    await expectConflict(complete(value, first.claimed.connection), "REALTIME_CONNECTION_CHANGED");
  });

  test("idempotently negotiates epoch one and fences its answer after a rotation", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    const replay = await transaction(value.owner.workspaceId, (tx) =>
      claimSessionRealtimeConnectionInTransaction(tx, first.input),
    );
    expect(replay).toMatchObject({ replay: true, connection: { id: first.claimed.connection.id } });
    await complete(value, first.claimed.connection);

    const rotationInput = {
      ...ownerProof(value),
      operationId: crypto.randomUUID(),
      expectedConnectionEpoch: 1,
      rotate: true,
    };
    const rotated = await transaction(value.owner.workspaceId, (tx) =>
      claimSessionRealtimeConnectionInTransaction(tx, rotationInput),
    );
    expect(rotated).toMatchObject({
      replay: false,
      modeVersion: 2,
      connection: { connectionEpoch: 2, state: "negotiating" },
    });
    await expectConflict(complete(value, first.claimed.connection), "REALTIME_CONNECTION_CHANGED");
    const active = await complete(value, rotated.connection, "v=0\r\na=answer:rotated\r\n");
    expect(active.connection).toMatchObject({ state: "active", connectionEpoch: 2 });
    const rotatedReplay = await transaction(value.owner.workspaceId, (tx) =>
      claimSessionRealtimeConnectionInTransaction(tx, rotationInput),
    );
    expect(rotatedReplay).toMatchObject({
      replay: true,
      modeVersion: 2,
      connection: { id: rotated.connection.id, state: "active" },
    });
  });

  test("accepts durable provider startup proof exactly once for the captured rotation fence", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    await complete(value, first.claimed.connection);
    const outbound = await transaction(value.owner.workspaceId, (tx) =>
      appendSessionRealtimeOutboundInTransaction(tx, {
        workspaceId: value.owner.workspaceId,
        sessionId: value.owner.sessionId,
        realtimeId: value.started.mode.id,
        operationId: crypto.randomUUID(),
        connectionEpoch: 1,
        kind: "delegation_result",
        delegationItemId: "delegation-startup-1",
        text: "durable result before rotation",
      }),
    );
    const rotated = await transaction(value.owner.workspaceId, (tx) =>
      claimSessionRealtimeConnectionInTransaction(tx, {
        ...ownerProof(value),
        operationId: crypto.randomUUID(),
        expectedConnectionEpoch: 1,
        rotate: true,
      }),
    );
    expect(rotated.connection.startupFenceSequence).toBe(outbound.entry.sequence);
    expect(rotated.startupEntries.map((entry) => entry.id)).toEqual([outbound.entry.id]);
    await complete(value, rotated.connection);

    const proof = {
      providerSessionId: "provider-session-startup-1",
      providerEventId: "provider-event-startup-1",
    };
    const syncInput = {
      ...ownerProof(value, rotated.modeVersion),
      connectionId: rotated.connection.id,
      connectionEpoch: rotated.connection.connectionEpoch,
      providerStarted: proof,
    };
    await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, syncInput),
    );
    await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, syncInput),
    );

    const persisted = await transaction(value.owner.workspaceId, async (tx) => {
      const [connection] = await tx
        .select()
        .from(schema.sessionRealtimeConnections)
        .where(eq(schema.sessionRealtimeConnections.id, rotated.connection.id))
        .limit(1);
      const [entry] = await tx
        .select()
        .from(schema.sessionRealtimeEntries)
        .where(eq(schema.sessionRealtimeEntries.id, outbound.entry.id))
        .limit(1);
      return { connection, entry };
    });
    expect(persisted.connection).toMatchObject({
      providerSessionId: proof.providerSessionId,
      startupEventId: proof.providerEventId,
    });
    expect(persisted.connection?.startupAcknowledgedAt).toBeInstanceOf(Date);
    expect(persisted.entry?.providerAckedAt).toBeInstanceOf(Date);

    await expectConflict(
      transaction(value.owner.workspaceId, (tx) =>
        syncSessionRealtimeLedgerInTransaction(tx, {
          ...syncInput,
          providerStarted: { ...proof, providerSessionId: "provider-session-other" },
        }),
      ),
      "REALTIME_CONNECTION_STATE_CHANGED",
    );
  });

  test("persists finalized transcripts once in ordinary session continuity", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    await complete(value, first.claimed.connection);
    const entries = [
      {
        operationId: crypto.randomUUID(),
        kind: "user_transcript" as const,
        providerEventId: "input-transcript-1",
        text: "finalized human voice",
      },
      {
        operationId: crypto.randomUUID(),
        kind: "assistant_transcript" as const,
        providerEventId: "output-transcript-1",
        text: "finalized assistant voice",
      },
    ];
    const input = {
      ...ownerProof(value),
      connectionId: first.claimed.connection.id,
      connectionEpoch: 1,
      entries,
    };
    const added = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, input),
    );
    expect(added.accepted.map((item) => item.replay)).toEqual([false, false]);
    const replay = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, input),
    );
    expect(replay.accepted.map((item) => item.replay)).toEqual([true, true]);

    const history = await getActiveSessionHistoryItems(
      client.db,
      value.owner.workspaceId,
      value.owner.sessionId,
    );
    expect(history.slice(-2).map(({ item }) => item)).toEqual([
      { type: "message", role: "user", content: "finalized human voice" },
      { type: "message", role: "assistant", content: "finalized assistant voice" },
    ]);
  });

  test("replays an unacknowledged ordinary update across rotation and preserves it for normal mode", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    await complete(value, first.claimed.connection);
    const operationId = crypto.randomUUID();
    const added = await addSessionSystemUpdate(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId!,
      sessionId: value.session.id,
      kind: "agent_message",
      classification: "info",
      sourceId: "another-session",
      dedupeKey: `voice-update-${operationId}`,
      summary: "durable update during voice",
      payload: { type: "agent_message", text: "durable update during voice", operationId },
    });
    if (!("update" in added)) throw new Error("Realtime update was not accepted");

    const firstSync = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value),
        connectionId: first.claimed.connection.id,
        connectionEpoch: 1,
      }),
    );
    const update = firstSync.outbound.find((entry) => entry.kind === "session_update");
    expect(update).toMatchObject({ sourceUpdateId: added.update.id, text: added.update.summary });
    const clientAcked = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value),
        connectionId: first.claimed.connection.id,
        connectionEpoch: 1,
        clientAckThroughSequence: update!.sequence,
      }),
    );
    expect(clientAcked.outbound.map((entry) => entry.id)).toContain(update!.id);

    const rotated = await transaction(value.owner.workspaceId, (tx) =>
      claimSessionRealtimeConnectionInTransaction(tx, {
        ...ownerProof(value),
        operationId: crypto.randomUUID(),
        expectedConnectionEpoch: 1,
        rotate: true,
      }),
    );
    await complete(value, rotated.connection, "v=0\r\na=answer:replay\r\n");
    const replayed = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value, rotated.modeVersion),
        connectionId: rotated.connection.id,
        connectionEpoch: 2,
      }),
    );
    expect(replayed.outbound.map((entry) => entry.id)).toContain(update!.id);
    const acknowledged = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value, rotated.modeVersion),
        connectionId: rotated.connection.id,
        connectionEpoch: 2,
        providerStarted: {
          providerSessionId: "provider-session-replay",
          providerEventId: "provider-event-replay",
        },
      }),
    );
    expect(acknowledged.outbound.map((entry) => entry.id)).not.toContain(update!.id);
    expect(
      await listOutstandingSessionSystemUpdates(
        client.db,
        value.owner.workspaceId,
        value.owner.sessionId,
      ),
    ).toHaveLength(1);
  });

  test("orders a delegation result for provider delivery and closes the active epoch on exit", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    await complete(value, first.claimed.connection);
    await proveProviderStarted(value, first.claimed.connection);
    const delegationItemId = "delegation-item-1";
    const call = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value),
        connectionId: first.claimed.connection.id,
        connectionEpoch: 1,
        entries: [
          {
            operationId: crypto.randomUUID(),
            kind: "delegation_call",
            providerEventId: "delegation-created-1",
            delegationItemId,
            payload: { name: "session_send_message", arguments: { sessionId: "target" } },
          },
        ],
      }),
    );
    const result = await transaction(value.owner.workspaceId, (tx) =>
      appendSessionRealtimeOutboundInTransaction(tx, {
        workspaceId: value.owner.workspaceId,
        sessionId: value.owner.sessionId,
        realtimeId: value.started.mode.id,
        operationId: crypto.randomUUID(),
        connectionEpoch: 1,
        kind: "delegation_result",
        delegationItemId,
        text: "durable tool result",
        payload: { ok: true },
      }),
    );
    expect(result.entry.sequence).toBeGreaterThan(call.accepted[0]!.entry.sequence);

    await transaction(value.owner.workspaceId, (tx) =>
      endSessionRealtimeInTransaction(tx, {
        ...ownerProof(value),
        reason: "user_stop",
      }),
    );
    const rows = await withWorkspaceRls(client.db, value.owner.workspaceId, (db) =>
      db
        .select({ state: schema.sessionRealtimeConnections.state })
        .from(schema.sessionRealtimeConnections)
        .where(eq(schema.sessionRealtimeConnections.realtimeId, value.started.mode.id))
        .orderBy(asc(schema.sessionRealtimeConnections.connectionEpoch)),
    );
    expect(rows).toEqual([{ state: "closed" }]);
  });

  test("atomically admits one idempotent ordinary turn on the same session without changing hierarchy", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    await complete(value, first.claimed.connection);
    await proveProviderStarted(value, first.claimed.connection);
    const before = await transaction(value.owner.workspaceId, async (tx) => {
      const [session] = await tx
        .select({
          id: schema.sessions.id,
          parentSessionId: schema.sessions.parentSessionId,
          rootSessionId: schema.sessions.rootSessionId,
          nestedAgentDepth: schema.sessions.nestedAgentDepth,
          sandboxGroupId: schema.sessions.sandboxGroupId,
        })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, value.session.id));
      const [{ count } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(schema.sessions)
        .where(eq(schema.sessions.workspaceId, value.owner.workspaceId));
      return { session, count: Number(count) };
    });
    const input = delegationSyncInput(value, first.claimed.connection);
    const admitted = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, input),
    );
    const replay = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, input),
    );
    const providerReplayInput = {
      ...input,
      entries: [{ ...input.entries[0]!, operationId: crypto.randomUUID() }],
    };
    const providerReplay = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, providerReplayInput),
    );
    expect(admitted.accepted).toHaveLength(1);
    expect(admitted.accepted[0]).toMatchObject({ replay: false });
    expect(admitted.accepted[0]!.entry.turnId).toBeString();
    expect(admitted.eventIds).toHaveLength(2);
    expect(admitted.workflowWakeRevision).toBeGreaterThan(0);
    expect(replay.accepted[0]).toMatchObject({
      replay: true,
      entry: { turnId: admitted.accepted[0]!.entry.turnId },
    });
    expect(replay.eventIds).toEqual([]);
    expect(replay.workflowWakeRevision).toBeNull();
    expect(providerReplay.accepted[0]).toMatchObject({
      replay: true,
      entry: {
        operationId: input.entries[0]!.operationId,
        turnId: admitted.accepted[0]!.entry.turnId,
      },
    });

    const persisted = await transaction(value.owner.workspaceId, async (tx) => {
      const turns = await tx
        .select()
        .from(schema.sessionTurns)
        .where(
          and(
            eq(schema.sessionTurns.sessionId, value.session.id),
            eq(schema.sessionTurns.id, admitted.accepted[0]!.entry.turnId!),
          ),
        );
      const calls = await tx
        .select()
        .from(schema.sessionRealtimeEntries)
        .where(
          and(
            eq(schema.sessionRealtimeEntries.realtimeId, value.started.mode.id),
            eq(schema.sessionRealtimeEntries.operationId, input.entries[0]!.operationId),
          ),
        );
      const [session] = await tx
        .select({
          id: schema.sessions.id,
          parentSessionId: schema.sessions.parentSessionId,
          rootSessionId: schema.sessions.rootSessionId,
          nestedAgentDepth: schema.sessions.nestedAgentDepth,
          sandboxGroupId: schema.sessions.sandboxGroupId,
        })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, value.session.id));
      const [{ count } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(schema.sessions)
        .where(eq(schema.sessions.workspaceId, value.owner.workspaceId));
      const [{ children } = { children: 0 }] = await tx
        .select({ children: sql<number>`count(*)` })
        .from(schema.sessions)
        .where(eq(schema.sessions.parentSessionId, value.session.id));
      return { turns, calls, session, count: Number(count), children: Number(children) };
    });
    expect(persisted.turns).toHaveLength(1);
    expect(persisted.turns[0]).toMatchObject({
      sessionId: value.session.id,
      source: "api",
      status: "queued",
      prompt: input.entries[0]!.text,
      initiatorKind: "subject",
      initiatorSubjectId: value.owner.ownerSubjectId,
    });
    expect(persisted.calls).toHaveLength(1);
    expect(persisted.calls[0]!.turnId).toBe(persisted.turns[0]!.id);
    expect(persisted.count).toBe(before.count);
    expect(persisted.children).toBe(0);
    expect(persisted.session).toEqual(before.session);
  });

  test("rolls back call and turn on an injected transient failure, then exact retry succeeds", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    await complete(value, first.claimed.connection);
    await proveProviderStarted(value, first.claimed.connection);
    const input = delegationSyncInput(value, first.claimed.connection);
    await expect(
      transaction(value.owner.workspaceId, (tx) =>
        syncSessionRealtimeLedgerInTransaction(tx, input, {
          afterDelegationAdmission: () => {
            throw new Error("injected transient admission failure");
          },
        }),
      ),
    ).rejects.toThrow("injected transient admission failure");
    const rolledBack = await transaction(value.owner.workspaceId, async (tx) => {
      const calls = await tx
        .select({ id: schema.sessionRealtimeEntries.id })
        .from(schema.sessionRealtimeEntries)
        .where(eq(schema.sessionRealtimeEntries.operationId, input.entries[0]!.operationId));
      const turns = await tx
        .select({ id: schema.sessionTurns.id })
        .from(schema.sessionTurns)
        .where(eq(schema.sessionTurns.prompt, input.entries[0]!.text));
      return { calls, turns };
    });
    expect(rolledBack).toEqual({ calls: [], turns: [] });

    const retried = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, input),
    );
    expect(retried.accepted[0]).toMatchObject({ replay: false });
    expect(retried.accepted[0]!.entry.turnId).toBeString();
  });

  test("rejects unproved or stale provider admission and deterministically ledgers an invalid call", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    await complete(value, first.claimed.connection);
    const unproved = delegationSyncInput(value, first.claimed.connection);
    await expectConflict(
      transaction(value.owner.workspaceId, (tx) =>
        syncSessionRealtimeLedgerInTransaction(tx, unproved),
      ),
      "REALTIME_PROVIDER_NOT_STARTED",
    );
    await proveProviderStarted(value, first.claimed.connection);
    const stale = {
      ...delegationSyncInput(value, first.claimed.connection),
      connectionEpoch: first.claimed.connection.connectionEpoch + 1,
    };
    await expectConflict(
      transaction(value.owner.workspaceId, (tx) =>
        syncSessionRealtimeLedgerInTransaction(tx, stale),
      ),
      "REALTIME_CONNECTION_CHANGED",
    );

    const operationId = crypto.randomUUID();
    const invalid = {
      ...ownerProof(value),
      connectionId: first.claimed.connection.id,
      connectionEpoch: first.claimed.connection.connectionEpoch,
      entries: [
        {
          operationId,
          kind: "delegation_call" as const,
          providerEventId: "delegation-invalid-1",
          text: "",
        },
      ],
    };
    const failed = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, invalid),
    );
    const failedReplay = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, invalid),
    );
    expect(failed.accepted[0]).toMatchObject({ replay: false, entry: { turnId: null } });
    expect(failed.outbound).toContainEqual(
      expect.objectContaining({
        kind: "error",
        turnId: null,
        payload: { code: "invalid_delegation_call", callOperationId: operationId },
      }),
    );
    expect(failedReplay.accepted[0]).toMatchObject({ replay: true, entry: { turnId: null } });
    const invalidState = await transaction(value.owner.workspaceId, async (tx) => {
      const turns = await tx
        .select({ id: schema.sessionTurns.id })
        .from(schema.sessionTurns)
        .where(eq(schema.sessionTurns.prompt, ""));
      const errors = await tx
        .select({ id: schema.sessionRealtimeEntries.id })
        .from(schema.sessionRealtimeEntries)
        .where(
          and(
            eq(schema.sessionRealtimeEntries.realtimeId, value.started.mode.id),
            eq(schema.sessionRealtimeEntries.kind, "error"),
          ),
        );
      return { turns, errors };
    });
    expect(invalidState.turns).toHaveLength(0);
    expect(invalidState.errors).toHaveLength(1);
  });

  test("keeps delegation admission isolated by session identity and workspace RLS", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    await complete(value, first.claimed.connection);
    await proveProviderStarted(value, first.claimed.connection);
    const otherSession = await createSession(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.owner.workspaceId,
      initialMessage: "isolated peer session",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const wrongSession = {
      ...delegationSyncInput(value, first.claimed.connection),
      sessionId: otherSession.id,
    };
    await expectConflict(
      transaction(value.owner.workspaceId, (tx) =>
        syncSessionRealtimeLedgerInTransaction(tx, wrongSession),
      ),
      "REALTIME_NOT_FOUND",
    );

    const foreign = await fixture();
    await expectConflict(
      transaction(foreign.owner.workspaceId, (tx) =>
        syncSessionRealtimeLedgerInTransaction(
          tx,
          delegationSyncInput(value, first.claimed.connection),
        ),
      ),
      "REALTIME_NOT_FOUND",
    );
    const peerTurns = await transaction(value.owner.workspaceId, (tx) =>
      tx
        .select({ id: schema.sessionTurns.id })
        .from(schema.sessionTurns)
        .where(eq(schema.sessionTurns.sessionId, otherSession.id)),
    );
    expect(peerTurns).toEqual([]);
  });
});
