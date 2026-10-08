import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type { Settings } from "@opengeni/config";
import { sql } from "drizzle-orm";
import {
  applySessionTurnSettlement,
  armSubscriptionCoreCodexCapacityWait,
  initializeSessionStartAtomically,
  materializeGoalContinuation,
  claimSessionWorkForAttempt,
  claimSubscriptionCapacityWakeDeliveries,
  abandonSubscriptionCapacityWakeDelivery,
  codexSubscriptionAuthorityV2ForAcceptanceInTransaction,
  countSubscriptionCoreCodexTurnRefusals,
  createDb,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  evaluateSubscriptionCoreCodexPlacement,
  getSubscriptionCoreCodexCapacityWaitForSession,
  markSubscriptionCapacityWakeDelivered,
  mutateSessionControlInTransaction,
  peekSessionWork,
  placeSubscriptionCoreCodexTurn,
  quarantineSubscriptionCoreCodexConnection,
  readSubscriptionCoreTurnIdentity,
  reconcileSubscriptionCoreCodexCapacityWait,
  recordSubscriptionCoreCodexModelCooldown,
  recordSubscriptionCoreCodexTurnFailure,
  recoverSubscriptionCoreCodexConnectionHealth,
  refreshSubscriptionCoreCodexCredential,
  releaseSubscriptionTurnLease,
  retrySubscriptionCapacityWakeDelivery,
  submitHumanPromptInTransaction,
  subscriptionCoreCodexCapacityWaitRef,
  subscriptionCoreCodexReselectionPoints,
  subscriptionCoreTurnActor,
  touchSubscriptionCoreCodexBinding,
  wakeSubscriptionCoreCodexCapacityWaiters,
  withRlsContext,
  withSessionRlsActorContext,
  withSubscriptionCapacityWakeOutboxScope,
  withWorkspaceSubjectSessionActivityRls,
  writeSubscriptionSessionBinding,
  type Database,
  type DbClient,
  type SubscriptionCoreTurnIdentity,
} from "../src";
import { rawRows } from "../src/database";
import { encryptEnvironmentValue } from "../src/environment-crypto";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const key = Buffer.alloc(32, 37);
const settings = { environmentsEncryptionKey: key.toString("base64") } as Settings;
const MODEL = "codex/gpt-5.5";
const TTL = 120_000;

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("subscription-core-codex-waits-v1");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 6 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

function idToken(planType: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_plan_type: planType } }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function encryptedTokens(label: string): string {
  return encryptEnvironmentValue(
    key,
    JSON.stringify({
      access_token: `access-${label}`,
      refresh_token: `refresh-${label}`,
      id_token: `id-${label}`,
    }),
  );
}

type Org = {
  accountId: string;
  ownerSubjectId: string;
  ownerMembershipId: string;
  personalWorkspaceId: string;
  sharedWorkspaceId: string;
};

async function organization(): Promise<Org> {
  const userId = `core-codex-waits-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Core Codex waits fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const ownerSubjectId = `user:${userId}`;
  const [membership] = await shared!.admin<{ id: string; personal_workspace_id: string }[]>`
    select id::text as id, personal_workspace_id::text as personal_workspace_id
    from organization_memberships
    where account_id = ${accountId}::uuid and subject_id = ${ownerSubjectId}
      and status = 'active' and revoked_at is null limit 1`;
  const [sharedWorkspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'Core Codex waits shared workspace') returning id::text as id`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${sharedWorkspace!.id}::uuid, ${ownerSubjectId}, 'owner')`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${sharedWorkspace!.id}::uuid, ${accountId}::uuid)`;
  await shared!.admin`
    insert into subscription_settings (
      account_id, rotation, providers, cross_provider_failover, fallback_order,
      personal_connections_allowed, personal_fallback_allowed
    ) values (
      ${accountId}::uuid, ${shared!.admin.json({ codex: { mode: "spread" } })}::jsonb,
      '{}'::jsonb, false, '{}'::jsonb, true, true
    )`;
  await shared!.admin`
    insert into subscription_person_preferences (
      account_id, organization_membership_id, personal_fallback_opt_in
    ) values (${accountId}::uuid, ${membership!.id}::uuid, true)`;
  return {
    accountId,
    ownerSubjectId,
    ownerMembershipId: membership!.id,
    personalWorkspaceId: membership!.personal_workspace_id,
    sharedWorkspaceId: sharedWorkspace!.id,
  };
}

async function enableCodexCutover(accountId: string, enabled = true): Promise<void> {
  await shared!.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${accountId}::uuid, 'codex', ${enabled})
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
}

