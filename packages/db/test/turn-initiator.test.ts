import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  addSessionSystemUpdate,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createSessionGoal,
  createSessionWithIdempotencyKey,
  editQueuedTurnInTransaction,
  frozenInitiatorForCommandActor,
  getSessionTurn,
  initializeSessionStartAtomically,
  saveComposerDraftInTransaction,
  submitHumanPromptInTransaction,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("turn-initiator");
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
    accountExternalSource: "turn-initiator-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Turn initiator test",
    workspaceExternalSource: "turn-initiator-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Turn initiator test",
    subjectId: `user:creator-${suffix}`,
    subjectLabel: "Creator",
  });
  return access.workspaceGrants[0]!;
}

function sessionInput(grant: Awaited<ReturnType<typeof fixture>>) {
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    createdBy: {
      kind: "subject" as const,
      subjectId: grant.subjectId,
      ...(grant.subjectLabel ? { label: grant.subjectLabel } : {}),
    },
    model: "scripted-model",
    sandboxBackend: "none" as const,
  };
}

describe("immutable session turn initiators", () => {
  test("initial-turn repair uses the frozen session creator, not the retrying caller", async () => {
    const grant = await fixture();
    const idempotencyKey = crypto.randomUUID();
    const first = await createSessionWithIdempotencyKey(client.db, {
      ...sessionInput(grant),
      createIdempotencyKey: idempotencyKey,
    });
    expect(first.created).toBe(true);

    const retry = await createSessionWithIdempotencyKey(client.db, {
      ...sessionInput(grant),
      createdBy: { kind: "subject", subjectId: "user:different-retry" },
      createIdempotencyKey: idempotencyKey,
    });
    expect(retry.created).toBe(false);
    expect(retry.session.createdBy).toEqual({
      kind: "subject",
      subjectId: grant.subjectId,
      label: "Creator",
    });

    const started = await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: retry.session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    expect(started.turn?.initiator).toEqual(retry.session.createdBy);
    const userMessageEvent = started.events.find((event) => event.type === "user.message");
    const queuedEvent = started.events.find((event) => event.type === "turn.queued");
    if (!userMessageEvent) throw new Error("missing initial user.message event");
    if (!queuedEvent) throw new Error("missing initial turn.queued event");
    expect((userMessageEvent.payload as Record<string, unknown>).initiator).toEqual(
      retry.session.createdBy,
    );
    expect((queuedEvent.payload as Record<string, unknown>).initiator).toEqual(
      retry.session.createdBy,
    );
  });

  test("Send and Steer capture their actor while queue Edit preserves the original actor", async () => {
    const grant = await fixture();
    const session = await createSession(client.db, sessionInput(grant));
    const sender = "user:sender";
    const editor = "user:editor";

    const sent = await withWorkspaceSubjectRls(client.db, grant.workspaceId!, sender, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          subjectId: sender,
          subjectLabel: "Sender",
          actor: { type: "human", subjectId: sender },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "queued work",
          resources: [],
          tools: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
    );
    const original = await getSessionTurn(client.db, grant.workspaceId!, sent.turnId);
    expect(original?.initiator).toEqual({
      kind: "subject",
      subjectId: sender,
      label: "Sender",
    });

    const edited = await withWorkspaceSubjectRls(client.db, grant.workspaceId!, editor, (db) =>
      db.transaction((tx) =>
        editQueuedTurnInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          turnId: sent.turnId,
          subjectId: editor,
          expectedTurnVersion: 1,
          expectedDraftRevision: 0,
          replaceDraft: false,
          actor: { type: "human", subjectId: editor },
          operationKey: crypto.randomUUID(),
        }),
      ),
    );
    const savedEdit = await withWorkspaceSubjectRls(client.db, grant.workspaceId!, editor, (db) =>
      db.transaction((tx) =>
        saveComposerDraftInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          subjectId: editor,
          expectedRevision: edited.draft.revision,
          text: "edited queued work",
          resources: [],
          tools: [],
          model: "scripted-model",
          reasoningEffort: "low",
        }),
      ),
    );
    const resubmitted = await withWorkspaceSubjectRls(client.db, grant.workspaceId!, editor, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          subjectId: editor,
          subjectLabel: "Editor",
          actor: { type: "human", subjectId: editor },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          expectedDraftRevision: savedEdit.revision,
          text: savedEdit.text,
          resources: [],
          tools: [],
          model: "scripted-model",
          reasoningEffort: "low",
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
    );
    expect(
      (await getSessionTurn(client.db, grant.workspaceId!, resubmitted.turnId))?.initiator,
    ).toEqual(original?.initiator);

    const steerSource = await withWorkspaceSubjectRls(client.db, grant.workspaceId!, sender, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          subjectId: sender,
          subjectLabel: "Sender",
          actor: { type: "human", subjectId: sender },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "draft to steer",
          resources: [],
          tools: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
    );
    const steerDraft = await withWorkspaceSubjectRls(client.db, grant.workspaceId!, editor, (db) =>
      db.transaction((tx) =>
        editQueuedTurnInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          turnId: steerSource.turnId,
          subjectId: editor,
          expectedTurnVersion: 1,
          expectedDraftRevision: 0,
          replaceDraft: false,
          actor: { type: "human", subjectId: editor },
          operationKey: crypto.randomUUID(),
        }),
      ),
    );
    const steered = await withWorkspaceSubjectRls(client.db, grant.workspaceId!, editor, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          subjectId: editor,
          subjectLabel: "Editor",
          actor: { type: "human", subjectId: editor },
          operationKey: crypto.randomUUID(),
          delivery: "steer",
          expectedDraftRevision: steerDraft.draft.revision,
          text: steerDraft.draft.text,
          resources: [],
          tools: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
    );
    expect(
      (await getSessionTurn(client.db, grant.workspaceId!, steered.turnId))?.initiator,
    ).toEqual({ kind: "subject", subjectId: editor, label: "Editor" });
  });

  test("the database rejects mutation of a persisted initiator", async () => {
    const grant = await fixture();
    const session = await createSession(client.db, sessionInput(grant));
    const started = await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    if (!started.turn) throw new Error("missing initialized turn");
    const startedTurnId = started.turn.id;
    let mutationError: unknown;
    try {
      await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
        db
          .update(schema.sessionTurns)
          .set({ initiatorSubjectId: "user:rewritten" })
          .where(eq(schema.sessionTurns.id, startedTurnId)),
      );
    } catch (error) {
      mutationError = error;
    }
    expect(mutationError).toBeInstanceOf(Error);
    expect((mutationError as Error & { cause?: { message?: string } }).cause?.message).toContain(
      "session turn initiator is immutable",
    );
  });

  test("agent work inherits across coalesced notices while service batches stay explicit", async () => {
    const grant = await fixture();
    const source = await createSession(client.db, sessionInput(grant));
    const sourceStart = await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: source.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    if (!sourceStart.turn) throw new Error("missing source turn");
    const sourceTurn = sourceStart.turn;
    const callerAttemptId = crypto.randomUUID();
    const inherited = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      frozenInitiatorForCommandActor(db as typeof client.db, grant.workspaceId!, {
        type: "agent_attempt",
        sessionId: source.id,
        turnId: sourceTurn.id,
        attemptId: callerAttemptId,
        executionGeneration: 1,
      }),
    );
    expect(inherited.initiator).toEqual(sourceTurn.initiator);
    expect(inherited.context.via).toEqual([
      {
        kind: "agent",
        sessionId: source.id,
        turnId: sourceTurn.id,
        attemptId: callerAttemptId,
        executionGeneration: 1,
      },
    ]);

    const steeredTarget = await createSession(client.db, sessionInput(grant));
    await addSessionSystemUpdate(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: steeredTarget.id,
      kind: "agent_steer_instruction",
      classification: "action_required",
      sourceId: source.id,
      dedupeKey: crypto.randomUUID(),
      summary: "Change direction",
      payload: {
        type: "agent_steer_instruction",
        instruction: "Change direction",
        operationId: crypto.randomUUID(),
      },
      lineage: {
        callerSessionId: source.id,
        callerTurnId: sourceTurn.id,
        callerAttemptId,
        callerExecutionGeneration: 1,
      },
    });
    const coalescedGoal = await createSessionGoal(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: steeredTarget.id,
      text: "Goal that must not override Steer",
      createdBy: "api",
    });
    await addSessionSystemUpdate(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: steeredTarget.id,
      kind: "goal_continuation",
      classification: "info",
      sourceId: coalescedGoal.id,
      dedupeKey: crypto.randomUUID(),
      summary: "Coalesced goal continuation",
      payload: {
        type: "goal_continuation",
        goalId: coalescedGoal.id,
        goalVersion: coalescedGoal.version,
        autoContinuation: 1,
        prompt: "Continue goal",
        policy: { model: "must-not-win-over-steer" },
      },
    });
    await addSessionSystemUpdate(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: steeredTarget.id,
      kind: "child_terminal_result",
      classification: "info",
      sourceId: crypto.randomUUID(),
      dedupeKey: crypto.randomUUID(),
      summary: "Coalesced machine notice",
      payload: {
        type: "child_terminal_result",
        childSessionId: source.id,
        status: "idle",
      },
    });
    const steeredClaim = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId: steeredTarget.id,
      workflowId: `session-${steeredTarget.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(steeredClaim.action).toBe("claimed");
    if (steeredClaim.action !== "claimed") throw new Error("Agent Steer was not claimed");
    expect(steeredClaim.turn.initiator).toEqual(sourceTurn.initiator);
    expect(steeredClaim.turn.source).toBe("system");
    expect(steeredClaim.turn.model).toBe("scripted-model");

    const malformedTarget = await createSession(client.db, sessionInput(grant));
    await addSessionSystemUpdate(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: malformedTarget.id,
      kind: "agent_steer_instruction",
      classification: "action_required",
      sourceId: source.id,
      dedupeKey: crypto.randomUUID(),
      summary: "Malformed legacy steer",
      payload: {
        type: "agent_steer_instruction",
        instruction: "Malformed legacy steer",
        operationId: crypto.randomUUID(),
      },
      lineage: {},
    });
    const malformedClaim = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId: malformedTarget.id,
      workflowId: `session-${malformedTarget.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(malformedClaim.action).toBe("claimed");
    if (malformedClaim.action !== "claimed") throw new Error("Malformed Steer was not claimed");
    expect(malformedClaim.turn.initiator).toEqual({
      kind: "service",
      subjectId: "internal-update",
      label: "OpenGeni internal update",
    });
    expect(malformedClaim.turn.initiatorContext.provenanceError).toBe(
      "agent_steer_lineage_incomplete",
    );

    const scheduledTarget = await createSession(client.db, {
      ...sessionInput(grant),
      createdBy: { kind: "service", subjectId: "scheduler" },
    });
    const scheduledTaskId = crypto.randomUUID();
    const scheduledRunId = crypto.randomUUID();
    await addSessionSystemUpdate(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: scheduledTarget.id,
      kind: "scheduled_occurrence",
      classification: "info",
      sourceId: scheduledRunId,
      dedupeKey: crypto.randomUUID(),
      summary: "Scheduled work",
      payload: {
        type: "scheduled_occurrence",
        text: "Scheduled work",
        scheduledTaskId,
        scheduledTaskRunId: scheduledRunId,
      },
    });
    const scheduledClaim = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId: scheduledTarget.id,
      workflowId: `session-${scheduledTarget.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(scheduledClaim.action).toBe("claimed");
    if (scheduledClaim.action !== "claimed") throw new Error("Scheduled turn was not claimed");
    expect(scheduledClaim.turn.initiator).toEqual({
      kind: "service",
      subjectId: "scheduler",
      label: "OpenGeni scheduler",
    });
    expect(scheduledClaim.turn.initiatorContext.scheduledRunIds).toEqual([scheduledRunId]);

    const mixedTarget = await createSession(client.db, sessionInput(grant));
    const goal = await createSessionGoal(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: mixedTarget.id,
      text: "Keep going",
      createdBy: "api",
    });
    await addSessionSystemUpdate(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: mixedTarget.id,
      kind: "goal_continuation",
      classification: "info",
      sourceId: goal.id,
      dedupeKey: crypto.randomUUID(),
      summary: "Continue goal",
      payload: {
        type: "goal_continuation",
        goalId: goal.id,
        goalVersion: goal.version,
        autoContinuation: 1,
        prompt: "Continue goal",
        policy: { model: "goal-routed-model", reasoningEffort: "high" },
      },
    });
    await addSessionSystemUpdate(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: mixedTarget.id,
      kind: "scheduled_occurrence",
      classification: "info",
      sourceId: crypto.randomUUID(),
      dedupeKey: crypto.randomUUID(),
      summary: "Scheduled context",
      payload: {
        type: "scheduled_occurrence",
        text: "Scheduled context",
        scheduledTaskId: crypto.randomUUID(),
        scheduledTaskRunId: crypto.randomUUID(),
      },
    });
    const mixedClaim = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId: mixedTarget.id,
      workflowId: `session-${mixedTarget.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(mixedClaim.action).toBe("claimed");
    if (mixedClaim.action !== "claimed") throw new Error("Mixed service batch was not claimed");
    expect(mixedClaim.turn.initiator).toEqual({
      kind: "service",
      subjectId: "internal-update",
      label: "OpenGeni internal update",
    });
    // The mixed service batch has no single subject initiator, but an ordinary
    // coalesced notice must not erase the goal's routing policy.
    expect(mixedClaim.turn.source).toBe("goal");
    expect(mixedClaim.turn.model).toBe("goal-routed-model");
    expect(mixedClaim.turn.reasoningEffort).toBe("high");
  });
});
