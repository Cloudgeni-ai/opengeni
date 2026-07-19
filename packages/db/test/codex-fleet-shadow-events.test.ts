import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createCodexFleetReplayRecordV1,
  replayCodexFleetDecisionV1,
  type CodexFleetDecisionInputV1,
  type CodexFleetReplayRecordV1,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { eq } from "drizzle-orm";
import {
  appendSessionEventsForTurnAttempt,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  listSessionEvents,
  requestSessionTurnRecovery,
  submitHumanPromptInTransaction,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
  type Database,
  type DbClient,
} from "../src/index";
import * as schema from "../src/schema";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const OBSERVED_AT = Date.parse("2026-07-18T12:00:00.000Z");

let available = true;
let shared: SharedTestDatabase | null = null;
let replicaA: DbClient;
let replicaB: DbClient;

type WorkspaceGrant = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
};

function fleetReplay(observedAtMs: number): CodexFleetReplayRecordV1 {
  const input: CodexFleetDecisionInputV1 = {
    observedAtMs,
    request: {
      placement: "new",
      priority: "standard",
      currentCandidateKey: "c00",
      waitAgeMs: 0,
      overlayKey: null,
      overlayMode: "none",
    },
    admission: {
      dynamicCapacityUnits: null,
      inUseUnits: 1,
      queuedManagerCount: 0,
      emergencyFuseActive: false,
    },
    candidates: [
      {
        key: "c00",
        status: "active",
        allocatorEnabled: true,
        cooldownRemainingMs: null,
        activeLeaseCount: 1,
        quota: {
          primary: { usedPercent: 20, resetRemainingMs: 60 * 60_000 },
          secondary: {
            usedPercent: 30,
            resetRemainingMs: 7 * 24 * 60 * 60_000,
          },
          checkedAgeMs: 60_000,
          confidence: "high",
        },
        cache: {
          state: "unknown",
          hitRatio: null,
          sampledTokens: null,
          checkedAgeMs: null,
          thresholdObservedForMs: null,
          confidence: "unknown",
        },
        observedBurn: {
          percentPerHour: null,
          confidence: "unknown",
        },
        inferredUnexplainedBurn: {
          percentPerHour: null,
          confidence: "unknown",
        },
        overlayKeys: [],
      },
      {
        key: "c01",
        status: "active",
        allocatorEnabled: true,
        cooldownRemainingMs: null,
        activeLeaseCount: 0,
        quota: {
          primary: { usedPercent: null, resetRemainingMs: null },
          secondary: { usedPercent: null, resetRemainingMs: null },
          checkedAgeMs: null,
          confidence: "unknown",
        },
        cache: {
          state: "unknown",
          hitRatio: null,
          sampledTokens: null,
          checkedAgeMs: null,
          thresholdObservedForMs: null,
          confidence: "unknown",
        },
        observedBurn: {
          percentPerHour: null,
          confidence: "unknown",
        },
        inferredUnexplainedBurn: {
          percentPerHour: null,
          confidence: "unknown",
        },
        overlayKeys: [],
      },
    ],
  };
  return createCodexFleetReplayRecordV1(input);
}

function fleetEventPayload(observedAtMs: number) {
  const replay = fleetReplay(observedAtMs);
  return {
    schemaVersion: 1,
    mode: "shadow",
    policyVersion: "adaptive-shadow-v1",
    actual: { outcome: "selected", candidateKey: "c00", reason: "active" },
    comparison: "match",
    replay,
  } as const;
}

