import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { and, asc, eq } from "drizzle-orm";

import {
  addSessionSystemUpdate,
  applySessionTurnSettlement,
  beginSessionRealtimeInTransaction,
  activateSessionRealtimeConnectionInTransaction,
  bootstrapWorkspace,
  claimSessionRealtimeConnectionInTransaction,
  claimSessionWorkForAttempt,
  completeSessionRealtimeConnectionInTransaction,
  createDb,
  createSession,
  endSessionRealtimeInTransaction,
  getSessionRealtimeContextProjectionForTurn,
  listSessionSystemUpdatesForTurn,
  recoverSessionDispatch,
  renderSessionRealtimeContext,
  SESSION_REALTIME_CONTEXT_HEADER,
  SESSION_REALTIME_CONTEXT_MAX_BYTES,
  submitHumanPromptInTransaction,
  syncSessionRealtimeLedgerInTransaction,
  withWorkspaceRls,
  type Database,
  type SessionRealtimeContextSourceEntry,
  type SessionRealtimeInboundEntryInput,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(30_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-realtime-context");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 16 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(workspaceLabel = "primary") {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `realtime-context-account-${workspaceLabel}-${suffix}`,
    accountName: "Realtime context",
    workspaceExternalSource: "test",
    workspaceExternalId: `realtime-context-workspace-${workspaceLabel}-${suffix}`,
    workspaceName: "Realtime context",
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
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
    session,
  };
}

