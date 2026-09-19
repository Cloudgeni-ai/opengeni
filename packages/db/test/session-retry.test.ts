import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  failSessionWorkBeforeAttemptClaim,
  getActiveSessionHistoryItems,
  getSession,
  getSessionTurn,
  listSessionEvents,
  mutateSessionControlInTransaction,
  retryFailedSessionInTransaction,
  getSessionRetryReceiptInTransaction,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  registerPendingSessionToolCall,
  recordPendingSessionToolCallResult,
} from "../src/index";
import type { SessionRetryRequest } from "@opengeni/contracts";
import {
  CODEX_CAPACITY_RECOVERY_KEY,
  readCodexCapacityRecovery,
} from "../src/codex-capacity-recovery";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
setDefaultTimeout(30_000);
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-retry");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const executionPolicy = resolveTurnExecutionPolicyV1(testSettings(), {
  modelId: "scripted-model",
  requestedModelId: null,
  modelSource: "session",
  reasoningEffort: "high",
  reasoningSource: "explicit",
  latencyMode: "standard",
  latencyModeSource: "session",
});

async function fixture(
  preclaim = false,
  tool: "none" | "completed" | "unknown" = "none",
  failureCode?: string,
) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "retry",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "retry",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const scope = <T>(
    fn: (db: Parameters<typeof retryFailedSessionInTransaction>[0]) => Promise<T>,
  ) => withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, grant.subjectId, fn);
  const accepted = await scope((db) =>
    submitHumanPromptInTransaction(db, {
      accountId: grant.accountId,
      workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
      actor: { type: "human", subjectId: grant.subjectId },
      operationKey: crypto.randomUUID(),
      delivery: "send",
      text: "Keep my original question",
      resources: [],
      reasoningEffortFallback: "medium",
      source: "user",
    }),
  );
  const claim = async () =>
    await claimSessionWorkForAttempt(client.db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
  if (preclaim) {
    await failSessionWorkBeforeAttemptClaim(client.db, workspaceId, {
      accountId: grant.accountId,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      trigger: { kind: "next" },
      error: "preclaim failure",
    });
  } else {
    const claimed = await claim();
    if (claimed.action !== "claimed") throw new Error("not claimed");
    if (tool !== "none") {
      const callId = crypto.randomUUID();
      const identity = {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        turnId: claimed.turn.id,
        executionGeneration: claimed.turn.executionGeneration,
        attemptId: claimed.turn.activeAttemptId!,
        callId,
      };
      await registerPendingSessionToolCall(client.db, {
        ...identity,
        callType: "function_call",
        callItem: { type: "function_call", callId, name: "completed_work", arguments: "{}" },
      });
      if (tool === "completed")
        await recordPendingSessionToolCallResult(client.db, {
          ...identity,
          resultItem: {
            type: "function_call_result",
            callId,
            name: "completed_work",
            output: { type: "text", text: "Already done; preserve this result" },
          },
        });
    }
    await applySessionTurnSettlement(client.db, workspaceId, {
      sessionId: session.id,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId: claimed.turn.activeAttemptId!,
      turnStatus: "failed",
      sessionStatus: "failed",
      activeTurnId: null,
      events: [
        {
          type: "turn.failed",
          payload: { error: "provider failure", ...(failureCode ? { code: failureCode } : {}) },
        },
        { type: "session.status.changed", payload: { status: "failed" } },
      ],
    });
  }
  const failure = (await listSessionEvents(client.db, workspaceId, session.id))
    .filter((e) => e.type === "turn.failed")
    .at(-1)!;
  const request: SessionRetryRequest = {
    clientEventId: crypto.randomUUID(),
    failureEventId: failure.id,
    reasoningEffort: "high",
  };
  const retry = (override: Partial<SessionRetryRequest> = {}) =>
    scope((db) =>
      retryFailedSessionInTransaction(db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
        request: { ...request, ...override },
        executionPolicy,
      }),
    );
  return { grant, workspaceId, session, turnId: accepted.turnId, request, retry, claim, scope };
}

