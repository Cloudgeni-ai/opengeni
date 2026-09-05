import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  addSessionSystemUpdateWithSourceMutation,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimPendingSessionSystemUpdateOutbox,
  claimSessionWorkForAttempt,
  configureChildLifecycleNotices,
  createDb,
  createSession,
  createVariableSet,
  enqueueSessionTurn,
  ensureManagedAccessForUserWithOrganizationMemberships,
  failSessionWorkBeforeAttemptClaim,
  getSessionForSubject,
  grantWorkspaceAccess,
  initializeSessionStartAtomically,
  listSessionsForSubject,
  markSessionSystemUpdateOutboxDeliveredInTransaction,
  materializeGoalContinuation,
  mutateSessionControlInTransaction,
  recordSessionGoalProgressWithEvent,
  recoverSessionWorkFailedBeforeAttemptClaim,
  sessionSystemUpdateOutboxKindPayload,
  setSessionAttention,
  settleSessionIdleWithParentOutbox,
  withWorkspaceSessionActivityRls,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(60_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("child-read-acknowledgment");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
  configureChildLifecycleNotices({ enabled: true });
}, 180_000);

afterAll(async () => {
  configureChildLifecycleNotices({ enabled: false });
  await client?.close();
  await shared?.release();
}, 60_000);

type Grant = { accountId: string; workspaceId: string; subjectId: string };

async function managedWorkspaceWithPersonalVariableSet(): Promise<{
  grant: Grant;
  variableSetId: string;
}> {
  const userId = `child-read-personal-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Child read personal-resource owner",
  });
  const membership = provisioned.organizationMemberships[0];
  if (!membership?.personalWorkspaceId) {
    throw new Error("managed human provisioned without a personal workspace");
  }
  const sharedGrant = provisioned.accessContext.workspaceGrants.find(
    (candidate) =>
      candidate.accountId === membership.organizationId &&
      candidate.workspaceId !== membership.personalWorkspaceId,
  );
  if (!sharedGrant?.workspaceId) {
    throw new Error("managed human provisioned without a shared workspace");
  }
  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (
      ${membership.organizationId}, 1, ${"e".repeat(64)}, ${"f".repeat(64)},
      'child-read-acknowledgment'
    ) on conflict (account_id) do nothing`;
  const variableSet = await createVariableSet(client.db, {
    accountId: membership.organizationId,
    workspaceId: membership.personalWorkspaceId,
    scope: "user",
    subjectId,
    name: `child-read-personal-${crypto.randomUUID()}`,
    variables: [{ name: "PERSONAL_TOKEN", valueEncrypted: "ciphertext:test" }],
  });
  return {
    grant: {
      accountId: membership.organizationId,
      workspaceId: sharedGrant.workspaceId,
      subjectId,
    },
    variableSetId: variableSet.id,
  };
}

