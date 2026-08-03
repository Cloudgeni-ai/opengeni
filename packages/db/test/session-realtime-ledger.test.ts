import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { and, asc, eq, sql } from "drizzle-orm";

import {
  acceptSessionHumanInputResponse,
  addSessionSystemUpdate,
  activateSessionRealtimeConnectionInTransaction,
  appendSessionEventsForTurnAttempt,
  appendSessionRealtimeOutboundInTransaction,
  applySessionTurnSettlement,
  beginSessionRealtimeInTransaction,
  bootstrapWorkspace,
  claimSessionRealtimeConnectionInTransaction,
  claimSessionWorkForAttempt,
  completeSessionRealtimeConnectionInTransaction,
  createDb,
  createSession,
  endSessionRealtimeInTransaction,
  failSessionRealtimeConnectionInTransaction,
  getActiveSessionHistoryItems,
  getSessionHumanInputRequest,
  listOutstandingSessionSystemUpdates,
  mutateSessionControlInTransaction,
  peekSessionWork,
  recoverSessionDispatch,
  SessionControlInvariantError,
  SessionRealtimeConflictError,
  settleCodexCredentialLeaseLoss,
  settleSessionAttemptInterruptions,
  submitHumanPromptInTransaction,
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

async function endMode(value: Fixture) {
  return await transaction(value.owner.workspaceId, (tx) =>
    endSessionRealtimeInTransaction(tx, {
      ...ownerProof(value),
      reason: "user_stop",
    }),
  );
}

async function beginReplacementMode(value: Fixture): Promise<Fixture> {
  const owner = {
    ...value.owner,
    operationId: crypto.randomUUID(),
    browserInstanceId: `browser-${crypto.randomUUID()}`,
    ownerKey: `owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
  };
  const started = await transaction(owner.workspaceId, (tx) =>
    beginSessionRealtimeInTransaction(tx, owner),
  );
  return { ...value, owner, started };
}

async function claimInitial(value: Fixture, promotionMode: "legacy" | "staged" = "staged") {
  const operationId = crypto.randomUUID();
  const input = {
    ...ownerProof(value),
    operationId,
    expectedConnectionEpoch: 1,
    rotate: false,
    promotionMode,
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
  await transaction(value.owner.workspaceId, (tx) =>
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
  return await transaction(value.owner.workspaceId, (tx) =>
    activateSessionRealtimeConnectionInTransaction(tx, {
      ...ownerProof(value),
      connectionId: connection.id,
      operationId: connection.operationId,
      connectionEpoch: connection.connectionEpoch,
      expectedConnectionEpoch: value.started.mode.connectionEpoch,
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
  const inputTranscript = "Complete one ordinary delegated task on this same session";
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
        text: `<realtime_delegation>\n  <input>${inputTranscript}</input>\n</realtime_delegation>`,
        payload: { offsetMs: 125, inputTranscript, transcriptFenceTurnIds: [] },
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

async function admitAndClaimDelegation(
  value: Fixture,
  connection: { id: string; connectionEpoch: number },
) {
  const admitted = await transaction(value.owner.workspaceId, (tx) =>
    syncSessionRealtimeLedgerInTransaction(tx, delegationSyncInput(value, connection)),
  );
  const turnId = admitted.accepted[0]?.entry.turnId;
  if (!turnId) throw new Error("Realtime delegation turn was not linked");
  expect(await peekSessionWork(client.db, value.owner.workspaceId, value.owner.sessionId)).toEqual({
    kind: "runnable",
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, value.owner.workspaceId, {
    sessionId: value.owner.sessionId,
    workflowId: `session-${value.owner.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") {
    throw new Error(`Realtime delegation turn was not claimable: ${claimed.reason}`);
  }
  expect(claimed.turn.id).toBe(turnId);
  return { admitted, turn: claimed.turn, attemptId };
}

async function freezeDelegatedHumanInput(
  value: Fixture,
  connection: { id: string; connectionEpoch: number },
) {
  const delegated = await admitAndClaimDelegation(value, connection);
  const requestId = crypto.randomUUID();
  const questions = [
    {
      id: "environment",
      kind: "single_select" as const,
      prompt: "Which environment should I deploy to?",
      label: "Environment",
      options: [
        { id: "staging", label: "Staging", description: "Validate before production" },
        { id: "production", label: "Production", description: "Deploy to users" },
      ],
      required: true,
      allowOther: false,
    },
  ];
  const request = {
    id: requestId,
    toolCallId: `human-input-${requestId}`,
    questions,
    allowSkip: false,
    expiresAt: null,
  };
  const settlement = await applySessionTurnSettlement(client.db, value.owner.workspaceId, {
    sessionId: value.owner.sessionId,
    turnId: delegated.turn.id,
    triggerEventId: delegated.turn.triggerEventId,
    attemptId: delegated.attemptId,
    turnStatus: "requires_action",
    sessionStatus: "requires_action",
    activeTurnId: delegated.turn.id,
    runState: {
      serializedRunState: JSON.stringify({ version: 1, waiting: requestId }),
      pendingApprovals: [],
      humanInputRequests: [request],
    },
    events: [
      { type: "session.humanInput.requested", payload: { request } },
      { type: "session.status.changed", payload: { status: "requires_action" } },
    ],
  });
  expect(settlement.action).toBe("settled");
  return { ...delegated, requestId, questions };
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

  test("stages a rotation beside epoch one and fences it only after browser activation", async () => {
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
      promotionMode: "staged" as const,
    };
    const rotated = await transaction(value.owner.workspaceId, (tx) =>
      claimSessionRealtimeConnectionInTransaction(tx, rotationInput),
    );
    expect(rotated).toMatchObject({
      replay: false,
      modeVersion: 1,
      connection: { connectionEpoch: 2, state: "negotiating" },
    });
    const beforePromotion = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value),
        connectionId: first.claimed.connection.id,
        connectionEpoch: first.claimed.connection.connectionEpoch,
      }),
    );
    expect(beforePromotion.outbound).toEqual([]);
    const active = await complete(value, rotated.connection, "v=0\r\na=answer:rotated\r\n");
    expect(active.connection).toMatchObject({ state: "active", connectionEpoch: 2 });
    expect(active.mode).toMatchObject({ version: 2, connectionEpoch: 2 });
    await expectConflict(
      transaction(value.owner.workspaceId, (tx) =>
        syncSessionRealtimeLedgerInTransaction(tx, {
          ...ownerProof(value, active.mode.version),
          connectionId: first.claimed.connection.id,
          connectionEpoch: first.claimed.connection.connectionEpoch,
        }),
      ),
      "REALTIME_CONNECTION_CHANGED",
    );
    const rotatedReplay = await transaction(value.owner.workspaceId, (tx) =>
      claimSessionRealtimeConnectionInTransaction(tx, rotationInput),
    );
    expect(rotatedReplay).toMatchObject({
      replay: true,
      modeVersion: 2,
      connection: { id: rotated.connection.id, state: "active" },
    });
  });

  test("preserves sole-parent legacy rotation and direct negotiating-to-active completion", async () => {
    const value = await fixture();
    const first = await claimInitial(value, "legacy");
    expect(first.claimed).toMatchObject({
      modeVersion: 1,
      connection: {
        connectionEpoch: 1,
        promotionMode: "legacy",
        state: "negotiating",
      },
    });
    const firstCompleted = await transaction(value.owner.workspaceId, (tx) =>
      completeSessionRealtimeConnectionInTransaction(tx, {
        workspaceId: value.owner.workspaceId,
        sessionId: value.owner.sessionId,
        realtimeId: value.started.mode.id,
        connectionId: first.claimed.connection.id,
        operationId: first.claimed.connection.operationId,
        connectionEpoch: first.claimed.connection.connectionEpoch,
        sdpAnswer: "v=0\r\na=answer:legacy-initial\r\n",
      }),
    );
    expect(firstCompleted.connection).toMatchObject({
      state: "active",
      promotionMode: "legacy",
    });

    const rotationInput = {
      ...ownerProof(value),
      operationId: crypto.randomUUID(),
      expectedConnectionEpoch: 1,
      rotate: true,
      promotionMode: "legacy" as const,
    };
    const rotated = await transaction(value.owner.workspaceId, (tx) =>
      claimSessionRealtimeConnectionInTransaction(tx, rotationInput),
    );
    expect(rotated).toMatchObject({
      modeVersion: 2,
      connection: {
        connectionEpoch: 2,
        promotionMode: "legacy",
        state: "negotiating",
      },
    });
    const rotatedCompleted = await transaction(value.owner.workspaceId, (tx) =>
      completeSessionRealtimeConnectionInTransaction(tx, {
        workspaceId: value.owner.workspaceId,
        sessionId: value.owner.sessionId,
        realtimeId: value.started.mode.id,
        connectionId: rotated.connection.id,
        operationId: rotated.connection.operationId,
        connectionEpoch: rotated.connection.connectionEpoch,
        sdpAnswer: "v=0\r\na=answer:legacy-rotated\r\n",
      }),
    );
    expect(rotatedCompleted.connection).toMatchObject({ state: "active" });

    const activationReplay = await transaction(value.owner.workspaceId, (tx) =>
      activateSessionRealtimeConnectionInTransaction(tx, {
        ...ownerProof(value),
        connectionId: rotated.connection.id,
        operationId: rotated.connection.operationId,
        connectionEpoch: rotated.connection.connectionEpoch,
        expectedConnectionEpoch: 1,
      }),
    );
    expect(activationReplay).toMatchObject({
      replay: true,
      mode: { version: 2, connectionEpoch: 2 },
      connection: { state: "active" },
    });
    const claimReplay = await transaction(value.owner.workspaceId, (tx) =>
      claimSessionRealtimeConnectionInTransaction(tx, rotationInput),
    );
    expect(claimReplay).toMatchObject({
      replay: true,
      modeVersion: 2,
      connection: { id: rotated.connection.id, state: "active" },
    });
  });

  test("rejects operation replay when the requested promotion mode changes", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    await expectConflict(
      transaction(value.owner.workspaceId, (tx) =>
        claimSessionRealtimeConnectionInTransaction(tx, {
          ...first.input,
          promotionMode: "legacy",
        }),
      ),
      "REALTIME_CONNECTION_CHANGED",
    );
  });

  test("keeps staged active and ready generations intact when a sole-parent writer races", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    await complete(value, first.claimed.connection);
    const replacement = await transaction(value.owner.workspaceId, (tx) =>
      claimSessionRealtimeConnectionInTransaction(tx, {
        ...ownerProof(value),
        operationId: crypto.randomUUID(),
        expectedConnectionEpoch: 1,
        rotate: true,
        promotionMode: "staged",
      }),
    );
    await transaction(value.owner.workspaceId, (tx) =>
      completeSessionRealtimeConnectionInTransaction(tx, {
        workspaceId: value.owner.workspaceId,
        sessionId: value.owner.sessionId,
        realtimeId: value.started.mode.id,
        connectionId: replacement.connection.id,
        operationId: replacement.connection.operationId,
        connectionEpoch: replacement.connection.connectionEpoch,
        sdpAnswer: "v=0\r\na=answer:staged-ready\r\n",
      }),
    );

    const legacyOperationId = crypto.randomUUID();
    await expect(
      shared.admin.begin(async (transactionSql) => {
        const [open] = await transactionSql<{ id: string }[]>`
          select id
          from session_realtime_connections
          where realtime_id = ${value.started.mode.id}
            and state in ('negotiating', 'active')
          for update
          limit 1`;
        if (!open) throw new Error("sole-parent writer found no open connection");
        await transactionSql`
          update session_realtime_connections
          set state = 'closed', closed_at = now(), updated_at = now()
          where id = ${open.id}`;
        await transactionSql`
          update session_realtime_modes
          set connection_epoch = 2, version = version + 1, updated_at = now()
          where id = ${value.started.mode.id}
            and connection_epoch = 1`;
        await transactionSql`
          insert into session_realtime_connections (
            account_id, workspace_id, session_id, realtime_id,
            operation_id, connection_epoch, state
          ) values (
            ${value.grant.accountId}, ${value.owner.workspaceId}, ${value.owner.sessionId},
            ${value.started.mode.id}, ${legacyOperationId}, 2, 'negotiating'
          )`;
      }),
    ).rejects.toMatchObject({ code: "23505" });

    const rows = await transaction(value.owner.workspaceId, (tx) =>
      tx
        .select({
          connectionEpoch: schema.sessionRealtimeConnections.connectionEpoch,
          promotionMode: schema.sessionRealtimeConnections.promotionMode,
          state: schema.sessionRealtimeConnections.state,
        })
        .from(schema.sessionRealtimeConnections)
        .where(eq(schema.sessionRealtimeConnections.realtimeId, value.started.mode.id))
        .orderBy(asc(schema.sessionRealtimeConnections.connectionEpoch)),
    );
    expect(rows).toEqual([
      { connectionEpoch: 1, promotionMode: "staged", state: "active" },
      { connectionEpoch: 2, promotionMode: "staged", state: "ready" },
    ]);
    const [mode] = await transaction(value.owner.workspaceId, (tx) =>
      tx
        .select({
          connectionEpoch: schema.sessionRealtimeModes.connectionEpoch,
          version: schema.sessionRealtimeModes.version,
        })
        .from(schema.sessionRealtimeModes)
        .where(eq(schema.sessionRealtimeModes.id, value.started.mode.id)),
    );
    expect(mode).toEqual({ connectionEpoch: 1, version: 1 });
  });

  test("failed replacement negotiation preserves the active connection and mode epoch", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    await complete(value, first.claimed.connection);
    const rotated = await transaction(value.owner.workspaceId, (tx) =>
      claimSessionRealtimeConnectionInTransaction(tx, {
        ...ownerProof(value),
        operationId: crypto.randomUUID(),
        expectedConnectionEpoch: 1,
        rotate: true,
      }),
    );
    await transaction(value.owner.workspaceId, (tx) =>
      failSessionRealtimeConnectionInTransaction(tx, {
        workspaceId: value.owner.workspaceId,
        sessionId: value.owner.sessionId,
        realtimeId: value.started.mode.id,
        connectionId: rotated.connection.id,
        operationId: rotated.connection.operationId,
        connectionEpoch: rotated.connection.connectionEpoch,
        failureCode: "network_error",
      }),
    );
    const stillActive = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value),
        connectionId: first.claimed.connection.id,
        connectionEpoch: first.claimed.connection.connectionEpoch,
      }),
    );
    expect(stillActive.outbound).toEqual([]);
    const retried = await transaction(value.owner.workspaceId, (tx) =>
      claimSessionRealtimeConnectionInTransaction(tx, {
        ...ownerProof(value),
        operationId: crypto.randomUUID(),
        expectedConnectionEpoch: 1,
        rotate: true,
      }),
    );
    expect(retried).toMatchObject({
      modeVersion: 1,
      connection: { state: "negotiating", connectionEpoch: 3 },
    });
  });

  test("accepts startup proof once without mistaking it for provider delivery", async () => {
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
    const rotationInput = {
      ...ownerProof(value),
      operationId: crypto.randomUUID(),
      expectedConnectionEpoch: 1,
      rotate: true,
    };
    const rotated = await transaction(value.owner.workspaceId, (tx) =>
      claimSessionRealtimeConnectionInTransaction(tx, rotationInput),
    );
    expect(rotated.connection.startupFenceSequence).toBe(outbound.entry.sequence);
    expect(rotated.startupEntries.map((entry) => entry.id)).toEqual([outbound.entry.id]);
    const active = await complete(value, rotated.connection);

    const proof = {
      providerSessionId: "provider-session-startup-1",
      providerEventId: "provider-event-startup-1",
    };
    const syncInput = {
      ...ownerProof(value, active.mode.version),
      connectionId: rotated.connection.id,
      connectionEpoch: rotated.connection.connectionEpoch,
      providerStarted: proof,
    };
    const firstStarted = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, syncInput),
    );
    const replayedStarted = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, syncInput),
    );
    expect(firstStarted.outbound.map((entry) => entry.id)).toContain(outbound.entry.id);
    expect(replayedStarted.outbound.map((entry) => entry.id)).toContain(outbound.entry.id);

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
    expect(persisted.entry?.providerAckedAt).toBeNull();

    const acknowledgedClaimReplay = await transaction(value.owner.workspaceId, (tx) =>
      claimSessionRealtimeConnectionInTransaction(tx, rotationInput),
    );
    expect(acknowledgedClaimReplay.replay).toBe(true);
    expect(acknowledgedClaimReplay.startupEntries.map((entry) => entry.id)).toEqual([
      outbound.entry.id,
    ]);

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

  test("keeps finalized transcripts out of durable history until the end-of-call tail flush", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    await complete(value, first.claimed.connection);
    await expect(
      transaction(value.owner.workspaceId, (tx) =>
        syncSessionRealtimeLedgerInTransaction(tx, {
          ...ownerProof(value),
          connectionId: first.claimed.connection.id,
          connectionEpoch: 1,
          entries: [
            {
              operationId: crypto.randomUUID(),
              kind: "user_transcript",
              text: "legacy transcript fragment",
            },
          ],
        }),
      ),
    ).rejects.toThrow("Finalized realtime transcript turn id is required");
    const entries = [
      {
        operationId: crypto.randomUUID(),
        kind: "user_transcript" as const,
        providerEventId: "input-transcript-1",
        text: "finalized human voice",
        payload: { turnId: "user-turn-1" },
      },
      {
        operationId: crypto.randomUUID(),
        kind: "assistant_transcript" as const,
        providerEventId: "output-transcript-1",
        text: "finalized assistant voice",
        payload: { turnId: "assistant-turn-1" },
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
    expect(added.accepted.map((item) => item.entry.historyItemId)).toEqual([null, null]);

    const history = await getActiveSessionHistoryItems(
      client.db,
      value.owner.workspaceId,
      value.owner.sessionId,
    );
    expect(history.some(({ item }) => JSON.stringify(item).includes("finalized human voice"))).toBe(
      false,
    );
    expect(
      history.some(({ item }) => JSON.stringify(item).includes("finalized assistant voice")),
    ).toBe(false);
  });

  test("rejects changed immutable input and outbound collisions on every operation replay", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    await complete(value, first.claimed.connection);
    const operationId = crypto.randomUUID();
    const exact = {
      ...ownerProof(value),
      connectionId: first.claimed.connection.id,
      connectionEpoch: 1,
      entries: [
        {
          operationId,
          kind: "user_transcript" as const,
          role: "user" as const,
          providerEventId: "immutable-transcript-1",
          text: "immutable finalized transcript",
          payload: { turnId: "immutable-turn-1", nested: { z: 1, a: 2 } },
        },
      ],
    };
    await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, exact),
    );
    await expect(
      transaction(value.owner.workspaceId, (tx) =>
        syncSessionRealtimeLedgerInTransaction(tx, {
          ...exact,
          entries: [{ ...exact.entries[0]!, text: "changed transcript" }],
        }),
      ),
    ).rejects.toMatchObject({ code: "REALTIME_ENTRY_CHANGED" });
    await expect(
      transaction(value.owner.workspaceId, (tx) =>
        syncSessionRealtimeLedgerInTransaction(tx, {
          ...exact,
          entries: [{ ...exact.entries[0]!, providerEventId: "immutable-transcript-2" }],
        }),
      ),
    ).rejects.toMatchObject({ code: "REALTIME_ENTRY_CHANGED" });
    await expect(
      transaction(value.owner.workspaceId, (tx) =>
        syncSessionRealtimeLedgerInTransaction(tx, {
          ...exact,
          entries: [
            {
              ...exact.entries[0]!,
              payload: { turnId: "immutable-turn-1", nested: { a: 3, z: 1 } },
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "REALTIME_ENTRY_CHANGED" });
    await expect(
      transaction(value.owner.workspaceId, (tx) =>
        syncSessionRealtimeLedgerInTransaction(tx, {
          ...exact,
          entries: [
            {
              operationId,
              kind: "error",
              providerEventId: "immutable-transcript-1",
              text: "immutable finalized transcript",
              payload: { nested: { z: 1, a: 2 } },
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "REALTIME_ENTRY_CHANGED" });

    const outboundOperationId = crypto.randomUUID();
    await transaction(value.owner.workspaceId, (tx) =>
      appendSessionRealtimeOutboundInTransaction(tx, {
        workspaceId: value.owner.workspaceId,
        sessionId: value.owner.sessionId,
        realtimeId: value.started.mode.id,
        operationId: outboundOperationId,
        connectionEpoch: 1,
        kind: "error",
        text: "outbound-only operation",
      }),
    );
    await expect(
      transaction(value.owner.workspaceId, (tx) =>
        syncSessionRealtimeLedgerInTransaction(tx, {
          ...ownerProof(value),
          connectionId: first.claimed.connection.id,
          connectionEpoch: 1,
          entries: [
            {
              operationId: outboundOperationId,
              kind: "error",
              text: "outbound-only operation",
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "REALTIME_ENTRY_CHANGED" });
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
    const active = await complete(value, rotated.connection, "v=0\r\na=answer:replay\r\n");
    const replayed = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value, active.mode.version),
        connectionId: rotated.connection.id,
        connectionEpoch: 2,
      }),
    );
    expect(replayed.outbound.map((entry) => entry.id)).toContain(update!.id);
    const acknowledged = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value, active.mode.version),
        connectionId: rotated.connection.id,
        connectionEpoch: 2,
        providerStarted: {
          providerSessionId: "provider-session-replay",
          providerEventId: "provider-event-replay",
        },
      }),
    );
    expect(acknowledged.outbound.map((entry) => entry.id)).toContain(update!.id);
    expect(
      await listOutstandingSessionSystemUpdates(
        client.db,
        value.owner.workspaceId,
        value.owner.sessionId,
      ),
    ).toHaveLength(1);
  });

  test("paginates more than 100 cross-session updates before filtering represented rows", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    await complete(value, first.claimed.connection);
    const updateIds = Array.from({ length: 135 }, () => crypto.randomUUID());
    const createdAt = new Date();
    await transaction(value.owner.workspaceId, async (tx) => {
      await tx.insert(schema.sessionSystemUpdates).values(
        updateIds.map((id, index) => ({
          id,
          accountId: value.grant.accountId,
          workspaceId: value.owner.workspaceId,
          sessionId: value.owner.sessionId,
          kind: "agent_message",
          classification: "info",
          sourceId: `pagination-source-${index}`,
          dedupeKey: `pagination-update-${id}`,
          summary: `pagination update ${index}`,
          payload: { type: "agent_message", text: `pagination update ${index}` },
          createdAt,
        })),
      );
    });

    const firstPage = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value),
        connectionId: first.claimed.connection.id,
        connectionEpoch: 1,
      }),
    );
    expect(firstPage.outbound).toHaveLength(100);
    const firstPageIds = new Set(firstPage.outbound.map((entry) => entry.sourceUpdateId));
    expect(firstPageIds.size).toBe(100);

    const secondPage = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value),
        connectionId: first.claimed.connection.id,
        connectionEpoch: 1,
        clientAckThroughSequence: Math.max(...firstPage.outbound.map((entry) => entry.sequence)),
      }),
    );
    expect(secondPage.outbound).toHaveLength(100);
    const newlyDelivered = secondPage.outbound.filter(
      (entry) => !firstPageIds.has(entry.sourceUpdateId),
    );
    expect(newlyDelivered).toHaveLength(35);
    expect(
      secondPage.outbound.slice(0, 35).every((entry) => !firstPageIds.has(entry.sourceUpdateId)),
    ).toBe(true);
    const secondPageIds = new Set(newlyDelivered.map((entry) => entry.sourceUpdateId));
    expect(secondPageIds.size).toBe(35);
    expect([...secondPageIds].some((id) => firstPageIds.has(id))).toBe(false);

    const represented = await transaction(value.owner.workspaceId, (tx) =>
      tx
        .select({ sourceUpdateId: schema.sessionRealtimeEntries.sourceUpdateId })
        .from(schema.sessionRealtimeEntries)
        .where(
          and(
            eq(schema.sessionRealtimeEntries.realtimeId, value.started.mode.id),
            eq(schema.sessionRealtimeEntries.kind, "session_update"),
          ),
        )
        .orderBy(asc(schema.sessionRealtimeEntries.sequence)),
    );
    expect(represented).toHaveLength(135);
    expect(new Set(represented.map(({ sourceUpdateId }) => sourceUpdateId)).size).toBe(135);
    expect(new Set([...firstPageIds, ...secondPageIds])).toEqual(new Set(updateIds));
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

    const replacement = await transaction(value.owner.workspaceId, (tx) =>
      claimSessionRealtimeConnectionInTransaction(tx, {
        ...ownerProof(value),
        operationId: crypto.randomUUID(),
        expectedConnectionEpoch: first.claimed.connection.connectionEpoch,
        rotate: true,
      }),
    );
    await transaction(value.owner.workspaceId, (tx) =>
      completeSessionRealtimeConnectionInTransaction(tx, {
        workspaceId: value.owner.workspaceId,
        sessionId: value.owner.sessionId,
        realtimeId: value.started.mode.id,
        connectionId: replacement.connection.id,
        operationId: replacement.connection.operationId,
        connectionEpoch: replacement.connection.connectionEpoch,
        sdpAnswer: "v=0\r\na=answer:ready-at-stop\r\n",
      }),
    );

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
    expect(rows).toEqual([{ state: "closed" }, { state: "closed" }]);
  });

  test("atomically admits one idempotent ordinary turn on the same session without changing hierarchy", async () => {
    const value = await fixture();
    await transaction(value.owner.workspaceId, async (tx) => {
      await tx.insert(schema.sessionTurns).values({
        accountId: value.grant.accountId,
        workspaceId: value.owner.workspaceId,
        sessionId: value.session.id,
        triggerEventId: crypto.randomUUID(),
        temporalWorkflowId: `session-${value.session.id}`,
        status: "completed",
        source: "user",
        position: 1,
        prompt: "prior configured conversation turn",
        resources: [],
        tools: [],
        model: "codex/configured-conversation-model",
        reasoningEffort: "high",
        latencyMode: "fast",
        sandboxBackend: "docker",
        sandboxOs: "linux",
        startedAt: new Date(),
        finishedAt: new Date(),
      });
    });
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
      const [userEvent] = await tx
        .select()
        .from(schema.sessionEvents)
        .where(eq(schema.sessionEvents.id, turns[0]!.triggerEventId));
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
      return { turns, calls, userEvent, session, count: Number(count), children: Number(children) };
    });
    expect(persisted.turns).toHaveLength(1);
    expect(persisted.turns[0]).toMatchObject({
      sessionId: value.session.id,
      source: "api",
      status: "queued",
      prompt: input.entries[0]!.text,
      model: "codex/configured-conversation-model",
      reasoningEffort: "high",
      latencyMode: "fast",
      sandboxBackend: "none",
      sandboxOs: null,
      initiatorKind: "service",
      initiatorSubjectId: value.owner.ownerSubjectId,
      lineage: { actor: "service" },
      metadata: {
        delivery: "steer",
        realtimeDelegation: {
          realtimeId: value.started.mode.id,
          connectionEpoch: 1,
          delegationItemId: input.entries[0]!.delegationItemId,
          ledgerEntryId: persisted.calls[0]!.id,
          source: "realtime_provider_delegation",
          inputTranscript: input.entries[0]!.payload.inputTranscript,
        },
        replacedTurnId: null,
        replacedAttemptId: null,
        interruptionCount: 0,
      },
    });
    expect(persisted.calls).toHaveLength(1);
    expect(persisted.userEvent?.payload).toEqual({
      text: input.entries[0]!.payload.inputTranscript,
      presentation: {
        kind: "realtime_voice",
        context: input.entries[0]!.text,
      },
      model: "codex/configured-conversation-model",
      reasoningEffort: "high",
      latencyMode: "fast",
      delivery: "steer",
      initiator: expect.any(Object),
    });
    expect(persisted.calls[0]!.turnId).toBe(persisted.turns[0]!.id);
    expect(persisted.count).toBe(before.count);
    expect(persisted.children).toBe(0);
    expect(persisted.session).toEqual(before.session);
  });

  test("delegation uses canonical Steer against an already-running ordinary turn", async () => {
    const value = await fixture();
    const connection = await claimInitial(value);
    await complete(value, connection.claimed.connection);
    await proveProviderStarted(value, connection.claimed.connection);
    const foreground = await transaction(value.owner.workspaceId, (tx) =>
      submitHumanPromptInTransaction(tx, {
        accountId: value.owner.accountId,
        workspaceId: value.owner.workspaceId,
        sessionId: value.owner.sessionId,
        subjectId: value.owner.ownerSubjectId,
        actor: { type: "human", subjectId: value.owner.ownerSubjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Work on the original direction",
        resources: [],
        reasoningEffortFallback: "low",
        source: "user",
      }),
    );
    const attemptId = crypto.randomUUID();
    const foregroundClaim = await claimSessionWorkForAttempt(client.db, value.owner.workspaceId, {
      sessionId: value.owner.sessionId,
      workflowId: `session-${value.owner.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(foregroundClaim).toMatchObject({
      action: "claimed",
      turn: { id: foreground.turnId },
    });

    const admitted = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(
        tx,
        delegationSyncInput(value, connection.claimed.connection),
      ),
    );
    const replacementId = admitted.accepted[0]?.entry.turnId;
    if (!replacementId) throw new Error("Realtime Steer replacement was not linked");
    const facts = await transaction(value.owner.workspaceId, async (tx) => {
      const [replacement] = await tx
        .select()
        .from(schema.sessionTurns)
        .where(eq(schema.sessionTurns.id, replacementId));
      const [interruption] = await tx
        .select()
        .from(schema.sessionAttemptInterruptions)
        .where(eq(schema.sessionAttemptInterruptions.attemptId, attemptId));
      const [session] = await tx
        .select({ activeTurnId: schema.sessions.activeTurnId })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, value.owner.sessionId));
      return { replacement, interruption, session };
    });
    expect(facts.replacement).toMatchObject({
      id: replacementId,
      status: "queued",
      metadata: {
        delivery: "steer",
        replacedTurnId: foreground.turnId,
        replacedAttemptId: attemptId,
        interruptionCount: 1,
      },
    });
    expect(facts.interruption).toMatchObject({ attemptId, kind: "steer", state: "pending" });
    expect(facts.session?.activeTurnId).toBe(foreground.turnId);
  });

  test("mirrors a durable structured question into realtime as speakable session context", async () => {
    const value = await fixture();
    const connection = await claimInitial(value);
    await complete(value, connection.claimed.connection);
    await proveProviderStarted(value, connection.claimed.connection);
    const waiting = await freezeDelegatedHumanInput(value, connection.claimed.connection);

    const sync = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value),
        connectionId: connection.claimed.connection.id,
        connectionEpoch: connection.claimed.connection.connectionEpoch,
      }),
    );
    const question = sync.outbound.find((entry) => entry.payload.source === "human_input_request");
    expect(question).toMatchObject({
      kind: "session_update",
      delegationItemId: null,
      payload: {
        source: "human_input_request",
        sourceTurnId: waiting.turn.id,
        channel: "speakable",
        status: "waiting_for_user",
        requestIds: [waiting.requestId],
      },
    });
    expect(question?.text).toContain("<prompt>Which environment should I deploy to?</prompt>");
    expect(question?.text).toContain("<label>Staging</label>");
    expect(question?.text).toContain("delegate exactly once");
    expect(question?.text).not.toContain("Steer");
  });

  test("mirrors an already-pending structured question when realtime starts", async () => {
    const value = await fixture();
    const connection = await claimInitial(value);
    await complete(value, connection.claimed.connection);
    await proveProviderStarted(value, connection.claimed.connection);
    const waiting = await freezeDelegatedHumanInput(value, connection.claimed.connection);
    await endMode(value);

    const resumed = await beginReplacementMode(value);
    const resumedConnection = await claimInitial(resumed);
    await complete(resumed, resumedConnection.claimed.connection);
    await proveProviderStarted(resumed, resumedConnection.claimed.connection);
    const sync = await transaction(resumed.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(resumed),
        connectionId: resumedConnection.claimed.connection.id,
        connectionEpoch: resumedConnection.claimed.connection.connectionEpoch,
      }),
    );

    expect(
      sync.outbound.find((entry) => entry.payload.source === "human_input_request"),
    ).toMatchObject({
      kind: "session_update",
      payload: {
        channel: "speakable",
        status: "waiting_for_user",
        trigger: "realtime_start",
        requestIds: [waiting.requestId],
        sourceTurnId: waiting.turn.id,
      },
    });
  });

  test("mirrors an accepted structured UI answer without delegating it again", async () => {
    const value = await fixture();
    const connection = await claimInitial(value);
    await complete(value, connection.claimed.connection);
    await proveProviderStarted(value, connection.claimed.connection);
    const waiting = await freezeDelegatedHumanInput(value, connection.claimed.connection);
    const questionSync = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value),
        connectionId: connection.claimed.connection.id,
        connectionEpoch: connection.claimed.connection.connectionEpoch,
      }),
    );
    const questionSequence = questionSync.outbound.find(
      (entry) => entry.payload.source === "human_input_request",
    )?.sequence;
    if (!questionSequence) throw new Error("Structured question was not projected");

    const accepted = await acceptSessionHumanInputResponse(client.db, {
      accountId: value.owner.accountId,
      workspaceId: value.owner.workspaceId,
      sessionId: value.owner.sessionId,
      requestId: waiting.requestId,
      response: {
        outcome: "answered",
        answers: [{ questionId: "environment", values: ["staging"] }],
      },
      respondedBy: value.owner.ownerSubjectId,
      clientEventId: crypto.randomUUID(),
    });
    expect(accepted.action).toBe("accepted");

    const sync = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value),
        connectionId: connection.claimed.connection.id,
        connectionEpoch: connection.claimed.connection.connectionEpoch,
        clientAckThroughSequence: questionSequence,
      }),
    );
    const response = sync.outbound.find((entry) => entry.payload.source === "human_input_response");
    expect(response).toMatchObject({
      kind: "session_update",
      payload: {
        source: "human_input_response",
        channel: "speakable",
        requestId: waiting.requestId,
        outcome: "answered",
      },
    });
    expect(response?.text).toContain("<value>Staging</value>");
    expect(response?.text).toContain("do not delegate it again");
  });

  test("a conversational answer delegates normally and supersedes the waiting question", async () => {
    const value = await fixture();
    const connection = await claimInitial(value);
    await complete(value, connection.claimed.connection);
    await proveProviderStarted(value, connection.claimed.connection);
    const waiting = await freezeDelegatedHumanInput(value, connection.claimed.connection);
    const firstSync = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value),
        connectionId: connection.claimed.connection.id,
        connectionEpoch: connection.claimed.connection.connectionEpoch,
      }),
    );
    const questionSequence = firstSync.outbound.find(
      (entry) => entry.payload.source === "human_input_request",
    )?.sequence;
    if (!questionSequence) throw new Error("Structured question was not projected");

    const operationId = crypto.randomUUID();
    const answer = "The answer to ‘Which environment should I deploy to?’ is Staging.";
    const delegated = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value),
        connectionId: connection.claimed.connection.id,
        connectionEpoch: connection.claimed.connection.connectionEpoch,
        clientAckThroughSequence: questionSequence,
        entries: [
          {
            operationId,
            kind: "delegation_call",
            providerEventId: `delegation-created-${operationId}`,
            delegationItemId: `delegation-item-${operationId}`,
            text: `<realtime_delegation>\n  <input>${answer}</input>\n</realtime_delegation>`,
            payload: { inputTranscript: answer, transcriptFenceTurnIds: [] },
          },
        ],
      }),
    );
    const answerTurnId = delegated.accepted[0]?.entry.turnId;
    if (!answerTurnId) throw new Error("Conversational answer was not delegated");
    expect(answerTurnId).not.toBe(waiting.turn.id);

    const state = await transaction(value.owner.workspaceId, async (tx) => {
      const [request] = await tx
        .select()
        .from(schema.sessionHumanInputRequests)
        .where(eq(schema.sessionHumanInputRequests.id, waiting.requestId));
      const [waitingTurn] = await tx
        .select({ status: schema.sessionTurns.status })
        .from(schema.sessionTurns)
        .where(eq(schema.sessionTurns.id, waiting.turn.id));
      const [answerTurn] = await tx
        .select({ prompt: schema.sessionTurns.prompt, metadata: schema.sessionTurns.metadata })
        .from(schema.sessionTurns)
        .where(eq(schema.sessionTurns.id, answerTurnId));
      return { request, waitingTurn, answerTurn };
    });
    expect(state.request).toMatchObject({
      status: "cancelled",
      response: { outcome: "cancelled" },
    });
    expect(state.waitingTurn?.status).toBe("superseded");
    expect(state.answerTurn?.prompt).toContain(answer);
    expect(state.answerTurn?.metadata).toMatchObject({ delivery: "steer" });
    expect(
      delegated.outbound.find(
        (entry) =>
          entry.payload.source === "human_input_response" &&
          entry.payload.requestId === waiting.requestId,
      ),
    ).toMatchObject({ payload: { outcome: "cancelled", channel: null } });
    expect(
      await getSessionHumanInputRequest(
        client.db,
        value.owner.workspaceId,
        value.owner.sessionId,
        waiting.requestId,
      ),
    ).toMatchObject({ status: "cancelled" });
  });

  test("session cancellation retires the pending voice question silently", async () => {
    const value = await fixture();
    const connection = await claimInitial(value);
    await complete(value, connection.claimed.connection);
    await proveProviderStarted(value, connection.claimed.connection);
    const waiting = await freezeDelegatedHumanInput(value, connection.claimed.connection);
    const firstSync = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value),
        connectionId: connection.claimed.connection.id,
        connectionEpoch: connection.claimed.connection.connectionEpoch,
      }),
    );
    const questionSequence = firstSync.outbound.find(
      (entry) => entry.payload.source === "human_input_request",
    )?.sequence;
    if (!questionSequence) throw new Error("Structured question was not projected");

    await transaction(value.owner.workspaceId, (tx) =>
      mutateSessionControlInTransaction(tx, {
        accountId: value.owner.accountId,
        workspaceId: value.owner.workspaceId,
        sessionId: value.owner.sessionId,
        actor: { type: "human", subjectId: value.owner.ownerSubjectId },
        operationKey: crypto.randomUUID(),
        action: "cancel",
      }),
    );
    const sync = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value),
        connectionId: connection.claimed.connection.id,
        connectionEpoch: connection.claimed.connection.connectionEpoch,
        clientAckThroughSequence: questionSequence,
      }),
    );
    expect(
      sync.outbound.find(
        (entry) =>
          entry.payload.source === "human_input_response" &&
          entry.payload.requestId === waiting.requestId,
      ),
    ).toMatchObject({ payload: { channel: null, outcome: "cancelled" } });
  });

  test("human Steer continues an ownerless realtime delegation through session context", async () => {
    const value = await fixture();
    const connection = await claimInitial(value);
    await complete(value, connection.claimed.connection);
    await proveProviderStarted(value, connection.claimed.connection);
    const admitted = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(
        tx,
        delegationSyncInput(value, connection.claimed.connection),
      ),
    );
    const delegatedTurnId = admitted.accepted[0]?.entry.turnId;
    if (!delegatedTurnId) throw new Error("Realtime delegation was not linked");
    await transaction(value.owner.workspaceId, async (tx) => {
      await tx.execute(sql`set local opengeni.session_inference_claim = '1'`);
      await tx
        .update(schema.sessionTurns)
        .set({ status: "requires_action", startedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.sessionTurns.id, delegatedTurnId));
      await tx
        .update(schema.sessions)
        .set({
          activeTurnId: delegatedTurnId,
          status: "requires_action",
          updatedAt: new Date(),
        })
        .where(eq(schema.sessions.id, value.owner.sessionId));
    });

    await transaction(value.owner.workspaceId, (tx) =>
      submitHumanPromptInTransaction(tx, {
        accountId: value.owner.accountId,
        workspaceId: value.owner.workspaceId,
        sessionId: value.owner.sessionId,
        subjectId: value.owner.ownerSubjectId,
        actor: { type: "human", subjectId: value.owner.ownerSubjectId },
        operationKey: crypto.randomUUID(),
        delivery: "steer",
        text: "Replace the waiting delegation",
        resources: [],
        reasoningEffortFallback: "medium",
        source: "user",
      }),
    );

    const projection = await transaction(value.owner.workspaceId, async (tx) => {
      const terminal = await tx
        .select()
        .from(schema.sessionRealtimeEntries)
        .where(
          and(
            eq(schema.sessionRealtimeEntries.turnId, delegatedTurnId),
            eq(schema.sessionRealtimeEntries.direction, "provider_out"),
            eq(schema.sessionRealtimeEntries.kind, "error"),
          ),
        );
      const [humanSteer] = await tx
        .select()
        .from(schema.sessionRealtimeEntries)
        .where(
          and(
            eq(schema.sessionRealtimeEntries.direction, "provider_out"),
            eq(schema.sessionRealtimeEntries.kind, "session_update"),
          ),
        );
      const [turn] = await tx
        .select({ status: schema.sessionTurns.status })
        .from(schema.sessionTurns)
        .where(eq(schema.sessionTurns.id, delegatedTurnId));
      return { humanSteer, terminal, turn };
    });
    expect(projection.turn?.status).toBe("superseded");
    expect(projection.terminal).toEqual([]);
    expect(projection.humanSteer).toMatchObject({
      kind: "session_update",
      text: expect.stringContaining("<status>accepted_for_steering</status>"),
      payload: {
        delivery: "steer",
        routing: "accepted_for_steering",
        source: "human_input",
      },
    });
  });

  test("human Steer does not fabricate a terminal after running-turn interruption settlement", async () => {
    const value = await fixture();
    const connection = await claimInitial(value);
    await complete(value, connection.claimed.connection);
    await proveProviderStarted(value, connection.claimed.connection);
    const admitted = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(
        tx,
        delegationSyncInput(value, connection.claimed.connection),
      ),
    );
    const delegatedTurnId = admitted.accepted[0]?.entry.turnId;
    if (!delegatedTurnId) throw new Error("Realtime delegation was not linked");
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(client.db, value.owner.workspaceId, {
      sessionId: value.owner.sessionId,
      workflowId: `session-${value.owner.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claim).toMatchObject({ action: "claimed", turn: { id: delegatedTurnId } });

    await transaction(value.owner.workspaceId, (tx) =>
      submitHumanPromptInTransaction(tx, {
        accountId: value.owner.accountId,
        workspaceId: value.owner.workspaceId,
        sessionId: value.owner.sessionId,
        subjectId: value.owner.ownerSubjectId,
        actor: { type: "human", subjectId: value.owner.ownerSubjectId },
        operationKey: crypto.randomUUID(),
        delivery: "steer",
        text: "Replace the running delegation",
        resources: [],
        reasoningEffortFallback: "medium",
        source: "user",
      }),
    );
    await settleSessionAttemptInterruptions(
      client.db,
      value.owner.workspaceId,
      value.owner.sessionId,
      attemptId,
    );

    const terminal = await transaction(value.owner.workspaceId, (tx) =>
      tx
        .select()
        .from(schema.sessionRealtimeEntries)
        .where(
          and(
            eq(schema.sessionRealtimeEntries.turnId, delegatedTurnId),
            eq(schema.sessionRealtimeEntries.direction, "provider_out"),
            eq(schema.sessionRealtimeEntries.kind, "error"),
          ),
        ),
    );
    expect(terminal).toEqual([]);
  });

  test("mirrors accepted human Send or Steer once as silent typed realtime context", async () => {
    const value = await fixture();
    const connection = await claimInitial(value);
    await complete(value, connection.claimed.connection);
    await proveProviderStarted(value, connection.claimed.connection);

    const human = await transaction(value.owner.workspaceId, (tx) =>
      submitHumanPromptInTransaction(tx, {
        accountId: value.owner.accountId,
        workspaceId: value.owner.workspaceId,
        sessionId: value.owner.sessionId,
        subjectId: value.owner.ownerSubjectId,
        actor: { type: "human", subjectId: value.owner.ownerSubjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Use <human> steering & keep context",
        resources: [],
        reasoningEffortFallback: "medium",
        source: "user",
      }),
    );
    const [mirrored] = await transaction(value.owner.workspaceId, (tx) =>
      tx
        .select()
        .from(schema.sessionRealtimeEntries)
        .where(
          and(
            eq(schema.sessionRealtimeEntries.realtimeId, value.started.mode.id),
            eq(schema.sessionRealtimeEntries.kind, "session_update"),
          ),
        ),
    );
    const mirroredText = String(mirrored?.text);
    expect(mirroredText).toContain("<status>accepted_for_execution</status>");
    expect(mirroredText).toContain("Use &lt;human&gt; steering &amp; keep context");
    expect(mirroredText).toContain("do not delegate this message again");
    expect(mirrored).toMatchObject({
      turnId: null,
      payload: {
        source: "human_input",
        sourceId: human.acceptedEventId,
        sourceTurnId: human.turnId,
        channel: null,
        delivery: "send",
        routing: "accepted_for_execution",
        acceptedEventId: human.acceptedEventId,
      },
    });

    await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(
        tx,
        delegationSyncInput(value, connection.claimed.connection),
      ),
    );
    const humanMirrors = await transaction(value.owner.workspaceId, (tx) =>
      tx
        .select({ payload: schema.sessionRealtimeEntries.payload })
        .from(schema.sessionRealtimeEntries)
        .where(
          and(
            eq(schema.sessionRealtimeEntries.realtimeId, value.started.mode.id),
            eq(schema.sessionRealtimeEntries.kind, "session_update"),
            sql`${schema.sessionRealtimeEntries.payload} ->> 'source' = 'human_input'`,
          ),
        ),
    );
    expect(humanMirrors).toHaveLength(1);
  });

  test("marks a human Send behind existing work as queued without a later acceptance echo", async () => {
    const value = await fixture();
    const connection = await claimInitial(value);
    await complete(value, connection.claimed.connection);
    await proveProviderStarted(value, connection.claimed.connection);

    await transaction(value.owner.workspaceId, (tx) =>
      submitHumanPromptInTransaction(tx, {
        accountId: value.owner.accountId,
        workspaceId: value.owner.workspaceId,
        sessionId: value.owner.sessionId,
        subjectId: value.owner.ownerSubjectId,
        actor: { type: "human", subjectId: value.owner.ownerSubjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "First waiting message",
        resources: [],
        reasoningEffortFallback: "medium",
        source: "user",
      }),
    );
    const second = await transaction(value.owner.workspaceId, (tx) =>
      submitHumanPromptInTransaction(tx, {
        accountId: value.owner.accountId,
        workspaceId: value.owner.workspaceId,
        sessionId: value.owner.sessionId,
        subjectId: value.owner.ownerSubjectId,
        actor: { type: "human", subjectId: value.owner.ownerSubjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Second waiting message",
        resources: [],
        reasoningEffortFallback: "medium",
        source: "user",
      }),
    );
    const [mirrored] = await transaction(value.owner.workspaceId, (tx) =>
      tx
        .select()
        .from(schema.sessionRealtimeEntries)
        .where(
          and(
            eq(schema.sessionRealtimeEntries.kind, "session_update"),
            sql`${schema.sessionRealtimeEntries.payload} ->> 'sourceId' = ${second.acceptedEventId}`,
          ),
        ),
    );

    expect(mirrored).toMatchObject({
      text: expect.stringContaining("<status>queued_for_execution</status>"),
      payload: {
        source: "human_input",
        routing: "queued_for_execution",
        delivery: "send",
      },
    });
  });

  test("mirrors progress and completion for work already running when realtime starts", async () => {
    const initial = await fixture();
    await endMode(initial);
    const foreground = await transaction(initial.owner.workspaceId, (tx) =>
      submitHumanPromptInTransaction(tx, {
        accountId: initial.owner.accountId,
        workspaceId: initial.owner.workspaceId,
        sessionId: initial.owner.sessionId,
        subjectId: initial.owner.ownerSubjectId,
        actor: { type: "human", subjectId: initial.owner.ownerSubjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Finish the pre-existing task",
        resources: [],
        reasoningEffortFallback: "medium",
        source: "user",
      }),
    );
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, initial.owner.workspaceId, {
      sessionId: initial.owner.sessionId,
      workflowId: `session-${initial.owner.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed")
      throw new Error(`Pre-existing turn not claimed: ${claimed.reason}`);
    expect(claimed.turn.id).toBe(foreground.turnId);

    const active = await beginReplacementMode(initial);
    const connection = await claimInitial(active);
    await complete(active, connection.claimed.connection);
    await proveProviderStarted(active, connection.claimed.connection);
    const appended = await appendSessionEventsForTurnAttempt(
      client.db,
      active.owner.workspaceId,
      active.owner.sessionId,
      claimed.turn.id,
      claimed.turn.executionGeneration,
      attemptId,
      [{ type: "agent.message.delta", payload: { text: "Still working on it." } }],
    );
    expect(appended.accepted).toBe(true);
    const settled = await applySessionTurnSettlement(client.db, active.owner.workspaceId, {
      sessionId: active.owner.sessionId,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        { type: "turn.completed", payload: { output: "Pre-existing task finished." } },
        { type: "session.status.changed", payload: { status: "idle" } },
      ],
    });
    expect(settled.action).toBe("settled");

    const rows = await transaction(active.owner.workspaceId, (tx) =>
      tx
        .select()
        .from(schema.sessionRealtimeEntries)
        .where(
          and(
            eq(schema.sessionRealtimeEntries.realtimeId, active.started.mode.id),
            eq(schema.sessionRealtimeEntries.kind, "session_update"),
          ),
        )
        .orderBy(asc(schema.sessionRealtimeEntries.sequence)),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      text: "Still working on it.",
      payload: { source: "assistant_progress", channel: "commentary", route: "session_context" },
    });
    expect(rows[1]).toMatchObject({
      text: "Pre-existing task finished.",
      payload: {
        source: "assistant_terminal",
        channel: "speakable",
        route: "session_context",
        status: "completed",
      },
    });
  });

  test("reattaches an old delegated turn to the new realtime session-wide context", async () => {
    const original = await fixture();
    const originalConnection = await claimInitial(original);
    await complete(original, originalConnection.claimed.connection);
    await proveProviderStarted(original, originalConnection.claimed.connection);
    const execution = await admitAndClaimDelegation(
      original,
      originalConnection.claimed.connection,
    );
    await endMode(original);

    const active = await beginReplacementMode(original);
    const activeConnection = await claimInitial(active);
    await complete(active, activeConnection.claimed.connection);
    await proveProviderStarted(active, activeConnection.claimed.connection);
    await appendSessionEventsForTurnAttempt(
      client.db,
      active.owner.workspaceId,
      active.owner.sessionId,
      execution.turn.id,
      execution.turn.executionGeneration,
      execution.attemptId,
      [{ type: "agent.message.delta", payload: { text: "Resumed delegation progress." } }],
    );
    const settled = await applySessionTurnSettlement(client.db, active.owner.workspaceId, {
      sessionId: active.owner.sessionId,
      turnId: execution.turn.id,
      triggerEventId: execution.turn.triggerEventId,
      attemptId: execution.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        { type: "turn.completed", payload: { output: "Old delegation finished." } },
        { type: "session.status.changed", payload: { status: "idle" } },
      ],
    });
    expect(settled.action).toBe("settled");

    const rows = await transaction(active.owner.workspaceId, (tx) =>
      tx
        .select()
        .from(schema.sessionRealtimeEntries)
        .where(
          and(
            eq(schema.sessionRealtimeEntries.realtimeId, active.started.mode.id),
            eq(schema.sessionRealtimeEntries.kind, "session_update"),
          ),
        )
        .orderBy(asc(schema.sessionRealtimeEntries.sequence)),
    );
    expect(rows.map((row) => [row.text, row.payload.channel])).toEqual([
      ["Resumed delegation progress.", "commentary"],
      ["Old delegation finished.", "speakable"],
    ]);
    expect(rows.every((row) => row.payload.priorRealtimeId === original.started.mode.id)).toBe(
      true,
    );
  });

  test("claims only the accepted delegation during realtime and projects one terminal result", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    await complete(value, first.claimed.connection);
    await proveProviderStarted(value, first.claimed.connection);
    const execution = await admitAndClaimDelegation(value, first.claimed.connection);

    const settled = await applySessionTurnSettlement(client.db, value.owner.workspaceId, {
      sessionId: value.owner.sessionId,
      turnId: execution.turn.id,
      triggerEventId: execution.turn.triggerEventId,
      attemptId: execution.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        {
          type: "turn.completed",
          payload: { output: "bounded delegated work completed" },
        },
        { type: "session.status.changed", payload: { status: "idle" } },
      ],
    });
    expect(settled.action).toBe("settled");

    const duplicate = await applySessionTurnSettlement(client.db, value.owner.workspaceId, {
      sessionId: value.owner.sessionId,
      turnId: execution.turn.id,
      triggerEventId: execution.turn.triggerEventId,
      attemptId: execution.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: { output: "duplicate notification" } }],
    });
    expect(duplicate.action).toBe("stale");

    const terminalRows = await transaction(value.owner.workspaceId, (tx) =>
      tx
        .select()
        .from(schema.sessionRealtimeEntries)
        .where(
          and(
            eq(schema.sessionRealtimeEntries.turnId, execution.turn.id),
            eq(schema.sessionRealtimeEntries.direction, "provider_out"),
          ),
        ),
    );
    expect(terminalRows).toHaveLength(1);
    expect(terminalRows[0]).toMatchObject({
      kind: "delegation_result",
      realtimeId: value.started.mode.id,
      delegationItemId: execution.admitted.accepted[0]!.entry.delegationItemId,
      turnId: execution.turn.id,
      text: "bounded delegated work completed",
      payload: {
        status: "completed",
        turnId: execution.turn.id,
        callLedgerEntryId: execution.admitted.accepted[0]!.entry.id,
      },
    });

    const pending = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value),
        connectionId: first.claimed.connection.id,
        connectionEpoch: first.claimed.connection.connectionEpoch,
      }),
    );
    expect(pending.outbound.map((entry) => entry.id)).toContain(terminalRows[0]!.id);
    const crashRetry = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value),
        connectionId: first.claimed.connection.id,
        connectionEpoch: first.claimed.connection.connectionEpoch,
      }),
    );
    expect(crashRetry.outbound.filter((entry) => entry.turnId === execution.turn.id)).toEqual([
      expect.objectContaining({ id: terminalRows[0]!.id, sequence: terminalRows[0]!.sequence }),
    ]);
    await expectConflict(
      transaction(value.owner.workspaceId, (tx) =>
        syncSessionRealtimeLedgerInTransaction(tx, {
          ...ownerProof(value),
          connectionId: first.claimed.connection.id,
          connectionEpoch: first.claimed.connection.connectionEpoch,
          providerAckSequences: [terminalRows[0]!.sequence],
        }),
      ),
      "REALTIME_ACK_INVALID",
    );
    const acknowledgment = {
      ...ownerProof(value),
      connectionId: first.claimed.connection.id,
      connectionEpoch: first.claimed.connection.connectionEpoch,
      clientAckThroughSequence: terminalRows[0]!.sequence,
      providerAckSequences: [terminalRows[0]!.sequence],
    };
    const acknowledged = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, acknowledgment),
    );
    expect(acknowledged.outbound.map((entry) => entry.id)).not.toContain(terminalRows[0]!.id);
    const lostResponseRetry = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, acknowledgment),
    );
    expect(lostResponseRetry.outbound.map((entry) => entry.id)).not.toContain(terminalRows[0]!.id);
  });

  test("projects accepted delegated assistant deltas as ordered durable progress", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    await complete(value, first.claimed.connection);
    await proveProviderStarted(value, first.claimed.connection);
    const execution = await admitAndClaimDelegation(value, first.claimed.connection);

    const appended = await appendSessionEventsForTurnAttempt(
      client.db,
      value.owner.workspaceId,
      value.owner.sessionId,
      execution.turn.id,
      execution.turn.executionGeneration,
      execution.attemptId,
      [
        { type: "agent.message.delta", payload: { text: "Checking " } },
        { type: "agent.message.delta", payload: { text: "the workspace." } },
      ],
    );
    expect(appended.accepted).toBe(true);

    const [progress] = await transaction(value.owner.workspaceId, (tx) =>
      tx
        .select()
        .from(schema.sessionRealtimeEntries)
        .where(
          and(
            eq(schema.sessionRealtimeEntries.turnId, execution.turn.id),
            eq(schema.sessionRealtimeEntries.kind, "delegation_progress"),
          ),
        ),
    );
    expect(progress).toMatchObject({
      realtimeId: value.started.mode.id,
      delegationItemId: execution.admitted.accepted[0]!.entry.delegationItemId,
      direction: "provider_out",
      text: "Checking the workspace.",
      payload: {
        status: "running",
        turnId: execution.turn.id,
        sourceEventIds: appended.events.map((event) => event.id),
      },
    });

    const pending = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        ...ownerProof(value),
        connectionId: first.claimed.connection.id,
        connectionEpoch: first.claimed.connection.connectionEpoch,
      }),
    );
    expect(pending.outbound).toContainEqual(
      expect.objectContaining({
        id: progress!.id,
        kind: "delegation_progress",
      }),
    );
  });

  test("rolls terminal settlement and projection back together before an exact retry", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    await complete(value, first.claimed.connection);
    await proveProviderStarted(value, first.claimed.connection);
    const execution = await admitAndClaimDelegation(value, first.claimed.connection);
    const settlement = {
      sessionId: value.owner.sessionId,
      turnId: execution.turn.id,
      triggerEventId: execution.turn.triggerEventId,
      attemptId: execution.attemptId,
      turnStatus: "completed" as const,
      sessionStatus: "idle" as const,
      activeTurnId: null,
      events: [
        { type: "turn.completed" as const, payload: { output: "retry-safe output" } },
        { type: "session.status.changed" as const, payload: { status: "idle" } },
      ],
    };
    await expect(
      applySessionTurnSettlement(client.db, value.owner.workspaceId, settlement, {
        afterRealtimeDelegationProjection: () => {
          throw new Error("injected post-projection crash");
        },
      }),
    ).rejects.toThrow("injected post-projection crash");
    const rolledBack = await transaction(value.owner.workspaceId, async (tx) => {
      const [turn] = await tx
        .select({ status: schema.sessionTurns.status })
        .from(schema.sessionTurns)
        .where(eq(schema.sessionTurns.id, execution.turn.id));
      const terminals = await tx
        .select({ id: schema.sessionRealtimeEntries.id })
        .from(schema.sessionRealtimeEntries)
        .where(
          and(
            eq(schema.sessionRealtimeEntries.turnId, execution.turn.id),
            eq(schema.sessionRealtimeEntries.direction, "provider_out"),
          ),
        );
      return { turn, terminals };
    });
    expect(rolledBack).toEqual({ turn: { status: "running" }, terminals: [] });
    const retried = await applySessionTurnSettlement(
      client.db,
      value.owner.workspaceId,
      settlement,
    );
    expect(retried.action).toBe("settled");
    const terminals = await transaction(value.owner.workspaceId, (tx) =>
      tx
        .select({ id: schema.sessionRealtimeEntries.id })
        .from(schema.sessionRealtimeEntries)
        .where(
          and(
            eq(schema.sessionRealtimeEntries.turnId, execution.turn.id),
            eq(schema.sessionRealtimeEntries.direction, "provider_out"),
          ),
        ),
    );
    expect(terminals).toHaveLength(1);
  });

  test("replays one unacknowledged terminal row on rotation and fences the stale connection ACK", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    await complete(value, first.claimed.connection);
    await proveProviderStarted(value, first.claimed.connection);
    const execution = await admitAndClaimDelegation(value, first.claimed.connection);
    await applySessionTurnSettlement(client.db, value.owner.workspaceId, {
      sessionId: value.owner.sessionId,
      turnId: execution.turn.id,
      triggerEventId: execution.turn.triggerEventId,
      attemptId: execution.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: { output: "rotate this exact result" } }],
    });
    const [terminal] = await transaction(value.owner.workspaceId, (tx) =>
      tx
        .select()
        .from(schema.sessionRealtimeEntries)
        .where(
          and(
            eq(schema.sessionRealtimeEntries.turnId, execution.turn.id),
            eq(schema.sessionRealtimeEntries.direction, "provider_out"),
          ),
        ),
    );
    if (!terminal) throw new Error("Terminal projection missing before rotation");

    const rotated = await transaction(value.owner.workspaceId, (tx) =>
      claimSessionRealtimeConnectionInTransaction(tx, {
        ...ownerProof(value),
        operationId: crypto.randomUUID(),
        expectedConnectionEpoch: 1,
        rotate: true,
      }),
    );
    expect(rotated.startupEntries).toEqual([
      expect.objectContaining({ id: terminal.id, sequence: terminal.sequence }),
    ]);
    const active = await complete(
      value,
      rotated.connection,
      "v=0\r\na=answer:terminal-rotation\r\n",
    );
    await expectConflict(
      transaction(value.owner.workspaceId, (tx) =>
        syncSessionRealtimeLedgerInTransaction(tx, {
          ...ownerProof(value, active.mode.version),
          connectionId: first.claimed.connection.id,
          connectionEpoch: first.claimed.connection.connectionEpoch,
          clientAckThroughSequence: terminal.sequence,
          providerAckSequences: [terminal.sequence],
        }),
      ),
      "REALTIME_CONNECTION_CHANGED",
    );
    const started = await proveProviderStarted(value, rotated.connection, active.mode.version);
    expect(started.outbound.map((entry) => entry.id)).toContain(terminal.id);
    const [unacknowledged] = await transaction(value.owner.workspaceId, (tx) =>
      tx
        .select({
          clientAckedAt: schema.sessionRealtimeEntries.clientAckedAt,
          providerAckedAt: schema.sessionRealtimeEntries.providerAckedAt,
        })
        .from(schema.sessionRealtimeEntries)
        .where(eq(schema.sessionRealtimeEntries.id, terminal.id)),
    );
    expect(unacknowledged?.clientAckedAt).toBeNull();
    expect(unacknowledged?.providerAckedAt).toBeNull();
  });

  test("projects deterministic errors from both exceptional terminal failure paths", async () => {
    const leaseValue = await fixture();
    const leaseConnection = await claimInitial(leaseValue);
    await complete(leaseValue, leaseConnection.claimed.connection);
    await proveProviderStarted(leaseValue, leaseConnection.claimed.connection);
    const leaseExecution = await admitAndClaimDelegation(
      leaseValue,
      leaseConnection.claimed.connection,
    );
    const leaseLoss = await settleCodexCredentialLeaseLoss(client.db, {
      accountId: leaseValue.owner.accountId,
      workspaceId: leaseValue.owner.workspaceId,
      sessionId: leaseValue.owner.sessionId,
      turnId: leaseExecution.turn.id,
      attemptId: leaseExecution.attemptId,
      holderId: crypto.randomUUID(),
      generation: 1,
      expectedRedispatches: 0,
      checkpointDurable: false,
      recoveryPayload: { reason: "unused" },
      failedPayload: {
        code: "codex_credential_lease_lost_without_checkpoint",
        error: "Credential lease was lost before a durable checkpoint.",
      },
    });
    expect(leaseLoss.action).toBe("failed");

    const crashValue = await fixture();
    const crashConnection = await claimInitial(crashValue);
    await complete(crashValue, crashConnection.claimed.connection);
    await proveProviderStarted(crashValue, crashConnection.claimed.connection);
    const crashExecution = await admitAndClaimDelegation(
      crashValue,
      crashConnection.claimed.connection,
    );
    const exhausted = await recoverSessionDispatch(client.db, crashValue.owner.workspaceId, {
      sessionId: crashValue.owner.sessionId,
      attemptId: crashExecution.attemptId,
      timeoutType: "HEARTBEAT",
      maxRedispatches: 0,
    });
    expect(exhausted.action).toBe("exceeded");

    for (const [value, turnId, code] of [
      [leaseValue, leaseExecution.turn.id, "codex_credential_lease_lost_without_checkpoint"],
      [crashValue, crashExecution.turn.id, "worker_death_redispatch_exhausted"],
    ] as const) {
      const rows = await transaction(value.owner.workspaceId, (tx) =>
        tx
          .select()
          .from(schema.sessionRealtimeEntries)
          .where(
            and(
              eq(schema.sessionRealtimeEntries.turnId, turnId),
              eq(schema.sessionRealtimeEntries.direction, "provider_out"),
            ),
          ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "error",
        turnId,
        payload: { code, status: "failed" },
      });
    }
  });

  test("does not deadlock ordinary work when delegation metadata is corrupted", async () => {
    const value = await fixture();
    const first = await claimInitial(value);
    await complete(value, first.claimed.connection);
    await proveProviderStarted(value, first.claimed.connection);
    const admitted = await transaction(value.owner.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(
        tx,
        delegationSyncInput(value, first.claimed.connection),
      ),
    );
    const turnId = admitted.accepted[0]!.entry.turnId!;
    await transaction(value.owner.workspaceId, (tx) =>
      tx
        .update(schema.sessionTurns)
        .set({ metadata: { realtimeDelegation: { realtimeId: value.started.mode.id } } })
        .where(eq(schema.sessionTurns.id, turnId)),
    );
    expect(
      await peekSessionWork(client.db, value.owner.workspaceId, value.owner.sessionId),
    ).toMatchObject({ kind: "runnable" });
    const claim = await claimSessionWorkForAttempt(client.db, value.owner.workspaceId, {
      sessionId: value.owner.sessionId,
      workflowId: `session-${value.owner.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claim).toMatchObject({ action: "claimed", turn: { id: turnId } });
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
    await expect(
      transaction(foreign.owner.workspaceId, (tx) =>
        syncSessionRealtimeLedgerInTransaction(
          tx,
          delegationSyncInput(value, first.claimed.connection),
        ),
      ),
    ).rejects.toBeInstanceOf(SessionControlInvariantError);
    const peerTurns = await transaction(value.owner.workspaceId, (tx) =>
      tx
        .select({ id: schema.sessionTurns.id })
        .from(schema.sessionTurns)
        .where(eq(schema.sessionTurns.sessionId, otherSession.id)),
    );
    expect(peerTurns).toEqual([]);
  });
});