describe("intent-preserving failed-session retry", () => {
  test("exact capacity Retry replenishes only its budget and suppression; Pause, stale failure and replay cannot reset it", async () => {
    const f = await fixture(false, "completed", "codex_capacity_recovery_exhausted");
    const pinnedCredentialId = crypto.randomUUID();
    const preserved = {
      codexCredentialPolicyHash: "accepted-manual-policy",
      codexCredentialPolicySnapshotV1: {
        schemaVersion: 1,
        source: "workspace",
        activeCredentialId: null,
        rotationEnabled: false,
        rotationStrategy: "sharded",
        pinnedCredentialId,
        pinSource: "manual",
        lastCredentialId: pinnedCredentialId,
      },
      codexCredentialFailedIds: [pinnedCredentialId],
      codexCredentialFailovers: 2,
      providerRecoveryCount: 3,
    };
    const budget = { falseResumptions: 10, resumeGeneration: null, retryNotBefore: null };
    await shared.admin`update session_turns set metadata = metadata || ${shared.admin.json({ ...preserved, [CODEX_CAPACITY_RECOVERY_KEY]: budget })}::jsonb where id = ${f.turnId}`;
    await shared.admin`insert into session_goals (account_id, workspace_id, session_id, status, text, continuation_suppressed_turn_id) values (${f.grant.accountId}, ${f.workspaceId}, ${f.session.id}, 'active', 'finish', ${f.turnId})`;
    const control = (action: "pause" | "resume") =>
      f.scope((db) =>
        mutateSessionControlInTransaction(db, {
          accountId: f.grant.accountId,
          workspaceId: f.workspaceId,
          sessionId: f.session.id,
          actor: { type: "human", subjectId: f.grant.subjectId },
          operationKey: crypto.randomUUID(),
          action,
        }),
      );
    await control("pause");
    await expect(f.retry()).rejects.toMatchObject({ code: "RETRY_PAUSED" });
    expect(
      readCodexCapacityRecovery(
        (await getSessionTurn(client.db, f.workspaceId, f.turnId))?.metadata,
      ),
    ).toEqual(budget);
    await control("resume");
    await expect(
      f.retry({ clientEventId: crypto.randomUUID(), failureEventId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "RETRY_STALE_FAILURE" });
    expect(await f.retry()).toMatchObject({ outcome: "accepted", turnId: f.turnId });
    const retried = await getSessionTurn(client.db, f.workspaceId, f.turnId);
    expect(retried?.metadata).toMatchObject(preserved);
    expect(retried?.metadata).not.toHaveProperty(CODEX_CAPACITY_RECOVERY_KEY);
    const [goal] =
      await shared.admin`select continuation_suppressed_turn_id from session_goals where session_id = ${f.session.id}`;
    expect(goal!.continuation_suppressed_turn_id).toBeNull();
    const claim = await f.claim();
    expect(claim.action).toBe("claimed");
    if (claim.action !== "claimed") throw new Error("expected same-turn retry");
    expect(claim.turn.id).toBe(f.turnId);
    await shared.admin`update session_turns set metadata = metadata || ${shared.admin.json({ [CODEX_CAPACITY_RECOVERY_KEY]: { ...budget, falseResumptions: 1 } })}::jsonb where id = ${f.turnId}`;
    expect(await f.retry()).toMatchObject({ outcome: "replayed", turnId: f.turnId });
    expect(
      readCodexCapacityRecovery(
        (await getSessionTurn(client.db, f.workspaceId, f.turnId))?.metadata,
      ).falseResumptions,
    ).toBe(1);
  });

  test("an earlier committed retry receipt still replays after a later safety refusal", async () => {
    const f = await fixture();
    await f.retry();
    const claimed = await f.claim();
    if (claimed.action !== "claimed") throw new Error("retry not claimed");
    await applySessionTurnSettlement(client.db, f.workspaceId, {
      sessionId: f.session.id,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId: claimed.turn.activeAttemptId!,
      turnStatus: "failed",
      sessionStatus: "failed",
      activeTurnId: null,
      events: [
        { type: "turn.failed", payload: { code: "provider_safety_refusal", retryable: false } },
        { type: "session.status.changed", payload: { status: "failed" } },
      ],
    });
    const before = await getSessionTurn(client.db, f.workspaceId, f.turnId);
    const events = await listSessionEvents(client.db, f.workspaceId, f.session.id);
    expect(await f.retry()).toMatchObject({
      outcome: "replayed",
      failureEventId: f.request.failureEventId,
    });
    const refusal = events.filter((event) => event.type === "turn.failed").at(-1)!;
    await expect(
      f.retry({ clientEventId: crypto.randomUUID(), failureEventId: refusal.id }),
    ).rejects.toMatchObject({ code: "RETRY_UNSUPPORTED_FAILURE" });
    expect(await getSessionTurn(client.db, f.workspaceId, f.turnId)).toEqual(before);
    expect(await listSessionEvents(client.db, f.workspaceId, f.session.id)).toEqual(events);
  });

  test("provider safety refusal cannot reopen the turn, including with a model change", async () => {
    const f = await fixture(false, "completed", "provider_safety_refusal");
    const before = await getSessionTurn(client.db, f.workspaceId, f.turnId);
    const history = await getActiveSessionHistoryItems(client.db, f.workspaceId, f.session.id);
    const events = await listSessionEvents(client.db, f.workspaceId, f.session.id);
    await expect(f.retry()).rejects.toMatchObject({ code: "RETRY_UNSUPPORTED_FAILURE" });
    await expect(f.retry({ model: "another-model" })).rejects.toMatchObject({
      code: "RETRY_UNSUPPORTED_FAILURE",
    });
    expect(await getSessionTurn(client.db, f.workspaceId, f.turnId)).toEqual(before);
    expect(await getActiveSessionHistoryItems(client.db, f.workspaceId, f.session.id)).toEqual(
      history,
    );
    expect(await listSessionEvents(client.db, f.workspaceId, f.session.id)).toEqual(events);
    expect((await getSession(client.db, f.workspaceId, f.session.id))!.status).toBe("failed");
    expect(
      await f.scope((db) =>
        getSessionRetryReceiptInTransaction(db, {
          workspaceId: f.workspaceId,
          sessionId: f.session.id,
          subjectId: f.grant.subjectId,
          request: f.request,
        }),
      ),
    ).toBeNull();
  });

  test("same turn, history, authority and original prompt survive concurrent idempotent retry", async () => {
    const f = await fixture(false, "completed");
    const before = await getSessionTurn(client.db, f.workspaceId, f.turnId);
    const history = await getActiveSessionHistoryItems(client.db, f.workspaceId, f.session.id);
    expect(JSON.stringify(history)).toContain("Already done; preserve this result");
    const results = await Promise.all([f.retry(), f.retry()]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["accepted", "replayed"]);
    expect(results.every((r) => r.turnId === f.turnId)).toBe(true);
    expect(await getActiveSessionHistoryItems(client.db, f.workspaceId, f.session.id)).toEqual(
      history,
    );
    const after = await getSessionTurn(client.db, f.workspaceId, f.turnId);
    expect(after).toMatchObject({
      prompt: before!.prompt,
      triggerEventId: before!.triggerEventId,
      status: "recovering",
      reasoningEffort: "high",
    });
    const events = await listSessionEvents(client.db, f.workspaceId, f.session.id);
    expect(events.filter((e) => e.type === "user.message")).toHaveLength(1);
    expect(events.filter((e) => e.type === "turn.recovery.requested")).toHaveLength(1);
    const claimed = await f.claim();
    expect(claimed.action).toBe("claimed");
    if (claimed.action === "claimed")
      expect(claimed.turn).toMatchObject({
        id: f.turnId,
        executionGeneration: before!.executionGeneration + 1,
      });
    expect(await getActiveSessionHistoryItems(client.db, f.workspaceId, f.session.id)).toEqual(
      history,
    );
    expect((await f.retry()).outcome).toBe("replayed");
    expect(
      await f.scope((db) =>
        getSessionRetryReceiptInTransaction(db, {
          workspaceId: f.workspaceId,
          sessionId: f.session.id,
          subjectId: f.grant.subjectId,
          request: f.request,
        }),
      ),
    ).toMatchObject({ outcome: "replayed", turnId: f.turnId });
  });

  test("never-claimed failed prompt uses first claim once", async () => {
    const f = await fixture(true);
    expect(await getActiveSessionHistoryItems(client.db, f.workspaceId, f.session.id)).toHaveLength(
      0,
    );
    await f.retry();
    expect((await getSession(client.db, f.workspaceId, f.session.id))!.activeTurnId).toBeNull();
    expect((await f.claim()).action).toBe("claimed");
    const history = await getActiveSessionHistoryItems(client.db, f.workspaceId, f.session.id);
    expect(history).toHaveLength(1);
    expect(JSON.stringify(history)).toContain("Keep my original question");
  });

  test("stale failure and reused key cannot admit another retry", async () => {
    const f = await fixture();
    await expect(f.retry({ failureEventId: crypto.randomUUID() })).rejects.toMatchObject({
      code: "RETRY_STALE_FAILURE",
    });
    await f.retry();
    await expect(f.retry({ model: "changed" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    await expect(f.retry({ clientEventId: crypto.randomUUID() })).rejects.toMatchObject({
      code: "RETRY_STALE_FAILURE",
    });
  });

  test("deliberate Pause stays separate from recovery", async () => {
    const f = await fixture();
    await f.scope((db) =>
      mutateSessionControlInTransaction(db, {
        accountId: f.grant.accountId,
        workspaceId: f.workspaceId,
        sessionId: f.session.id,
        actor: { type: "human", subjectId: f.grant.subjectId },
        action: "pause",
        operationKey: crypto.randomUUID(),
      }),
    );
    await expect(f.retry()).rejects.toMatchObject({ code: "RETRY_PAUSED" });
  });

  test("unknown tool outcomes reject retry even after terminal settlement removes pending rows", async () => {
    const f = await fixture(false, "unknown");
    await expect(f.retry()).rejects.toMatchObject({ code: "RETRY_EXECUTION_UNRESOLVED" });
    expect((await getSession(client.db, f.workspaceId, f.session.id))!.status).toBe("failed");
  });
});
