import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import {
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  listOutstandingSessionSystemUpdates,
  markSessionWorkflowWakeDelivered,
  settleSessionIdleWithParentOutbox,
  waitForSessionInputWithEvent,
  type SessionWorkflowWakeDeliveryResult,
} from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

import { notifyParentOfChildIdle, type NotifyServices } from "../src/activities/parent-wake";

// The child-to-parent handoff with real PostgreSQL. Only the Temporal
// transport is replaced: the recorder stands in for signalWithStart and then
// runs the same durable acknowledgement the production signaler runs.

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb> | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-parent-wake");
  if (!shared) {
    if (requireRealDatabase) throw new Error("Parent wake PostgreSQL harness is unavailable");
    console.warn("[worker-parent-wake] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("a finished child signals its parent parked in wait_for_input immediately", async () => {
  if (!shared || !client) return;
  const admin = shared.admin;
  const db = client.db;
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "worker-parent-wake",
    accountExternalId: `account-${suffix}`,
    accountName: "Worker parent wake",
    workspaceExternalSource: "worker-parent-wake",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Worker parent wake",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const accountId = grant.accountId;
  const workspaceId = grant.workspaceId!;

  async function start(
    message: string,
    parent?: {
      session: { id: string };
      turn: { id: string; executionGeneration: number };
      attemptId: string;
    },
  ) {
    const session = await createSession(db, {
      accountId,
      workspaceId,
      ...(parent
        ? {
            parentSessionId: parent.session.id,
            createdByActor: {
              type: "agent_attempt" as const,
              attemptId: parent.attemptId,
              sessionId: parent.session.id,
              turnId: parent.turn.id,
              executionGeneration: parent.turn.executionGeneration,
            },
          }
        : {}),
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
    await initializeSessionStartAtomically(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      clientEventId: `initial:${session.id}`,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error("turn was not claimed");
    // The start wake is consumed by this claim long before the turn ends.
    await admin`update session_workflow_wake_outbox set delivered_revision = wake_revision
      where session_id = ${session.id}`;
    return { session, turn: claimed.turn, attemptId };
  }

  async function settleIdle(started: Awaited<ReturnType<typeof start>>) {
    const settled = await applySessionTurnSettlement(db, workspaceId, {
      sessionId: started.session.id,
      turnId: started.turn.id,
      triggerEventId: started.turn.triggerEventId,
      attemptId: started.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: { reason: "test" } }],
    });
    expect(settled.action).toBe("settled");
  }

  // The parent delegates, parks in wait_for_input, and its turn settles idle.
  const parent = await start("delegate the audit and wait");
  const child = await start("run the audit", parent);
  await waitForSessionInputWithEvent(db, workspaceId, parent.session.id, {
    reason: "waiting for the audit child",
    timeoutSeconds: 600,
    command: {
      accountId,
      actor: {
        type: "agent_attempt",
        sessionId: parent.session.id,
        turnId: parent.turn.id,
        attemptId: parent.attemptId,
        executionGeneration: parent.turn.executionGeneration,
      },
      operationKey: crypto.randomUUID(),
    },
  });
  await settleIdle(parent);
  const [deadline] = await admin<Array<{ wake_revision: number | string; reason: string }>>`
    select wake_revision, reason from session_workflow_wake_outbox
    where session_id = ${parent.session.id}`;
  expect(deadline?.reason).toBe("session_input_wait_deadline");

  // A close racing the still-owned turn cannot publish a parent result.
  expect(await settleSessionIdleWithParentOutbox(db, workspaceId, child.session.id)).toEqual({
    action: "stale",
    episodeKey: null,
    events: [],
  });
  expect(await listOutstandingSessionSystemUpdates(db, workspaceId, parent.session.id)).toEqual([]);

  // The child finishes; its idle boundary commits the parent outbox row.
  await settleIdle(child);
  const boundary = await settleSessionIdleWithParentOutbox(db, workspaceId, child.session.id);
  if (boundary.action !== "settled" || !boundary.notifyParent) {
    throw new Error("child idle boundary did not notify its parent");
  }

  const signals: Array<{
    sessionId: string;
    wakeRevision: number;
    delivery: SessionWorkflowWakeDeliveryResult;
  }> = [];
  const errors: string[] = [];
  const services: NotifyServices = {
    db,
    bus: { publish: async () => undefined } as unknown as EventBus,
    settings: {} as Settings,
    observability: {
      info: () => undefined,
      error: (message: string) => {
        errors.push(message);
      },
    } as unknown as NotifyServices["observability"],
    wakeSessionWorkflow: async (wake) => {
      const delivery = await markSessionWorkflowWakeDelivered(db, {
        accountId: wake.accountId,
        workspaceId: wake.workspaceId,
        sessionId: wake.sessionId,
        temporalWorkflowId: wake.workflowId,
        wakeRevision: wake.wakeRevision,
      });
      signals.push({ sessionId: wake.sessionId, wakeRevision: wake.wakeRevision, delivery });
      return delivery;
    },
  };
  await notifyParentOfChildIdle(services, workspaceId, child.session.id, boundary.episodeKey);

  // A signal during close or an activity retry may revisit the same boundary.
  // It must neither create another result nor signal the parent twice.
  expect(await settleSessionIdleWithParentOutbox(db, workspaceId, child.session.id)).toMatchObject({
    action: "settled",
    episodeKey: boundary.episodeKey,
    notifyParent: true,
  });
  await notifyParentOfChildIdle(services, workspaceId, child.session.id, boundary.episodeKey);

  expect(errors).toEqual([]);
  const pending = await listOutstandingSessionSystemUpdates(db, workspaceId, parent.session.id);
  expect(pending.map((update) => update.kind)).toEqual(["child_terminal_result"]);
  // The parent is signalled now, on the deadline's revision, instead of waiting
  // for the periodic dispatcher. The acknowledgement keeps the revision open
  // until a claim consumes the result.
  expect(signals).toEqual([
    {
      sessionId: parent.session.id,
      wakeRevision: Number(deadline!.wake_revision),
      delivery: { action: "pending_admission", blocker: "pending_machine_input" },
    },
  ]);
}, 60_000);