async function createWorkspace(db: Database, label: string): Promise<WorkspaceGrant> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "test",
    accountExternalId: `${label}-account-${suffix}`,
    accountName: `${label} account`,
    workspaceExternalSource: "test",
    workspaceExternalId: `${label}-workspace-${suffix}`,
    workspaceName: `${label} workspace`,
    subjectId: `${label}-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0];
  if (!grant?.workspaceId) throw new Error(`${label} workspace grant missing`);
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
  };
}

async function createRunningTurn(db: Database, grant: WorkspaceGrant) {
  const session = await createSession(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  await withWorkspaceSubjectRls(db, grant.workspaceId, grant.subjectId, (scoped) =>
    scoped.transaction((tx) =>
      submitHumanPromptInTransaction(tx as typeof scoped, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "record a fleet shadow decision",
        resources: [],
        tools: [],
        reasoningEffortFallback: "low",
        source: "user",
      }),
    ),
  );
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(db, grant.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("fleet test turn was not claimed");
  return { session, turn: claimed.turn, attemptId };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("codex-fleet-shadow-events");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[codex-fleet-shadow-events] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    available = false;
    console.warn("[codex-fleet-shadow-events] PostgreSQL unavailable, skipping");
    return;
  }
  replicaA = createDb(shared.appUrl, { max: 1 });
  replicaB = createDb(shared.appUrl, { max: 1 });
}, 180_000);

afterAll(async () => {
  await replicaA?.close().catch(() => undefined);
  await replicaB?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("OPE-32 durable Codex fleet shadow decisions", () => {
  test("multi-replica writes stay ordered, replayable, and fenced across recovery", async () => {
    if (!available) return;
    const grant = await createWorkspace(replicaA.db, "fleet-a");
    const isolatedGrant = await createWorkspace(replicaB.db, "fleet-b");
    const { session, turn, attemptId } = await createRunningTurn(replicaA.db, grant);

    const [left, right] = await Promise.all([
      appendSessionEventsForTurnAttempt(
        replicaA.db,
        grant.workspaceId,
        session.id,
        turn.id,
        turn.executionGeneration,
        attemptId,
        [
          {
            type: "codex.fleet.decision",
            payload: fleetEventPayload(OBSERVED_AT),
          },
        ],
      ),
      appendSessionEventsForTurnAttempt(
        replicaB.db,
        grant.workspaceId,
        session.id,
        turn.id,
        turn.executionGeneration,
        attemptId,
        [
          {
            type: "codex.fleet.decision",
            payload: fleetEventPayload(OBSERVED_AT + 1),
          },
        ],
      ),
    ]);

    expect(left.accepted).toBe(true);
    expect(right.accepted).toBe(true);
    const appended = [...left.events, ...right.events].sort((a, b) => a.sequence - b.sequence);
    expect(appended).toHaveLength(2);
    expect(new Set(appended.map((event) => event.id)).size).toBe(2);
    expect(appended[1]!.sequence).toBe(appended[0]!.sequence + 1);
    for (const event of appended) {
      expect(event).toMatchObject({
        type: "codex.fleet.decision",
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        turnId: turn.id,
        turnGeneration: turn.executionGeneration,
        turnAttemptId: attemptId,
        turnAssociation: "current",
      });
    }

    const durable = (await listSessionEvents(replicaB.db, grant.workspaceId, session.id)).filter(
      (event) => event.type === "codex.fleet.decision",
    );
    expect(durable.map((event) => event.id).sort()).toEqual(
      appended.map((event) => event.id).sort(),
    );
    for (const event of durable) {
      const payload = event.payload as { replay: CodexFleetReplayRecordV1 };
      expect(replayCodexFleetDecisionV1(payload.replay)).toMatchObject({
        matches: true,
      });
    }

    expect(
      await requestSessionTurnRecovery(replicaA.db, grant.workspaceId, {
        sessionId: session.id,
        turnId: turn.id,
        triggerEventId: turn.triggerEventId,
        attemptId,
        reason: "worker_shutdown",
      }),
    ).toMatchObject({ action: "recovering" });
    const nextAttemptId = crypto.randomUUID();
    const nextClaim = await claimSessionWorkForAttempt(replicaB.db, grant.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: nextAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(nextClaim).toMatchObject({
      action: "claimed",
      turn: { id: turn.id, executionGeneration: turn.executionGeneration + 1 },
    });

    const rejected = await appendSessionEventsForTurnAttempt(
      replicaA.db,
      grant.workspaceId,
      session.id,
      turn.id,
      turn.executionGeneration,
      attemptId,
      [
        {
          type: "codex.fleet.decision",
          payload: fleetEventPayload(OBSERVED_AT + 2),
        },
      ],
    );
    expect(rejected).toMatchObject({
      accepted: false,
      events: [
        {
          type: "turn.event.rejected_late",
          turnId: turn.id,
          turnGeneration: turn.executionGeneration,
          turnAttemptId: attemptId,
          turnAssociation: "late_rejected",
          payload: {
            rejectedType: "codex.fleet.decision",
            currentAttemptId: nextAttemptId,
          },
        },
      ],
    });
    const afterRecovery = await listSessionEvents(replicaB.db, grant.workspaceId, session.id);
    expect(
      afterRecovery.filter(
        (event) => event.type === "codex.fleet.decision" && event.turnAssociation === "current",
      ),
    ).toHaveLength(2);

    const crossWorkspaceRows = await withWorkspaceRls(
      replicaB.db,
      isolatedGrant.workspaceId,
      (scoped) =>
        scoped
          .select({ id: schema.sessionEvents.id })
          .from(schema.sessionEvents)
          .where(eq(schema.sessionEvents.workspaceId, grant.workspaceId)),
    );
    expect(crossWorkspaceRows).toEqual([]);
  });

  test("uses a non-bypass app role and FORCE RLS on the durable event table", async () => {
    if (!available || !shared) return;
    const [role] = await shared.admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'opengeni_app'`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const [table] = await shared.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity
      from pg_class
      where oid = 'session_events'::regclass`;
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
