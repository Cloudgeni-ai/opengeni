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
  readPublicSandboxRecovery,
  getSessionTurn,
  listSessionEvents,
  mutateSessionControlInTransaction,
  retryFailedSessionInTransaction,
  getSessionRetryReceiptInTransaction,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  registerPendingSessionToolCall,
  recordPendingSessionToolCallResult,
  requestSessionTurnRecovery,
  readSessionTurnToolProgressRecoveryState,
  appendSessionEventsForTurnAttempt,
} from "../src/index";
import { NOT_STARTED_TOOL_CALL_EVENT_TEXT } from "../src/session-tool-call-settlement";
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
  tool: "none" | "completed" | "unknown" | "not_started" = "none",
  failureCode?: string,
  sandboxBackend: "none" | "modal" = "none",
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
    sandboxBackend,
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
  }
  let toolCallId: string | null = null;
  if (!preclaim) {
    const claimed = await claim();
    if (claimed.action !== "claimed") throw new Error("not claimed");
    if (tool !== "none") {
      const callId = crypto.randomUUID();
      toolCallId = callId;
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
        callItem: {
          type: "function_call",
          callId,
          name: tool === "not_started" ? "exec_command" : "completed_work",
          arguments: "{}",
        },
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
      ...(tool === "not_started" && toolCallId ? { notStartedToolCallIds: [toolCallId] } : {}),
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
  return {
    grant,
    workspaceId,
    session,
    turnId: accepted.turnId,
    request,
    retry,
    claim,
    scope,
    toolCallId,
  };
}

describe("intent-preserving failed-session retry", () => {
  test("unchanged blocked effective route refuses Retry, including model changes; healthy Connected Machine ignores degraded home", async () => {
    const f = await fixture(false, "completed");
    await shared.admin`insert into sandbox_leases(account_id,workspace_id,sandbox_group_id,backend,liveness,resume_state,expires_at)
      values(${f.grant.accountId},${f.workspaceId},${f.session.sandboxGroupId},'modal','cold',
        '{"opengeniRecovery":{"restore":{"status":"unrecoverable","retryable":false}}}'::jsonb,now())`;
    await expect(f.retry()).rejects.toMatchObject({ code: "RETRY_SANDBOX_RECOVERY_REQUIRED" });
    await expect(f.retry({ model: "another-model" })).rejects.toMatchObject({
      code: "RETRY_SANDBOX_RECOVERY_REQUIRED",
    });
    const machineId = crypto.randomUUID();
    const enrollmentId = crypto.randomUUID();
    await shared.admin`insert into enrollments(id,account_id,workspace_id,pubkey,last_seen_at) values(${enrollmentId},${f.grant.accountId},${f.workspaceId},${`ed25519:${machineId}`},now())`;
    await shared.admin`insert into sandboxes(id,account_id,workspace_id,kind,name,enrollment_id) values(${machineId},${f.grant.accountId},${f.workspaceId},'selfhosted','healthy machine',${enrollmentId})`;
    await shared.admin`update sessions set active_sandbox_id = ${machineId}, active_epoch = active_epoch + 1 where id = ${f.session.id}`;
    expect(
      await readPublicSandboxRecovery(client.db, {
        accountId: f.grant.accountId,
        workspaceId: f.workspaceId,
        sessionId: f.session.id,
        subjectId: f.grant.subjectId,
      }),
    ).toMatchObject({
      status: "unsupported",
      reason: "connected_machine_selected",
      checkpoint: null,
    });
    expect((await f.retry()).outcome).toBe("accepted");
    await shared.admin`update sessions set active_sandbox_id = null, active_epoch = active_epoch + 1 where id = ${f.session.id}`;
    expect((await f.retry()).outcome).toBe("replayed");
  });

  test("a definitively lost managed group admits Retry into its system lane only once every member is quiescent", async () => {
    const f = await fixture(false, "none", undefined, "modal");
    const member = await createSession(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.workspaceId,
      initialMessage: "",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "modal",
      sandboxGroupId: f.session.sandboxGroupId,
    });
    // confirmDrainCold's no-archive loss: no checkpoint exists at all.
    await shared.admin`insert into sandbox_leases(account_id,workspace_id,sandbox_group_id,backend,liveness,resume_state,expires_at)
      values(${f.grant.accountId},${f.workspaceId},${f.session.sandboxGroupId},'modal','cold',
        ${shared.admin.json({
          backendId: "modal",
          opengeniRecovery: {
            provider: {
              status: "missing",
              instanceId: "lost-box",
              observedAt: "2026-09-21T00:00:00.000Z",
              diagnostic: "provider_not_found_before_workspace_capture",
            },
            restore: {
              status: "unrecoverable",
              retryable: false,
              failureCode: "archive_unavailable",
            },
            workspace: { status: "unrecoverable" },
          },
        })}::jsonb,now())`;
    const recoveryScope = {
      accountId: f.grant.accountId,
      workspaceId: f.workspaceId,
      sessionId: f.session.id,
      subjectId: f.grant.subjectId,
    };
    await f.scope((db) =>
      submitHumanPromptInTransaction(db, {
        accountId: f.grant.accountId,
        workspaceId: f.workspaceId,
        sessionId: member.id,
        subjectId: f.grant.subjectId,
        actor: { type: "human", subjectId: f.grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "child work still running",
        resources: [],
        reasoningEffortFallback: "medium",
        source: "user",
      }),
    );
    const running = await claimSessionWorkForAttempt(client.db, f.workspaceId, {
      sessionId: member.id,
      workflowId: `session-${member.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(running).toMatchObject({ action: "claimed" });
    expect(await readPublicSandboxRecovery(client.db, recoveryScope)).toMatchObject({
      status: "blocked",
      reason: "shared_sandbox_member_active",
    });
    await expect(f.retry()).rejects.toMatchObject({ code: "RETRY_SANDBOX_RECOVERY_REQUIRED" });
    if (running.action !== "claimed") throw new Error("member not claimed");
    await applySessionTurnSettlement(client.db, f.workspaceId, {
      sessionId: member.id,
      turnId: running.turn.id,
      triggerEventId: running.turn.triggerEventId,
      attemptId: running.turn.activeAttemptId!,
      turnStatus: "failed",
      sessionStatus: "failed",
      activeTurnId: null,
      events: [
        { type: "turn.failed", payload: { error: "sandbox lost" } },
        { type: "session.status.changed", payload: { status: "failed" } },
      ],
    });
    expect(await readPublicSandboxRecovery(client.db, recoveryScope)).toMatchObject({
      status: "eligible",
      automaticAvailable: true,
      automaticLane: "fresh_workspace",
      checkpoint: null,
    });
    expect((await f.retry()).outcome).toBe("accepted");
  });

  test("a call stranded by an older terminal turn does not block Retry; one in the retried turn does", async () => {
    const f = await fixture();
    const strand = async (turnId: string) => {
      const [attempt] = await shared.admin<{ id: string }[]>`
        select id from session_turn_attempts where turn_id = ${turnId} order by updated_at desc limit 1`;
      await shared.admin`insert into session_pending_tool_calls (account_id, workspace_id, session_id,
          turn_id, execution_generation, attempt_id, call_id, call_type, call_item, call_item_codec_version)
        values (${f.grant.accountId}, ${f.workspaceId}, ${f.session.id}, ${turnId}, 1, ${attempt!.id},
          ${`stranded-${turnId}`}, 'function_call',
          ${shared.admin.json({ type: "function_call", name: "exec_command", callId: "stranded", arguments: "{}" })}, 1)`;
    };
    await strand(f.turnId);
    // Reopening the very turn could replay that call.
    await expect(f.retry()).rejects.toMatchObject({ code: "RETRY_EXECUTION_UNRESOLVED" });
    // A later turn fails for an unrelated reason; the older stranded call can
    // never be resumed by reopening it.
    await f.scope((db) =>
      submitHumanPromptInTransaction(db, {
        accountId: f.grant.accountId,
        workspaceId: f.workspaceId,
        sessionId: f.session.id,
        subjectId: f.grant.subjectId,
        actor: { type: "human", subjectId: f.grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "A newer request",
        resources: [],
        reasoningEffortFallback: "medium",
        source: "user",
      }),
    );
    const claimed = await f.claim();
    if (claimed.action !== "claimed") throw new Error("second turn not claimed");
    await applySessionTurnSettlement(client.db, f.workspaceId, {
      sessionId: f.session.id,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId: claimed.turn.activeAttemptId!,
      turnStatus: "failed",
      sessionStatus: "failed",
      activeTurnId: null,
      events: [
        { type: "turn.failed", payload: { error: "provider failure" } },
        { type: "session.status.changed", payload: { status: "failed" } },
      ],
    });
    const latest = (await listSessionEvents(client.db, f.workspaceId, f.session.id))
      .filter((event) => event.type === "turn.failed")
      .at(-1)!;
    expect(latest.turnId).toBe(claimed.turn.id);
    expect(
      (await f.retry({ failureEventId: latest.id, clientEventId: crypto.randomUUID() })).outcome,
    ).toBe("accepted");
  });

  // Every core waiter's breaker shares the same turn state: a SuperGrok core
  // or Claude core turn's exhaustion is replenished exactly as a Codex one.
  test.each([
    "codex_capacity_recovery_exhausted",
    "xai_capacity_recovery_exhausted",
    "claude_capacity_recovery_exhausted",
  ])(
    "exact capacity Retry (%s) replenishes only its budget and suppression; Pause, stale failure and replay cannot reset it",
    async (exhaustedCode) => {
      const f = await fixture(false, "completed", exhaustedCode);
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
    },
  );

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
    // Permanent, not settling: a distinct code lets the person act on it.
    await expect(f.retry()).rejects.toMatchObject({ code: "RETRY_TOOL_OUTCOME_UNKNOWN" });
    expect((await getSession(client.db, f.workspaceId, f.session.id))!.status).toBe("failed");
  });

  test("a call proven not started settles replay safe and does not block Retry", async () => {
    const f = await fixture(false, "not_started");
    const output = (await listSessionEvents(client.db, f.workspaceId, f.session.id)).find(
      (event) => event.type === "agent.toolCall.output",
    )!;
    expect(output.payload).toMatchObject({
      id: f.toolCallId,
      output: {
        isError: true,
        content: [{ type: "text", text: NOT_STARTED_TOOL_CALL_EVENT_TEXT }],
      },
      recovery: { interrupted: true, outcome: "not_started", reason: "turn_failed" },
    });
    const history = await getActiveSessionHistoryItems(client.db, f.workspaceId, f.session.id);
    expect(
      history.flatMap(({ item }) => (item.callId === f.toolCallId ? [item] : [])),
    ).toMatchObject([{ type: "function_call" }, { type: "function_call_result" }]);
    expect((await f.retry()).outcome).toBe("accepted");
  });

  test("tool-call command-start recovery is bounded by tool progress and stays retryable when exhausted", async () => {
    const f = await fixture(true);
    const progress = () =>
      readSessionTurnToolProgressRecoveryState(client.db, f.workspaceId, {
        sessionId: f.session.id,
        turnId: f.turnId,
      });
    const runExecThatNeverStarts = async (providerRecoveryCount?: number) => {
      const claimed = await f.claim();
      if (claimed.action !== "claimed") throw new Error("not claimed");
      const callId = crypto.randomUUID();
      const identity = {
        accountId: f.grant.accountId,
        workspaceId: f.workspaceId,
        sessionId: f.session.id,
        turnId: claimed.turn.id,
        executionGeneration: claimed.turn.executionGeneration,
        attemptId: claimed.turn.activeAttemptId!,
        callId,
      };
      await registerPendingSessionToolCall(client.db, {
        ...identity,
        callType: "function_call",
        callItem: { type: "function_call", callId, name: "exec_command", arguments: "{}" },
      });
      expect((await progress()).toolCallInFlight).toBe(true);
      if (providerRecoveryCount === undefined) return { claimed, identity };
      const recovery = await requestSessionTurnRecovery(client.db, f.workspaceId, {
        sessionId: f.session.id,
        turnId: claimed.turn.id,
        triggerEventId: claimed.turn.triggerEventId,
        attemptId: claimed.turn.activeAttemptId!,
        reason: "sandbox_command_start_unavailable",
        providerRecoveryCount,
        notStartedToolCallIds: [callId],
        detail: { code: "sandbox_command_start_unavailable", retryable: true },
      });
      expect(recovery.action).toBe("recovering");
      expect(recovery.events.map((event) => event.type)).toEqual([
        "agent.toolCall.output",
        "turn.recovery.requested",
        "session.status.changed",
      ]);
      expect(recovery.events[0]!.payload).toMatchObject({
        id: callId,
        recovery: { outcome: "not_started", reason: "sandbox_command_start_unavailable" },
      });
      expect(recovery.events[1]!.payload).toMatchObject({
        reason: "sandbox_command_start_unavailable",
        toolCallInterrupted: true,
      });
      return { claimed, identity };
    };
    // A never-claimed preclaim failure has no started turn; re-accept a turn
    // by retrying it, then run the tool sequence on its attempts.
    expect((await f.retry()).outcome).toBe("accepted");
    expect(await progress()).toEqual({ toolCallInFlight: false, toolInterruptedRecoveries: 0 });
    await runExecThatNeverStarts(1);
    expect(await progress()).toEqual({ toolCallInFlight: false, toolInterruptedRecoveries: 1 });
    await runExecThatNeverStarts(2);
    expect((await progress()).toolInterruptedRecoveries).toBe(2);

    // A recorded tool result is progress and restarts the bound.
    const progressed = await runExecThatNeverStarts();
    const appended = await appendSessionEventsForTurnAttempt(
      client.db,
      f.workspaceId,
      f.session.id,
      progressed.claimed.turn.id,
      progressed.claimed.turn.executionGeneration,
      progressed.claimed.turn.activeAttemptId!,
      [
        {
          type: "agent.toolCall.output",
          payload: { id: progressed.identity.callId, output: "ok" },
        },
      ],
    );
    expect(appended.accepted).toBe(true);
    expect((await progress()).toolInterruptedRecoveries).toBe(0);
    await recordPendingSessionToolCallResult(client.db, {
      ...progressed.identity,
      resultItem: {
        type: "function_call_result",
        callId: progressed.identity.callId,
        name: "exec_command",
        output: { type: "text", text: "ok" },
      },
    });
    const recovered = await requestSessionTurnRecovery(client.db, f.workspaceId, {
      sessionId: f.session.id,
      turnId: progressed.claimed.turn.id,
      triggerEventId: progressed.claimed.turn.triggerEventId,
      attemptId: progressed.claimed.turn.activeAttemptId!,
      reason: "provider_unavailable",
      providerRecoveryCount: 1,
    });
    expect(recovered.action).toBe("recovering");
    // No call was interrupted, so this recovery does not count toward the bound.
    expect(recovered.events.at(-2)!.payload).not.toHaveProperty("toolCallInterrupted");
    expect((await progress()).toolInterruptedRecoveries).toBe(0);

    // Exhaustion: the turn fails with the not-started call, and Retry works.
    const { claimed, identity } = await runExecThatNeverStarts();
    const settled = await applySessionTurnSettlement(client.db, f.workspaceId, {
      sessionId: f.session.id,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId: claimed.turn.activeAttemptId!,
      turnStatus: "failed",
      sessionStatus: "failed",
      activeTurnId: null,
      notStartedToolCallIds: [identity.callId],
      events: [
        {
          type: "turn.failed",
          payload: {
            error: "The sandbox isn't ready yet.",
            code: "sandbox_command_start_unavailable",
            retryable: false,
            recoveryExhausted: true,
          },
        },
        { type: "session.status.changed", payload: { status: "failed" } },
      ],
    });
    expect(settled.action).toBe("settled");
    const failure = (await listSessionEvents(client.db, f.workspaceId, f.session.id))
      .filter((event) => event.type === "turn.failed")
      .at(-1)!;
    expect(
      (await f.retry({ clientEventId: crypto.randomUUID(), failureEventId: failure.id })).outcome,
    ).toBe("accepted");
    // Human Retry restarts the automatic bound.
    expect((await progress()).toolInterruptedRecoveries).toBe(0);
  });
});