async function sharedConnection(org: Org, label: string): Promise<string> {
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      provider_account_id, plan_type, provider_state, expires_at
    ) values (
      ${org.accountId}::uuid, 'codex', 'subscription', ${encryptedTokens(label)},
      'shared', 'organization', ${`chatgpt-${label}`}, 'pro',
      ${shared!.admin.json({ isFedramp: false })}::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz
    ) returning id::text as id`;
  for (const workspaceId of [org.personalWorkspaceId, org.sharedWorkspaceId]) {
    await shared!.admin`
      insert into subscription_connection_assignment_policies (
        account_id, connection_id, workspace_id, inference_pool
      ) values (${org.accountId}::uuid, ${row!.id}::uuid, ${workspaceId}::uuid, 'organization')`;
  }
  return row!.id;
}

async function personalConnection(
  org: Org,
  label: string,
  generation = 1,
  options: { provider?: "codex" | "claude"; status?: string } = {},
): Promise<string> {
  const connectionId = crypto.randomUUID();
  const authorityId = crypto.randomUUID();
  await shared!.admin`
    insert into organization_user_resource_authorities (
      id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
    ) values (
      ${authorityId}::uuid, ${org.accountId}::uuid, ${org.ownerMembershipId}::uuid,
      'subscription_connection', ${connectionId}::uuid, ${generation}, 'active'
    )`;
  await shared!.admin`
    insert into subscription_connections (
      id, account_id, provider, credential_encrypted, ownership, scope_kind,
      owner_organization_membership_id, owner_subject_id, authority_id,
      authority_resource_kind, authority_generation, provider_account_id, provider_state,
      expires_at, status
    ) values (
      ${connectionId}::uuid, ${org.accountId}::uuid, ${options.provider ?? "codex"},
      ${encryptedTokens(label)},
      'personal', 'people', ${org.ownerMembershipId}::uuid, ${org.ownerSubjectId},
      ${authorityId}::uuid, 'subscription_connection', ${generation}, ${`chatgpt-${label}`},
      ${shared!.admin.json({ isFedramp: false })}::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz,
      ${options.status ?? "active"}
    )`;
  return connectionId;
}

async function exhaust(org: Org, connectionId: string, until: number | null): Promise<void> {
  await shared!.admin`
    insert into subscription_connection_quota (
      account_id, connection_id, quota, observed_refresh_generation, revision
    ) values (${org.accountId}::uuid, ${connectionId}::uuid, ${shared!.admin.json({
      windows: [],
      modelCooldowns: {},
      exhaustedUntil: until,
      exhaustedKind: until === null ? null : "quota",
      source: "refusal",
    })}::jsonb, 1, 1)
    on conflict (connection_id) do update set quota = excluded.quota,
      revision = subscription_connection_quota.revision + 1`;
}

type TurnFixture = {
  identity: SubscriptionCoreTurnIdentity;
  attemptId: string;
  executionGeneration: number;
  holderId: string;
};

async function ownedSession(
  org: Org,
  workspaceId: string,
  visibility?: "user_private" | "workspace_shared",
): Promise<string> {
  const session = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
    createSession(client!.db, {
      accountId: org.accountId,
      workspaceId,
      initialMessage: "core codex waits fixture",
      resources: [],
      metadata: {},
      model: MODEL,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      ...(visibility ? { visibility } : {}),
      subjectId: org.ownerSubjectId,
      createdBy: { kind: "subject" as const, subjectId: org.ownerSubjectId },
      createdByContext: {},
    }),
  );
  return session.id;
}

/** A claimed, running turn: the exact state the worker places from. */
async function runningTurn(
  org: Org,
  input: { workspaceId: string; sessionId?: string; service?: boolean },
): Promise<TurnFixture> {
  const sessionId = input.sessionId ?? (await ownedSession(org, input.workspaceId));
  // A service turn in the owner's session sees it as the owner's core
  // actor does (owner as effective human); its stored turn human is NULL.
  const actor = input.service
    ? { subjectId: "service:subscription-core", initiatingHumanSubjectId: org.ownerSubjectId }
    : { subjectId: org.ownerSubjectId };
  const turn = await withSessionRlsActorContext(actor, () =>
    enqueueSessionTurn(client!.db, {
      accountId: org.accountId,
      workspaceId: input.workspaceId,
      sessionId,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${sessionId}`,
      source: "user",
      prompt: "core codex waits fixture",
      resources: [],
      tools: [],
      model: MODEL,
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator: input.service
        ? { kind: "service", subjectId: "service:subscription-core" }
        : { kind: "subject", subjectId: org.ownerSubjectId },
    }),
  );
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client!.db, input.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`claim failed: ${claimed.reason}`);
  expect(claimed.turn.id).toBe(turn.id);
  const identity = await readSubscriptionCoreTurnIdentity(client!.db, {
    accountId: org.accountId,
    workspaceId: input.workspaceId,
    sessionId,
    turnId: turn.id,
  });
  if (!identity) throw new Error("accepted turn identity was not readable");
  return {
    identity,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
    holderId: `codex-turn:${sessionId}:${turn.id}:${attemptId}`,
  };
}

function place(turn: TurnFixture) {
  return placeSubscriptionCoreCodexTurn(client!.db, {
    identity: turn.identity,
    attemptId: turn.attemptId,
    executionGeneration: turn.executionGeneration,
    holderId: turn.holderId,
    productModelId: MODEL,
    reasoningLevel: "medium",
    leaseTtlMs: TTL,
  });
}

function evaluate(turn: TurnFixture) {
  return evaluateSubscriptionCoreCodexPlacement(client!.db, {
    identity: turn.identity,
    productModelId: MODEL,
    reasoningLevel: "medium",
  });
}

function leaseOf(turn: TurnFixture, connectionId: string) {
  return { connectionId, holderId: turn.holderId, generation: turn.executionGeneration };
}

async function arm(turn: TurnFixture, earliestResetAt: Date | null) {
  return await armSubscriptionCoreCodexCapacityWait(client!.db, {
    accountId: turn.identity.accountId,
    workspaceId: turn.identity.workspaceId,
    sessionId: turn.identity.sessionId,
    turnId: turn.identity.turnId,
    attemptId: turn.attemptId,
    waitReason: "no_eligible_capacity",
    earliestResetAt,
    failurePayload: { code: "subscription_capacity_unavailable" },
  });
}

async function rowState(turn: TurnFixture) {
  const [row] = await shared!.admin<
    {
      session_status: string;
      active_turn_id: string | null;
      turn_status: string;
      active_attempt_id: string | null;
      recovery: { resumeGeneration: number | null; falseResumptions: number } | null;
    }[]
  >`
    select session.status as session_status, session.active_turn_id::text as active_turn_id,
      turn.status as turn_status, turn.active_attempt_id::text as active_attempt_id,
      turn.metadata->'codexCapacityRecoveryV1' as recovery
    from sessions session join session_turns turn on turn.session_id = session.id
    where session.id = ${turn.identity.sessionId}::uuid and turn.id = ${turn.identity.turnId}::uuid`;
  return row!;
}

async function waiterRows(
  turn: TurnFixture,
): Promise<
  Array<{ waiter_id: string; generation: string; wake_revision: string; observed: string }>
> {
  const rows = await shared!.admin<
    { waiter_id: string; generation: string; wake_revision: string; observed: string }[]
  >`
    select waiter_id::text as waiter_id, generation::text as generation,
      wake_revision::text as wake_revision, observed_wake_revision::text as observed
    from subscription_capacity_waiters
    where session_id = ${turn.identity.sessionId}::uuid`;
  return rows.map((row) => ({ ...row }));
}

