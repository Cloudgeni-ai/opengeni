import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  addSessionSystemUpdate,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  listSessionSystemUpdatesForTurn,
  markSessionWorkflowWakeDelivered,
  peekSessionWork,
  sendAgentMessageInTransaction,
  waitForSessionInputWithEvent,
  withWorkspaceSessionActivityRls,
} from "../src/index";

// An internal update (child result, Agent message, media or scheduled result)
// that reaches an idle session with an undelivered workflow wake coalesces into
// that wake's revision. The wake row is often a future-dated delayed wake, such
// as the `wait_for_input` safety deadline, so the producer must still request
// an immediate signal; otherwise delivery waits for the periodic dispatcher.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(60_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("internal-update-wake-signal");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Grant = { accountId: string; workspaceId: string; subjectId: string };

async function workspace(): Promise<Grant> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "internal-update-wake-signal",
    accountExternalId: `account-${suffix}`,
    accountName: "Internal update wake signal",
    workspaceExternalSource: "internal-update-wake-signal",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Internal update wake signal",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
}

/** A session whose first turn is claimed and still running. */
async function startSession(grant: Grant, message: string) {
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: message,
    resources: [],
    tools: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    clientEventId: `initial:${session.id}`,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  return { session, ...(await claim(grant, session.id)) };
}

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
  if (claimed.action !== "claimed") throw new Error(`turn was not claimed: ${claimed.action}`);
  return { turn: claimed.turn, attemptId };
}

async function settleIdle(
  grant: Grant,
  sessionId: string,
  claimed: Awaited<ReturnType<typeof claim>>,
) {
  const settled = await applySessionTurnSettlement(client.db, grant.workspaceId, {
    sessionId,
    turnId: claimed.turn.id,
    triggerEventId: claimed.turn.triggerEventId,
    attemptId: claimed.attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: { reason: "test" } }],
  });
  expect(settled.action).toBe("settled");
}

/** The production parent shape: the agent spawned work, called
 * `wait_for_input`, and its turn settled idle behind the durable deadline. */
async function parkedSession(grant: Grant) {
  const started = await startSession(grant, "delegate and wait");
  // The start wake was consumed by the claim long before the agent waits.
  await markWakeDelivered(started.session.id);
  const waiting = await waitForSessionInputWithEvent(
    client.db,
    grant.workspaceId,
    started.session.id,
    {
      reason: "waiting for a child session to report",
      timeoutSeconds: 600,
      command: {
        accountId: grant.accountId,
        actor: {
          type: "agent_attempt",
          sessionId: started.session.id,
          turnId: started.turn.id,
          attemptId: started.attemptId,
          executionGeneration: started.turn.executionGeneration,
        },
        operationKey: crypto.randomUUID(),
      },
    },
  );
  await settleIdle(grant, started.session.id, started);
  return { ...started, deadlineAt: waiting.deadlineAt };
}

async function wakeRow(sessionId: string) {
  const [row] = await shared.admin<
    Array<{
      reason: string;
      wake_revision: number | string;
      delivered_revision: number | string;
      next_attempt_at: Date;
    }>
  >`
    select reason, wake_revision, delivered_revision, next_attempt_at
    from session_workflow_wake_outbox where session_id = ${sessionId}`;
  if (!row) throw new Error(`no workflow wake row for ${sessionId}`);
  return {
    reason: row.reason,
    wakeRevision: Number(row.wake_revision),
    deliveredRevision: Number(row.delivered_revision),
    nextAttemptAt: row.next_attempt_at,
  };
}

async function markWakeDelivered(sessionId: string) {
  await shared.admin`
    update session_workflow_wake_outbox
    set delivered_revision = wake_revision
    where session_id = ${sessionId}`;
}

function childResult(grant: Grant, sessionId: string, parentTurnId: string) {
  const childSessionId = crypto.randomUUID();
  return addSessionSystemUpdate(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
    kind: "child_terminal_result",
    classification: "success",
    sourceId: childSessionId,
    dedupeKey: `child-completion:${childSessionId}:test`,
    summary: "Child finished",
    payload: { type: "child_terminal_result", childSessionId, status: "idle" },
    lineage: { parentSessionId: sessionId, parentTurnId, childSessionId },
  });
}

/** The production Agent message producer, called by a live peer attempt. */
function sendAgentMessage(
  grant: Grant,
  targetSessionId: string,
  caller: Awaited<ReturnType<typeof startSession>>,
  text: string,
) {
  return withWorkspaceSessionActivityRls(client.db, grant.workspaceId, (db) =>
    db.transaction((tx) =>
      sendAgentMessageInTransaction(tx as unknown as typeof db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        targetSessionId,
        actor: {
          type: "agent_attempt",
          sessionId: caller.session.id,
          turnId: caller.turn.id,
          attemptId: caller.attemptId,
          executionGeneration: caller.turn.executionGeneration,
        },
        operationKey: crypto.randomUUID(),
        text,
      }),
    ),
  );
}

