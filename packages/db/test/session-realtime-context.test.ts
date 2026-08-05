import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { and, asc, eq } from "drizzle-orm";

import {
  activateSessionRealtimeConnectionInTransaction,
  beginSessionRealtimeInTransaction,
  bootstrapWorkspace,
  claimSessionRealtimeConnectionInTransaction,
  completeSessionRealtimeConnectionInTransaction,
  createDb,
  createSession,
  endSessionRealtimeInTransaction,
  getSessionRealtimeContinuityEntries,
  renderSessionRealtimeTail,
  SESSION_REALTIME_CONTEXT_MAX_BYTES,
  SESSION_REALTIME_TAIL_INSTRUCTION,
  SESSION_REALTIME_TAIL_SOURCE,
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
  client = createDb(shared.appUrl, { max: 12 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function transaction<T>(workspaceId: string, fn: (db: Database) => Promise<T>): Promise<T> {
  return await withWorkspaceRls(client.db, workspaceId, (db) =>
    db.transaction((tx) => fn(tx as unknown as Database)),
  );
}

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `realtime-context-account-${suffix}`,
    accountName: "Realtime context",
    workspaceExternalSource: "test",
    workspaceExternalId: `realtime-context-workspace-${suffix}`,
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

type Fixture = Awaited<ReturnType<typeof fixture>>;

function transcript(
  role: "user" | "assistant",
  text: string,
  payload: Record<string, unknown> = {},
): SessionRealtimeInboundEntryInput {
  return {
    operationId: crypto.randomUUID(),
    kind: role === "user" ? "user_transcript" : "assistant_transcript",
    role,
    text,
    payload: { turnId: crypto.randomUUID(), ...payload },
  };
}

async function runMode(
  value: Fixture,
  entries: SessionRealtimeInboundEntryInput[],
  options: { providerStarted?: boolean; baseMs?: number } = {},
) {
  const baseMs = options.baseMs ?? Date.now();
  const owner = {
    accountId: value.accountId,
    workspaceId: value.workspaceId,
    sessionId: value.session.id,
    operationId: crypto.randomUUID(),
    ownerSubjectId: value.subjectId,
    browserInstanceId: `browser-${crypto.randomUUID()}`,
    ownerKey: `owner-${crypto.randomUUID()}-${crypto.randomUUID()}`,
    model: "gpt-live-1-boulder-alpha" as const,
  };
  const started = await transaction(value.workspaceId, (tx) =>
    beginSessionRealtimeInTransaction(tx, { ...owner, now: new Date(baseMs), leaseMs: 120_000 }),
  );
  const claimed = await transaction(value.workspaceId, (tx) =>
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
      now: new Date(baseMs + 1),
    }),
  );
  await transaction(value.workspaceId, (tx) =>
    completeSessionRealtimeConnectionInTransaction(tx, {
      workspaceId: value.workspaceId,
      sessionId: value.session.id,
      realtimeId: started.mode.id,
      connectionId: claimed.connection.id,
      operationId: claimed.connection.operationId,
      connectionEpoch: 1,
      sdpAnswer: "v=0\r\na=answer\r\n",
      now: new Date(baseMs + 2),
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
      connectionId: claimed.connection.id,
      operationId: claimed.connection.operationId,
      connectionEpoch: 1,
      now: new Date(baseMs + 3),
    }),
  );
  if (entries.length > 0 || options.providerStarted) {
    await transaction(value.workspaceId, (tx) =>
      syncSessionRealtimeLedgerInTransaction(tx, {
        workspaceId: value.workspaceId,
        sessionId: value.session.id,
        realtimeId: started.mode.id,
        ownerSubjectId: owner.ownerSubjectId,
        browserInstanceId: owner.browserInstanceId,
        ownerKey: owner.ownerKey,
        expectedVersion: started.mode.version,
        connectionId: claimed.connection.id,
        connectionEpoch: 1,
        entries,
        ...(options.providerStarted
          ? { providerStarted: { providerSessionId: `provider-${started.mode.id}` } }
          : {}),
        now: new Date(baseMs + 4),
      }),
    );
  }
  const ended = await transaction(value.workspaceId, (tx) =>
    endSessionRealtimeInTransaction(tx, {
      workspaceId: value.workspaceId,
      sessionId: value.session.id,
      realtimeId: started.mode.id,
      ownerSubjectId: owner.ownerSubjectId,
      browserInstanceId: owner.browserInstanceId,
      ownerKey: owner.ownerKey,
      expectedVersion: started.mode.version,
      reason: "user_stop",
      now: new Date(baseMs + 10),
    }),
  );
  return { owner, started, claimed, ended };
}

function sourceEntry(role: "user" | "assistant", text: string): SessionRealtimeContextSourceEntry {
  return {
    id: crypto.randomUUID(),
    realtimeId: crypto.randomUUID(),
    sequence: 1,
    role,
    text,
    payload: { turnId: crypto.randomUUID() },
  };
}

describe("session realtime transcript tail and continuity", () => {
  test("renders escaped, bounded Codex-style tail context", () => {
    const escaped = renderSessionRealtimeTail([
      sourceEntry("user", "change <this> & that"),
      sourceEntry("assistant", "understood"),
    ]);
    expect(escaped.context).toContain("&lt;this&gt; &amp; that");
    expect(escaped.context).not.toContain("change <this>");

    const rendered = renderSessionRealtimeTail([
      sourceEntry("user", "change <this> & that"),
      sourceEntry("assistant", "understood"),
      sourceEntry("user", "x".repeat(SESSION_REALTIME_CONTEXT_MAX_BYTES * 2)),
    ]);
    expect(rendered.context).toContain(`<source>${SESSION_REALTIME_TAIL_SOURCE}</source>`);
    expect(rendered.context).toContain(SESSION_REALTIME_TAIL_INSTRUCTION);
    expect(rendered.context).toContain("continue it from the current state");
    expect(rendered.context).not.toContain("You probably do not have to do anything");
    expect(rendered.context).toContain("[2 older transcript turns omitted]");
    expect(Buffer.byteLength(rendered.context!, "utf8")).toBeLessThanOrEqual(
      SESSION_REALTIME_CONTEXT_MAX_BYTES,
    );
    expect(rendered.includedEntryCount + rendered.omittedEntryCount).toBe(3);
  });

  test("ending an empty realtime mode creates no backend turn", async () => {
    const value = await fixture();
    const mode = await runMode(value, []);
    const facts = await transaction(value.workspaceId, async (tx) => {
      const [row] = await tx
        .select({ projectionId: schema.sessionRealtimeModes.contextProjectionId })
        .from(schema.sessionRealtimeModes)
        .where(eq(schema.sessionRealtimeModes.id, mode.started.mode.id));
      const turns = await tx
        .select({ id: schema.sessionTurns.id })
        .from(schema.sessionTurns)
        .where(eq(schema.sessionTurns.sessionId, value.session.id));
      return { row, turns };
    });
    expect(facts.row?.projectionId).toBeNull();
    expect(facts.turns).toHaveLength(0);
  });

  test("ending with transcript tail immediately creates one canonical Steer turn", async () => {
    const value = await fixture();
    const mode = await runMode(value, [
      transcript("user", "Please remember the final constraint"),
      transcript("assistant", "I will."),
    ]);
    const replay = await transaction(value.workspaceId, (tx) =>
      endSessionRealtimeInTransaction(tx, {
        workspaceId: value.workspaceId,
        sessionId: value.session.id,
        realtimeId: mode.started.mode.id,
        ownerSubjectId: mode.owner.ownerSubjectId,
        browserInstanceId: mode.owner.browserInstanceId,
        ownerKey: mode.owner.ownerKey,
        expectedVersion: mode.started.mode.version,
        reason: "user_stop",
      }),
    );
    expect(replay.replay).toBe(true);
    const facts = await transaction(value.workspaceId, async (tx) => {
      const [row] = await tx
        .select({ projectionId: schema.sessionRealtimeModes.contextProjectionId })
        .from(schema.sessionRealtimeModes)
        .where(eq(schema.sessionRealtimeModes.id, mode.started.mode.id));
      const projections = await tx
        .select()
        .from(schema.sessionRealtimeContextProjections)
        .where(eq(schema.sessionRealtimeContextProjections.sessionId, value.session.id));
      const turns = await tx
        .select()
        .from(schema.sessionTurns)
        .where(eq(schema.sessionTurns.sessionId, value.session.id))
        .orderBy(asc(schema.sessionTurns.createdAt));
      const [userEvent] = turns[0]
        ? await tx
            .select({ payload: schema.sessionEvents.payload })
            .from(schema.sessionEvents)
            .where(eq(schema.sessionEvents.id, turns[0].triggerEventId))
        : [];
      return { row, projections, turns, userEvent };
    });
    expect(facts.row?.projectionId).toBe(facts.projections[0]?.id);
    expect(facts.projections).toHaveLength(1);
    expect(facts.projections[0]?.context).toContain("Please remember the final constraint");
    expect(facts.turns).toHaveLength(1);
    expect(facts.turns[0]).toMatchObject({
      id: facts.projections[0]?.turnId,
      status: "queued",
      metadata: {
        delivery: "steer",
        realtimeTailFlush: { source: SESSION_REALTIME_TAIL_SOURCE },
      },
    });
    expect(facts.userEvent?.payload).toMatchObject({
      text: "Voice session ended. Remaining conversation context was sent to the agent.",
      presentation: {
        kind: "realtime_voice_handoff",
        context: facts.projections[0]?.context,
      },
    });
  });

  test("flushes only finalized transcript after the latest delegation fence", async () => {
    const value = await fixture();
    const delegationItemId = `delegation-${crypto.randomUUID()}`;
    const mode = await runMode(
      value,
      [
        transcript("user", "before delegation"),
        {
          operationId: crypto.randomUUID(),
          kind: "delegation_call",
          providerEventId: `provider-${crypto.randomUUID()}`,
          delegationItemId,
          text: "<realtime_delegation><input>do it</input></realtime_delegation>",
          payload: { inputTranscript: "do it", transcriptFenceTurnIds: [] },
        },
        transcript("user", "do it", { coveredByDelegationItemId: delegationItemId }),
        transcript("assistant", "I have started it."),
        transcript("user", "Use the safer option."),
      ],
      { providerStarted: true },
    );
    const [projection] = await transaction(value.workspaceId, (tx) =>
      tx
        .select()
        .from(schema.sessionRealtimeContextProjections)
        .where(eq(schema.sessionRealtimeContextProjections.sessionId, value.session.id)),
    );
    expect(projection?.context).not.toContain("before delegation");
    expect(projection?.context).not.toContain(">do it<");
    expect(projection?.context).toContain("I have started it.");
    expect(projection?.context).toContain("Use the safer option.");
    expect(projection?.sourceEntryCount).toBe(2);
    expect(mode.ended.mode.state).toBe("ended");
  });

  test("returns bounded finalized continuity across ended and current modes without dedup", async () => {
    const value = await fixture();
    await runMode(value, [
      transcript("user", "first voice"),
      transcript("assistant", "first reply"),
    ]);
    await runMode(
      value,
      [transcript("user", "second voice"), transcript("assistant", "second reply")],
      { baseMs: Date.now() + 1_000 },
    );
    const continuity = await getSessionRealtimeContinuityEntries(
      client.db,
      value.workspaceId,
      value.session.id,
      3,
    );
    expect(continuity.map((entry) => [entry.role, entry.text])).toEqual([
      ["assistant", "first reply"],
      ["user", "second voice"],
      ["assistant", "second reply"],
    ]);
    expect(new Set(continuity.map((entry) => entry.turnId)).size).toBe(3);
  });

  test("keeps tail state isolated by workspace and session", async () => {
    const first = await fixture();
    const second = await fixture();
    await runMode(first, [transcript("user", "first only")]);
    await runMode(second, [transcript("user", "second only")]);
    const [firstProjection] = await transaction(first.workspaceId, (tx) =>
      tx
        .select()
        .from(schema.sessionRealtimeContextProjections)
        .where(
          and(
            eq(schema.sessionRealtimeContextProjections.workspaceId, first.workspaceId),
            eq(schema.sessionRealtimeContextProjections.sessionId, first.session.id),
          ),
        ),
    );
    expect(firstProjection?.context).toContain("first only");
    expect(firstProjection?.context).not.toContain("second only");
  });
});