describe.skipIf(!realDb)("Codex chat waits, wakes and health on the shared core", () => {
  test("runs as the non-superuser, non-bypass application role", async () => {
    const [role] = await rawRows<{ currentUser: string; superuser: boolean; bypassRls: boolean }>(
      client!.db,
      sql`select current_user as "currentUser", rolsuper as superuser,
          rolbypassrls as "bypassRls"
        from pg_catalog.pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ currentUser: "opengeni_app", superuser: false, bypassRls: false });
  });

  test("a placement wait parks the turn on the core waiter and resumes it when capacity returns", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const connectionId = await sharedConnection(org, "parked");
    const resetAt = Date.now() + 3_600_000;
    await exhaust(org, connectionId, resetAt);
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    expect(await place(turn)).toMatchObject({
      kind: "wait",
      reason: "no_eligible_capacity",
      earliestResetAt: new Date(resetAt),
    });

    const armed = await arm(turn, new Date(resetAt));
    if (armed.action !== "waiting") throw new Error(`arm returned ${armed.action}`);
    expect(armed.waiter).toMatchObject({
      blockedTurnId: turn.identity.turnId,
      blockedTurnGeneration: turn.executionGeneration,
      generation: 1,
      wakeRevision: 1,
      observedWakeRevision: 1,
      waitReason: "no_eligible_capacity",
      resetKind: "authoritative",
      nextCheckAt: new Date(resetAt),
    });
    expect(armed.events.map((event) => event.type)).toEqual([
      "codex.capacity.waiting",
      "session.status.changed",
    ]);
    expect(armed.events[0]!.payload).toMatchObject({
      code: "subscription_capacity_unavailable",
      recovery: "codex_capacity",
      waiterId: armed.waiter.waiterId,
      generation: 1,
    });
    expect(await rowState(turn)).toMatchObject({
      session_status: "waiting_capacity",
      active_turn_id: turn.identity.turnId,
      turn_status: "waiting_capacity",
      active_attempt_id: null,
    });
    // Re-arming the same attempt is an idempotent no-op.
    expect(await arm(turn, new Date(resetAt))).toMatchObject({ action: "waiting", events: [] });

    // The workflow peek and the activity lookup see it in the legacy shape.
    const ref = subscriptionCoreCodexCapacityWaitRef(armed.waiter);
    expect(ref).toEqual({
      waiterId: armed.waiter.waiterId,
      generation: 1,
      nextCheckAt: new Date(resetAt).toISOString(),
      wakeRevision: 1,
    });
    expect(
      await peekSessionWork(client!.db, org.sharedWorkspaceId, turn.identity.sessionId),
    ).toEqual({ kind: "capacity-wait", ref });
    expect(
      await getSubscriptionCoreCodexCapacityWaitForSession(
        client!.db,
        org.sharedWorkspaceId,
        turn.identity.sessionId,
      ),
    ).toMatchObject({ waiterId: armed.waiter.waiterId });

    // Still exhausted: waiting, acknowledging the evaluated revision.
    expect(await evaluate(turn)).toMatchObject({ kind: "wait", reason: "no_eligible_capacity" });
    const reconcileInput = {
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      sessionId: turn.identity.sessionId,
      waiterId: armed.waiter.waiterId,
      generation: 1,
      evaluatedWakeRevision: 1,
    };
    const waiting = await reconcileSubscriptionCoreCodexCapacityWait(client!.db, {
      ...reconcileInput,
      evaluation: {
        kind: "wait",
        waitReason: "no_eligible_capacity",
        earliestResetAt: new Date(resetAt),
        healthRetryAt: null,
      },
    });
    expect(waiting).toMatchObject({ action: "waiting", waiter: { refreshAttempt: 0 } });

    // Capacity returns: the exact blocked turn becomes recovering, the waiter goes.
    await exhaust(org, connectionId, null);
    expect(await evaluate(turn)).toMatchObject({ kind: "run", connectionId });
    const resumed = await reconcileSubscriptionCoreCodexCapacityWait(client!.db, {
      ...reconcileInput,
      evaluation: { kind: "run" },
    });
    expect(resumed.action).toBe("resumed");
    expect(resumed.events.map((event) => event.type)).toEqual([
      "codex.capacity.resumed",
      "session.status.changed",
    ]);
    expect(await waiterRows(turn)).toEqual([]);
    expect(await rowState(turn)).toMatchObject({
      session_status: "recovering",
      turn_status: "recovering",
      recovery: { resumeGeneration: turn.executionGeneration + 1, falseResumptions: 0 },
    });
    // A duplicate timer or signal for the resumed waiter does nothing.
    expect(
      await reconcileSubscriptionCoreCodexCapacityWait(client!.db, {
        ...reconcileInput,
        evaluation: { kind: "run" },
      }),
    ).toEqual({ action: "stale", events: [] });
  });

  test("arming refuses a stale attempt and a disabled cutover", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const connectionId = await sharedConnection(org, "stale-arm");
    await exhaust(org, connectionId, Date.now() + 60_000);
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    expect(await arm({ ...turn, attemptId: crypto.randomUUID() }, null)).toEqual({
      action: "stale",
      events: [],
    });
    await enableCodexCutover(org.accountId, false);
    expect(await arm(turn, null)).toEqual({ action: "stale", events: [] });
    expect(await rowState(turn)).toMatchObject({ turn_status: "running" });
    expect(await waiterRows(turn)).toEqual([]);
  });

  test("a wake fans out across workspaces through the outbox and a wake during evaluation stays pending", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const connectionId = await sharedConnection(org, "fanout");
    await exhaust(org, connectionId, Date.now() + 3_600_000);
    const first = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    const second = await runningTurn(org, { workspaceId: org.personalWorkspaceId });
    const firstArmed = await arm(first, null);
    const secondArmed = await arm(second, null);
    if (firstArmed.action !== "waiting" || secondArmed.action !== "waiting")
      throw new Error("arm failed");

    // Called from inside a turn's session actor: the wake still runs in the
    // trusted empty-subject outbox scope.
    const scopes = await withSessionRlsActorContext(
      { subjectId: "service:agent-turn", initiatingHumanSubjectId: org.ownerSubjectId },
      () =>
        wakeSubscriptionCoreCodexCapacityWaiters(client!.db, {
          accountId: org.accountId,
          reason: "quota_observed_available",
        }),
    );
    expect(new Set(scopes.map((scope) => scope.workspaceId))).toEqual(
      new Set([org.sharedWorkspaceId, org.personalWorkspaceId]),
    );
    expect(await waiterRows(first)).toEqual([
      { waiter_id: firstArmed.waiter.waiterId, generation: "1", wake_revision: "2", observed: "1" },
    ]);
    const generic = await shared!.admin<{ session_id: string }[]>`
      select session_id::text as session_id from session_workflow_wake_outbox
      where session_id in (${first.identity.sessionId}::uuid, ${second.identity.sessionId}::uuid)
        and wake_revision > delivered_revision`;
    expect(generic).toHaveLength(2);

    // The evaluation saw revision 1; the wake to revision 2 stays pending, so
    // the workflow re-evaluates at once instead of sleeping until the timer.
    const waiting = await reconcileSubscriptionCoreCodexCapacityWait(client!.db, {
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      sessionId: first.identity.sessionId,
      waiterId: firstArmed.waiter.waiterId,
      generation: 1,
      evaluatedWakeRevision: 1,
      evaluation: {
        kind: "wait",
        waitReason: "no_eligible_capacity",
        earliestResetAt: null,
        healthRetryAt: null,
      },
    });
    if (waiting.action !== "waiting") throw new Error("expected waiting");
    expect(subscriptionCoreCodexCapacityWaitRef(waiting.waiter).nextCheckAt).toBe(
      new Date(0).toISOString(),
    );

    const scope = { accountId: org.accountId, workspaceId: org.sharedWorkspaceId };
    // The outbox is invisible to a subject; only the trusted worker scope claims it.
    const asSubject = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
      withRlsContext(client!.db, scope, (db) =>
        claimSubscriptionCapacityWakeDeliveries(db, { limit: 10, claimTtlMs: 60_000 }),
      ),
    );
    expect(asSubject).toEqual([]);

    // Crash between claim and signal: the claim expires and is claimed again
    // under a newer claim generation, which fences the late acknowledgement.
    const [claimed] = await withSubscriptionCapacityWakeOutboxScope(client!.db, scope, (db) =>
      claimSubscriptionCapacityWakeDeliveries(db, { limit: 10, claimTtlMs: 1 }),
    );
    expect(claimed).toMatchObject({
      sessionId: first.identity.sessionId,
      waiterId: firstArmed.waiter.waiterId,
      wakeRevision: 2,
      attemptCount: 1,
    });
    await Bun.sleep(20);
    const [reclaimed] = await withSubscriptionCapacityWakeOutboxScope(client!.db, scope, (db) =>
      claimSubscriptionCapacityWakeDeliveries(db, { limit: 10, claimTtlMs: 60_000 }),
    );
    expect(reclaimed).toMatchObject({ id: claimed!.id, attemptCount: 2 });
    expect(
      await withSubscriptionCapacityWakeOutboxScope(client!.db, scope, (db) =>
        markSubscriptionCapacityWakeDelivered(db, claimed!),
      ),
    ).toBe(false);
    expect(
      await withSubscriptionCapacityWakeOutboxScope(client!.db, scope, (db) =>
        markSubscriptionCapacityWakeDelivered(db, reclaimed!),
      ),
    ).toBe(true);
    expect(
      await withSubscriptionCapacityWakeOutboxScope(client!.db, scope, (db) =>
        claimSubscriptionCapacityWakeDeliveries(db, { limit: 10, claimTtlMs: 60_000 }),
      ),
    ).toEqual([]);

    // Failed signals retry with backoff and are given up after their bound.
    const personalScope = { accountId: org.accountId, workspaceId: org.personalWorkspaceId };
    const [pending] = await withSubscriptionCapacityWakeOutboxScope(
      client!.db,
      personalScope,
      (db) => claimSubscriptionCapacityWakeDeliveries(db, { limit: 10, claimTtlMs: 60_000 }),
    );
    expect(
      await withSubscriptionCapacityWakeOutboxScope(client!.db, personalScope, (db) =>
        retrySubscriptionCapacityWakeDelivery(db, {
          id: pending!.id,
          claimGeneration: pending!.claimGeneration,
          retryInMs: 1,
          failureCode: "signal_failed",
        }),
      ),
    ).toBe(true);
    await Bun.sleep(20);
    const [retried] = await withSubscriptionCapacityWakeOutboxScope(
      client!.db,
      personalScope,
      (db) => claimSubscriptionCapacityWakeDeliveries(db, { limit: 10, claimTtlMs: 60_000 }),
    );
    expect(retried).toMatchObject({ id: pending!.id, attemptCount: 2 });
    expect(
      await withSubscriptionCapacityWakeOutboxScope(client!.db, personalScope, (db) =>
        abandonSubscriptionCapacityWakeDelivery(db, {
          id: retried!.id,
          claimGeneration: retried!.claimGeneration,
          failureCode: "signal_attempts_exhausted",
        }),
      ),
    ).toBe(true);
    const [abandoned] = await shared!.admin<
      { delivered: boolean; last_error: string | null }[]
    >`select delivered_at is not null as delivered, last_error
      from subscription_capacity_wake_outbox where id = ${retried!.id}::uuid`;
    expect(abandoned).toEqual({ delivered: true, last_error: "signal_attempts_exhausted" });
    // The waiter's own revision stays unobserved for the workflow's next peek.
    expect(await waiterRows(second)).toMatchObject([{ wake_revision: "2", observed: "1" }]);

    // A disabled cutover wakes nothing.
    await enableCodexCutover(org.accountId, false);
    expect(
      await wakeSubscriptionCoreCodexCapacityWaiters(client!.db, {
        accountId: org.accountId,
        reason: "quota_observed_available",
      }),
    ).toEqual([]);
  });

  test("a changed session or revoked authority supersedes the waiter without running the turn", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const connectionId = await sharedConnection(org, "supersede");
    await exhaust(org, connectionId, Date.now() + 60_000);
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    const armed = await arm(turn, null);
    if (armed.action !== "waiting") throw new Error("arm failed");
    const superseded = await reconcileSubscriptionCoreCodexCapacityWait(client!.db, {
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      sessionId: turn.identity.sessionId,
      waiterId: armed.waiter.waiterId,
      generation: armed.waiter.generation,
      evaluatedWakeRevision: armed.waiter.wakeRevision,
      evaluation: { kind: "revoked" },
    });
    expect(superseded.action).toBe("superseded");
    expect(superseded.events[0]).toMatchObject({
      type: "codex.capacity.superseded",
      payload: { reason: "subscription_access_revoked" },
    });
    expect(await waiterRows(turn)).toEqual([]);
    expect(await rowState(turn)).toMatchObject({
      session_status: "idle",
      active_turn_id: null,
      turn_status: "superseded",
    });
  });

  test("Steer and Cancel remove the blocked turn's core waiter; a left-behind row is checked at once", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const connectionId = await sharedConnection(org, "steer-cancel");
    const resetAt = new Date(Date.now() + 5 * 3_600_000);
    await exhaust(org, connectionId, resetAt.getTime());
    const asOwner = <T>(fn: Parameters<typeof withWorkspaceSubjectSessionActivityRls<T>>[3]) =>
      withWorkspaceSubjectSessionActivityRls(
        client!.db,
        org.sharedWorkspaceId,
        org.ownerSubjectId,
        fn,
      );
    const outboxRows = async (sessionId: string) =>
      (
        await shared!.admin<{ id: string }[]>`
          select id::text as id from subscription_capacity_wake_outbox
          where session_id = ${sessionId}::uuid`
      ).map((row) => row.id);

    // Steer: the blocked turn is superseded and its core waiter goes with it,
    // so the peek finds the Steer turn instead of sleeping to the reset.
    const steered = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    const steeredArm = await arm(steered, resetAt);
    if (steeredArm.action !== "waiting") throw new Error("arm failed");
    await wakeSubscriptionCoreCodexCapacityWaiters(client!.db, {
      accountId: org.accountId,
      reason: "fixture_pending_wake",
    });
    expect(await outboxRows(steered.identity.sessionId)).toHaveLength(1);
    await asOwner((tx) =>
      submitHumanPromptInTransaction(tx, {
        accountId: org.accountId,
        workspaceId: org.sharedWorkspaceId,
        sessionId: steered.identity.sessionId,
        subjectId: org.ownerSubjectId,
        actor: { type: "human", subjectId: org.ownerSubjectId },
        operationKey: crypto.randomUUID(),
        delivery: "steer",
        text: "change of plan",
        resources: [],
        reasoningEffortFallback: "medium",
        source: "user",
      }),
    );
    expect(await waiterRows(steered)).toEqual([]);
    expect(await outboxRows(steered.identity.sessionId)).toEqual([]);
    expect(await rowState(steered)).toMatchObject({ turn_status: "superseded" });
    const afterSteer = await peekSessionWork(
      client!.db,
      org.sharedWorkspaceId,
      steered.identity.sessionId,
    );
    expect(afterSteer.kind).not.toBe("capacity-wait");

    // Cancel: no orphan waiter is left to receive account-wide wakes.
    const cancelled = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    if ((await arm(cancelled, resetAt)).action !== "waiting") throw new Error("arm failed");
    await asOwner((tx) =>
      mutateSessionControlInTransaction(tx, {
        accountId: org.accountId,
        workspaceId: org.sharedWorkspaceId,
        sessionId: cancelled.identity.sessionId,
        actor: { type: "human", subjectId: org.ownerSubjectId },
        operationKey: crypto.randomUUID(),
        action: "cancel",
      }),
    );
    expect(await waiterRows(cancelled)).toEqual([]);
    expect(await rowState(cancelled)).toMatchObject({ turn_status: "cancelled" });
    await wakeSubscriptionCoreCodexCapacityWaiters(client!.db, {
      accountId: org.accountId,
      reason: "quota_observed_available",
    });
    expect(await outboxRows(cancelled.identity.sessionId)).toEqual([]);

    // Any other transition that leaves a row behind: the peek and the lookup
    // report an immediate check, and that reconcile deletes the row.
    const orphaned = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    const orphanArm = await arm(orphaned, resetAt);
    if (orphanArm.action !== "waiting") throw new Error("arm failed");
    await shared!.admin`update session_turns set status = 'superseded', finished_at = now()
      where id = ${orphaned.identity.turnId}::uuid`;
    await shared!.admin`update sessions set status = 'idle', active_turn_id = null
      where id = ${orphaned.identity.sessionId}::uuid`;
    const stale = await getSubscriptionCoreCodexCapacityWaitForSession(
      client!.db,
      org.sharedWorkspaceId,
      orphaned.identity.sessionId,
    );
    expect(stale).toMatchObject({ waiterId: orphanArm.waiter.waiterId, blockedTurnLive: false });
    const immediate = {
      kind: "capacity-wait" as const,
      ref: {
        waiterId: orphanArm.waiter.waiterId,
        generation: orphanArm.waiter.generation,
        nextCheckAt: new Date(0).toISOString(),
        wakeRevision: orphanArm.waiter.wakeRevision,
      },
    };
    expect(
      await peekSessionWork(client!.db, org.sharedWorkspaceId, orphaned.identity.sessionId),
    ).toEqual(immediate);
    const removed = await reconcileSubscriptionCoreCodexCapacityWait(client!.db, {
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      sessionId: orphaned.identity.sessionId,
      waiterId: orphanArm.waiter.waiterId,
      generation: orphanArm.waiter.generation,
      evaluatedWakeRevision: orphanArm.waiter.wakeRevision,
      evaluation: { kind: "paused" },
    });
    expect(removed).toMatchObject({
      action: "superseded",
      events: [{ type: "codex.capacity.superseded", payload: { reason: "active_turn_changed" } }],
    });
    expect(await waiterRows(orphaned)).toEqual([]);
    expect(
      (await peekSessionWork(client!.db, org.sharedWorkspaceId, orphaned.identity.sessionId)).kind,
    ).not.toBe("capacity-wait");
  });

  test("a 403 quarantines the leased connection until its retry time; a revoked sign-in stays down", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const first = await sharedConnection(org, "health-a");
    const second = await sharedConnection(org, "health-b");
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    const placed = await place(turn);
    if (placed.kind !== "run") throw new Error("expected a placement");
    const refused = placed.connectionId;
    const other = refused === first ? second : first;
    const ref = leaseOf(turn, refused);

    // A refusal seen with an older credential generation, or from a turn
    // without the lease, never quarantines.
    expect(
      await quarantineSubscriptionCoreCodexConnection(client!.db, turn.identity, ref, {
        kind: "forbidden",
        refreshGeneration: 7,
      }),
    ).toBe(false);
    const bystander = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    expect(
      await quarantineSubscriptionCoreCodexConnection(
        client!.db,
        bystander.identity,
        leaseOf(bystander, refused),
        { kind: "forbidden", refreshGeneration: 1 },
      ),
    ).toBe(false);
    expect(
      await quarantineSubscriptionCoreCodexConnection(client!.db, turn.identity, ref, {
        kind: "forbidden",
        refreshGeneration: 1,
      }),
    ).toBe(true);
    const [quarantined] = await shared!.admin<
      { status: string; retry_in_minutes: number; last_error: string }[]
    >`select status, round(extract(epoch from health_retry_at - now()) / 60)::int as retry_in_minutes,
        last_error from subscription_connections where id = ${refused}::uuid`;
    expect(quarantined).toEqual({
      status: "error",
      retry_in_minutes: 60,
      last_error: "model request was forbidden for this credential",
    });

    // Placement no longer returns to it; a waiter learns when it comes back.
    expect(await place(bystander)).toMatchObject({ kind: "run", connectionId: other });
    await exhaust(org, other, null);
    await shared!.admin`update subscription_connections set status = 'needs_relogin'
      where id = ${other}::uuid`;
    const waiter = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    const waitPlacement = await place(waiter);
    expect(waitPlacement).toMatchObject({ kind: "wait", reason: "no_eligible_capacity" });
    if (waitPlacement.kind !== "wait") throw new Error("expected wait");
    expect(waitPlacement.healthRetryAt?.getTime()).toBeGreaterThan(Date.now() + 3_000_000);

    // Not yet due: nothing recovers. Due: it serves again.
    expect(await recoverSubscriptionCoreCodexConnectionHealth(client!.db, waiter.identity)).toBe(0);
    await shared!.admin`update subscription_connections
      set health_retry_at = now() - interval '1 second' where id = ${refused}::uuid`;
    expect(await recoverSubscriptionCoreCodexConnectionHealth(client!.db, waiter.identity)).toBe(1);
    const [recovered] = await shared!.admin<{ status: string; health_retry_at: Date | null }[]>`
      select status, health_retry_at from subscription_connections where id = ${refused}::uuid`;
    expect(recovered).toEqual({ status: "active", health_retry_at: null });
    // The other connection's sign-in failure is never cleared by time.
    const [signIn] = await shared!.admin<{ status: string }[]>`
      select status from subscription_connections where id = ${other}::uuid`;
    expect(signIn!.status).toBe("needs_relogin");
    expect(await place(waiter)).toMatchObject({ kind: "run", connectionId: refused });

    // A 401 that survived refresh marks the connection as needing sign-in.
    expect(
      await quarantineSubscriptionCoreCodexConnection(
        client!.db,
        waiter.identity,
        leaseOf(waiter, refused),
        { kind: "sign_in", refreshGeneration: 1 },
      ),
    ).toBe(true);
    const [relogin] = await shared!.admin<{ status: string; health_retry_at: Date | null }[]>`
      select status, health_retry_at from subscription_connections where id = ${refused}::uuid`;
    expect(relogin).toEqual({ status: "needs_relogin", health_retry_at: null });

    // With the cutover off the seam refuses.
    await enableCodexCutover(org.accountId, false);
    expect(
      await quarantineSubscriptionCoreCodexConnection(
        client!.db,
        waiter.identity,
        leaseOf(waiter, refused),
        { kind: "forbidden", refreshGeneration: 1 },
      ),
    ).toBe(false);
  });

  test("health recovery reaches only connections the recovering turn could lease", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const personalId = await personalConnection(org, "recover-personal");
    await shared!.admin`update subscription_connections
      set status = 'error', last_error = 'model request was forbidden for this credential',
        health_retry_at = now() - interval '1 second'
      where id = ${personalId}::uuid`;
    const personalStatus = async () => {
      const [row] = await shared!.admin<{ status: string }[]>`
        select status from subscription_connections where id = ${personalId}::uuid`;
      return row!.status;
    };

    // The owner's own turn in a shared session froze no personal authority:
    // it cannot see the owner's personal connection, so it cannot end its
    // quarantine either.
    const sharedTurn = await runningTurn(org, {
      workspaceId: org.sharedWorkspaceId,
      sessionId: await ownedSession(org, org.sharedWorkspaceId, "workspace_shared"),
    });
    expect(
      await recoverSubscriptionCoreCodexConnectionHealth(client!.db, sharedTurn.identity),
    ).toBe(0);
    expect(await personalStatus()).toBe("error");

    const privateSessionId = await ownedSession(org, org.sharedWorkspaceId, "user_private");
    const ownerAuthority = shared!.admin.json({
      version: 2,
      personal: [
        { provider: "codex", ownerMembershipId: org.ownerMembershipId, authorityGeneration: 1 },
      ],
    });

    // A service (no-human) turn in the owner's private session: its session
    // access records the owner as the effective human, but placement never
    // grants it personal capacity, so recovery must not either, even with a
    // (forged) personal entry on the turn.
    const serviceTurn = await runningTurn(org, {
      workspaceId: org.sharedWorkspaceId,
      sessionId: privateSessionId,
      service: true,
    });
    await shared!.admin`update session_turns set subscription_authority = ${ownerAuthority}::jsonb
      where id = ${serviceTurn.identity.turnId}::uuid`;
    const serviceIdentity = await readSubscriptionCoreTurnIdentity(client!.db, {
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      sessionId: privateSessionId,
      turnId: serviceTurn.identity.turnId,
    });
    expect(serviceIdentity).toMatchObject({ initiatingHumanSubjectId: null });
    // The service turn does hold session access (placement evaluates for it).
    expect(
      (
        await evaluateSubscriptionCoreCodexPlacement(client!.db, {
          identity: serviceIdentity!,
          productModelId: MODEL,
          reasoningLevel: "medium",
        })
      ).kind,
    ).not.toBe("not_visible");
    expect(await recoverSubscriptionCoreCodexConnectionHealth(client!.db, serviceIdentity!)).toBe(
      0,
    );
    expect(await personalStatus()).toBe("error");

    // The owner's own private turn whose frozen v2 authority names this
    // connection's owner membership and generation recovers it.
    const privateTurn = await runningTurn(org, {
      workspaceId: org.sharedWorkspaceId,
      sessionId: await ownedSession(org, org.sharedWorkspaceId, "user_private"),
    });
    await shared!.admin`update session_turns set subscription_authority = ${ownerAuthority}::jsonb
      where id = ${privateTurn.identity.turnId}::uuid`;
    const privateIdentity = await readSubscriptionCoreTurnIdentity(client!.db, {
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      sessionId: privateTurn.identity.sessionId,
      turnId: privateTurn.identity.turnId,
    });
    expect(await recoverSubscriptionCoreCodexConnectionHealth(client!.db, privateIdentity!)).toBe(
      1,
    );
    expect(await personalStatus()).toBe("active");
  });

  test("an error the quarantine did not write is never cleared by health recovery", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const connectionId = await sharedConnection(org, "admin-error");
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    expect(await place(turn)).toMatchObject({ kind: "run", connectionId });
    expect(
      await quarantineSubscriptionCoreCodexConnection(
        client!.db,
        turn.identity,
        leaseOf(turn, connectionId),
        { kind: "forbidden", refreshGeneration: 1 },
      ),
    ).toBe(true);
    const health = async () => {
      const [row] = await shared!.admin<
        { status: string; last_error: string | null; has_retry: boolean }[]
      >`select status, last_error, health_retry_at is not null as has_retry
        from subscription_connections where id = ${connectionId}::uuid`;
      return row!;
    };
    expect(await health()).toMatchObject({ status: "error", has_retry: true });
    // An administrator returns it to service, later marks it failed for an
    // unrelated reason: the old quarantine's retry time does not survive.
    await shared!.admin`update subscription_connections set status = 'active'
      where id = ${connectionId}::uuid`;
    expect(await health()).toMatchObject({ status: "active", has_retry: false });
    await shared!.admin`update subscription_connections
      set status = 'error', last_error = 'disabled by an administrator'
      where id = ${connectionId}::uuid`;
    const bystander = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    expect(await recoverSubscriptionCoreCodexConnectionHealth(client!.db, bystander.identity)).toBe(
      0,
    );
    expect(await health()).toEqual({
      status: "error",
      last_error: "disabled by an administrator",
      has_retry: false,
    });
    // Rewriting the error of a quarantined row also ends the quarantine's claim.
    await shared!.admin`update subscription_connections
      set health_retry_at = now() - interval '1 second',
        last_error = 'model request was forbidden for this credential'
      where id = ${connectionId}::uuid`;
    await shared!.admin`update subscription_connections set last_error = 'under investigation'
      where id = ${connectionId}::uuid`;
    expect(await health()).toMatchObject({ status: "error", has_retry: false });
    expect(await recoverSubscriptionCoreCodexConnectionHealth(client!.db, bystander.identity)).toBe(
      0,
    );
  });

  test("a plan-entitlement refusal cools the model down; a rotated id_token with a new plan clears it", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const connectionId = await sharedConnection(org, "plan");
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    expect(await place(turn)).toMatchObject({ kind: "run", connectionId });
    const ref = leaseOf(turn, connectionId);
    const until = new Date(Date.now() + 86_400_000);
    expect(
      await recordSubscriptionCoreCodexModelCooldown(client!.db, turn.identity, ref, {
        modelId: MODEL,
        until,
        refreshGeneration: 2,
      }),
    ).toBe(false);
    expect(
      await recordSubscriptionCoreCodexModelCooldown(client!.db, turn.identity, ref, {
        modelId: MODEL,
        until,
        refreshGeneration: 1,
      }),
    ).toBe(true);
    const next = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    expect(await place(next)).toMatchObject({
      kind: "wait",
      reason: "no_eligible_capacity",
      earliestResetAt: until,
    });

    // The same plan on refresh keeps the cooldown; a new plan clears it.
    const rotate = (label: string, plan: string) => ({
      refresh: async () => ({
        accessToken: `access-${label}`,
        refreshToken: `refresh-${label}`,
        idToken: idToken(plan),
      }),
    });
    expect(
      await refreshSubscriptionCoreCodexCredential(
        client!.db,
        settings,
        turn.identity,
        ref,
        1,
        rotate("same", "pro"),
      ),
    ).toMatchObject({ kind: "refreshed", planType: "pro", refreshGeneration: 2 });
    expect(await place(next)).toMatchObject({ kind: "wait" });
    expect(
      await refreshSubscriptionCoreCodexCredential(
        client!.db,
        settings,
        turn.identity,
        ref,
        2,
        rotate("upgraded", "plus"),
      ),
    ).toMatchObject({ kind: "refreshed", planType: "plus", refreshGeneration: 3 });
    const [stored] = await shared!.admin<{ plan_type: string; cooldowns: unknown }[]>`
      select connection.plan_type, quota.quota->'modelCooldowns' as cooldowns
      from subscription_connections connection
      join subscription_connection_quota quota on quota.connection_id = connection.id
      where connection.id = ${connectionId}::uuid`;
    expect(stored).toEqual({ plan_type: "plus", cooldowns: {} });
    expect(await place(next)).toMatchObject({ kind: "run", connectionId });
  });

  test("an explicit pin refused mid-turn waits on the pinned account instead of failing over", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const pinned = await sharedConnection(org, "pin-refused");
    const other = await sharedConnection(org, "pin-other");
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    const asTurn = <T>(fn: (db: Database) => Promise<T>) =>
      withSessionRlsActorContext(subscriptionCoreTurnActor(turn.identity), () =>
        withRlsContext(
          client!.db,
          { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
          fn,
        ),
      );
    await asTurn((db) =>
      writeSubscriptionSessionBinding(db, {
        accountId: org.accountId,
        workspaceId: org.sharedWorkspaceId,
        sessionId: turn.identity.sessionId,
        provider: "codex",
        connectionId: pinned,
        modelId: MODEL,
        choice: "explicit",
        onlyThisModel: false,
        lastModelCallAt: null,
        lastSwitchReason: "explicit_choice",
      }),
    );
    expect(await place(turn)).toMatchObject({ kind: "run", connectionId: pinned, explicit: true });
    // The pinned account refuses (a 403): recorded and quarantined as on any
    // core turn, then the same turn is placed again.
    const ref = leaseOf(turn, pinned);
    expect(
      await recordSubscriptionCoreCodexTurnFailure(client!.db, turn.identity, ref, {
        kind: "forbidden",
      }),
    ).toBe(true);
    expect(
      await quarantineSubscriptionCoreCodexConnection(client!.db, turn.identity, ref, {
        kind: "forbidden",
        refreshGeneration: 1,
      }),
    ).toBe(true);
    await asTurn((db) =>
      releaseSubscriptionTurnLease(db, { ...turn.identity, provider: "codex", ...ref }),
    );
    const replaced = await place(turn);
    expect(replaced).toMatchObject({
      kind: "wait",
      reason: "pinned_account_unavailable",
      explicitConnectionId: pinned,
    });
    if (replaced.kind !== "wait") throw new Error("expected wait");
    expect(replaced.healthRetryAt?.getTime()).toBeGreaterThan(Date.now());
    // It parks on the core waiter with the quarantine's end as its next check.
    const armed = await arm(turn, null);
    expect(armed).toMatchObject({ action: "waiting" });
    const [lease] = await shared!.admin<{ connection_id: string }[]>`
      select connection_id::text as connection_id from subscription_leases
      where turn_id = ${turn.identity.turnId}::uuid`;
    expect(lease).toBeUndefined();
    void other;
  });

  test("refusals accumulate per turn across connections and repeats", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const first = await sharedConnection(org, "count-a");
    const second = await sharedConnection(org, "count-b");
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    expect(await countSubscriptionCoreCodexTurnRefusals(client!.db, turn.identity)).toBe(0);
    const placed = await place(turn);
    if (placed.kind !== "run") throw new Error("expected placement");
    const ref = leaseOf(turn, placed.connectionId);
    for (const kind of ["quota", "quota"]) {
      expect(
        await recordSubscriptionCoreCodexTurnFailure(client!.db, turn.identity, ref, { kind }),
      ).toBe(true);
    }
    expect(await countSubscriptionCoreCodexTurnRefusals(client!.db, turn.identity)).toBe(2);
    // Re-place the same attempt on the other connection and refuse there too.
    const other = placed.connectionId === first ? second : first;
    await exhaust(org, placed.connectionId, Date.now() + 60_000);
    await shared!
      .admin`delete from subscription_leases where turn_id = ${turn.identity.turnId}::uuid`;
    expect(await place(turn)).toMatchObject({ kind: "run", connectionId: other });
    expect(
      await recordSubscriptionCoreCodexTurnFailure(
        client!.db,
        turn.identity,
        leaseOf(turn, other),
        {
          kind: "forbidden",
        },
      ),
    ).toBe(true);
    expect(await countSubscriptionCoreCodexTurnRefusals(client!.db, turn.identity)).toBe(3);
  });

  test("compaction since the last model call releases a warm automatic binding", async () => {
    expect(
      subscriptionCoreCodexReselectionPoints({
        binding: { modelId: MODEL, lastModelCallAt: 1 },
        productModelId: MODEL,
        lastContextReplacedAt: 2,
      }),
    ).toEqual(["compaction_completed"]);
    // A compaction before the last model call is already part of the warm prefix.
    expect(
      subscriptionCoreCodexReselectionPoints({
        binding: { modelId: MODEL, lastModelCallAt: 2 },
        productModelId: MODEL,
        lastContextReplacedAt: 1,
      }),
    ).toEqual([]);
    expect(
      subscriptionCoreCodexReselectionPoints({
        binding: { modelId: "codex/other", lastModelCallAt: 0 },
        productModelId: MODEL,
        lastContextReplacedAt: null,
      }),
    ).toEqual(["model_changed"]);
    expect(
      subscriptionCoreCodexReselectionPoints({
        binding: null,
        productModelId: MODEL,
        lastContextReplacedAt: 5,
      }),
    ).toEqual([]);

    const org = await organization();
    await enableCodexCutover(org.accountId);
    const bound = await sharedConnection(org, "bound");
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    expect(await place(turn)).toMatchObject({
      kind: "run",
      connectionId: bound,
      switch: "initial",
    });
    expect(
      await touchSubscriptionCoreCodexBinding(
        client!.db,
        turn.identity,
        leaseOf(turn, bound),
        new Date(),
      ),
    ).toBe(true);
    const primary = await sharedConnection(org, "primary");
    await shared!.admin`update subscription_settings
      set rotation = ${shared!.admin.json({ codex: { mode: "primary_first" } })}::jsonb,
        codex_primary_connection_id = ${primary}::uuid
      where account_id = ${org.accountId}::uuid and workspace_id is null`;
    await shared!.admin`update sessions set last_input_tokens = 1234
      where id = ${turn.identity.sessionId}::uuid`;
    // Warm and no re-selection point: the session stays where it is.
    expect(await evaluate(turn)).toMatchObject({
      kind: "run",
      connectionId: bound,
      switch: "sticky",
    });
    // An unknown input-token count (aggregate-usage fallback, no usage
    // reported) is not a compaction: the binding stays warm.
    await shared!.admin`update sessions set last_input_tokens = null
      where id = ${turn.identity.sessionId}::uuid`;
    expect(await evaluate(turn)).toMatchObject({
      kind: "run",
      connectionId: bound,
      switch: "sticky",
    });
    // The durable compaction event after the last model call is the marker.
    await shared!.admin`with bumped as (
        update sessions set last_sequence = last_sequence + 1
        where id = ${turn.identity.sessionId}::uuid
        returning account_id, workspace_id, id, last_sequence
      )
      insert into session_events (account_id, workspace_id, session_id, sequence, type, payload,
        occurred_at)
      select account_id, workspace_id, id, last_sequence, 'session.context.compacted',
        '{}'::jsonb, clock_timestamp() + interval '1 second'
      from bumped`;
    expect(await evaluate(turn)).toMatchObject({ kind: "run", connectionId: primary });
  });

  test("acceptance freezes Codex personal authority only for the owner's own private work", async () => {
    const org = await organization();
    await personalConnection(org, "owner-personal");
    const privateSession = await ownedSession(org, org.sharedWorkspaceId, "user_private");
    const sharedSession = await ownedSession(org, org.sharedWorkspaceId, "workspace_shared");
    const personalWorkspaceSession = await ownedSession(
      org,
      org.personalWorkspaceId,
      "workspace_shared",
    );
    const resolve = (
      workspaceId: string,
      sessionId: string,
      acceptingSubjectId: string | null,
      requestSubject = org.ownerSubjectId,
    ) =>
      withSessionRlsActorContext({ subjectId: requestSubject }, () =>
        withRlsContext(client!.db, { accountId: org.accountId, workspaceId }, (db) =>
          codexSubscriptionAuthorityV2ForAcceptanceInTransaction(db, {
            accountId: org.accountId,
            workspaceId,
            sessionId,
            acceptingSubjectId,
          }),
        ),
      );
    const personal = {
      version: 2 as const,
      personal: [
        {
          provider: "codex" as const,
          ownerMembershipId: org.ownerMembershipId,
          authorityGeneration: 1,
        },
      ],
    };
    const empty = { version: 2 as const, personal: [] };

    // Before the cutover nothing is written: v1 stays authoritative.
    expect(await resolve(org.sharedWorkspaceId, privateSession, org.ownerSubjectId)).toBeNull();
    await enableCodexCutover(org.accountId, false);
    expect(await resolve(org.sharedWorkspaceId, privateSession, org.ownerSubjectId)).toBeNull();
    await enableCodexCutover(org.accountId);

    expect(await resolve(org.sharedWorkspaceId, privateSession, org.ownerSubjectId)).toEqual(
      personal,
    );
    expect(
      await resolve(org.personalWorkspaceId, personalWorkspaceSession, org.ownerSubjectId),
    ).toEqual(personal);
    // Shared work, non-human acceptance, a different accepting human, or a
    // request subject that is not the accepting human freeze no personal authority.
    expect(await resolve(org.sharedWorkspaceId, sharedSession, org.ownerSubjectId)).toEqual(empty);
    expect(await resolve(org.sharedWorkspaceId, privateSession, null)).toEqual(empty);
    expect(await resolve(org.sharedWorkspaceId, privateSession, "user:someone-else")).toEqual(
      empty,
    );
    expect(
      await resolve(
        org.sharedWorkspaceId,
        privateSession,
        org.ownerSubjectId,
        "service:api-key-actor",
      ),
    ).toEqual(empty);

    // The real human-prompt path writes the same value on the accepted turn,
    // and non-human acceptance writes the empty value.
    const submit = (sessionId: string, actor: { type: "human" | "service"; subjectId: string }) =>
      withWorkspaceSubjectSessionActivityRls(
        client!.db,
        org.sharedWorkspaceId,
        actor.subjectId,
        (scoped) =>
          submitHumanPromptInTransaction(scoped, {
            accountId: org.accountId,
            workspaceId: org.sharedWorkspaceId,
            sessionId,
            subjectId: actor.subjectId,
            actor,
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "accepted authority fixture",
            resources: [],
            reasoningEffortFallback: "medium",
            source: actor.type === "human" ? "user" : "api",
          }),
      );
    await submit(privateSession, { type: "human", subjectId: org.ownerSubjectId });
    await submit(sharedSession, { type: "human", subjectId: org.ownerSubjectId });
    await submit(sharedSession, { type: "service", subjectId: "service:api-key-actor" });
    const accepted = await shared!.admin<
      { session_id: string; source: string; authority: unknown }[]
    >`
      select session_id::text as session_id, source, subscription_authority as authority
      from session_turns
      where session_id in (${privateSession}::uuid, ${sharedSession}::uuid) order by created_at`;
    expect(accepted.map((row) => [row.session_id, row.source, row.authority])).toEqual([
      [privateSession, "user", personal],
      [sharedSession, "user", empty],
      [sharedSession, "api", empty],
    ]);

    // Only the owner's serviceable personal Codex connections count: another
    // provider's re-grant or a connection waiting for a new sign-in cannot
    // make the Codex generation ambiguous.
    await personalConnection(org, "owner-claude", 2, { provider: "claude" });
    await personalConnection(org, "owner-relogin", 3, { status: "needs_relogin" });
    expect(await resolve(org.sharedWorkspaceId, privateSession, org.ownerSubjectId)).toEqual(
      personal,
    );
    // Codex connections with different current generations freeze nothing personal.
    await personalConnection(org, "owner-personal-2", 2);
    expect(await resolve(org.sharedWorkspaceId, privateSession, org.ownerSubjectId)).toEqual(empty);
  });

  test("the owner's initial message and its goal continuation carry the same frozen authority", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    await personalConnection(org, "goal-personal");
    const sessionId = await ownedSession(org, org.sharedWorkspaceId, "user_private");
    await initializeSessionStartAtomically(client!.db, {
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      sessionId,
      clientEventId: `initial:${sessionId}`,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      goal: { text: "Prove the frozen authority", mutationPolicy: "preserve_intent" },
    });
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client!.db, org.sharedWorkspaceId, {
      sessionId,
      workflowId: `session-${sessionId}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error("initial turn not claimed");
    const personal = {
      version: 2,
      personal: [
        { provider: "codex", ownerMembershipId: org.ownerMembershipId, authorityGeneration: 1 },
      ],
    };
    const authorityOf = async (turnId: string) => {
      const [row] = await shared!.admin<{ authority: unknown }[]>`
        select subscription_authority as authority from session_turns where id = ${turnId}::uuid`;
      return row!.authority;
    };
    expect(await authorityOf(claimed.turn.id)).toEqual(personal);
    const settled = await applySessionTurnSettlement(client!.db, org.sharedWorkspaceId, {
      sessionId,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: { reason: "test" } }],
    });
    expect(settled.action).toBe("settled");
    await materializeGoalContinuation(client!.db, {
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      sessionId,
      workflowId: `session-${sessionId}`,
      defaultMaxAutoContinuations: null,
      budgetBlocked: null,
      policy: {
        model: MODEL,
        reasoningEffort: "low",
        latencyMode: "standard" as const,
        tools: [],
        sandboxBackend: "none",
      },
      prompt: (goal, count) => `continue ${goal.text} (${count})`,
    });
    const continuation = await claimSessionWorkForAttempt(client!.db, org.sharedWorkspaceId, {
      sessionId,
      workflowId: `session-${sessionId}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (continuation.action !== "claimed") throw new Error("continuation not claimed");
    expect(continuation.turn.source).toBe("goal");
    expect(await authorityOf(continuation.turn.id)).toEqual(personal);
  });
});
