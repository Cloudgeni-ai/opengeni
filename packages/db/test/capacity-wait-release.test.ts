import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { readTurnExecutionPolicyV1, TurnExecutionPolicyV1 } from "@opengeni/contracts";
import {
  armSubscriptionCoreCapacityWait,
  bootstrapWorkspace,
  capacityWaitNotificationKey,
  claimSessionWorkForAttempt,
  configureChildLifecycleNotices,
  createDb,
  createSession,
  getSession,
  getSessionTurn,
  initializeSessionStartAtomically,
  listSessionEvents,
  mutateSessionControlInTransaction,
  mutateWorkspaceControlInTransaction,
  reconcileSubscriptionCoreCapacityWait,
  setSessionModelInTransaction,
  withWorkspaceSessionActivityRls,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(60_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("capacity-wait-release");
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

const FOUR_DAYS_MS = 4 * 24 * 60 * 60_000;

async function workspace(): Promise<Grant> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "capacity-wait-release",
    accountExternalId: `account-${suffix}`,
    accountName: "Capacity wait release",
    workspaceExternalSource: "capacity-wait-release",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Capacity wait release",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
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
  return { claimed, attemptId };
}

/** A top-level chat whose first turn is parked on Codex capacity four days out. */
async function waitingChat(grant: Grant) {
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "do the work",
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
    goal: null,
  });
  const { claimed, attemptId } = await claim(grant, session.id);
  if (claimed.action !== "claimed") throw new Error("turn was not claimed");
  const resetsAt = new Date(Date.now() + FOUR_DAYS_MS);
  const armed = await armSubscriptionCoreCapacityWait(client.db, "codex", {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    waitReason: "no_eligible_capacity",
    earliestResetAt: resetsAt,
    failurePayload: { error: "No Codex subscription has capacity for this turn right now." },
  });
  if (armed.action !== "waiting") throw new Error(`wait not armed: ${armed.action}`);
  return { session, turn: claimed.turn, waiter: armed.waiter, resetsAt };
}

function newModelPolicy() {
  return TurnExecutionPolicyV1.parse({
    schemaVersion: 1,
    productModelId: "other-model",
    requestedModelId: "other-model",
    modelSource: "explicit",
    reasoningEffort: "high",
    reasoningSource: "explicit",
    latencyMode: "standard",
    latencyModeSource: "session",
    providerId: "scripted-provider",
    upstreamModelId: "other-upstream",
    wireApi: "responses",
    credentialSource: { kind: "deployment", mechanism: "api_key" },
    billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
    definitionVersion: `sha256:${"b".repeat(64)}`,
  });
}

async function switchModel(grant: Grant, sessionId: string, turnId: string) {
  return await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, (db) =>
    db.transaction((tx) =>
      setSessionModelInTransaction(tx as unknown as typeof db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        model: "other-model",
        reasoningEffort: "high",
        capacityRelease: { turnId, executionPolicy: newModelPolicy() },
      }),
    ),
  );
}

async function control(grant: Grant, sessionId: string, action: "pause" | "resume") {
  return await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, (db) =>
    db.transaction((tx) =>
      mutateSessionControlInTransaction(tx as unknown as typeof db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        action,
      }),
    ),
  );
}

async function workspaceControl(grant: Grant, action: "pause" | "resume") {
  return await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, (db) =>
    db.transaction((tx) =>
      mutateWorkspaceControlInTransaction(tx as unknown as typeof db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        action,
      }),
    ),
  );
}

/** The run after Resume finds no capacity again and parks the same turn. */
async function rearm(grant: Grant, chat: Awaited<ReturnType<typeof waitingChat>>) {
  const { claimed, attemptId } = await claim(grant, chat.session.id);
  if (claimed.action !== "claimed") throw new Error(`not claimed: ${claimed.action}`);
  expect(claimed.turn.id).toBe(chat.turn.id);
  const armed = await armSubscriptionCoreCapacityWait(client.db, "codex", {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: chat.session.id,
    turnId: chat.turn.id,
    attemptId,
    waitReason: "no_eligible_capacity",
    earliestResetAt: chat.resetsAt,
    failurePayload: { error: "No Codex subscription has capacity for this turn right now." },
  });
  expect(armed.action).toBe("waiting");
}