async function workspace(): Promise<Grant> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "child-read-acknowledgment",
    accountExternalId: `account-${suffix}`,
    accountName: "Child read acknowledgment",
    workspaceExternalSource: "child-read-acknowledgment",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Child read acknowledgment",
    subjectId: `user:owner-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
}

/** A second member of the same workspace, so per-viewer isolation is testable. */
async function member(grant: Grant, control = false): Promise<string> {
  const subjectId = `user:other-${crypto.randomUUID()}`;
  await grantWorkspaceAccess(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId,
    permissions: control ? ["sessions:read", "sessions:control"] : ["sessions:read"],
  });
  return subjectId;
}

async function startSession(
  grant: Grant,
  input: { parent?: Started; goal?: boolean; message: string; personalVariableSetId?: string },
) {
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    ...(input.parent
      ? {
          parentSessionId: input.parent.session.id,
          createdByActor: {
            type: "agent_attempt" as const,
            attemptId: input.parent.attemptId,
            sessionId: input.parent.session.id,
            turnId: input.parent.turn.id,
            executionGeneration: input.parent.turn.executionGeneration,
          },
        }
      : {}),
    initialMessage: input.message,
    resources: [],
    tools: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    ...(input.personalVariableSetId
      ? {
          subjectId: grant.subjectId,
          variableSetIds: [input.personalVariableSetId],
          variableSetId: input.personalVariableSetId,
          initialPersonalResourceAttachmentIntent: {
            mode: "session" as const,
            workspaceSharedAcknowledged: true,
            sharedOutputWarningVersion: 1 as const,
          },
        }
      : {}),
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    clientEventId: `initial:${session.id}`,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: input.goal
      ? { text: "Orchestrate the workers", mutationPolicy: "preserve_intent" }
      : null,
  });
  const claimed = await claim(grant, session.id);
  if (claimed.action !== "claimed") throw new Error("turn was not claimed");
  return { session, turn: claimed.turn, attemptId: claimed.attemptId };
}

type Started = Awaited<ReturnType<typeof startSession>>;

async function claim(grant: Grant, sessionId: string) {
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  return { ...claimed, attemptId };
}

async function settle(
  grant: Grant,
  started: Started,
  status: "completed" | "failed",
): Promise<void> {
  const settled = await applySessionTurnSettlement(client.db, grant.workspaceId, {
    sessionId: started.session.id,
    turnId: started.turn.id,
    triggerEventId: started.turn.triggerEventId,
    attemptId: started.attemptId,
    turnStatus: status,
    sessionStatus: status === "completed" ? "idle" : "failed",
    activeTurnId: null,
    events: [
      status === "completed"
        ? { type: "turn.completed" as const, payload: { reason: "test" } }
        : { type: "turn.failed" as const, payload: { error: "test failure" } },
    ],
  });
  expect(settled.action).toBe("settled");
  if (status === "completed") {
    // The idle boundary, not turn settlement, is what enqueues this session's
    // `child_terminal_result` for its parent.
    await settleSessionIdleWithParentOutbox(client.db, grant.workspaceId, started.session.id);
  }
}

const settleIdle = (grant: Grant, started: Started) => settle(grant, started, "completed");
const settleFailed = (grant: Grant, started: Started) => settle(grant, started, "failed");

/**
 * What the worker's outbox delivery loop does: claim every committed child
 * lifecycle row and turn the ones aimed at `targetSessionId` into pending
 * machine input on that parent.
 */
async function deliverOutboxTo(targetSessionId: string): Promise<number> {
  const rows = await claimPendingSessionSystemUpdateOutbox(client.db, 1_000);
  let delivered = 0;
  for (const row of rows) {
    if (row.targetSessionId !== targetSessionId) continue;
    await addSessionSystemUpdateWithSourceMutation(
      client.db,
      {
        accountId: row.accountId,
        workspaceId: row.workspaceId,
        sessionId: row.targetSessionId,
        ...sessionSystemUpdateOutboxKindPayload(row),
        classification: row.classification,
        sourceId: row.sourceId,
        dedupeKey: row.dedupeKey,
        summary: row.summary,
        lineage: row.lineage,
        personalConnectionDelegations: row.personalConnectionDelegations,
        xaiProviderAccountAuthoritySnapshot: row.xaiProviderAccountAuthoritySnapshot,
      },
      async (tx) => {
        await markSessionSystemUpdateOutboxDeliveredInTransaction(tx, row);
      },
    );
    delivered += 1;
  }
  return delivered;
}

function materialize(grant: Grant, sessionId: string) {
  return materializeGoalContinuation(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
    workflowId: `session-${sessionId}`,
    defaultMaxAutoContinuations: null,
    budgetBlocked: null,
    policy: {
      model: "scripted-model",
      reasoningEffort: "low",
      latencyMode: "standard" as const,
      tools: [],
      sandboxBackend: "none",
    },
    prompt: (goal, count) => `continue ${goal.text} (${count})`,
  });
}

type PinRow = {
  acknowledged_sequence: number;
  attention_version: number;
  pinned: boolean;
  version: number;
  archived: boolean;
};

async function pinRow(subjectId: string, sessionId: string): Promise<PinRow | null> {
  const rows = await shared.admin<PinRow[]>`
    select acknowledged_sequence, attention_version, pinned, version, archived
    from session_pins
    where subject_id = ${subjectId} and session_id = ${sessionId}`;
  return rows[0] ?? null;
}

async function pinRowCount(sessionId: string): Promise<number> {
  const [row] = await shared.admin<Array<{ count: number }>>`
    select count(*)::int as count from session_pins where session_id = ${sessionId}`;
  return row!.count;
}

async function lastSequence(sessionId: string): Promise<number> {
  const [row] = await shared.admin<Array<{ last_sequence: number }>>`
    select last_sequence from sessions where id = ${sessionId}`;
  return row!.last_sequence;
}

/** A direct human pause of one session, which notices its parent. */
async function pauseSession(grant: Grant, sessionId: string): Promise<void> {
  await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, (db) =>
    db.transaction((tx) =>
      mutateSessionControlInTransaction(tx as unknown as typeof db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        action: "pause",
      }),
    ),
  );
}

/** A queued ordinary human prompt on an idle parent. */
async function enqueueHumanTurn(grant: Grant, sessionId: string): Promise<void> {
  await enqueueSessionTurn(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
    triggerEventId: crypto.randomUUID(),
    temporalWorkflowId: `session-${sessionId}`,
    source: "user",
    prompt: "keep going",
    resources: [],
    tools: [],
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    metadata: {},
    initiator: { kind: "subject", subjectId: grant.subjectId },
  });
}

describe("child read acknowledgment on parent consumption", () => {
  test("a queued human turn that consumes a child terminal result acknowledges that child", async () => {
    const grant = await workspace();
    const other = await member(grant);
    const parent = await startSession(grant, { message: "orchestrate" });
    const child = await startSession(grant, { parent, message: "work" });
    await settleIdle(grant, child);
    expect(await deliverOutboxTo(parent.session.id)).toBe(1);
    await settleIdle(grant, parent);

    const childSequence = await lastSequence(child.session.id);
    expect(childSequence).toBeGreaterThan(0);
    const beforeClaim = await getSessionForSubject(
      client.db,
      grant.workspaceId,
      child.session.id,
      grant.subjectId,
    );
    expect(beforeClaim?.unread).toBe(true);

    await enqueueHumanTurn(grant, parent.session.id);
    const claimed = await claim(grant, parent.session.id);
    expect(claimed.action).toBe("claimed");

    expect(await pinRow(grant.subjectId, child.session.id)).toMatchObject({
      acknowledged_sequence: childSequence,
      // The acknowledgment must NOT mint an optimistic revision: it publishes no
      // event a browser could learn from, so bumping this would silently stale
      // the version the rail holds and 409 the human's next attention click.
      attention_version: 0,
      // Acknowledging is not pinning and not archiving.
      pinned: false,
      version: 0,
      archived: false,
    });
    const afterClaim = await getSessionForSubject(
      client.db,
      grant.workspaceId,
      child.session.id,
      grant.subjectId,
    );
    expect(afterClaim?.unread).toBe(false);

    // (a) Only the turn's initiating human is acknowledged.
    expect(await pinRow(other, child.session.id)).toBeNull();
    const forOther = await getSessionForSubject(
      client.db,
      grant.workspaceId,
      child.session.id,
      other,
    );
    expect(forOther?.unread).toBe(true);

    // (b) A further child event makes it unread again with no special handling.
    await enqueueHumanTurn(grant, child.session.id);
    const reclaimed = await claim(grant, child.session.id);
    if (reclaimed.action !== "claimed") throw new Error("child turn was not reclaimed");
    await settleIdle(grant, {
      session: child.session,
      turn: reclaimed.turn,
      attemptId: reclaimed.attemptId,
    });
    expect(await lastSequence(child.session.id)).toBeGreaterThan(childSequence);
    const reopened = await getSessionForSubject(
      client.db,
      grant.workspaceId,
      child.session.id,
      grant.subjectId,
    );
    expect(reopened?.unread).toBe(true);
  });

  test("a goal continuation batch carrying a child notice acknowledges for the causal human", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { goal: true, message: "orchestrate" });
    const child = await startSession(grant, { parent, message: "work" });
    await settleIdle(grant, parent);
    expect((await materialize(grant, parent.session.id)).action).toBe("continue");
    await settleIdle(grant, child);
    expect(await deliverOutboxTo(parent.session.id)).toBe(1);

    const childSequence = await lastSequence(child.session.id);
    const claimed = await claim(grant, parent.session.id);
    expect(claimed.action).toBe("claimed");
    expect(await pinRow(grant.subjectId, child.session.id)).toMatchObject({
      acknowledged_sequence: childSequence,
    });
  });

  test("a child result inherits its exact parent-turn human and admits session personal resources", async () => {
    const { grant, variableSetId } = await managedWorkspaceWithPersonalVariableSet();
    const parent = await startSession(grant, {
      message: "orchestrate",
      personalVariableSetId: variableSetId,
    });
    const child = await startSession(grant, { parent, message: "work" });
    await settleIdle(grant, child);
    expect(await deliverOutboxTo(parent.session.id)).toBe(1);
    await settleIdle(grant, parent);

    const [pendingUpdate] = await shared.admin<Array<{ id: string }>>`
      select id from session_system_updates
      where session_id = ${parent.session.id} and state = 'pending'`;
    if (!pendingUpdate) throw new Error("child result update was not pending");
    const failed = await failSessionWorkBeforeAttemptClaim(client.db, grant.workspaceId, {
      accountId: grant.accountId,
      sessionId: parent.session.id,
      workflowId: `session-${parent.session.id}`,
      trigger: { kind: "next" },
      error: "Agent turn admission failed before attempt claim.",
    });
    expect(failed.action).toBe("failed");
    const failedSequence = await lastSequence(parent.session.id);
    const [failureEvent] = await shared.admin<
      Array<{
        payload: { status: string; code: string; failedSystemUpdateIds?: string[] };
        turnId: string | null;
      }>
    >`
      select payload, turn_id as "turnId"
      from session_events
      where session_id = ${parent.session.id}
        and sequence = ${failedSequence}`;
    expect(failureEvent).toEqual({
      payload: {
        status: "failed",
        code: "pre_claim_failure",
        failedSystemUpdateIds: [pendingUpdate.id],
      },
      turnId: null,
    });
    // Test-only fixture rewrite: simulate the immutable event shape emitted by
    // the worker version that produced the September 2026 incident. New writers
    // bind the exact failed set above; recovery must also prove the old set from
    // durable pending and terminal lifecycle history.
    await shared.admin`
      update session_events
      set payload = payload - 'failedSystemUpdateIds'
      where session_id = ${parent.session.id}
        and sequence = ${failedSequence}`;
    const recoveryOperationId = `child-read-recovery-${crypto.randomUUID()}`;
    expect(
      await recoverSessionWorkFailedBeforeAttemptClaim(client.db, grant.workspaceId, {
        accountId: grant.accountId,
        sessionId: parent.session.id,
        workflowId: `session-${parent.session.id}`,
        operationId: `${recoveryOperationId}-wrong-set`,
        expectedFailureEventSequence: failedSequence,
        expectedLastSequence: failedSequence,
        failedUpdateIds: [crypto.randomUUID()],
      }),
    ).toEqual({ action: "stale", event: null });
    const recovered = await recoverSessionWorkFailedBeforeAttemptClaim(
      client.db,
      grant.workspaceId,
      {
        accountId: grant.accountId,
        sessionId: parent.session.id,
        workflowId: `session-${parent.session.id}`,
        operationId: recoveryOperationId,
        expectedFailureEventSequence: failedSequence,
        expectedLastSequence: failedSequence,
        failedUpdateIds: [pendingUpdate.id],
      },
    );
    expect(recovered).toMatchObject({
      action: "recovered",
      restoredUpdateIds: [pendingUpdate.id],
      event: {
        payload: {
          recoveredFailureEventSequence: failedSequence,
          recoveredLastSequence: failedSequence,
          restoredUpdateCount: 1,
          restoredUpdateIdsSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
      },
    });
    expect(
      await recoverSessionWorkFailedBeforeAttemptClaim(client.db, grant.workspaceId, {
        accountId: grant.accountId,
        sessionId: parent.session.id,
        workflowId: `session-${parent.session.id}`,
        operationId: recoveryOperationId,
        expectedFailureEventSequence: failedSequence,
        expectedLastSequence: failedSequence,
        failedUpdateIds: [pendingUpdate.id],
      }),
    ).toMatchObject({ action: "already_recovered" });
    expect(
      await recoverSessionWorkFailedBeforeAttemptClaim(client.db, grant.workspaceId, {
        accountId: grant.accountId,
        sessionId: parent.session.id,
        workflowId: `session-${parent.session.id}`,
        operationId: recoveryOperationId,
        expectedFailureEventSequence: failedSequence - 1,
        expectedLastSequence: failedSequence,
        failedUpdateIds: [pendingUpdate.id],
      }),
    ).toEqual({ action: "stale", event: null });
    expect(
      await recoverSessionWorkFailedBeforeAttemptClaim(client.db, grant.workspaceId, {
        accountId: grant.accountId,
        sessionId: parent.session.id,
        workflowId: `session-${parent.session.id}`,
        operationId: recoveryOperationId,
        expectedFailureEventSequence: failedSequence,
        expectedLastSequence: failedSequence,
        failedUpdateIds: [crypto.randomUUID()],
      }),
    ).toEqual({ action: "stale", event: null });

    const claimed = await claim(grant, parent.session.id);
    expect(claimed.action).toBe("claimed");
    if (claimed.action !== "claimed") throw new Error("child result was not claimed");
    expect(claimed.turn.initiatingHumanSubjectId).toBe(grant.subjectId);
    const [admission] = await shared.admin<Array<{ subjectId: string; resourceCount: number }>>`
        select
          initiating_human_subject_id as "subjectId",
          resource_count::int as "resourceCount"
        from session_attempt_personal_resource_admissions
        where attempt_id = ${claimed.attemptId}`;
    expect(admission).toEqual({ subjectId: grant.subjectId, resourceCount: 1 });
    expect(await pinRow(grant.subjectId, child.session.id)).toMatchObject({
      acknowledged_sequence: await lastSequence(child.session.id),
    });
  }, 240_000);

  test("pre-claim recovery refuses a nested session with parent-facing terminal truth", async () => {
    const grant = await workspace();
    const root = await startSession(grant, { message: "orchestrate" });
    const child = await startSession(grant, { parent: root, message: "delegate" });
    const grandchild = await startSession(grant, { parent: child, message: "work" });
    await settleIdle(grant, grandchild);
    expect(await deliverOutboxTo(child.session.id)).toBe(1);
    await settleIdle(grant, child);

    const [pendingUpdate] = await shared.admin<Array<{ id: string }>>`
      select id from session_system_updates
      where session_id = ${child.session.id} and state = 'pending'`;
    if (!pendingUpdate) throw new Error("nested child result update was not pending");
    const failed = await failSessionWorkBeforeAttemptClaim(client.db, grant.workspaceId, {
      accountId: grant.accountId,
      sessionId: child.session.id,
      workflowId: `session-${child.session.id}`,
      trigger: { kind: "next" },
      error: "Agent turn admission failed before attempt claim.",
    });
    expect(failed.action).toBe("failed");
    const failedSequence = await lastSequence(child.session.id);
    expect(
      await recoverSessionWorkFailedBeforeAttemptClaim(client.db, grant.workspaceId, {
        accountId: grant.accountId,
        sessionId: child.session.id,
        workflowId: `session-${child.session.id}`,
        operationId: `nested-recovery-${crypto.randomUUID()}`,
        expectedFailureEventSequence: failedSequence,
        expectedLastSequence: failedSequence,
        failedUpdateIds: [pendingUpdate.id],
      }),
    ).toEqual({ action: "stale", event: null });
  }, 240_000);

  test("child results from different causal humans are claimed in separate turns", async () => {
    const ownerGrant = await workspace();
    const otherGrant = {
      ...ownerGrant,
      subjectId: await member(ownerGrant, true),
    };
    const parent = await startSession(ownerGrant, { message: "orchestrate first" });
    const ownerChild = await startSession(ownerGrant, { parent, message: "owner work" });
    await settleIdle(ownerGrant, ownerChild);
    await settleIdle(ownerGrant, parent);

    await enqueueHumanTurn(otherGrant, parent.session.id);
    const otherParentClaim = await claim(otherGrant, parent.session.id);
    if (otherParentClaim.action !== "claimed") {
      throw new Error("second parent turn was not claimed");
    }
    const otherParent = {
      session: parent.session,
      turn: otherParentClaim.turn,
      attemptId: otherParentClaim.attemptId,
    };
    const otherChild = await startSession(otherGrant, {
      parent: otherParent,
      message: "other member work",
    });
    await settleIdle(otherGrant, otherChild);
    await settleIdle(otherGrant, otherParent);

    expect(await deliverOutboxTo(parent.session.id)).toBe(2);

    const ownerResultClaim = await claim(ownerGrant, parent.session.id);
    expect(ownerResultClaim.action).toBe("claimed");
    if (ownerResultClaim.action !== "claimed") {
      throw new Error("owner child result was not claimed");
    }
    expect(ownerResultClaim.turn.initiatingHumanSubjectId).toBe(ownerGrant.subjectId);
    expect(await pinRow(ownerGrant.subjectId, ownerChild.session.id)).toMatchObject({
      acknowledged_sequence: await lastSequence(ownerChild.session.id),
    });
    expect(await pinRow(otherGrant.subjectId, otherChild.session.id)).toBeNull();

    await settleIdle(ownerGrant, {
      session: parent.session,
      turn: ownerResultClaim.turn,
      attemptId: ownerResultClaim.attemptId,
    });
    const otherResultClaim = await claim(otherGrant, parent.session.id);
    expect(otherResultClaim.action).toBe("claimed");
    if (otherResultClaim.action !== "claimed") {
      throw new Error("other member child result was not claimed");
    }
    expect(otherResultClaim.turn.initiatingHumanSubjectId).toBe(otherGrant.subjectId);
    expect(await pinRow(otherGrant.subjectId, otherChild.session.id)).toMatchObject({
      acknowledged_sequence: await lastSequence(otherChild.session.id),
    });
  }, 240_000);

  test("a parent-consumed failure keeps lifecycle truth but clears failure attention", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { message: "orchestrate" });
    const child = await startSession(grant, { parent, message: "work" });
    await settleFailed(grant, child);
    expect(await deliverOutboxTo(parent.session.id)).toBe(1);
    await settleIdle(grant, parent);
    const beforeClaim = await listSessionsForSubject(client.db, grant.workspaceId, {
      subjectId: grant.subjectId,
      parentSessionId: null,
    });
    expect(
      beforeClaim.sessions.find((session) => session.id === parent.session.id)?.treeStats,
    ).toMatchObject({
      failedDescendants: 1,
      unreadFailedDescendants: 1,
      unreadDescendants: 1,
    });
    await enqueueHumanTurn(grant, parent.session.id);
    expect((await claim(grant, parent.session.id)).action).toBe("claimed");

    const seen = await getSessionForSubject(
      client.db,
      grant.workspaceId,
      child.session.id,
      grant.subjectId,
    );
    expect(seen?.unread).toBe(false);
    // Lifecycle truth is unchanged, while the viewer-specific rail attention
    // on this child and its ancestors has been acknowledged.
    expect(seen?.status).toBe("failed");
    const afterClaim = await listSessionsForSubject(client.db, grant.workspaceId, {
      subjectId: grant.subjectId,
      parentSessionId: null,
    });
    expect(
      afterClaim.sessions.find((session) => session.id === parent.session.id)?.treeStats,
    ).toMatchObject({
      failedDescendants: 1,
      unreadFailedDescendants: 0,
      unreadDescendants: 0,
    });
  });

  test("an acknowledgment already ahead of the consumed child is never regressed", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { message: "orchestrate" });
    const child = await startSession(grant, { parent, message: "work" });
    await settleIdle(grant, child);
    expect(await deliverOutboxTo(parent.session.id)).toBe(1);
    await settleIdle(grant, parent);

    const childSequence = await lastSequence(child.session.id);
    // A fence beyond the child's current sequence, as a racing claim or a
    // client that acknowledged a later frontier would leave it.
    await shared.admin`
      insert into session_pins
        (account_id, workspace_id, subject_id, session_id, pinned, pinned_at, version,
         acknowledged_sequence, attention_version, archive_version)
      values
        (${grant.accountId}, ${grant.workspaceId}, ${grant.subjectId}, ${child.session.id},
         false, null, 0, ${childSequence + 5}, 7, 0)`;

    await enqueueHumanTurn(grant, parent.session.id);
    expect((await claim(grant, parent.session.id)).action).toBe("claimed");
    expect(await pinRow(grant.subjectId, child.session.id)).toMatchObject({
      acknowledged_sequence: childSequence + 5,
      // The monotone guard skipped the write entirely, so the optimistic
      // revision did not move either.
      attention_version: 7,
    });
  });

  test("many notices for one child in a single batch produce exactly one acknowledgment", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { message: "orchestrate" });
    const child = await startSession(grant, { parent, message: "work", goal: true });
    // A progress note and a human pause are two independent notices for the
    // same child; neither supersedes the other.
    await recordSessionGoalProgressWithEvent(client.db, grant.workspaceId, child.session.id, {
      progressNote: "half way",
      command: {
        accountId: grant.accountId,
        actor: {
          type: "agent_attempt",
          attemptId: child.attemptId,
          sessionId: child.session.id,
          turnId: child.turn.id,
          executionGeneration: child.turn.executionGeneration,
        },
        operationKey: crypto.randomUUID(),
      },
    });
    await pauseSession(grant, child.session.id);
    expect(await deliverOutboxTo(parent.session.id)).toBe(2);
    await settleIdle(grant, parent);

    const childSequence = await lastSequence(child.session.id);
    await enqueueHumanTurn(grant, parent.session.id);
    expect((await claim(grant, parent.session.id)).action).toBe("claimed");
    expect(await pinRowCount(child.session.id)).toBe(1);
    expect(await pinRow(grant.subjectId, child.session.id)).toMatchObject({
      acknowledged_sequence: childSequence,
      attention_version: 0,
    });
  });

  test("a nested chain acknowledges at every level with no orchestrator-specific rule", async () => {
    const grant = await workspace();
    const root = await startSession(grant, { message: "root" });
    const middle = await startSession(grant, { parent: root, message: "middle" });
    const leaf = await startSession(grant, { parent: middle, message: "leaf" });

    await settleIdle(grant, leaf);
    expect(await deliverOutboxTo(middle.session.id)).toBe(1);
    await settleIdle(grant, middle);
    expect(await deliverOutboxTo(root.session.id)).toBe(1);

    const leafSequence = await lastSequence(leaf.session.id);
    await enqueueHumanTurn(grant, middle.session.id);
    expect((await claim(grant, middle.session.id)).action).toBe("claimed");
    expect(await pinRow(grant.subjectId, leaf.session.id)).toMatchObject({
      acknowledged_sequence: leafSequence,
    });

    const middleSequence = await lastSequence(middle.session.id);
    await settleIdle(grant, root);
    await enqueueHumanTurn(grant, root.session.id);
    expect((await claim(grant, root.session.id)).action).toBe("claimed");
    expect(await pinRow(grant.subjectId, middle.session.id)).toMatchObject({
      acknowledged_sequence: middleSequence,
    });
  });

  test("the acknowledgment mints no optimistic revision, so the next attention click still applies", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { message: "orchestrate" });
    const child = await startSession(grant, { parent, message: "work" });
    await settleIdle(grant, child);
    expect(await deliverOutboxTo(parent.session.id)).toBe(1);
    await settleIdle(grant, parent);
    await enqueueHumanTurn(grant, parent.session.id);
    expect((await claim(grant, parent.session.id)).action).toBe("claimed");

    // The rail sends `expectedVersion: session.attentionVersion ?? 0` with every
    // attention mutation, and the acknowledgment emits no event, no NATS
    // invalidation, and no sequence advance the page could learn from. If it had
    // bumped the revision, this exact call would raise the conflict the API maps
    // to a 409 and a "Couldn't update the session status." toast.
    const seen = await getSessionForSubject(
      client.db,
      grant.workspaceId,
      child.session.id,
      grant.subjectId,
    );
    expect(seen?.attentionVersion).toBe(0);
    const marked = await setSessionAttention(client.db, {
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      sessionId: child.session.id,
      unread: true,
      expectedVersion: seen?.attentionVersion ?? 0,
    });
    expect(marked?.unread).toBe(true);
  });

  test("a later consumption advances past an earlier explicit mark-unread", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { message: "orchestrate" });
    const child = await startSession(grant, { parent, message: "work" });
    await settleIdle(grant, child);
    expect(await deliverOutboxTo(parent.session.id)).toBe(1);
    await settleIdle(grant, parent);
    await enqueueHumanTurn(grant, parent.session.id);
    const firstParentClaim = await claim(grant, parent.session.id);
    if (firstParentClaim.action !== "claimed") throw new Error("parent turn was not claimed");

    const marked = await setSessionAttention(client.db, {
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      sessionId: child.session.id,
      unread: true,
    });
    expect(marked?.unread).toBe(true);

    // The child does more work and reports again. The fence is monotone and
    // OpenGeni keeps no durable "leave this unread" intent, so the next
    // consumption advances straight past the human's earlier mark-unread. This
    // pins the real behaviour: consumption is the signal, and an explicit
    // mark-unread survives only until the parent consumes a newer notice.
    await enqueueHumanTurn(grant, child.session.id);
    const reclaimed = await claim(grant, child.session.id);
    if (reclaimed.action !== "claimed") throw new Error("child turn was not reclaimed");
    await settleIdle(grant, {
      session: child.session,
      turn: reclaimed.turn,
      attemptId: reclaimed.attemptId,
    });
    expect(await deliverOutboxTo(parent.session.id)).toBe(1);
    await settleIdle(grant, {
      session: parent.session,
      turn: firstParentClaim.turn,
      attemptId: firstParentClaim.attemptId,
    });
    await enqueueHumanTurn(grant, parent.session.id);
    expect((await claim(grant, parent.session.id)).action).toBe("claimed");

    const afterSecondConsumption = await getSessionForSubject(
      client.db,
      grant.workspaceId,
      child.session.id,
      grant.subjectId,
    );
    expect(afterSecondConsumption?.unread).toBe(false);
  });

  /**
   * The acknowledgment probes the `session-personal-state` fence shared rather
   * than exclusive. `listSessionsForSubject` holds the shared counterpart for its
   * whole rail-list transaction, so an exclusive probe would drop the
   * acknowledgment precisely while the human is looking at the rail; membership
   * removal's exclusive hold must still block it.
   */
  async function withPersonalStateFenceHeld<T>(
    grant: Grant,
    mode: "shared" | "exclusive",
    run: () => Promise<T>,
  ): Promise<T> {
    const holder = postgres(shared.adminUrl, { max: 1 });
    const key = `session-personal-state:${grant.workspaceId}:${grant.subjectId}`;
    const acquire =
      mode === "shared"
        ? holder`select pg_advisory_lock_shared(hashtextextended(${key}, 0))`
        : holder`select pg_advisory_lock(hashtextextended(${key}, 0))`;
    await acquire;
    try {
      return await run();
    } finally {
      await holder`select pg_advisory_unlock_all()`.catch(() => undefined);
      await holder.end().catch(() => undefined);
    }
  }

  test("a concurrent shared personal-state holder does not block the acknowledgment", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { message: "orchestrate" });
    const child = await startSession(grant, { parent, message: "work" });
    await settleIdle(grant, child);
    expect(await deliverOutboxTo(parent.session.id)).toBe(1);
    await settleIdle(grant, parent);
    await enqueueHumanTurn(grant, parent.session.id);

    const childSequence = await lastSequence(child.session.id);
    // Exactly what the rail list holds while the human has it open; it refreshes
    // on focus, online, and visibilitychange, so this is the common case.
    const claimed = await withPersonalStateFenceHeld(grant, "shared", () =>
      claim(grant, parent.session.id),
    );
    expect(claimed.action).toBe("claimed");
    expect(await pinRow(grant.subjectId, child.session.id)).toMatchObject({
      acknowledged_sequence: childSequence,
    });
  });

  test("an exclusive personal-state holder makes the acknowledgment a clean no-op", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { message: "orchestrate" });
    const child = await startSession(grant, { parent, message: "work" });
    await settleIdle(grant, child);
    expect(await deliverOutboxTo(parent.session.id)).toBe(1);
    await settleIdle(grant, parent);
    await enqueueHumanTurn(grant, parent.session.id);

    // Membership removal (migration 0278) holds this exclusively before it takes
    // the workspace/session prefix. The acknowledgment must yield, so it cannot
    // recreate a removed member's personal row after the cleanup DELETE.
    const claimed = await withPersonalStateFenceHeld(grant, "exclusive", () =>
      claim(grant, parent.session.id),
    );
    // Skipping is a clean no-op: the turn is still claimed and the batch is still
    // delivered, the child simply stays unread.
    expect(claimed.action).toBe("claimed");
    expect(await pinRowCount(child.session.id)).toBe(0);
    const seen = await getSessionForSubject(
      client.db,
      grant.workspaceId,
      child.session.id,
      grant.subjectId,
    );
    expect(seen?.unread).toBe(true);
  });

  test("a notice naming a session that is not this parent's child acknowledges nothing", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { message: "orchestrate" });
    const child = await startSession(grant, { parent, message: "work" });
    const stranger = await startSession(grant, { message: "unrelated" });
    await settleIdle(grant, child);
    expect(await deliverOutboxTo(parent.session.id)).toBe(1);
    // Repoint the committed notice at a session this parent does not own, as a
    // corrupt or hand-inserted payload would. The insert is fenced on
    // `parent_session_id`, so a payload field cannot decide whose personal state
    // is mutated even under the temporary subject scope.
    await shared.admin`
      update session_system_updates
      set payload = jsonb_set(payload, '{childSessionId}', ${shared.admin.json(stranger.session.id)})
      where session_id = ${parent.session.id} and kind = 'child_terminal_result'`;
    await settleIdle(grant, parent);
    await enqueueHumanTurn(grant, parent.session.id);
    expect((await claim(grant, parent.session.id)).action).toBe("claimed");

    expect(await pinRowCount(stranger.session.id)).toBe(0);
    expect(await pinRowCount(child.session.id)).toBe(0);
  });
});
