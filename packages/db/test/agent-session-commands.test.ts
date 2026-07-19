import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  AgentCommandAuthorityError,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  listOutstandingSessionSystemUpdates,
  listSessionSystemUpdatesForTurn,
  markSessionAttemptQuiesced,
  mutateSessionControlInTransaction,
  sendAgentMessageInTransaction,
  settleSessionAttemptInterruptions,
  steerAgentSessionInTransaction,
  submitHumanPromptInTransaction,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
  type SessionCommandActor,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("agent-session-commands");
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
    accountName: "Agent commands",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Agent commands",
    subjectId: `subject-${suffix}`,
  });
  return access.workspaceGrants[0]!;
}

async function makeSession(
  grant: Awaited<ReturnType<typeof fixture>>,
  parentSessionId: string | null = null,
) {
  return await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
    ...(parentSessionId ? { parentSessionId } : {}),
  });
}

async function submit(
  grant: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
  text: string,
  delivery: "send" | "steer" = "send",
) {
  return await withWorkspaceSubjectRls(client.db, grant.workspaceId!, grant.subjectId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as typeof db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId,
        subjectId: grant.subjectId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery,
        text,
        resources: [],
        tools: [],
        model: "scripted-model",
        reasoningEffort: "low",
        reasoningEffortFallback: "medium",
        source: "user",
      }),
    ),
  );
}

async function activeAgent(
  grant: Awaited<ReturnType<typeof fixture>>,
  parentSessionId: string | null = null,
) {
  const session = await makeSession(grant, parentSessionId);
  await submit(grant, session.id, "agent is working");
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`Caller was not claimed: ${claim.reason}`);
  const actor: Extract<SessionCommandActor, { type: "agent_attempt" }> = {
    type: "agent_attempt",
    sessionId: session.id,
    turnId: claim.turn.id,
    attemptId,
    executionGeneration: claim.turn.executionGeneration,
  };
  return { session, turn: claim.turn, attemptId, actor };
}