/** The person's capacity-wait notices for this chat, in order: posted or withdrawn. */
async function notices(grant: Grant, chat: Awaited<ReturnType<typeof waitingChat>>) {
  const key = capacityWaitNotificationKey(chat.turn.id);
  return (await eventsOf(grant, chat.session.id))
    .filter(
      (event) =>
        (event.type === "session.notification.posted" ||
          event.type === "session.notification.withdrawn") &&
        (event.payload as { key?: string }).key === key,
    )
    .map((event) => event.type.replace("session.notification.", ""));
}

/** What the workflow's capacity sleep does when it wakes: reconcile its waiter. */
async function reconcile(
  grant: Grant,
  chat: Awaited<ReturnType<typeof waitingChat>>,
): Promise<string> {
  const result = await reconcileSubscriptionCoreCapacityWait(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: chat.session.id,
    waiterId: chat.waiter.waiterId,
    generation: chat.waiter.generation,
    evaluatedWakeRevision: chat.waiter.wakeRevision,
    evaluation: {
      kind: "wait",
      waitReason: "no_eligible_capacity",
      earliestResetAt: chat.resetsAt,
      healthRetryAt: null,
    },
  });
  return result.action;
}

async function eventsOf(grant: Grant, sessionId: string) {
  return await listSessionEvents(client.db, grant.workspaceId, sessionId);
}

