import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "../src/schema";
import {
  armCodexCapacityWait,
  claimSessionWorkForAttempt,
  codexCapacityRefreshBackoffMs,
  createDb,
  encryptEnvironmentValue,
  enqueueSessionTurn,
  ensureCodexRotationSettings,
  getCodexCapacityWaitForSession,
  listPendingCodexCapacityWakeTargets,
  reconcileCodexCapacityWait,
  registerPendingSessionToolCall,
  setSessionCodexPin,
  updateCodexRotationSettings,
  upsertCodexSubscriptionCredential,
  withCodexCapacityMutation,
  type CodexCapacityAvailabilityDecision,
  type CodexCapacitySelectionContext,
  type CodexLeaseAccountStatus,
  type Database,
  type DbClient,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let monitor: postgres.Sql;
let clientA: DbClient;
let clientB: DbClient;
let claimClient: DbClient;
let dbA: Database;
let dbB: Database;
let claimDb: Database;

const settings = testSettings({
  codexSubscriptionEnabled: true,
  codexCredentialLeasingEnabled: true,
  environmentsEncryptionKey: Buffer.alloc(32, 17).toString("base64"),
});

type Workspace = { accountId: string; workspaceId: string };
type CapacityScenario = Workspace & {
  sessionId: string;
  turnId: string;
  attemptId: string;
  goalId: string;
  workflowId: string;
};

async function claimTestTurn(
  db: Database,
  workspaceId: string,
  sessionId: string,
  workflowId: string,
) {
  const result = await claimSessionWorkForAttempt(db, workspaceId, {
    sessionId,
    workflowId,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  return result.action === "claimed" ? result.turn : null;
}

async function freshWorkspace(): Promise<Workspace> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('codex capacity account') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'codex capacity workspace') returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function connectCredential(ws: Workspace, allocatorEnabled = false): Promise<string> {
  const key = Buffer.from(settings.environmentsEncryptionKey!, "base64");
  const credential = await upsertCodexSubscriptionCredential(dbA, {
    accountId: ws.accountId,
    workspaceId: ws.workspaceId,
    credentialEncrypted: encryptEnvironmentValue(
      key,
      JSON.stringify({ access_token: "test", refresh_token: "test", id_token: "test" }),
    ),
    chatgptAccountId: crypto.randomUUID(),
    scopes: null,
    planType: "pro",
    isFedramp: false,
    expiresAt: new Date(Date.now() + 60_000),
    lastRefreshAt: new Date(),
  });
  await ensureCodexRotationSettings(dbA, ws.accountId, ws.workspaceId);
  await updateCodexRotationSettings(dbA, ws.workspaceId, { rotationEnabled: true });
  await admin`
    update codex_subscription_credentials
    set allocator_enabled = ${allocatorEnabled}
    where workspace_id = ${ws.workspaceId} and id = ${credential.id}`;
  return credential.id;
}

async function seedScenario(ws: Workspace): Promise<CapacityScenario> {
  const sessionId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const goalId = crypto.randomUUID();
  const workflowId = `session-${sessionId}`;
  await admin`
    insert into sessions (
      id, account_id, workspace_id, initial_message, model,
      sandbox_backend, sandbox_group_id, status, temporal_workflow_id
    ) values (
      ${sessionId}, ${ws.accountId}, ${ws.workspaceId}, 'capacity test',
      'codex/gpt-5.6-sol', 'modal', ${sessionId}, 'running', ${workflowId}
    )`;
  await admin.begin(async (tx) => {
    await tx`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, position, prompt, model,
        reasoning_effort, sandbox_backend, resources, tools, metadata,
        execution_generation, active_attempt_id
      ) values (
        ${turnId}, ${ws.accountId}, ${ws.workspaceId}, ${sessionId}, ${crypto.randomUUID()},
        ${workflowId}, 'running', 1, 'capacity test', 'codex/gpt-5.6-sol',
        'xhigh', 'modal', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
        1, ${attemptId}
      )`;
    await tx`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id,
        execution_generation, state, temporal_workflow_id,
        temporal_workflow_run_id, temporal_activity_id, verified_control_revision
      ) values (
        ${attemptId}, ${ws.accountId}, ${ws.workspaceId}, ${sessionId}, ${turnId},
        1, 'running', ${workflowId}, ${`run-${attemptId}`}, ${`capacity-${attemptId}`}, 0
      )`;
    await tx`update sessions set active_turn_id = ${turnId} where id = ${sessionId}`;
  });
  await admin`
    insert into session_goals (
      id, account_id, workspace_id, session_id, status, text,
      success_criteria, version, max_auto_continuations
    ) values (
      ${goalId}, ${ws.accountId}, ${ws.workspaceId}, ${sessionId}, 'active',
      'finish the capacity test', 'resume exactly once', 1, 20
    )`;
  return { ...ws, sessionId, turnId, attemptId, goalId, workflowId };
}

async function arm(scenario: CapacityScenario, resetAt: Date | null = null) {
  return await armCodexCapacityWait(dbA, {
    accountId: scenario.accountId,
    workspaceId: scenario.workspaceId,
    sessionId: scenario.sessionId,
    turnId: scenario.turnId,
    attemptId: scenario.attemptId,
    workflowId: scenario.workflowId,
    goalId: scenario.goalId,
    goalVersion: 1,
    earliestResetAt: resetAt,
    resetKind: resetAt ? "authoritative" : "bounded_refresh",
    failurePayload: {
      error: "all connected Codex subscriptions are unavailable",
      code: "codex_usage_limit_reached",
    },
  });
}

async function waitForAppSessionLockWait(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await monitor<{ waiting: number }[]>`
      select count(*)::int as waiting
      from pg_stat_activity
      where datname = current_database()
        and usename = 'opengeni_app'
        and wait_event_type = 'Lock'
        and query ilike '%sessions%'`;
    if ((row?.waiting ?? 0) > 0) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("claim did not block on the session row");
}

function availableDecision(credentialId: string): CodexCapacityAvailabilityDecision {
  return { kind: "available", credentialId };
}

const unavailableDecision = (): CodexCapacityAvailabilityDecision => ({
  kind: "unavailable",
  earliestResetAt: null,
  resetKind: "bounded_refresh",
});

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("codex-capacity-waiters");
  if (!shared) {
    available = false;
    console.warn("[codex-capacity-waiters] postgres unavailable, skipping");
    return;
  }
  admin = shared.admin;
  monitor = postgres(shared.adminUrl, { max: 1 });
  clientA = createDb(shared.appUrl, { max: 12 });
  clientB = createDb(shared.appUrl, { max: 12 });
  claimClient = createDb(shared.appUrl, { max: 1 });
  dbA = clientA.db;
  dbB = clientB.db;
  claimDb = claimClient.db;
}, 180_000);