describe("attempt-fenced Agent session commands", () => {
  test("Agent Pause rejects self and every ancestor workstream with zero writes", async () => {
    const grant = await fixture();
    const parent = await makeSession(grant);
    const caller = await activeAgent(grant, parent.id);

    for (const targetSessionId of [caller.session.id, parent.id]) {
      await expect(
        withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
          db.transaction((tx) =>
            mutateSessionControlInTransaction(tx as typeof db, {
              accountId: grant.accountId,
              workspaceId: grant.workspaceId!,
              sessionId: targetSessionId,
              actor: caller.actor,
              operationKey: crypto.randomUUID(),
              action: "pause",
            }),
          ),
        ),
      ).rejects.toMatchObject({
        code: "SELF_OR_ANCESTOR_PAUSE",
      } satisfies Partial<AgentCommandAuthorityError>);
    }
    const rows = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db
        .select({ id: schema.sessionCommandReceipts.id })
        .from(schema.sessionCommandReceipts)
        .where(eq(schema.sessionCommandReceipts.actorAttemptId, caller.attemptId)),
    );
    expect(rows).toHaveLength(0);
  });

  test("Agent message stays pending under Pause and never becomes human queue work", async () => {
    const grant = await fixture();
    const caller = await activeAgent(grant);
    const target = await makeSession(grant);
    await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        mutateSessionControlInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: target.id,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: crypto.randomUUID(),
          action: "pause",
        }),
      ),
    );
    const delivered = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        sendAgentMessageInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          targetSessionId: target.id,
          actor: caller.actor,
          operationKey: crypto.randomUUID(),
          text: "important child information",
        }),
      ),
    );
    expect(delivered).toMatchObject({ effectiveState: "paused", wakeRevision: null });
    expect(
      await listOutstandingSessionSystemUpdates(client.db, grant.workspaceId!, target.id),
    ).toMatchObject([{ kind: "agent_message", state: "pending" }]);
    const queued = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db
        .select({ id: schema.sessionTurns.id })
        .from(schema.sessionTurns)
        .where(
          and(
            eq(schema.sessionTurns.sessionId, target.id),
            eq(schema.sessionTurns.status, "queued"),
          ),
        ),
    );
    expect(queued).toHaveLength(0);
  });

  test("an interrupted caller cannot publish or counter-control another session", async () => {
    const grant = await fixture();
    const caller = await activeAgent(grant);
    const target = await makeSession(grant);
    await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        mutateSessionControlInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: caller.session.id,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: crypto.randomUUID(),
          action: "pause",
        }),
      ),
    );
    await expect(
      withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
        db.transaction((tx) =>
          mutateSessionControlInTransaction(tx as typeof db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId!,
            sessionId: target.id,
            actor: caller.actor,
            operationKey: crypto.randomUUID(),
            action: "resume",
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "CALLER_INTERRUPTED" });

    await expect(
      withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
        db.transaction((tx) =>
          sendAgentMessageInTransaction(tx as typeof db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId!,
            targetSessionId: target.id,
            actor: caller.actor,
            operationKey: crypto.randomUUID(),
            text: "late zombie result",
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "CALLER_INTERRUPTED" });

    const lateUpdates = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db
        .select({ id: schema.sessionSystemUpdates.id })
        .from(schema.sessionSystemUpdates)
        .where(eq(schema.sessionSystemUpdates.sessionId, target.id)),
    );
    expect(lateUpdates).toHaveLength(0);
  });

  test("a committed Agent command replays after caller interruption while a new command is rejected", async () => {
    const grant = await fixture();
    const caller = await activeAgent(grant);
    const target = await makeSession(grant);
    const operationKey = crypto.randomUUID();
    const invoke = (key: string, text: string) =>
      withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
        db.transaction((tx) =>
          sendAgentMessageInTransaction(tx as typeof db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId!,
            targetSessionId: target.id,
            actor: caller.actor,
            operationKey: key,
            text,
          }),
        ),
      );

    const original = await invoke(operationKey, "durable result");
    await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        mutateSessionControlInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: caller.session.id,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: crypto.randomUUID(),
          action: "pause",
        }),
      ),
    );

    const replay = await invoke(operationKey, "durable result");
    expect(replay).toMatchObject({ replay: true, updateId: original.updateId });
    await expect(invoke(crypto.randomUUID(), "zombie result")).rejects.toMatchObject({
      code: "CALLER_INTERRUPTED",
    });
    expect(
      await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
        db
          .select({ id: schema.sessionSystemUpdates.id })
          .from(schema.sessionSystemUpdates)
          .where(eq(schema.sessionSystemUpdates.sessionId, target.id)),
      ),
    ).toHaveLength(1);
  });

  test("Agent Steer waits for the old owner to quiesce then runs before an unchanged human queue", async () => {
    const grant = await fixture();
    const caller = await activeAgent(grant);
    const target = await makeSession(grant);
    const first = await submit(grant, target.id, "currently running");
    const queued = await submit(grant, target.id, "human prompt must stay first in its queue");
    const targetAttemptId = crypto.randomUUID();
    const targetClaim = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId: target.id,
      workflowId: `session-${target.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: targetAttemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (targetClaim.action !== "claimed") throw new Error("Target was not claimed");
    expect(targetClaim.turn.id).toBe(first.turnId);
    const beforeOrder = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db
        .select({ id: schema.sessionTurns.id })
        .from(schema.sessionTurns)
        .where(
          and(
            eq(schema.sessionTurns.sessionId, target.id),
            eq(schema.sessionTurns.status, "queued"),
          ),
        )
        .orderBy(asc(schema.sessionTurns.position)),
    );
    expect(beforeOrder.map((row) => row.id)).toEqual([queued.turnId]);

    const steered = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        steerAgentSessionInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          targetSessionId: target.id,
          actor: caller.actor,
          operationKey: crypto.randomUUID(),
          instruction: "inspect the new evidence before continuing",
        }),
      ),
    );
    expect(steered.interruptionCount).toBe(1);
    const afterOrder = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db
        .select({ id: schema.sessionTurns.id })
        .from(schema.sessionTurns)
        .where(
          and(
            eq(schema.sessionTurns.sessionId, target.id),
            eq(schema.sessionTurns.status, "queued"),
          ),
        )
        .orderBy(asc(schema.sessionTurns.position)),
    );
    expect(afterOrder).toEqual(beforeOrder);

    await settleSessionAttemptInterruptions(
      client.db,
      grant.workspaceId!,
      target.id,
      targetAttemptId,
    );
    const internalAttemptId = crypto.randomUUID();
    const internalClaimInput = {
      sessionId: target.id,
      workflowId: `session-${target.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: internalAttemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" as const },
    };
    const blockedClaim = await claimSessionWorkForAttempt(
      client.db,
      grant.workspaceId!,
      internalClaimInput,
    );
    expect(blockedClaim).toEqual({ action: "unclaimed", reason: "control-pending" });

    await markSessionAttemptQuiesced(client.db, {
      workspaceId: grant.workspaceId!,
      sessionId: target.id,
      attemptId: targetAttemptId,
      temporalWorkflowId: `session-${target.id}`,
    });
    const internalClaim = await claimSessionWorkForAttempt(
      client.db,
      grant.workspaceId!,
      internalClaimInput,
    );
    if (internalClaim.action !== "claimed") throw new Error("Agent Steer was not claimed");
    expect(internalClaim.turn.source).toBe("system");
    expect(
      await listSessionSystemUpdatesForTurn(
        client.db,
        grant.workspaceId!,
        target.id,
        internalClaim.turn.id,
      ),
    ).toMatchObject([{ id: steered.updateId, kind: "agent_steer_instruction" }]);
    await applySessionTurnSettlement(client.db, grant.workspaceId!, {
      sessionId: target.id,
      turnId: internalClaim.turn.id,
      triggerEventId: internalClaim.turn.triggerEventId,
      attemptId: internalAttemptId,
      turnStatus: "completed",
      sessionStatus: "queued",
      activeTurnId: null,
      events: [],
    });
    const humanAttemptId = crypto.randomUUID();
    const humanClaim = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId: target.id,
      workflowId: `session-${target.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: humanAttemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (humanClaim.action !== "claimed") throw new Error("Human queue did not resume");
    expect(humanClaim.turn.id).toBe(queued.turnId);
  });
});