describe("long subscription capacity waits", () => {
  test("a top-level chat's person is notified at once with the reset time", async () => {
    const grant = await workspace();
    const chat = await waitingChat(grant);
    const posted = (await eventsOf(grant, chat.session.id)).find(
      (event) => event.type === "session.notification.posted",
    );
    expect(posted?.turnId).toBe(chat.turn.id);
    const payload = posted?.payload as { key: string; title: string; body: string };
    expect(payload.key).toBe(capacityWaitNotificationKey(chat.turn.id));
    expect(payload.title).toBe("Chat waiting for Codex capacity");
    expect(payload.body).toContain(
      `until about ${chat.resetsAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    );
    expect(payload.body).toContain("switch the chat to another model");
  });

  test("switching the chat's model releases the waiting turn onto the new model", async () => {
    const grant = await workspace();
    const chat = await waitingChat(grant);
    const switched = await switchModel(grant, chat.session.id, chat.turn.id);
    expect(switched.releasedCapacityWaitTurnId).toBe(chat.turn.id);

    // The waiter is gone: the workflow's capacity sleep finds nothing to wait for.
    expect(await reconcile(grant, chat)).toBe("stale");
    const turn = await getSessionTurn(client.db, grant.workspaceId, chat.turn.id);
    expect(turn?.status).toBe("recovering");
    expect(turn?.model).toBe("other-model");
    expect((await getSession(client.db, grant.workspaceId, chat.session.id))?.status).toBe(
      "recovering",
    );
    const types = (await eventsOf(grant, chat.session.id)).map((event) => event.type);
    expect(types).toContain("session.model_settings.updated");
    expect(types).toContain("turn.recovery.requested");
    expect(types).toContain("session.notification.withdrawn");

    // The same logical turn runs next, on the new model.
    const { claimed } = await claim(grant, chat.session.id);
    if (claimed.action !== "claimed") throw new Error(`not claimed: ${claimed.action}`);
    expect(claimed.turn.id).toBe(chat.turn.id);
    expect(claimed.turn.model).toBe("other-model");
    expect(
      readTurnExecutionPolicyV1(
        (await getSessionTurn(client.db, grant.workspaceId, chat.turn.id))?.metadata,
      ),
    ).toMatchObject({ kind: "valid", policy: { productModelId: "other-model" } });
  });

  test("Pause stops the waiting turn; Resume continues it, on a model switched meanwhile", async () => {
    const grant = await workspace();
    const chat = await waitingChat(grant);
    const paused = await control(grant, chat.session.id, "pause");
    expect(paused.outcome).toBe("changed");
    expect(
      paused.affectedSessionEvents.find((entry) => entry.sessionId === chat.session.id)?.eventIds
        .length,
    ).toBeGreaterThan(1);

    expect(await reconcile(grant, chat)).toBe("stale");
    expect((await getSessionTurn(client.db, grant.workspaceId, chat.turn.id))?.status).toBe(
      "recovering",
    );
    const session = await getSession(client.db, grant.workspaceId, chat.session.id);
    expect(session?.status).toBe("idle");
    expect(session?.activeTurnId).toBe(chat.turn.id);
    const recovery = (await eventsOf(grant, chat.session.id)).find(
      (event) => event.type === "turn.recovery.requested",
    );
    expect(recovery?.payload).toMatchObject({
      reason: "session_pause",
      capacityWaitReleased: true,
    });
    // Nothing runs while paused.
    expect((await claim(grant, chat.session.id)).claimed.action).not.toBe("claimed");

    // A model switch while paused moves the stopped turn too, without running it.
    const switched = await switchModel(grant, chat.session.id, chat.turn.id);
    expect(switched.releasedCapacityWaitTurnId).toBe(chat.turn.id);
    expect((await getSession(client.db, grant.workspaceId, chat.session.id))?.status).toBe("idle");
    expect((await claim(grant, chat.session.id)).claimed.action).not.toBe("claimed");

    await control(grant, chat.session.id, "resume");
    const { claimed } = await claim(grant, chat.session.id);
    if (claimed.action !== "claimed") throw new Error(`not claimed: ${claimed.action}`);
    expect(claimed.turn.id).toBe(chat.turn.id);
    expect(claimed.turn.model).toBe("other-model");
  });

  test("Pause withdraws the person's notice; Resume announces a wait that still holds", async () => {
    const grant = await workspace();
    const chat = await waitingChat(grant);
    expect(await notices(grant, chat)).toEqual(["posted"]);

    await control(grant, chat.session.id, "pause");
    expect(await notices(grant, chat)).toEqual(["posted", "withdrawn"]);

    await control(grant, chat.session.id, "resume");
    await rearm(grant, chat);
    expect(await notices(grant, chat)).toEqual(["posted", "withdrawn", "posted"]);
  });

  test("pausing the whole workspace stops the wait and withdraws the notice too", async () => {
    const grant = await workspace();
    const chat = await waitingChat(grant);

    const paused = await workspaceControl(grant, "pause");
    expect(paused.outcome).toBe("changed");
    expect(paused.affectedSessionEvents.map((entry) => entry.sessionId)).toEqual([chat.session.id]);
    expect(await notices(grant, chat)).toEqual(["posted", "withdrawn"]);
    // The waiter is gone, so nothing will claim the paused turn when capacity returns.
    expect(await reconcile(grant, chat)).toBe("stale");
    expect((await getSessionTurn(client.db, grant.workspaceId, chat.turn.id))?.status).toBe(
      "recovering",
    );
    expect((await getSession(client.db, grant.workspaceId, chat.session.id))?.status).toBe("idle");
    expect((await claim(grant, chat.session.id)).claimed.action).not.toBe("claimed");
    // Pausing again changes nothing more.
    expect((await workspaceControl(grant, "pause")).outcome).toBe("unchanged");

    await workspaceControl(grant, "resume");
    await rearm(grant, chat);
    expect(await notices(grant, chat)).toEqual(["posted", "withdrawn", "posted"]);
  });
});