afterAll(async () => {
  await claimClient?.close().catch(() => undefined);
  await clientA?.close().catch(() => undefined);
  await clientB?.close().catch(() => undefined);
  await monitor?.end().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("credential allocator durable Codex capacity waits", () => {
  test("bounded unknown-reset backoff is deterministic and capped", () => {
    expect(codexCapacityRefreshBackoffMs(-1)).toBe(60_000);
    expect(codexCapacityRefreshBackoffMs(0)).toBe(60_000);
    expect(codexCapacityRefreshBackoffMs(1)).toBe(120_000);
    expect(codexCapacityRefreshBackoffMs(4)).toBe(900_000);
    expect(codexCapacityRefreshBackoffMs(100)).toBe(900_000);
  });

  test("arm settles the turn/session/wait/events atomically and is idempotent", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    await connectCredential(ws, false);
    const scenario = await seedScenario(ws);
    await registerPendingSessionToolCall(dbA, {
      accountId: scenario.accountId,
      workspaceId: scenario.workspaceId,
      sessionId: scenario.sessionId,
      turnId: scenario.turnId,
      executionGeneration: 1,
      attemptId: scenario.attemptId,
      callId: "capacity-call",
      callType: "function_call",
      callItem: {
        type: "function_call",
        name: "external_mutation",
        callId: "capacity-call",
        status: "in_progress",
        arguments: "{}",
      },
    });
    const armed = await arm(scenario);
    expect(armed.action).toBe("waiting");
    if (armed.action !== "waiting") throw new Error("expected waiter");
    expect(armed.events.map((event) => event.type)).toEqual([
      "agent.toolCall.output",
      "turn.failed",
      "codex.capacity.waiting",
      "session.status.changed",
    ]);
    expect(armed.events.every((event) => event.turnAttemptId === scenario.attemptId)).toBe(true);
    expect(armed.waiter.observedWakeRevision).toBe(armed.waiter.wakeRevision);
    const [state] = await admin<
      {
        session_status: string;
        active_turn_id: string | null;
        turn_status: string;
        active_attempt_id: string | null;
        last_sequence: number;
      }[]
    >`
      select s.status as session_status, s.active_turn_id, t.status as turn_status,
             t.active_attempt_id, s.last_sequence
      from sessions s join session_turns t on t.id = ${scenario.turnId}
      where s.id = ${scenario.sessionId}`;
    expect(state).toEqual({
      session_status: "idle",
      active_turn_id: null,
      turn_status: "failed",
      active_attempt_id: null,
      last_sequence: 4,
    });
    const [closed] = await admin<{ pending: number; history: number }[]>`
      select
        (select count(*)::int from session_pending_tool_calls
         where turn_id = ${scenario.turnId}) as pending,
        (select count(*)::int from session_history_items
         where turn_id = ${scenario.turnId}) as history`;
    expect(closed).toEqual({ pending: 0, history: 2 });

    const duplicate = await arm(scenario);
    expect(duplicate.action).toBe("waiting");
    expect(duplicate.events).toHaveLength(0);
    const [eventCount] = await admin<{ count: number }[]>`
      select count(*)::int as count from session_events where session_id = ${scenario.sessionId}`;
    expect(eventCount?.count).toBe(4);
  });

  test("claim locks session before the pending internal update", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const credentialId = await connectCredential(ws, true);
    const scenario = await seedScenario(ws);
    const armed = await arm(scenario);
    if (armed.action !== "waiting") throw new Error("expected waiter");
    const resumed = await reconcileCodexCapacityWait(
      dbA,
      {
        accountId: scenario.accountId,
        workspaceId: scenario.workspaceId,
        sessionId: scenario.sessionId,
        waiterId: armed.waiter.id,
        generation: armed.waiter.generation,
      },
      () => availableDecision(credentialId),
    );
    if (resumed.action !== "resumed") throw new Error("expected resumed update");

    let claim: ReturnType<typeof claimTestTurn> | null = null;
    await admin.begin(async (lockTx) => {
      await lockTx`
        select id from sessions
        where workspace_id = ${scenario.workspaceId} and id = ${scenario.sessionId}
        for update`;
      claim = claimTestTurn(claimDb, scenario.workspaceId, scenario.sessionId, scenario.workflowId);
      await waitForAppSessionLockWait();

      // If claim took the pending update before waiting for the session, this
      // statement forms update -> session / session -> update and times out.
      // The canonical session-first claim leaves the update lockable.
      await lockTx`set local lock_timeout = '250ms'`;
      const locked = await lockTx<{ id: string }[]>`
        select id from session_system_updates
        where workspace_id = ${scenario.workspaceId} and id = ${resumed.update.id}
        for update`;
      expect(locked.map((row) => row.id)).toEqual([resumed.update.id]);
    });

    const claimed = await claim!;
    expect(claimed?.source).toBe("goal");
    const [delivered] = await admin<{ delivered_turn_id: string | null; state: string }[]>`
      select delivered_turn_id, state from session_system_updates
      where id = ${resumed.update.id}`;
    expect(delivered).toEqual({ delivered_turn_id: claimed?.id ?? null, state: "delivered" });
  });

  test("reactive arm is fenced by the live holder, generation, and worker redispatch", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const credentialId = await connectCredential(ws, true);
    const scenario = await seedScenario(ws);
    await admin`
      insert into codex_credential_leases (
        account_id, workspace_id, credential_id, turn_id,
        holder_id, generation, leased_until
      ) values (
        ${scenario.accountId}, ${scenario.workspaceId}, ${credentialId}, ${scenario.turnId},
        'current-holder', 4, now() + interval '5 minutes'
      )`;
    const input = {
      accountId: scenario.accountId,
      workspaceId: scenario.workspaceId,
      sessionId: scenario.sessionId,
      turnId: scenario.turnId,
      workflowId: scenario.workflowId,
      goalId: scenario.goalId,
      goalVersion: 1,
      earliestResetAt: null,
      resetKind: "bounded_refresh" as const,
      failurePayload: { code: "codex_usage_limit_reached" },
    };
    expect(
      (
        await armCodexCapacityWait(dbA, {
          ...input,
          attemptId: crypto.randomUUID(),
          leaseFence: { holderId: "current-holder", generation: 4 },
          expectedRedispatches: 0,
        })
      ).action,
    ).toBe("stale");
    expect(
      (
        await armCodexCapacityWait(dbA, {
          ...input,
          attemptId: scenario.attemptId,
          leaseFence: { holderId: "stale-holder", generation: 3 },
          expectedRedispatches: 0,
        })
      ).action,
    ).toBe("stale");
    expect(
      (
        await armCodexCapacityWait(dbA, {
          ...input,
          attemptId: scenario.attemptId,
          leaseFence: { holderId: "current-holder", generation: 4 },
          expectedRedispatches: 1,
        })
      ).action,
    ).toBe("stale");
    const armed = await armCodexCapacityWait(dbA, {
      ...input,
      attemptId: scenario.attemptId,
      leaseFence: { holderId: "current-holder", generation: 4 },
      expectedRedispatches: 0,
    });
    expect(armed.action).toBe("waiting");
    const [lease] = await admin<{ count: number }[]>`
      select count(*)::int as count from codex_credential_leases
      where workspace_id = ${scenario.workspaceId} and turn_id = ${scenario.turnId}`;
    expect(lease?.count).toBe(0);
  });

  test("unknown reset stays idle without churn and advances bounded refresh state", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    await connectCredential(ws, false);
    const scenario = await seedScenario(ws);
    const armed = await arm(scenario);
    if (armed.action !== "waiting") throw new Error("expected waiter");
    const reconciled = await reconcileCodexCapacityWait(
      dbA,
      {
        accountId: scenario.accountId,
        workspaceId: scenario.workspaceId,
        sessionId: scenario.sessionId,
        waiterId: armed.waiter.id,
        generation: armed.waiter.generation,
        now: new Date(armed.waiter.nextCheckAt.getTime() + 1),
      },
      unavailableDecision,
    );
    expect(reconciled.action).toBe("waiting");
    if (reconciled.action !== "waiting") throw new Error("expected waiter");
    expect(reconciled.waiter.refreshAttempt).toBe(1);
    expect(reconciled.waiter.nextCheckAt.getTime()).toBeGreaterThan(
      armed.waiter.nextCheckAt.getTime(),
    );
    const [turns] = await admin<{ count: number }[]>`
      select count(*)::int as count from session_turns where session_id = ${scenario.sessionId}`;
    expect(turns?.count).toBe(1);
  });

  test("one capacity mutation wakes and concurrent evaluators enqueue/meter once", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const credentialId = await connectCredential(ws, false);
    await connectCredential(ws, false);
    const scenario = await seedScenario(ws);
    await admin`
      update session_turns
      set metadata = jsonb_build_object(
        'codexCredentialPolicyHash', 'accepted-policy-v1',
        'privateAcceptedScope', jsonb_build_object('credentialId', ${credentialId}::text),
        'workerDeathRedispatches', 3,
        'codexCredentialFailovers', 7
      )
      where id = ${scenario.turnId}`;
    const armed = await arm(scenario);
    if (armed.action !== "waiting") throw new Error("expected waiter");

    const mutation = await withCodexCapacityMutation(
      dbA,
      { workspaceId: scenario.workspaceId, reason: "allocator_reenabled" },
      async (tx) => {
        const updated = await tx
          .update(schema.codexSubscriptionCredentials)
          .set({ allocatorEnabled: true })
          .where(eq(schema.codexSubscriptionCredentials.id, credentialId))
          .returning({ id: schema.codexSubscriptionCredentials.id });
        return { result: true, changed: updated.length === 1 };
      },
    );
    expect(mutation.wakeTargets).toHaveLength(1);
    expect(mutation.wakeTargets[0]?.wakeRevision).toBe(armed.waiter.wakeRevision + 1);
    expect(await listPendingCodexCapacityWakeTargets(dbA, scenario.workspaceId)).toHaveLength(1);

    const reconcileInput = {
      accountId: scenario.accountId,
      workspaceId: scenario.workspaceId,
      sessionId: scenario.sessionId,
      waiterId: armed.waiter.id,
      generation: armed.waiter.generation,
    };
    type PrivateAcceptedScope = { credentialId: string; policyHash: string };
    const observed: Array<{
      policyHash: string | null;
      scope: PrivateAcceptedScope | null;
      ids: string[];
    }> = [];
    const decide = (context: CodexCapacitySelectionContext<PrivateAcceptedScope>) => {
      observed.push({
        policyHash: context.policyHash,
        scope: context.policyScope,
        ids: context.accounts.map((account) => account.id),
      });
      return availableDecision(context.accounts[0]!.id);
    };
    const policy = {
      resolvePolicyScope: (metadata: Readonly<Record<string, unknown>>) => {
        const scope = metadata.privateAcceptedScope as { credentialId?: unknown } | undefined;
        const policyHash = metadata.codexCredentialPolicyHash;
        return typeof scope?.credentialId === "string" && typeof policyHash === "string"
          ? { credentialId: scope.credentialId, policyHash }
          : null;
      },
      filterNewAllocationCandidates: ({
        accounts,
        policyScope,
      }: {
        accounts: readonly CodexLeaseAccountStatus[];
        policyScope: PrivateAcceptedScope | null;
      }) => accounts.filter((account) => account.id === policyScope?.credentialId),
    };
    const results = await Promise.all([
      reconcileCodexCapacityWait(dbA, reconcileInput, decide, policy),
      reconcileCodexCapacityWait(dbB, reconcileInput, decide, policy),
    ]);
    expect(results.filter((result) => result.action === "resumed")).toHaveLength(1);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual({
      policyHash: "accepted-policy-v1",
      scope: { credentialId, policyHash: "accepted-policy-v1" },
      ids: [credentialId],
    });
    const resumedResult = results.find((result) => result.action === "resumed");
    if (resumedResult?.action !== "resumed") throw new Error("expected resumed update");
    expect(resumedResult.update.payload).toMatchObject({
      type: "goal_continuation",
      capacityWaiterId: armed.waiter.id,
      policy: {
        model: "codex/gpt-5.6-sol",
        reasoningEffort: "xhigh",
      },
    });
    const [counts] = await admin<
      { turns: number; continuations: number; updates: number; usage: number; resumed: number }[]
    >`
      select
        (select count(*)::int from session_turns where session_id = ${scenario.sessionId}) as turns,
        (select count(*)::int from session_events where session_id = ${scenario.sessionId}
          and type = 'goal.continuation') as continuations,
        (select count(*)::int from session_system_updates where session_id = ${scenario.sessionId}
          and state = 'pending') as updates,
        (select count(*)::int from usage_events where workspace_id = ${scenario.workspaceId}
          and event_type = 'agent_run.created') as usage,
        (select count(*)::int from codex_capacity_waiters where id = ${armed.waiter.id}
          and status = 'resumed') as resumed`;
    expect(counts).toEqual({ turns: 1, continuations: 0, updates: 1, usage: 1, resumed: 1 });
  });

  test("a policy-pin CAS advances the waiter outbox in the same allocator transaction", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const credentialId = await connectCredential(ws, false);
    const scenario = await seedScenario(ws);
    const armed = await arm(scenario);
    if (armed.action !== "waiting") throw new Error("expected waiter");

    const mutation = await withCodexCapacityMutation(
      dbA,
      { workspaceId: ws.workspaceId, reason: "codex_policy_pin_changed" },
      async (tx) => {
        const changed = await setSessionCodexPin(
          tx,
          ws.workspaceId,
          scenario.sessionId,
          credentialId,
          "policy",
          { expected: { pinnedCredentialId: null, pinSource: null } },
        );
        return { result: changed, changed };
      },
    );
    expect(mutation.result).toBe(true);
    expect(mutation.wakeTargets).toEqual([
      expect.objectContaining({
        waiterId: armed.waiter.id,
        generation: armed.waiter.generation,
        wakeRevision: armed.waiter.wakeRevision + 1,
      }),
    ]);
  });

  test("manual goal pause or newer queued work supersedes without a continuation", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const credentialId = await connectCredential(ws, true);
    const paused = await seedScenario(ws);
    const pausedArm = await arm(paused);
    if (pausedArm.action !== "waiting") throw new Error("expected waiter");
    await admin`update session_goals set status = 'paused' where id = ${paused.goalId}`;
    const pausedResult = await reconcileCodexCapacityWait(
      dbA,
      {
        accountId: paused.accountId,
        workspaceId: paused.workspaceId,
        sessionId: paused.sessionId,
        waiterId: pausedArm.waiter.id,
        generation: pausedArm.waiter.generation,
      },
      () => availableDecision(credentialId),
    );
    expect(pausedResult.action).toBe("superseded");

    const queued = await seedScenario(ws);
    const queuedArm = await arm(queued);
    if (queuedArm.action !== "waiting") throw new Error("expected waiter");
    await enqueueSessionTurn(dbA, {
      accountId: queued.accountId,
      workspaceId: queued.workspaceId,
      sessionId: queued.sessionId,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: queued.workflowId,
      source: "user",
      prompt: "newer user work",
      resources: [],
      tools: [],
      model: "codex/gpt-5.6-sol",
      reasoningEffort: "xhigh",
      sandboxBackend: "modal",
      metadata: {},
    });
    const queuedResult = await reconcileCodexCapacityWait(
      dbB,
      {
        accountId: queued.accountId,
        workspaceId: queued.workspaceId,
        sessionId: queued.sessionId,
        waiterId: queuedArm.waiter.id,
        generation: queuedArm.waiter.generation,
      },
      () => availableDecision(credentialId),
    );
    expect(queuedResult.action).toBe("superseded");
    const [continuations] = await admin<{ count: number }[]>`
      select count(*)::int as count from session_events
      where session_id in (${paused.sessionId}, ${queued.sessionId})
        and type = 'goal.continuation'`;
    expect(continuations?.count).toBe(0);
  });

  test("a user prompt arriving after capacity wake stays ahead of the internal update", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const credentialId = await connectCredential(ws, true);
    const scenario = await seedScenario(ws);
    const armed = await arm(scenario);
    if (armed.action !== "waiting") throw new Error("expected waiter");
    const resumed = await reconcileCodexCapacityWait(
      dbA,
      {
        accountId: scenario.accountId,
        workspaceId: scenario.workspaceId,
        sessionId: scenario.sessionId,
        waiterId: armed.waiter.id,
        generation: armed.waiter.generation,
      },
      () => availableDecision(credentialId),
    );
    if (resumed.action !== "resumed") throw new Error("expected resume");
    const userTurn = await enqueueSessionTurn(dbA, {
      accountId: scenario.accountId,
      workspaceId: scenario.workspaceId,
      sessionId: scenario.sessionId,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: scenario.workflowId,
      source: "user",
      prompt: "user won the race",
      resources: [],
      tools: [],
      model: "codex/gpt-5.6-sol",
      reasoningEffort: "xhigh",
      sandboxBackend: "modal",
      metadata: {},
    });
    const claimed = await claimTestTurn(
      dbA,
      scenario.workspaceId,
      scenario.sessionId,
      scenario.workflowId,
    );
    expect(claimed?.id).toBe(userTurn.id);
    const [state] = await admin<
      {
        user_status: string;
        update_status: string;
        waiter_status: string;
        session_status: string;
        active_turn_id: string | null;
      }[]
    >`
      select
        (select status from session_turns where id = ${userTurn.id}) as user_status,
        (select state from session_system_updates where id = ${resumed.update.id}) as update_status,
        (select status from codex_capacity_waiters where id = ${armed.waiter.id}) as waiter_status,
        status as session_status,
        active_turn_id
      from sessions where id = ${scenario.sessionId}`;
    expect(state).toEqual({
      user_status: "running",
      update_status: "delivered",
      waiter_status: "resumed",
      session_status: "running",
      active_turn_id: userTurn.id,
    });
  });

  test("waiter reads remain FORCE-RLS isolated across workspaces", async () => {
    if (!available) return;
    const wsA = await freshWorkspace();
    const wsB = await freshWorkspace();
    await connectCredential(wsA, false);
    await connectCredential(wsB, false);
    const scenarioA = await seedScenario(wsA);
    const scenarioB = await seedScenario(wsB);
    await arm(scenarioA);
    await arm(scenarioB);
    expect(
      await getCodexCapacityWaitForSession(dbA, wsA.workspaceId, scenarioB.sessionId),
    ).toBeNull();
    const rowsA = await listPendingCodexCapacityWakeTargets(dbA, wsA.workspaceId);
    expect(rowsA.every((row) => row.workspaceId === wsA.workspaceId)).toBe(true);
    const [role] = await admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'opengeni_app'`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});
