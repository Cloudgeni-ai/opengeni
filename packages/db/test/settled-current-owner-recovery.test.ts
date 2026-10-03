import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { TurnExecutionPolicyV1, TURN_EXECUTION_POLICY_METADATA_KEY } from "@opengeni/contracts";
import { createSessionStateActivities } from "../../../apps/worker/src/activities/session-state";
import {
  bootstrapWorkspace,
  claimPendingSessionWorkflowWakes,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionTurn,
  installOrReadTurnExecutionPolicyForAttempt,
  listSessionEvents,
  markSessionWorkflowWakeDelivered,
  mutateSessionControlInTransaction,
  mutateWorkspaceControlInTransaction,
  peekSessionWork,
  reconcileSettledSessionAttempt,
  recoverSessionDispatch,
  submitHumanPromptInTransaction,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectSessionActivityRls,
  type ReconcileSettledSessionAttemptInput,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("settled-current-owner-recovery");
  if (!acquired) throw new Error("Restricted PostgreSQL fixture unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(child = false) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "settled-owner-test",
    accountExternalId: suffix,
    accountName: "Owner test",
    workspaceExternalSource: "settled-owner-test",
    workspaceExternalId: suffix,
    workspaceName: "Owner test",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const create = async (parentSessionId?: string) =>
    await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
      ...(parentSessionId ? { parentSessionId } : {}),
    });
  const parent = await create();
  const session = child ? await create(parent.id) : parent;
  await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, grant.subjectId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "continue only the exact accepted turn",
        resources: [],
        reasoningEffortFallback: "low",
        source: "user",
      }),
    ),
  );
  const proof: ReconcileSettledSessionAttemptInput = {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    turnId: "",
    attemptId: crypto.randomUUID(),
    executionGeneration: 1,
    temporalWorkflowId: `session-${session.id}`,
    temporalWorkflowRunId: crypto.randomUUID(),
    temporalActivityId: crypto.randomUUID(),
    activitySettled: true,
    maxRedispatches: 3,
  };
  const claim = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: proof.temporalWorkflowId,
    workflowRunId: proof.temporalWorkflowRunId,
    dispatchId: proof.temporalActivityId,
    attemptId: proof.attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("Missing exact original owner");
  proof.turnId = claim.turn.id;
  proof.executionGeneration = claim.turn.executionGeneration;
  await installOrReadTurnExecutionPolicyForAttempt(client.db, {
    ...proof,
    policyForAbsent: TurnExecutionPolicyV1.parse({
      schemaVersion: 1,
      productModelId: "scripted-model",
      requestedModelId: null,
      modelSource: "deployment",
      reasoningEffort: "low",
      reasoningSource: "deployment",
      providerId: "scripted-provider",
      upstreamModelId: "scripted-upstream",
      wireApi: "responses",
      credentialSource: { kind: "deployment", mechanism: "api_key" },
      billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
      definitionVersion: `sha256:${"a".repeat(64)}`,
    }),
  });
  return { grant, parent, session, proof, turn: claim.turn };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function ownerRow(ctx: Fixture) {
  const [row] = await shared.admin`
    select state, outcome, quiesced_at from session_turn_attempts
    where account_id = ${ctx.proof.accountId} and workspace_id = ${ctx.proof.workspaceId}
      and session_id = ${ctx.proof.sessionId} and id = ${ctx.proof.attemptId}
  `;
  return row!;
}
async function wakeRow(ctx: Fixture) {
  const [row] = await shared.admin`
    select wake_revision, delivered_revision from session_workflow_wake_outbox
    where workspace_id = ${ctx.proof.workspaceId} and session_id = ${ctx.proof.sessionId}
  `;
  return {
    wake_revision: Number(row!.wake_revision),
    delivered_revision: Number(row!.delivered_revision),
  };
}
async function authorityRow(ctx: Fixture) {
  const [row] = await shared.admin`
    select initiating_human_subject_id, trigger_event_id, goal_snapshot, metadata
    from session_turns where workspace_id = ${ctx.proof.workspaceId} and id = ${ctx.proof.turnId}
  `;
  return row!;
}
async function successor(ctx: Fixture) {
  return await claimSessionWorkForAttempt(client.db, ctx.proof.workspaceId, {
    sessionId: ctx.session.id,
    workflowId: ctx.proof.temporalWorkflowId,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
}
async function writer(ctx: Fixture, kind: "unknown" | "retained" | "process-child") {
  const leaseId = crypto.randomUUID(),
    admissionId = crypto.randomUUID(),
    processId = crypto.randomUUID();
  const base = {
    account_id: ctx.proof.accountId,
    workspace_id: ctx.proof.workspaceId,
    session_id: ctx.session.id,
    lease_id: leaseId,
    sandbox_group_id: ctx.session.sandboxGroupId,
    lease_epoch: 0,
    provider_backend: "modal",
    provider_instance_id: "sb-owner-fixture",
    route_kind: "home",
    route_epoch: 0,
  };
  await shared.admin`insert into sandbox_leases ${shared.admin({
    id: leaseId,
    account_id: ctx.proof.accountId,
    workspace_id: ctx.proof.workspaceId,
    sandbox_group_id: ctx.session.sandboxGroupId,
    backend: "modal",
    instance_id: "sb-owner-fixture",
    expires_at: new Date(Date.now() + 60_000),
  })}`;
  await shared.admin`insert into sandbox_workspace_mutation_admissions ${shared.admin({
    ...base,
    id: admissionId,
    actor_kind: "turn",
    actor_id: ctx.proof.attemptId,
    turn_id: ctx.turn.id,
    attempt_id: ctx.proof.attemptId,
    execution_generation: ctx.proof.executionGeneration,
    holder_kind: "turn",
    holder_id: `turn:${ctx.turn.id}`,
    operation: "execCommand",
    workspace_generation: 1,
    provider_outcome: kind === "unknown" ? null : "retained",
  })}`;
  if (kind !== "unknown") {
    await shared.admin`insert into sandbox_lease_holders ${shared.admin({
      account_id: ctx.proof.accountId,
      workspace_id: ctx.proof.workspaceId,
      lease_id: leaseId,
      kind: "process",
      holder_id: `process:${processId}`,
      subject_id: ctx.session.id,
    })}`;
    await shared.admin`insert into sandbox_retained_processes ${shared.admin({
      ...base,
      id: processId,
      parent_admission_id: admissionId,
      holder_id: `process:${processId}`,
      owner_actor_kind: "turn",
      owner_actor_id: ctx.proof.attemptId,
      owner_turn_id: ctx.turn.id,
      owner_attempt_id: ctx.proof.attemptId,
      owner_execution_generation: ctx.proof.executionGeneration,
      provider_session_id: 1,
    })}`;
    if (kind === "process-child")
      await shared.admin`insert into sandbox_workspace_mutation_admissions ${shared.admin({
        ...base,
        id: crypto.randomUUID(),
        actor_kind: "process",
        actor_id: processId,
        holder_kind: "process",
        holder_id: `process:${processId}`,
        operation: "writeFile",
        workspace_generation: 2,
        provider_outcome: null,
      })}`;
  }
}

describe("exact settled-current-owner reconciliation", () => {
  test("concurrent settled proofs close one exact owner, retain wake debt and claim one same-turn successor", async () => {
    const ctx = await fixture();
    const before = await authorityRow(ctx);
    const [oldWake] = (await claimPendingSessionWorkflowWakes(client.db, 100)).filter(
      (wake) => wake.sessionId === ctx.session.id,
    );
    if (!oldWake) throw new Error("Missing prior wake debt");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reconcileSettledSessionAttempt(client.db, ctx.proof)),
    );
    expect(results.filter((result) => result.action === "recovering")).toHaveLength(1);
    expect(results.filter((result) => result.action === "stale")).toHaveLength(7);
    expect(await ownerRow(ctx)).toMatchObject({
      state: "closed",
      outcome: "lease_lost_recoverable",
    });
    expect((await ownerRow(ctx)).quiesced_at).not.toBeNull();
    expect(await peekSessionWork(client.db, ctx.proof.workspaceId, ctx.session.id)).toEqual({
      kind: "runnable",
    });
    await markSessionWorkflowWakeDelivered(client.db, oldWake);
    expect((await wakeRow(ctx)).wake_revision).toBeGreaterThan(
      (await wakeRow(ctx)).delivered_revision,
    );
    const claims = await Promise.all(Array.from({ length: 8 }, () => successor(ctx)));
    const claimed = claims.filter((result) => result.action === "claimed");
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      action: "claimed",
      turn: {
        id: ctx.turn.id,
        triggerEventId: ctx.turn.triggerEventId,
        executionGeneration: ctx.proof.executionGeneration + 1,
      },
    });
    const after = await authorityRow(ctx);
    expect(after.initiating_human_subject_id).toBe(before.initiating_human_subject_id);
    expect(after.trigger_event_id).toBe(before.trigger_event_id);
    expect(after.goal_snapshot).toEqual(before.goal_snapshot);
    expect(after.metadata[TURN_EXECUTION_POLICY_METADATA_KEY]).toEqual(
      before.metadata[TURN_EXECUTION_POLICY_METADATA_KEY],
    );
    expect((await wakeRow(ctx)).wake_revision).toBeGreaterThan(
      (await wakeRow(ctx)).delivered_revision,
    );
    expect(await reconcileSettledSessionAttempt(client.db, ctx.proof)).toMatchObject({
      action: "stale",
    });
    const events = await listSessionEvents(client.db, ctx.proof.workspaceId, ctx.session.id);
    expect(events.filter((event) => event.type === "turn.recovery.requested")).toHaveLength(1);
    expect(
      events.filter(
        (event) => event.clientEventId === `opengeni:attempt-quiesced:${ctx.proof.attemptId}`,
      ),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) => event.type === "turn.failed" || event.type === "turn.dispatch.expired",
      ),
    ).toBe(false);
    expect(events.find((event) => event.type === "turn.recovery.requested")?.payload).toMatchObject(
      { reason: "settled_activity" },
    );
  }, 30_000);

  test.each([
    "accountId",
    "workspaceId",
    "sessionId",
    "turnId",
    "attemptId",
    "executionGeneration",
    "temporalWorkflowId",
    "temporalWorkflowRunId",
    "temporalActivityId",
  ] as const)(
    "mismatched %s is never proof authority",
    async (field) => {
      const ctx = await fixture();
      const before = await wakeRow(ctx);
      const other = field === "workspaceId" || field === "accountId" ? await fixture() : null;
      const proof = {
        ...ctx.proof,
        [field]:
          field === "executionGeneration"
            ? ctx.proof.executionGeneration + 1
            : field === "workspaceId"
              ? other!.proof.workspaceId
              : field === "accountId"
                ? other!.proof.accountId
                : field === "sessionId"
                  ? (
                      await createSession(client.db, {
                        accountId: ctx.proof.accountId,
                        workspaceId: ctx.proof.workspaceId,
                        initialMessage: "other",
                        resources: [],
                        metadata: {},
                        model: "scripted-model",
                        reasoningEffort: "low",
                        latencyMode: "standard",
                        sandboxBackend: "none",
                      })
                    ).id
                  : crypto.randomUUID(),
      };
      expect(await reconcileSettledSessionAttempt(client.db, proof)).toMatchObject({
        action: "stale",
      });
      expect(await ownerRow(ctx)).toMatchObject({ state: "claimed", quiesced_at: null });
      expect(await wakeRow(ctx)).toEqual(before);
    },
    30_000,
  );

  test.each([
    "sandboxSetupOutcomeUnknown",
    "sandboxSetupRecoveryExhausted",
    "sandboxLifecycleWait",
  ])("%s cannot be cleared by unrelated terminal activity proof", async (marker) => {
    const ctx = await fixture();
    await shared.admin`update session_turns set metadata = metadata || ${shared.admin.json({ [marker]: { unknown: true } })}
        where workspace_id = ${ctx.proof.workspaceId} and id = ${ctx.turn.id}`;
    expect(await reconcileSettledSessionAttempt(client.db, ctx.proof)).toMatchObject({
      action: "stale",
    });
    expect(await ownerRow(ctx)).toMatchObject({ state: "claimed", quiesced_at: null });
  });

  test.each(["writer", "Pause", "replacement"])(
    "%s committed during authenticated inspection wins under-lock revalidation",
    async (race) => {
      const ctx = await fixture();
      const activities = createSessionStateActivities(
        async () =>
          ({
            db: client.db,
            bus: {},
            observability: {},
            settings: {},
            inspectSessionAttemptActivity: async () => {
              if (race === "writer") await writer(ctx, "unknown");
              else if (race === "Pause")
                await withWorkspaceSessionActivityRls(client.db, ctx.proof.workspaceId, (db) =>
                  db.transaction((tx) =>
                    mutateWorkspaceControlInTransaction(tx as unknown as typeof db, {
                      accountId: ctx.proof.accountId,
                      workspaceId: ctx.proof.workspaceId,
                      actor: { type: "human", subjectId: ctx.grant.subjectId },
                      operationKey: crypto.randomUUID(),
                      action: "pause",
                      reason: "test",
                    }),
                  ),
                );
              else {
                expect(await reconcileSettledSessionAttempt(client.db, ctx.proof)).toMatchObject({
                  action: "recovering",
                });
                expect(await successor(ctx)).toMatchObject({ action: "claimed" });
              }
              return "settled";
            },
          }) as any,
      );
      expect(
        await activities.reconcileSettledSessionAttempt({
          accountId: ctx.proof.accountId,
          workspaceId: ctx.proof.workspaceId,
          sessionId: ctx.session.id,
          turnId: ctx.turn.id,
          attemptId: ctx.proof.attemptId,
          executionGeneration: ctx.proof.executionGeneration,
          workflowId: ctx.proof.temporalWorkflowId,
          workflowRunId: ctx.proof.temporalWorkflowRunId,
          activityId: ctx.proof.temporalActivityId,
        }),
      ).toEqual({ action: race === "writer" ? "pending" : "stale" });
      expect(await getSessionTurn(client.db, ctx.proof.workspaceId, ctx.turn.id)).toMatchObject({
        status: "running",
        executionGeneration: ctx.proof.executionGeneration + (race === "replacement" ? 1 : 0),
      });
    },
    30_000,
  );

  test("unsettled/unknown activity is a pending no-op", async () => {
    const ctx = await fixture();
    expect(
      await reconcileSettledSessionAttempt(client.db, { ...ctx.proof, activitySettled: false }),
    ).toEqual({ action: "pending", events: [] });
    expect(await ownerRow(ctx)).toMatchObject({ state: "claimed", quiesced_at: null });
  });

  test.each(["unknown", "retained", "process-child"] as const)(
    "settled activity cannot revoke %s physical/inference writers",
    async (kind) => {
      const ctx = await fixture();
      await writer(ctx, kind);
      const before = await wakeRow(ctx);
      expect(await reconcileSettledSessionAttempt(client.db, ctx.proof)).toEqual({
        action: "pending",
        events: [],
      });
      expect(await ownerRow(ctx)).toMatchObject({ state: "claimed", quiesced_at: null });
      expect(await wakeRow(ctx)).toEqual(before);
      expect(
        (await getSessionTurn(client.db, ctx.proof.workspaceId, ctx.turn.id))?.activeAttemptId,
      ).toBe(ctx.proof.attemptId);
    },
  );

  test.each(["workspace", "session", "ancestor"] as const)(
    "authoritative %s Pause wins over settled proof",
    async (kind) => {
      const ctx = await fixture(kind === "ancestor");
      await withWorkspaceSessionActivityRls(client.db, ctx.proof.workspaceId, (db) =>
        db.transaction((tx) =>
          (async () => {
            if (kind === "workspace")
              await mutateWorkspaceControlInTransaction(tx as unknown as typeof db, {
                accountId: ctx.proof.accountId,
                workspaceId: ctx.proof.workspaceId,
                actor: { type: "human", subjectId: ctx.grant.subjectId },
                operationKey: crypto.randomUUID(),
                action: "pause",
                reason: "test",
              });
            else
              await mutateSessionControlInTransaction(tx as unknown as typeof db, {
                accountId: ctx.proof.accountId,
                workspaceId: ctx.proof.workspaceId,
                sessionId: kind === "ancestor" ? ctx.parent.id : ctx.session.id,
                actor: { type: "human", subjectId: ctx.grant.subjectId },
                operationKey: crypto.randomUUID(),
                action: "pause",
                reason: "test",
              });
          })(),
        ),
      );
      const before = await wakeRow(ctx);
      expect(await reconcileSettledSessionAttempt(client.db, ctx.proof)).toMatchObject({
        action: "stale",
      });
      expect(await ownerRow(ctx)).toMatchObject({ state: "claimed", quiesced_at: null });
      expect(await wakeRow(ctx)).toEqual(before);
    },
  );

  test("settled owner recovery consumes the existing bounded crash budget without replaying provider work", async () => {
    const ctx = await fixture();
    for (let count = 1; count <= 4; count += 1) {
      const result = await reconcileSettledSessionAttempt(client.db, ctx.proof);
      expect(result).toMatchObject({
        action: count === 4 ? "exceeded" : "recovering",
        turnId: ctx.turn.id,
        redispatches: Math.min(count, 3),
      });
      if (count === 4) break;
      const claim = await successor(ctx);
      if (claim.action !== "claimed") throw new Error("Missing bounded successor");
      const [attempt] =
        await shared.admin`select temporal_workflow_run_id, temporal_activity_id from session_turn_attempts where id=${claim.turn.activeAttemptId}`;
      ctx.proof = {
        ...ctx.proof,
        attemptId: claim.turn.activeAttemptId!,
        executionGeneration: claim.turn.executionGeneration,
        temporalWorkflowRunId: attempt!.temporal_workflow_run_id,
        temporalActivityId: attempt!.temporal_activity_id,
      };
    }
    expect(await getSessionTurn(client.db, ctx.proof.workspaceId, ctx.turn.id)).toMatchObject({
      status: "failed",
      activeAttemptId: null,
    });
    expect(
      (await listSessionEvents(client.db, ctx.proof.workspaceId, ctx.session.id)).filter(
        (event) => event.type === "turn.failed",
      ),
    ).toHaveLength(1);
  }, 30_000);

  test("legacy exact timeout recovery also atomically creates recovery wake debt", async () => {
    const ctx = await fixture();
    const before = await wakeRow(ctx);
    await recoverSessionDispatch(client.db, ctx.proof.workspaceId, {
      sessionId: ctx.session.id,
      attemptId: ctx.proof.attemptId,
      timeoutType: "HEARTBEAT",
      maxRedispatches: 3,
    });
    expect((await wakeRow(ctx)).wake_revision).toBeGreaterThan(before.wake_revision);
    // Transport timeout did not prove physical quiescence; no new receipt.
    expect((await ownerRow(ctx)).quiesced_at).toBeNull();
  });
});