function receipt(grant: Grant, sessionId: string, wakeRevision: number) {
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
    temporalWorkflowId: `session-${sessionId}`,
    wakeRevision,
  };
}

describe("internal update wake signal", () => {
  test("a child result into a parked wait signals now and reuses the deadline revision", async () => {
    const grant = await workspace();
    const parent = await parkedSession(grant);
    const deadline = await wakeRow(parent.session.id);
    expect(deadline.reason).toBe("session_input_wait_deadline");
    expect(deadline.wakeRevision).toBeGreaterThan(deadline.deliveredRevision);
    expect(deadline.nextAttemptAt.toISOString()).toBe(parent.deadlineAt);

    const result = await childResult(grant, parent.session.id, parent.turn.id);
    if (!result.added) throw new Error(`child result was not added: ${result.reason}`);
    // The immediate signal is requested even though a delayed wake was already
    // outstanding; the input coalesces into that revision instead of a new one.
    expect(result.shouldWake).toBe(true);
    expect(result.workflowWakeRevision).toBe(deadline.wakeRevision);
    const pulled = await wakeRow(parent.session.id);
    expect(pulled.wakeRevision).toBe(deadline.wakeRevision);
    expect(pulled.reason).toBe("internal_update_batch");
    expect(pulled.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(await peekSessionWork(client.db, grant.workspaceId, parent.session.id)).toEqual({
      kind: "runnable",
    });

    // A second result before the claim joins the same revision and signals too.
    const second = await childResult(grant, parent.session.id, parent.turn.id);
    if (!second.added) throw new Error(`second child result was not added: ${second.reason}`);
    expect(second.shouldWake).toBe(true);
    expect(second.workflowWakeRevision).toBe(deadline.wakeRevision);

    // The signal is only a hint: its transport acknowledgement cannot retire
    // the revision while the input is still pending.
    const ack = receipt(grant, parent.session.id, deadline.wakeRevision);
    expect(await markSessionWorkflowWakeDelivered(client.db, ack)).toEqual({
      action: "pending_admission",
      blocker: "pending_machine_input",
    });
    expect((await wakeRow(parent.session.id)).deliveredRevision).toBe(deadline.deliveredRevision);

    // One claim consumes both results as a single batch; afterwards the same
    // revision acknowledges.
    const consumed = await claim(grant, parent.session.id);
    const batch = await listSessionSystemUpdatesForTurn(
      client.db,
      grant.workspaceId,
      parent.session.id,
      consumed.turn.id,
    );
    expect(batch.map((update) => update.id).sort()).toEqual(
      [result.update.id, second.update.id].sort(),
    );
    expect(await markSessionWorkflowWakeDelivered(client.db, ack)).toEqual({
      action: "acknowledged",
    });
  });

  test("an Agent message into a parked wait signals now through the production producer", async () => {
    const grant = await workspace();
    const target = await parkedSession(grant);
    const deadline = await wakeRow(target.session.id);
    const caller = await startSession(grant, "peer caller");

    const message = await sendAgentMessage(grant, target.session.id, caller, "migration finished");
    expect(message.replay).toBe(false);
    expect(message.shouldSignal).toBe(true);
    expect(message.wakeRevision).toBe(deadline.wakeRevision);
    expect((await wakeRow(target.session.id)).wakeRevision).toBe(deadline.wakeRevision);
  });

  test("updates coalescing into an already-due wake keep one revision and each signal", async () => {
    const grant = await workspace();
    const target = await startSession(grant, "no wait");
    await settleIdle(grant, target.session.id, target);
    await markWakeDelivered(target.session.id);
    const settled = await wakeRow(target.session.id);
    const caller = await startSession(grant, "peer caller");

    // The first message opens a new revision that is due now.
    const first = await sendAgentMessage(grant, target.session.id, caller, "first peer update");
    expect(first.shouldSignal).toBe(true);
    expect(first.wakeRevision).toBe(settled.wakeRevision + 1);

    // A second message before any delivery joins that revision and signals
    // again; the duplicate hint cannot create a second transport revision.
    const second = await sendAgentMessage(grant, target.session.id, caller, "second peer update");
    expect(second.shouldSignal).toBe(true);
    expect(second.wakeRevision).toBe(first.wakeRevision);
    expect((await wakeRow(target.session.id)).wakeRevision).toBe(settled.wakeRevision + 1);

    // Nor a second model turn: one claim receives both messages.
    const consumed = await claim(grant, target.session.id);
    const batch = await listSessionSystemUpdatesForTurn(
      client.db,
      grant.workspaceId,
      target.session.id,
      consumed.turn.id,
    );
    expect(batch.map((update) => update.id).sort()).toEqual(
      [first.updateId, second.updateId].sort(),
    );
  });
});
