import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { McpPersonalConnectionDelegation } from "@opengeni/contracts";
import { and, asc, eq } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  AgentCommandAuthorityError,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionQueueSnapshot,
  listOutstandingSessionSystemUpdates,
  listSessionSystemUpdatesForTurn,
  markSessionAttemptQuiesced,
  markSessionWorkflowWakeDelivered,
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
  personalConnectionDelegations: McpPersonalConnectionDelegation[] = [],
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
        model: "scripted-model",
        reasoningEffort: "low",
        reasoningEffortFallback: "medium",
        source: "user",
        personalConnectionDelegations,
      }),
    ),
  );
}

async function activeAgent(
  grant: Awaited<ReturnType<typeof fixture>>,
  parentSessionId: string | null = null,
  personalConnectionDelegations: McpPersonalConnectionDelegation[] = [],
) {
  const session = await makeSession(grant, parentSessionId);
  await submit(grant, session.id, "agent is working", "send", personalConnectionDelegations);
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

async function wakeRow(workspaceId: string, sessionId: string) {
  return await withWorkspaceRls(client.db, workspaceId, async (db) => {
    const [row] = await db
      .select()
      .from(schema.sessionWorkflowWakeOutbox)
      .where(
        and(
          eq(schema.sessionWorkflowWakeOutbox.workspaceId, workspaceId),
          eq(schema.sessionWorkflowWakeOutbox.sessionId, sessionId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

describe("attempt-fenced Agent session commands", () => {
  test("Agent Message and Steer freeze caller authority while queue disclosure stays public-safe", async () => {
    const grant = await fixture();
    const connectionId = crypto.randomUUID();
    const delegations: McpPersonalConnectionDelegation[] = [
      {
        serverId: "linear",
        connectionId,
        ownerSubjectId: grant.subjectId,
        providerDomain: "linear.app",
        kind: "oauth2",
      },
    ];
    const caller = await activeAgent(grant, null, delegations);

    const messageTarget = await makeSession(grant);
    const messageOperationKey = crypto.randomUUID();
    const message = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        sendAgentMessageInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          targetSessionId: messageTarget.id,
          actor: caller.actor,
          operationKey: messageOperationKey,
          text: "Use my delegated Linear connection",
        }),
      ),
    );
    const messageReplay = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        sendAgentMessageInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          targetSessionId: messageTarget.id,
          actor: caller.actor,
          operationKey: messageOperationKey,
          text: "Use my delegated Linear connection",
        }),
      ),
    );
    expect(messageReplay).toMatchObject({ replay: true, updateId: message.updateId });

    const steerTarget = await makeSession(grant);
    const steerOperationKey = crypto.randomUUID();
    const steer = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        steerAgentSessionInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          targetSessionId: steerTarget.id,
          actor: caller.actor,
          operationKey: steerOperationKey,
          instruction: "Continue with my delegated Linear connection",
        }),
      ),
    );
    const steerReplay = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        steerAgentSessionInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          targetSessionId: steerTarget.id,
          actor: caller.actor,
          operationKey: steerOperationKey,
          instruction: "Continue with my delegated Linear connection",
        }),
      ),
    );
    expect(steerReplay).toMatchObject({ replay: true, updateId: steer.updateId });

    const stored = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db
        .select({
          id: schema.sessionSystemUpdates.id,
          personalConnectionDelegations: schema.sessionSystemUpdates.personalConnectionDelegations,
        })
        .from(schema.sessionSystemUpdates)
        .where(
          and(
            eq(schema.sessionSystemUpdates.workspaceId, grant.workspaceId!),
            eq(schema.sessionSystemUpdates.sourceId, caller.session.id),
          ),
        )
        .orderBy(asc(schema.sessionSystemUpdates.createdAt), asc(schema.sessionSystemUpdates.id)),
    );
    expect(stored).toEqual([
      { id: message.updateId, personalConnectionDelegations: delegations },
      { id: steer.updateId, personalConnectionDelegations: delegations },
    ]);

    const messageAttemptId = crypto.randomUUID();
    const messageClaim = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId: messageTarget.id,
      workflowId: `session-${messageTarget.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: messageAttemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (messageClaim.action !== "claimed") throw new Error("Agent message was not claimed");
    expect(messageClaim.turn.personalConnectionDelegations).toEqual(delegations);

    const snapshot = await getSessionQueueSnapshot(client.db, grant.workspaceId!, messageTarget.id);
    expect(snapshot?.activePersonalConnections).toEqual([
      { serverId: "linear", providerDomain: "linear.app" },
    ]);
    const publicProjection = JSON.stringify(snapshot);
    expect(publicProjection).not.toContain(connectionId);
    expect(publicProjection).not.toContain(grant.subjectId);
  });

  test("child completion keeps the exact spawning parent-turn authority after the parent moves on", async () => {
    const grant = await fixture();
    const spawningDelegations: McpPersonalConnectionDelegation[] = [
      {
        serverId: "linear",
        connectionId: crypto.randomUUID(),
        ownerSubjectId: grant.subjectId,
        providerDomain: "linear.app",
        kind: "oauth2",
      },
    ];
    const parent = await activeAgent(grant, null, spawningDelegations);
    const child = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "child initial work",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
      parentSessionId: parent.session.id,
      createdByActor: parent.actor,
      personalConnectionDelegations: spawningDelegations,
    });

    await applySessionTurnSettlement(client.db, grant.workspaceId!, {
      sessionId: parent.session.id,
      turnId: parent.turn.id,
      triggerEventId: parent.turn.triggerEventId,
      attemptId: parent.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [],
    });
    const laterDelegations: McpPersonalConnectionDelegation[] = [
      {
        serverId: "github",
        connectionId: crypto.randomUUID(),
        ownerSubjectId: grant.subjectId,
        providerDomain: "github.com",
        kind: "oauth2",
      },
    ];
    await submit(grant, parent.session.id, "later unrelated parent work", "send", laterDelegations);
    const laterParentClaim = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId: parent.session.id,
      workflowId: `session-${parent.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (laterParentClaim.action !== "claimed") throw new Error("later parent turn was not claimed");
    expect(laterParentClaim.turn.personalConnectionDelegations).toEqual(laterDelegations);

    await submit(grant, child.id, "child work that fails");
    const childAttemptId = crypto.randomUUID();
    const childClaim = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId: child.id,
      workflowId: `session-${child.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: childAttemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (childClaim.action !== "claimed") throw new Error("child turn was not claimed");
    await applySessionTurnSettlement(client.db, grant.workspaceId!, {
      sessionId: child.id,
      turnId: childClaim.turn.id,
      triggerEventId: childClaim.turn.triggerEventId,
      attemptId: childAttemptId,
      turnStatus: "failed",
      sessionStatus: "failed",
      activeTurnId: null,
      events: [{ type: "turn.failed", payload: { error: "expected test failure" } }],
    });

    const [outbox] = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db
        .select({
          lineage: schema.sessionSystemUpdateOutbox.lineage,
          personalConnectionDelegations:
            schema.sessionSystemUpdateOutbox.personalConnectionDelegations,
        })
        .from(schema.sessionSystemUpdateOutbox)
        .where(eq(schema.sessionSystemUpdateOutbox.sourceSessionId, child.id)),
    );
    expect(outbox?.personalConnectionDelegations).toEqual(spawningDelegations);
    expect(outbox?.lineage).toMatchObject({
      childSessionId: child.id,
      parentSessionId: parent.session.id,
      parentTurnId: parent.turn.id,
      turnId: childClaim.turn.id,
    });
  });

  test("per-turn instructions are durable on the turn and absent from the visible user event", async () => {
    const grant = await fixture();
    const session = await makeSession(grant);
    const instructions = "Current host context: record 42 is selected.";
    const submitted = await withWorkspaceSubjectRls(
      client.db,
      grant.workspaceId!,
      grant.subjectId,
      (db) =>
        db.transaction((tx) =>
          submitHumanPromptInTransaction(tx as typeof db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId!,
            sessionId: session.id,
            subjectId: grant.subjectId,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "Use the selected record",
            turnInstructions: instructions,
            resources: [],
            model: "scripted-model",
            reasoningEffort: "low",
            reasoningEffortFallback: "medium",
            source: "user",
          }),
        ),
    );

    const [turn] = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db
        .select({
          prompt: schema.sessionTurns.prompt,
          turnInstructions: schema.sessionTurns.turnInstructions,
        })
        .from(schema.sessionTurns)
        .where(eq(schema.sessionTurns.id, submitted.turnId)),
    );
    const [event] = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db
        .select({ payload: schema.sessionEvents.payload })
        .from(schema.sessionEvents)
        .where(eq(schema.sessionEvents.id, submitted.acceptedEventId)),
    );

    expect(turn).toEqual({
      prompt: "Use the selected record",
      turnInstructions: instructions,
    });
    expect(event?.payload).toMatchObject({ text: "Use the selected record" });
    expect(event?.payload).not.toHaveProperty("turnInstructions");
  });

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

  test("Agent Steer reports cancellation cleanup with no visible human queue", async () => {
    const grant = await fixture();
    const caller = await activeAgent(grant);
    const target = await activeAgent(grant);

    const steered = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        steerAgentSessionInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          targetSessionId: target.session.id,
          actor: caller.actor,
          operationKey: crypto.randomUUID(),
          instruction: "replace the active direction",
        }),
      ),
    );

    expect(steered.interruptionCount).toBe(1);
    expect(
      await getSessionQueueSnapshot(client.db, grant.workspaceId!, target.session.id),
    ).toMatchObject({ items: [], stoppingPreviousAttempt: true });
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

  test("idle repeated Agent Steer keeps stale wake acknowledgements outstanding until one newest-direction claim", async () => {
    const grant = await fixture();
    const caller = await activeAgent(grant);
    const target = await makeSession(grant);
    const steer = (instruction: string) =>
      withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
        db.transaction((tx) =>
          steerAgentSessionInTransaction(tx as typeof db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId!,
            targetSessionId: target.id,
            actor: caller.actor,
            operationKey: crypto.randomUUID(),
            instruction,
          }),
        ),
      );
    const acknowledge = (wakeRevision: number) =>
      markSessionWorkflowWakeDelivered(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: target.id,
        temporalWorkflowId: `session-${target.id}`,
        wakeRevision,
      });

    const first = await steer("first direction must be superseded");
    const firstWakeRevision = first.wakeRevision;
    if (firstWakeRevision === null) throw new Error("Agent Steer did not register a wake");
    expect(await acknowledge(firstWakeRevision)).toEqual({
      action: "pending_admission",
      blocker: "pending_agent_steer",
    });
    // An accepted Temporal signal whose response was lost can be delivered and
    // acknowledged again. Transport duplication still cannot consume DB work.
    expect(await acknowledge(firstWakeRevision)).toEqual({
      action: "pending_admission",
      blocker: "pending_agent_steer",
    });

    const newest = await steer("only this newest direction may run");
    const newestWakeRevision = newest.wakeRevision;
    if (newestWakeRevision === null) throw new Error("Newest Agent Steer did not register a wake");
    expect(newestWakeRevision).toBe(firstWakeRevision + 1);
    expect(await acknowledge(firstWakeRevision)).toEqual({
      action: "pending_admission",
      blocker: "pending_agent_steer",
    });
    expect(await wakeRow(grant.workspaceId!, target.id)).toMatchObject({
      wakeRevision: newestWakeRevision,
      deliveredRevision: 0,
    });

    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId: target.id,
      workflowId: `session-${target.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error("Newest Agent Steer was not claimed");
    expect(claimed.turn.source).toBe("system");
    expect(
      await listSessionSystemUpdatesForTurn(
        client.db,
        grant.workspaceId!,
        target.id,
        claimed.turn.id,
      ),
    ).toMatchObject([{ id: newest.updateId, kind: "agent_steer_instruction" }]);

    const updates = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db
        .select({
          id: schema.sessionSystemUpdates.id,
          state: schema.sessionSystemUpdates.state,
          deliveredTurnId: schema.sessionSystemUpdates.deliveredTurnId,
        })
        .from(schema.sessionSystemUpdates)
        .where(eq(schema.sessionSystemUpdates.sessionId, target.id)),
    );
    expect(updates.find((update) => update.id === first.updateId)).toMatchObject({
      state: "superseded",
      deliveredTurnId: null,
    });
    expect(updates.find((update) => update.id === newest.updateId)).toMatchObject({
      state: "delivered",
      deliveredTurnId: claimed.turn.id,
    });

    const duplicateClaim = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId: target.id,
      workflowId: `session-${target.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(duplicateClaim).toEqual({ action: "unclaimed", reason: "no-work" });

    // Once the DB claim adopted the newest direction, an old sender may only
    // acknowledge its own revision; it cannot hide the newer wake.
    expect(await acknowledge(firstWakeRevision)).toEqual({ action: "acknowledged" });
    expect(await wakeRow(grant.workspaceId!, target.id)).toMatchObject({
      wakeRevision: newestWakeRevision,
      deliveredRevision: firstWakeRevision,
    });
    expect(await acknowledge(newestWakeRevision)).toEqual({ action: "acknowledged" });
    expect(await wakeRow(grant.workspaceId!, target.id)).toMatchObject({
      wakeRevision: newestWakeRevision,
      deliveredRevision: newestWakeRevision,
    });
    const systemTurns = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db
        .select({ id: schema.sessionTurns.id })
        .from(schema.sessionTurns)
        .where(
          and(
            eq(schema.sessionTurns.sessionId, target.id),
            eq(schema.sessionTurns.source, "system"),
          ),
        ),
    );
    expect(systemTurns).toEqual([{ id: claimed.turn.id }]);
  });

  test("Pause may acknowledge an Agent Steer wake only because Resume commits a fresh admission revision", async () => {
    const grant = await fixture();
    const caller = await activeAgent(grant);
    const target = await makeSession(grant);
    const steered = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        steerAgentSessionInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          targetSessionId: target.id,
          actor: caller.actor,
          operationKey: crypto.randomUUID(),
          instruction: "preserve this direction across Pause and Resume",
        }),
      ),
    );
    const steeredWakeRevision = steered.wakeRevision;
    if (steeredWakeRevision === null) throw new Error("Agent Steer did not register a wake");
    const paused = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
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
    expect(paused.control.state).toBe("paused");
    expect(
      await markSessionWorkflowWakeDelivered(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: target.id,
        temporalWorkflowId: `session-${target.id}`,
        wakeRevision: steeredWakeRevision,
      }),
    ).toEqual({ action: "acknowledged" });

    const resumed = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        mutateSessionControlInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: target.id,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: crypto.randomUUID(),
          action: "resume",
        }),
      ),
    );
    expect(resumed.control.state).toBe("active");
    expect(resumed.wakeCount).toBe(1);
    const freshWake = await wakeRow(grant.workspaceId!, target.id);
    expect(freshWake).toMatchObject({
      wakeRevision: steeredWakeRevision + 1,
      deliveredRevision: steeredWakeRevision,
      reason: "session_resume",
    });
    expect(
      await markSessionWorkflowWakeDelivered(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: target.id,
        temporalWorkflowId: `session-${target.id}`,
        wakeRevision: freshWake!.wakeRevision,
      }),
    ).toEqual({ action: "pending_admission", blocker: "pending_agent_steer" });

    const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId: target.id,
      workflowId: `session-${target.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error("Resumed Agent Steer was not claimed");
    expect(
      await listSessionSystemUpdatesForTurn(
        client.db,
        grant.workspaceId!,
        target.id,
        claimed.turn.id,
      ),
    ).toMatchObject([{ id: steered.updateId, state: "delivered" }]);
    expect(
      await markSessionWorkflowWakeDelivered(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: target.id,
        temporalWorkflowId: `session-${target.id}`,
        wakeRevision: freshWake!.wakeRevision,
      }),
    ).toEqual({ action: "acknowledged" });
    expect(await wakeRow(grant.workspaceId!, target.id)).toMatchObject({
      wakeRevision: freshWake!.wakeRevision,
      deliveredRevision: freshWake!.wakeRevision,
    });
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
    const steeredWakeRevision = steered.wakeRevision;
    if (steeredWakeRevision === null) throw new Error("Agent Steer did not register a wake");
    expect(steered.interruptionCount).toBe(1);
    expect(
      await markSessionWorkflowWakeDelivered(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: target.id,
        temporalWorkflowId: `session-${target.id}`,
        wakeRevision: steeredWakeRevision,
      }),
    ).toEqual({ action: "pending_admission", blocker: "pending_agent_steer" });
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
    expect(
      await markSessionWorkflowWakeDelivered(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: target.id,
        temporalWorkflowId: `session-${target.id}`,
        wakeRevision: steeredWakeRevision,
      }),
    ).toEqual({ action: "pending_admission", blocker: "pending_agent_steer" });
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
    const receiptWake = await wakeRow(grant.workspaceId!, target.id);
    expect(receiptWake!.wakeRevision).toBe(steeredWakeRevision + 1);
    expect(
      await markSessionWorkflowWakeDelivered(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: target.id,
        temporalWorkflowId: `session-${target.id}`,
        wakeRevision: receiptWake!.wakeRevision,
      }),
    ).toEqual({ action: "pending_admission", blocker: "pending_agent_steer" });
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
    expect(
      await markSessionWorkflowWakeDelivered(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: target.id,
        temporalWorkflowId: `session-${target.id}`,
        wakeRevision: steeredWakeRevision,
      }),
    ).toEqual({ action: "acknowledged" });
    expect(await wakeRow(grant.workspaceId!, target.id)).toMatchObject({
      wakeRevision: receiptWake!.wakeRevision,
      deliveredRevision: steeredWakeRevision,
    });
    expect(
      await markSessionWorkflowWakeDelivered(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: target.id,
        temporalWorkflowId: `session-${target.id}`,
        wakeRevision: receiptWake!.wakeRevision,
      }),
    ).toEqual({ action: "acknowledged" });
    const [oldQuiescedAt] = await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      const [attempt] = await db
        .select({ quiescedAt: schema.sessionTurnAttempts.quiescedAt })
        .from(schema.sessionTurnAttempts)
        .where(eq(schema.sessionTurnAttempts.id, targetAttemptId));
      await db
        .update(schema.sessionTurnAttempts)
        .set({ quiescedAt: null })
        .where(eq(schema.sessionTurnAttempts.id, targetAttemptId));
      return [attempt?.quiescedAt ?? null] as const;
    });
    expect(oldQuiescedAt).not.toBeNull();
    expect(await getSessionQueueSnapshot(client.db, grant.workspaceId!, target.id)).toMatchObject({
      stoppingPreviousAttempt: false,
    });
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db
        .update(schema.sessionTurnAttempts)
        .set({ quiescedAt: oldQuiescedAt })
        .where(eq(schema.sessionTurnAttempts.id, targetAttemptId));
    });
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

  test("a human Steer claims ahead of an older pending Agent Steer and carries it as context", async () => {
    const grant = await fixture();
    const caller = await activeAgent(grant);
    const target = await makeSession(grant);
    await submit(grant, target.id, "currently running");
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

    const agentSteer = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        steerAgentSessionInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          targetSessionId: target.id,
          actor: caller.actor,
          operationKey: crypto.randomUUID(),
          instruction: "inspect the older agent direction",
        }),
      ),
    );
    const humanSteer = await submit(grant, target.id, "the human replacement direction", "steer");

    await settleSessionAttemptInterruptions(
      client.db,
      grant.workspaceId!,
      target.id,
      targetAttemptId,
    );
    await markSessionAttemptQuiesced(client.db, {
      workspaceId: grant.workspaceId!,
      sessionId: target.id,
      attemptId: targetAttemptId,
      temporalWorkflowId: `session-${target.id}`,
    });

    const replacement = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId: target.id,
      workflowId: `session-${target.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (replacement.action !== "claimed") throw new Error("Human Steer was not claimed");
    expect(replacement.turn.id).toBe(humanSteer.turnId);
    expect(replacement.turn.source).toBe("user");
    expect(
      await listSessionSystemUpdatesForTurn(
        client.db,
        grant.workspaceId!,
        target.id,
        replacement.turn.id,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: agentSteer.updateId,
          kind: "agent_steer_instruction",
        }),
      ]),
    );
  });
});