async function peerSession(value: Fixture, label: string) {
  return await createSession(client.db, {
    accountId: value.accountId,
    workspaceId: value.workspaceId,
    initialMessage: label,
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
}

async function transaction<T>(workspaceId: string, fn: (db: Database) => Promise<T>): Promise<T> {
  return await withWorkspaceRls(client.db, workspaceId, (db) =>
    db.transaction((tx) => fn(tx as unknown as Database)),
  );
}

function realtimeOwner(value: Fixture, sessionId = value.session.id) {
  return {
    accountId: value.accountId,
    workspaceId: value.workspaceId,
    sessionId,
    operationId: crypto.randomUUID(),
    ownerSubjectId: value.subjectId,
    browserInstanceId: `browser-${crypto.randomUUID()}`,
    ownerKey: `owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
    model: "gpt-live-1-boulder-alpha" as const,
  };
}

function ledgerEntry(
  kind: SessionRealtimeInboundEntryInput["kind"],
  text: string | null,
  payload: Record<string, unknown> = {},
): SessionRealtimeInboundEntryInput {
  return {
    operationId: crypto.randomUUID(),
    kind,
    ...(kind === "user_transcript" ? { role: "user" as const } : {}),
    ...(kind === "assistant_transcript" ? { role: "assistant" as const } : {}),
    text,
    payload,
  };
}

async function completedMode(
  value: Fixture,
  options: {
    sessionId?: string;
    firstEntries?: SessionRealtimeInboundEntryInput[];
    rotatedEntries?: SessionRealtimeInboundEntryInput[];
    baseMs?: number;
  } = {},
) {
  const owner = realtimeOwner(value, options.sessionId);
  const baseMs = options.baseMs ?? Date.now();
  const started = await transaction(value.workspaceId, (tx) =>
    beginSessionRealtimeInTransaction(tx, {
      ...owner,
      now: new Date(baseMs),
      leaseMs: 120_000,
    }),
  );
  const firstClaim = await transaction(value.workspaceId, (tx) =>
    claimSessionRealtimeConnectionInTransaction(tx, {
      workspaceId: value.workspaceId,
      sessionId: owner.sessionId,
      realtimeId: started.mode.id,
      ownerSubjectId: owner.ownerSubjectId,
      browserInstanceId: owner.browserInstanceId,
      ownerKey: owner.ownerKey,
      expectedVersion: started.mode.version,
      operationId: crypto.randomUUID(),
      expectedConnectionEpoch: 1,
      rotate: false,
      now: new Date(baseMs + 1),
    }),
  );
  await transaction(value.workspaceId, (tx) =>
    completeSessionRealtimeConnectionInTransaction(tx, {
      workspaceId: value.workspaceId,
      sessionId: owner.sessionId,
      realtimeId: started.mode.id,
      connectionId: firstClaim.connection.id,
      operationId: firstClaim.connection.operationId,
      connectionEpoch: 1,
      sdpAnswer: "v=0\r\na=answer:first\r\n",
      now: new Date(baseMs + 2),
    }),
  );
  await transaction(value.workspaceId, (tx) =>
    activateSessionRealtimeConnectionInTransaction(tx, {
      workspaceId: value.workspaceId,
      sessionId: owner.sessionId,
      realtimeId: started.mode.id,
      ownerSubjectId: owner.ownerSubjectId,
      browserInstanceId: owner.browserInstanceId,
      ownerKey: owner.ownerKey,
      expectedVersion: started.mode.version,
      expectedConnectionEpoch: 1,
      connectionId: firstClaim.connection.id,
      operationId: firstClaim.connection.operationId,
      connectionEpoch: 1,
      now: new Date(baseMs + 2),
    }),
  );
  if ((options.firstEntries?.length ?? 0) > 0) {
    await transaction(value.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        workspaceId: value.workspaceId,
        sessionId: owner.sessionId,
        realtimeId: started.mode.id,
        ownerSubjectId: owner.ownerSubjectId,
        browserInstanceId: owner.browserInstanceId,
        ownerKey: owner.ownerKey,
        expectedVersion: started.mode.version,
        connectionId: firstClaim.connection.id,
        connectionEpoch: 1,
        entries: options.firstEntries,
        now: new Date(baseMs + 3),
      }),
    );
  }

  let finalVersion = started.mode.version;
  let finalConnection = firstClaim.connection;
  if (options.rotatedEntries) {
    const rotated = await transaction(value.workspaceId, (tx) =>
      claimSessionRealtimeConnectionInTransaction(tx, {
        workspaceId: value.workspaceId,
        sessionId: owner.sessionId,
        realtimeId: started.mode.id,
        ownerSubjectId: owner.ownerSubjectId,
        browserInstanceId: owner.browserInstanceId,
        ownerKey: owner.ownerKey,
        expectedVersion: started.mode.version,
        operationId: crypto.randomUUID(),
        expectedConnectionEpoch: 1,
        rotate: true,
        now: new Date(baseMs + 4),
      }),
    );
    finalConnection = rotated.connection;
    await transaction(value.workspaceId, (tx) =>
      completeSessionRealtimeConnectionInTransaction(tx, {
        workspaceId: value.workspaceId,
        sessionId: owner.sessionId,
        realtimeId: started.mode.id,
        connectionId: rotated.connection.id,
        operationId: rotated.connection.operationId,
        connectionEpoch: 2,
        sdpAnswer: "v=0\r\na=answer:rotated\r\n",
        now: new Date(baseMs + 5),
      }),
    );
    const activated = await transaction(value.workspaceId, (tx) =>
      activateSessionRealtimeConnectionInTransaction(tx, {
        workspaceId: value.workspaceId,
        sessionId: owner.sessionId,
        realtimeId: started.mode.id,
        ownerSubjectId: owner.ownerSubjectId,
        browserInstanceId: owner.browserInstanceId,
        ownerKey: owner.ownerKey,
        expectedVersion: started.mode.version,
        expectedConnectionEpoch: 1,
        connectionId: rotated.connection.id,
        operationId: rotated.connection.operationId,
        connectionEpoch: rotated.connection.connectionEpoch,
        now: new Date(baseMs + 5),
      }),
    );
    finalVersion = activated.mode.version;
    if (options.rotatedEntries.length > 0) {
      await transaction(value.workspaceId, (tx) =>
        syncSessionRealtimeLedgerInTransaction(tx, {
          workspaceId: value.workspaceId,
          sessionId: owner.sessionId,
          realtimeId: started.mode.id,
          ownerSubjectId: owner.ownerSubjectId,
          browserInstanceId: owner.browserInstanceId,
          ownerKey: owner.ownerKey,
          expectedVersion: finalVersion,
          connectionId: rotated.connection.id,
          connectionEpoch: 2,
          entries: options.rotatedEntries,
          now: new Date(baseMs + 6),
        }),
      );
    }
  }
  const ended = await transaction(value.workspaceId, (tx) =>
    endSessionRealtimeInTransaction(tx, {
      workspaceId: value.workspaceId,
      sessionId: owner.sessionId,
      realtimeId: started.mode.id,
      ownerSubjectId: owner.ownerSubjectId,
      browserInstanceId: owner.browserInstanceId,
      ownerKey: owner.ownerKey,
      expectedVersion: finalVersion,
      reason: "user_stop",
      now: new Date(baseMs + 10),
    }),
  );
  return { owner, started, ended, finalVersion, finalConnection };
}

async function submitPrompt(value: Fixture, text: string, sessionId = value.session.id) {
  return await transaction(value.workspaceId, (tx) =>
    submitHumanPromptInTransaction(tx, {
      accountId: value.accountId,
      workspaceId: value.workspaceId,
      sessionId,
      subjectId: value.subjectId,
      actor: { type: "human", subjectId: value.subjectId },
      operationKey: crypto.randomUUID(),
      delivery: "send",
      text,
      resources: [],
      tools: [],
      reasoningEffortFallback: "low",
      source: "user",
    }),
  );
}

function claimInput(
  sessionId: string,
  overrides: Partial<{ attemptId: string; dispatchId: string }> = {},
) {
  return {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: overrides.attemptId ?? crypto.randomUUID(),
    dispatchId: overrides.dispatchId ?? crypto.randomUUID(),
    trigger: { kind: "next" as const },
  };
}

function contextEvents(context: string | null): Array<Record<string, unknown>> {
  return (context ?? "")
    .split("\n")
    .filter((line) => line.startsWith("event="))
    .map((line) => JSON.parse(line.slice("event=".length)) as Record<string, unknown>);
}

function sourceEntry(
  text: string,
  overrides: Partial<SessionRealtimeContextSourceEntry> = {},
): SessionRealtimeContextSourceEntry {
  return {
    id: crypto.randomUUID(),
    realtimeId: crypto.randomUUID(),
    modeStartedAt: new Date("2026-07-29T00:00:00.000Z"),
    modeEndedAt: new Date("2026-07-29T00:01:00.000Z"),
    modeEndReason: "user_stop",
    connectionEpoch: 1,
    sequence: 1,
    direction: "provider_in",
    kind: "user_transcript",
    role: "user",
    providerEventId: null,
    delegationItemId: null,
    sourceUpdateId: null,
    turnId: null,
    text,
    payload: {},
    clientAckedAt: null,
    providerAckedAt: null,
    createdAt: new Date("2026-07-29T00:00:30.000Z"),
    ...overrides,
  };
}

describe("session realtime context projection", () => {
  test("renders deterministic chronological whole-entry context under the UTF-8 byte bound", () => {
    const older = sourceEntry("older", {
      sequence: 1,
      payload: { z: 1, a: { y: 2, b: 3 }, ä: 4, Z: 5 },
    });
    const oversized = sourceEntry("界😀".repeat(12_000), { sequence: 2 });
    const newest = sourceEntry("newest 😀", { sequence: 3 });

    const rendered = renderSessionRealtimeContext(2, [older, oversized, newest]);
    const replay = renderSessionRealtimeContext(2, [older, oversized, newest]);

    expect(rendered).toEqual(replay);
    expect(rendered.context?.startsWith(SESSION_REALTIME_CONTEXT_HEADER)).toBe(true);
    expect(Buffer.byteLength(rendered.context!, "utf8")).toBeLessThanOrEqual(
      SESSION_REALTIME_CONTEXT_MAX_BYTES,
    );
    expect(Buffer.from(rendered.context!, "utf8").toString("utf8")).toBe(rendered.context!);
    expect(rendered.context).not.toContain("�");
    expect(rendered).toMatchObject({ includedEntryCount: 2, omittedEntryCount: 1 });
    expect(contextEvents(rendered.context).map((entry) => entry.text)).toEqual([
      "older",
      "newest 😀",
    ]);
    expect(Object.keys(contextEvents(rendered.context)[0]?.payload ?? {})).toEqual([
      "Z",
      "a",
      "z",
      "ä",
    ]);
    expect(contextEvents(rendered.context)[0]?.payload).toEqual({
      Z: 5,
      a: { b: 3, y: 2 },
      z: 1,
      ä: 4,
    });
  });

  test("binds multiple ended modes and rotations once, survives same-turn recovery, and never replays later", async () => {
    const value = await fixture("recovery");
    const base = Date.now();
    await completedMode(value, {
      baseMs: base,
      firstEntries: [ledgerEntry("user_transcript", "mode one user")],
    });
    await completedMode(value, {
      baseMs: base + 1_000,
      firstEntries: [ledgerEntry("assistant_transcript", "mode two before rotation")],
      rotatedEntries: [ledgerEntry("user_transcript", "mode two after rotation")],
    });
    const prompt = await submitPrompt(value, "continue in text");
    const firstClaimInput = claimInput(value.session.id);
    const firstClaim = await claimSessionWorkForAttempt(
      client.db,
      value.workspaceId,
      firstClaimInput,
    );
    expect(firstClaim.action).toBe("claimed");
    if (firstClaim.action !== "claimed") throw new Error(firstClaim.reason);
    expect(firstClaim.turn.id).toBe(prompt.turnId);

    const projection = await getSessionRealtimeContextProjectionForTurn(
      client.db,
      value.workspaceId,
      value.session.id,
      firstClaim.turn.id,
    );
    expect(projection).toMatchObject({
      turnId: firstClaim.turn.id,
      sourceModeCount: 2,
      sourceEntryCount: 3,
      includedEntryCount: 3,
      omittedEntryCount: 0,
    });
    expect(contextEvents(projection?.context ?? null).map((entry) => entry.text)).toEqual([
      "mode one user",
      "mode two before rotation",
      "mode two after rotation",
    ]);
    expect(
      contextEvents(projection?.context ?? null).map((entry) => entry.connectionEpoch),
    ).toEqual([1, 1, 2]);

    const exactClaimReplay = await claimSessionWorkForAttempt(
      client.db,
      value.workspaceId,
      firstClaimInput,
    );
    expect(exactClaimReplay).toMatchObject({ action: "claimed", turn: { id: firstClaim.turn.id } });
    const recovery = await recoverSessionDispatch(client.db, value.workspaceId, {
      sessionId: value.session.id,
      attemptId: firstClaimInput.attemptId,
      timeoutType: "HEARTBEAT",
      maxRedispatches: 3,
    });
    expect(recovery).toMatchObject({ action: "recovering", turnId: firstClaim.turn.id });
    const recoveryClaimInput = claimInput(value.session.id);
    const recoveryClaim = await claimSessionWorkForAttempt(
      client.db,
      value.workspaceId,
      recoveryClaimInput,
    );
    expect(recoveryClaim).toMatchObject({
      action: "claimed",
      turn: { id: firstClaim.turn.id, executionGeneration: 2 },
    });
    const recoveredProjection = await getSessionRealtimeContextProjectionForTurn(
      client.db,
      value.workspaceId,
      value.session.id,
      firstClaim.turn.id,
    );
    expect(recoveredProjection?.id).toBe(projection?.id);

    if (recoveryClaim.action !== "claimed") throw new Error(recoveryClaim.reason);
    await applySessionTurnSettlement(client.db, value.workspaceId, {
      sessionId: value.session.id,
      turnId: recoveryClaim.turn.id,
      triggerEventId: recoveryClaim.turn.triggerEventId,
      attemptId: recoveryClaimInput.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        { type: "turn.completed", payload: { output: "continued" } },
        { type: "session.status.changed", payload: { status: "idle" } },
      ],
    });
    const laterPrompt = await submitPrompt(value, "later ordinary turn");
    const laterClaim = await claimSessionWorkForAttempt(
      client.db,
      value.workspaceId,
      claimInput(value.session.id),
    );
    expect(laterClaim).toMatchObject({ action: "claimed", turn: { id: laterPrompt.turnId } });
    expect(
      await getSessionRealtimeContextProjectionForTurn(
        client.db,
        value.workspaceId,
        value.session.id,
        laterPrompt.turnId,
      ),
    ).toBeNull();
    const projections = await transaction(value.workspaceId, (tx) =>
      tx
        .select({ id: schema.sessionRealtimeContextProjections.id })
        .from(schema.sessionRealtimeContextProjections)
        .where(eq(schema.sessionRealtimeContextProjections.sessionId, value.session.id)),
    );
    expect(projections).toHaveLength(1);
  });

  test("rolls claim projection and consumption back together, and explicitly consumes empty history", async () => {
    const rollback = await fixture("rollback");
    const completed = await completedMode(rollback, {
      firstEntries: [ledgerEntry("user_transcript", "rollback me")],
    });
    const prompt = await submitPrompt(rollback, "claim after rollback");
    const input = claimInput(rollback.session.id);
    await expect(
      claimSessionWorkForAttempt(client.db, rollback.workspaceId, input, {
        afterRealtimeContextProjection: () => {
          throw new Error("injected post-projection failure");
        },
      }),
    ).rejects.toThrow("injected post-projection failure");
    const rolledBack = await transaction(rollback.workspaceId, async (tx) => {
      const [turn] = await tx
        .select({ status: schema.sessionTurns.status })
        .from(schema.sessionTurns)
        .where(eq(schema.sessionTurns.id, prompt.turnId));
      const [mode] = await tx
        .select({ projectionId: schema.sessionRealtimeModes.contextProjectionId })
        .from(schema.sessionRealtimeModes)
        .where(eq(schema.sessionRealtimeModes.id, completed.started.mode.id));
      const projections = await tx
        .select({ id: schema.sessionRealtimeContextProjections.id })
        .from(schema.sessionRealtimeContextProjections)
        .where(eq(schema.sessionRealtimeContextProjections.turnId, prompt.turnId));
      const history = await tx
        .select({ id: schema.sessionHistoryItems.id })
        .from(schema.sessionHistoryItems)
        .where(eq(schema.sessionHistoryItems.turnId, prompt.turnId));
      const attempts = await tx
        .select({ id: schema.sessionTurnAttempts.id })
        .from(schema.sessionTurnAttempts)
        .where(eq(schema.sessionTurnAttempts.turnId, prompt.turnId));
      return { turn, mode, projections, history, attempts };
    });
    expect(rolledBack).toEqual({
      turn: { status: "queued" },
      mode: { projectionId: null },
      projections: [],
      history: [],
      attempts: [],
    });
    await expect(
      claimSessionWorkForAttempt(client.db, rollback.workspaceId, input),
    ).resolves.toMatchObject({ action: "claimed", turn: { id: prompt.turnId } });

    const empty = await fixture("empty");
    const emptyMode = await completedMode(empty);
    const emptyPrompt = await submitPrompt(empty, "after silent realtime");
    await claimSessionWorkForAttempt(client.db, empty.workspaceId, claimInput(empty.session.id));
    const emptyProjection = await getSessionRealtimeContextProjectionForTurn(
      client.db,
      empty.workspaceId,
      empty.session.id,
      emptyPrompt.turnId,
    );
    expect(emptyProjection).toMatchObject({
      context: null,
      sourceModeCount: 1,
      sourceEntryCount: 0,
      includedEntryCount: 0,
      omittedEntryCount: 0,
    });
    const [emptyMarker] = await transaction(empty.workspaceId, (tx) =>
      tx
        .select({ projectionId: schema.sessionRealtimeModes.contextProjectionId })
        .from(schema.sessionRealtimeModes)
        .where(eq(schema.sessionRealtimeModes.id, emptyMode.started.mode.id)),
    );
    expect(emptyMarker?.projectionId).toBe(emptyProjection?.id);

    const noHistory = await fixture("none");
    const noHistoryPrompt = await submitPrompt(noHistory, "ordinary without voice");
    await claimSessionWorkForAttempt(
      client.db,
      noHistory.workspaceId,
      claimInput(noHistory.session.id),
    );
    expect(
      await getSessionRealtimeContextProjectionForTurn(
        client.db,
        noHistory.workspaceId,
        noHistory.session.id,
        noHistoryPrompt.turnId,
      ),
    ).toBeNull();
  });

  test("keeps active delegation claims fenced from continuity and coexists with pending updates", async () => {
    const value = await fixture("delegation");
    const prior = await completedMode(value, {
      firstEntries: [ledgerEntry("user_transcript", "prior completed mode")],
    });
    const owner = realtimeOwner(value);
    const started = await transaction(value.workspaceId, (tx) =>
      beginSessionRealtimeInTransaction(tx, owner),
    );
    const connection = await transaction(value.workspaceId, (tx) =>
      claimSessionRealtimeConnectionInTransaction(tx, {
        workspaceId: value.workspaceId,
        sessionId: value.session.id,
        realtimeId: started.mode.id,
        ownerSubjectId: owner.ownerSubjectId,
        browserInstanceId: owner.browserInstanceId,
        ownerKey: owner.ownerKey,
        expectedVersion: started.mode.version,
        operationId: crypto.randomUUID(),
        expectedConnectionEpoch: 1,
        rotate: false,
      }),
    );
    await transaction(value.workspaceId, (tx) =>
      completeSessionRealtimeConnectionInTransaction(tx, {
        workspaceId: value.workspaceId,
        sessionId: value.session.id,
        realtimeId: started.mode.id,
        connectionId: connection.connection.id,
        operationId: connection.connection.operationId,
        connectionEpoch: 1,
        sdpAnswer: "v=0\r\na=answer:delegation\r\n",
      }),
    );
    await transaction(value.workspaceId, (tx) =>
      activateSessionRealtimeConnectionInTransaction(tx, {
        workspaceId: value.workspaceId,
        sessionId: value.session.id,
        realtimeId: started.mode.id,
        ownerSubjectId: owner.ownerSubjectId,
        browserInstanceId: owner.browserInstanceId,
        ownerKey: owner.ownerKey,
        expectedVersion: started.mode.version,
        expectedConnectionEpoch: 1,
        connectionId: connection.connection.id,
        operationId: connection.connection.operationId,
        connectionEpoch: 1,
      }),
    );
    await transaction(value.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        workspaceId: value.workspaceId,
        sessionId: value.session.id,
        realtimeId: started.mode.id,
        ownerSubjectId: owner.ownerSubjectId,
        browserInstanceId: owner.browserInstanceId,
        ownerKey: owner.ownerKey,
        expectedVersion: started.mode.version,
        connectionId: connection.connection.id,
        connectionEpoch: 1,
        providerStarted: {
          providerSessionId: "provider-session-context",
          providerEventId: "provider-started-context",
        },
      }),
    );
    const updateId = crypto.randomUUID();
    const update = await addSessionSystemUpdate(client.db, {
      accountId: value.accountId,
      workspaceId: value.workspaceId,
      sessionId: value.session.id,
      classification: "info",
      sourceId: updateId,
      dedupeKey: `context-update-${updateId}`,
      summary: "cross-session update during realtime",
      kind: "child_terminal_result",
      payload: {
        type: "child_terminal_result",
        childSessionId: crypto.randomUUID(),
        status: "idle",
      },
    });
    if (!update.added) throw new Error("Cross-session update was not inserted");
    const delegationOperation = crypto.randomUUID();
    const delegated = await transaction(value.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        workspaceId: value.workspaceId,
        sessionId: value.session.id,
        realtimeId: started.mode.id,
        ownerSubjectId: owner.ownerSubjectId,
        browserInstanceId: owner.browserInstanceId,
        ownerKey: owner.ownerKey,
        expectedVersion: started.mode.version,
        connectionId: connection.connection.id,
        connectionEpoch: 1,
        entries: [
          {
            operationId: delegationOperation,
            kind: "delegation_call",
            providerEventId: `delegation-created-${delegationOperation}`,
            delegationItemId: `delegation-item-${delegationOperation}`,
            text: "perform delegated work",
            payload: { offsetMs: 100 },
          },
        ],
      }),
    );
    const delegatedTurnId = delegated.accepted[0]?.entry.turnId;
    if (!delegatedTurnId) throw new Error("Delegation was not admitted");
    const delegatedClaimInput = claimInput(value.session.id);
    const delegatedClaim = await claimSessionWorkForAttempt(
      client.db,
      value.workspaceId,
      delegatedClaimInput,
    );
    expect(delegatedClaim).toMatchObject({ action: "claimed", turn: { id: delegatedTurnId } });
    expect(
      await getSessionRealtimeContextProjectionForTurn(
        client.db,
        value.workspaceId,
        value.session.id,
        delegatedTurnId,
      ),
    ).toBeNull();
    const [priorMarker] = await transaction(value.workspaceId, (tx) =>
      tx
        .select({ projectionId: schema.sessionRealtimeModes.contextProjectionId })
        .from(schema.sessionRealtimeModes)
        .where(eq(schema.sessionRealtimeModes.id, prior.started.mode.id)),
    );
    expect(priorMarker?.projectionId).toBeNull();

    if (delegatedClaim.action !== "claimed") throw new Error(delegatedClaim.reason);
    await applySessionTurnSettlement(client.db, value.workspaceId, {
      sessionId: value.session.id,
      turnId: delegatedTurnId,
      triggerEventId: delegatedClaim.turn.triggerEventId,
      attemptId: delegatedClaimInput.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        { type: "turn.completed", payload: { output: "delegated result" } },
        { type: "session.status.changed", payload: { status: "idle" } },
      ],
    });
    const delayedDelegationOperation = crypto.randomUUID();
    const delayedDelegation = await transaction(value.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        workspaceId: value.workspaceId,
        sessionId: value.session.id,
        realtimeId: started.mode.id,
        ownerSubjectId: owner.ownerSubjectId,
        browserInstanceId: owner.browserInstanceId,
        ownerKey: owner.ownerKey,
        expectedVersion: started.mode.version,
        connectionId: connection.connection.id,
        connectionEpoch: 1,
        entries: [
          {
            operationId: delayedDelegationOperation,
            kind: "delegation_call",
            providerEventId: `delegation-created-${delayedDelegationOperation}`,
            delegationItemId: `delegation-item-${delayedDelegationOperation}`,
            text: "perform delayed delegated work",
            payload: { offsetMs: 200 },
          },
        ],
      }),
    );
    const delayedDelegatedTurnId = delayedDelegation.accepted[0]?.entry.turnId;
    if (!delayedDelegatedTurnId) throw new Error("Delayed delegation was not admitted");
    await transaction(value.workspaceId, (tx) =>
      endSessionRealtimeInTransaction(tx, {
        workspaceId: value.workspaceId,
        sessionId: value.session.id,
        realtimeId: started.mode.id,
        ownerSubjectId: owner.ownerSubjectId,
        browserInstanceId: owner.browserInstanceId,
        ownerKey: owner.ownerKey,
        expectedVersion: started.mode.version,
        reason: "user_stop",
      }),
    );
    const delayedClaimInput = claimInput(value.session.id);
    const delayedClaim = await claimSessionWorkForAttempt(
      client.db,
      value.workspaceId,
      delayedClaimInput,
    );
    expect(delayedClaim).toMatchObject({
      action: "claimed",
      turn: { id: delayedDelegatedTurnId },
    });
    expect(
      await getSessionRealtimeContextProjectionForTurn(
        client.db,
        value.workspaceId,
        value.session.id,
        delayedDelegatedTurnId,
      ),
    ).toBeNull();
    const unconsumedMarkers = await transaction(value.workspaceId, (tx) =>
      tx
        .select({
          id: schema.sessionRealtimeModes.id,
          projectionId: schema.sessionRealtimeModes.contextProjectionId,
        })
        .from(schema.sessionRealtimeModes)
        .where(
          and(
            eq(schema.sessionRealtimeModes.workspaceId, value.workspaceId),
            eq(schema.sessionRealtimeModes.sessionId, value.session.id),
          ),
        ),
    );
    expect(unconsumedMarkers).toHaveLength(2);
    expect(unconsumedMarkers.every((mode) => mode.projectionId === null)).toBe(true);
    if (delayedClaim.action !== "claimed") throw new Error(delayedClaim.reason);
    await applySessionTurnSettlement(client.db, value.workspaceId, {
      sessionId: value.session.id,
      turnId: delayedDelegatedTurnId,
      triggerEventId: delayedClaim.turn.triggerEventId,
      attemptId: delayedClaimInput.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        { type: "turn.completed", payload: { output: "delayed delegated result" } },
        { type: "session.status.changed", payload: { status: "idle" } },
      ],
    });
    const ordinary = await submitPrompt(value, "ordinary text after delegation");
    const ordinaryClaim = await claimSessionWorkForAttempt(
      client.db,
      value.workspaceId,
      claimInput(value.session.id),
    );
    expect(ordinaryClaim).toMatchObject({ action: "claimed", turn: { id: ordinary.turnId } });
    const projection = await getSessionRealtimeContextProjectionForTurn(
      client.db,
      value.workspaceId,
      value.session.id,
      ordinary.turnId,
    );
    expect(projection?.sourceModeCount).toBe(2);
    expect(contextEvents(projection?.context ?? null).map((entry) => entry.kind)).toEqual([
      "user_transcript",
      "delegation_call",
      "session_update",
      "delegation_result",
      "delegation_call",
      "delegation_result",
    ]);
    const deliveredUpdates = await listSessionSystemUpdatesForTurn(
      client.db,
      value.workspaceId,
      value.session.id,
      ordinary.turnId,
    );
    expect(deliveredUpdates.map((delivered) => delivered.id)).toEqual([update.update.id]);
  });

  test("isolates source consumption across two sessions and two workspaces", async () => {
    const primary = await fixture("isolation-primary");
    const peer = await peerSession(primary, "peer session");
    const foreign = await fixture("isolation-foreign");
    const base = Date.now();
    const primaryMode = await completedMode(primary, {
      sessionId: primary.session.id,
      baseMs: base,
      firstEntries: [ledgerEntry("user_transcript", "primary-only")],
    });
    const peerMode = await completedMode(primary, {
      sessionId: peer.id,
      baseMs: base + 1_000,
      firstEntries: [ledgerEntry("user_transcript", "peer-only")],
    });
    const foreignMode = await completedMode(foreign, {
      baseMs: base + 2_000,
      firstEntries: [ledgerEntry("user_transcript", "foreign-only")],
    });
    const primaryPrompt = await submitPrompt(primary, "primary text");
    const peerPrompt = await submitPrompt(primary, "peer text", peer.id);
    const foreignPrompt = await submitPrompt(foreign, "foreign text");

    await claimSessionWorkForAttempt(
      client.db,
      primary.workspaceId,
      claimInput(primary.session.id),
    );
    const primaryProjection = await getSessionRealtimeContextProjectionForTurn(
      client.db,
      primary.workspaceId,
      primary.session.id,
      primaryPrompt.turnId,
    );
    expect(contextEvents(primaryProjection?.context ?? null).map((entry) => entry.text)).toEqual([
      "primary-only",
    ]);
    expect(
      await getSessionRealtimeContextProjectionForTurn(
        client.db,
        primary.workspaceId,
        peer.id,
        primaryPrompt.turnId,
      ),
    ).toBeNull();
    expect(
      await getSessionRealtimeContextProjectionForTurn(
        client.db,
        foreign.workspaceId,
        primary.session.id,
        primaryPrompt.turnId,
      ),
    ).toBeNull();

    const markersAfterPrimary = await transaction(primary.workspaceId, (tx) =>
      tx
        .select({
          id: schema.sessionRealtimeModes.id,
          projectionId: schema.sessionRealtimeModes.contextProjectionId,
        })
        .from(schema.sessionRealtimeModes)
        .where(
          and(
            eq(schema.sessionRealtimeModes.workspaceId, primary.workspaceId),
            eq(schema.sessionRealtimeModes.state, "ended"),
          ),
        )
        .orderBy(asc(schema.sessionRealtimeModes.endedAt)),
    );
    expect(
      markersAfterPrimary.find((mode) => mode.id === primaryMode.started.mode.id)?.projectionId,
    ).toBe(primaryProjection?.id);
    expect(
      markersAfterPrimary.find((mode) => mode.id === peerMode.started.mode.id)?.projectionId,
    ).toBeNull();
    const [foreignMarkerBefore] = await transaction(foreign.workspaceId, (tx) =>
      tx
        .select({ projectionId: schema.sessionRealtimeModes.contextProjectionId })
        .from(schema.sessionRealtimeModes)
        .where(eq(schema.sessionRealtimeModes.id, foreignMode.started.mode.id)),
    );
    expect(foreignMarkerBefore?.projectionId).toBeNull();

    await claimSessionWorkForAttempt(client.db, primary.workspaceId, claimInput(peer.id));
    await claimSessionWorkForAttempt(
      client.db,
      foreign.workspaceId,
      claimInput(foreign.session.id),
    );
    expect(
      contextEvents(
        (
          await getSessionRealtimeContextProjectionForTurn(
            client.db,
            primary.workspaceId,
            peer.id,
            peerPrompt.turnId,
          )
        )?.context ?? null,
      ).map((entry) => entry.text),
    ).toEqual(["peer-only"]);
    expect(
      contextEvents(
        (
          await getSessionRealtimeContextProjectionForTurn(
            client.db,
            foreign.workspaceId,
            foreign.session.id,
            foreignPrompt.turnId,
          )
        )?.context ?? null,
      ).map((entry) => entry.text),
    ).toEqual(["foreign-only"]);
  });
});
