/**
 * A Codex core waiter parked behind a stored exhausted window whose reset is
 * days away re-reads `/wham/usage` while it waits, so an early provider reset
 * resumes the turn instead of leaving it parked until the stale reset. Real
 * PostgreSQL; only the provider's usage endpoint is stubbed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  armSubscriptionCoreCodexCapacityWait,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  encryptEnvironmentValue,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  evaluateSubscriptionCoreCodexPlacement,
  readSubscriptionCoreTurnIdentity,
  withSessionRlsActorContext,
  type DbClient,
  type SubscriptionCoreTurnIdentity,
} from "@opengeni/db";
import { reconcileCoreCodexCapacityWait } from "../src/activities/subscription-core-codex-waits";
import { resetCodexCoreUsageProbeAttempts } from "../src/activities/subscription-core-codex-quota";

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const key = Buffer.alloc(32, 41);
const settings = testSettings({ environmentsEncryptionKey: key.toString("base64") });
const MODEL = "codex/gpt-5.5";
const DAY = 86_400_000;

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("codex-capacity-reprobe");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

type Org = { accountId: string; ownerSubjectId: string; workspaceId: string };

async function organization(): Promise<Org> {
  const userId = `codex-reprobe-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Codex reprobe fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const ownerSubjectId = `user:${userId}`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'Codex reprobe workspace') returning id::text as id`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${workspace!.id}::uuid, ${ownerSubjectId}, 'owner')`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}::uuid, ${accountId}::uuid)`;
  await shared!.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${accountId}::uuid, 'codex', true)
    on conflict (account_id, provider) do update set enabled = true`;
  return { accountId, ownerSubjectId, workspaceId: workspace!.id };
}

async function sharedConnection(org: Org): Promise<string> {
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      provider_account_id, plan_type, provider_state, expires_at
    ) values (
      ${org.accountId}::uuid, 'codex', 'subscription',
      ${encryptEnvironmentValue(
        key,
        JSON.stringify({
          access_token: "access-reprobe",
          refresh_token: "refresh-reprobe",
          id_token: "id-reprobe",
        }),
      )},
      'shared', 'organization', 'chatgpt-reprobe', 'pro',
      ${shared!.admin.json({ isFedramp: false })}::jsonb,
      ${new Date(Date.now() + DAY).toISOString()}::timestamptz
    ) returning id::text as id`;
  await shared!.admin`
    insert into subscription_connection_assignment_policies (
      account_id, connection_id, workspace_id, inference_pool
    ) values (${org.accountId}::uuid, ${row!.id}::uuid, ${org.workspaceId}::uuid, 'organization')`;
  return row!.id;
}

/** The stored row as a usage read left it days ago: the weekly window exhausted. */
async function staleWeeklyExhaustion(
  org: Org,
  connectionId: string,
  resetsAt: number,
  refusal = false,
) {
  await shared!.admin`
    insert into subscription_connection_quota (
      account_id, connection_id, quota, observed_refresh_generation, revision, updated_at
    ) select ${org.accountId}::uuid, ${connectionId}::uuid, ${shared!.admin.json({
      windows: refusal
        ? []
        : [{ id: "secondary", status: "exhausted", resetsAt, usedPercent: 100 }],
      modelCooldowns: {},
      exhaustedUntil: refusal ? resetsAt : null,
      exhaustedKind: refusal ? "quota" : null,
      source: refusal ? "response_headers" : "usage_endpoint",
    })}::jsonb, connection.refresh_generation, 1, now() - interval '4 days'
    from subscription_connections connection where connection.id = ${connectionId}::uuid`;
}

async function runningTurn(org: Org) {
  const session = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
    createSession(client!.db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      initialMessage: "codex reprobe fixture",
      resources: [],
      metadata: {},
      model: MODEL,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      subjectId: org.ownerSubjectId,
      createdBy: { kind: "subject" as const, subjectId: org.ownerSubjectId },
      createdByContext: {},
    }),
  );
  const turn = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
    enqueueSessionTurn(client!.db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      sessionId: session.id,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${session.id}`,
      source: "user",
      prompt: "codex reprobe fixture",
      resources: [],
      tools: [],
      model: MODEL,
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator: { kind: "subject", subjectId: org.ownerSubjectId },
    }),
  );
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client!.db, org.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`claim failed: ${claimed.reason}`);
  const identity = await readSubscriptionCoreTurnIdentity(client!.db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    sessionId: session.id,
    turnId: turn.id,
  });
  if (!identity) throw new Error("accepted turn identity was not readable");
  return { identity, attemptId };
}

/** `/wham/usage` as the provider answers after an early reset: one weekly window at 55%. */
function stubEarlyResetUsage(
  resetsAt: number,
  usedPercent = 55,
  overrides: { allowed?: boolean; additionalLimitPercent?: number } = {},
): string[] {
  const calls: string[] = [];
  const original = globalThis.fetch;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes("/wham/usage")) return await original(input, init);
    calls.push(url);
    return Response.json({
      plan_type: "pro",
      rate_limit: {
        allowed: overrides.allowed ?? usedPercent < 100,
        limit_reached: usedPercent >= 100,
        primary_window: {
          used_percent: usedPercent,
          limit_window_seconds: 604_800,
          reset_at: Math.floor(resetsAt / 1000),
        },
        secondary_window: null,
      },
      ...(overrides.additionalLimitPercent === undefined
        ? {}
        : {
            additional_limits: [
              {
                limit_name: "feature",
                metered_feature: "feature",
                primary_window: {
                  used_percent: overrides.additionalLimitPercent,
                  limit_window_seconds: 18_000,
                  reset_at: Math.floor(resetsAt / 1000),
                },
                secondary_window: null,
              },
            ],
          }),
    });
  }) as typeof fetch);
  restoreFetch = () => fetchSpy.mockRestore();
  return calls;
}

async function storedQuota(connectionId: string) {
  const [row] = await shared!.admin<{ quota: { source: string; windows: unknown[] } }[]>`
    select quota from subscription_connection_quota where connection_id = ${connectionId}::uuid`;
  return row!.quota;
}

async function sessionStatus(identity: SubscriptionCoreTurnIdentity) {
  const [row] = await shared!.admin<{ session_status: string; turn_status: string }[]>`
    select session.status as session_status, turn.status as turn_status
    from sessions session join session_turns turn on turn.session_id = session.id
    where session.id = ${identity.sessionId}::uuid and turn.id = ${identity.turnId}::uuid`;
  return row!;
}

async function park(org: Org, resetAt: number) {
  const turn = await runningTurn(org);
  const armed = await armSubscriptionCoreCodexCapacityWait(client!.db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    sessionId: turn.identity.sessionId,
    turnId: turn.identity.turnId,
    attemptId: turn.attemptId,
    waitReason: "no_eligible_capacity",
    earliestResetAt: new Date(resetAt),
    failurePayload: { code: "subscription_capacity_unavailable" },
  });
  if (armed.action !== "waiting") throw new Error(`arm returned ${armed.action}`);
  return { turn, waiter: armed.waiter };
}

async function reconcile(org: Org, parked: Awaited<ReturnType<typeof park>>) {
  return await reconcileCoreCodexCapacityWait(
    { db: client!.db, bus: new MemoryEventBus(), settings },
    {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      sessionId: parked.turn.identity.sessionId,
      waiterId: parked.waiter.waiterId,
      generation: parked.waiter.generation,
    },
  );
}

describe.skipIf(!realDb)("Codex capacity waits re-read usage before a far reset", () => {
  test("an early provider reset resumes a turn parked behind a stale weekly exhaustion", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org);
    const staleReset = Date.now() + 2 * DAY;
    await staleWeeklyExhaustion(org, connectionId, staleReset);
    const turn = await runningTurn(org);

    const placement = await evaluateSubscriptionCoreCodexPlacement(client!.db, {
      identity: turn.identity,
      productModelId: MODEL,
      reasoningLevel: "medium",
    });
    expect(placement).toMatchObject({
      kind: "wait",
      reason: "no_eligible_capacity",
      earliestResetAt: new Date(staleReset),
    });
    if (placement.kind !== "wait") throw new Error("expected a wait");
    const armedAt = Date.now();
    const armed = await armSubscriptionCoreCodexCapacityWait(client!.db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      sessionId: turn.identity.sessionId,
      turnId: turn.identity.turnId,
      attemptId: turn.attemptId,
      waitReason: placement.reason,
      earliestResetAt: placement.earliestResetAt,
      failurePayload: { code: "subscription_capacity_unavailable" },
    });
    if (armed.action !== "waiting") throw new Error(`arm returned ${armed.action}`);
    // The waiter checks again on the bounded backoff, not at the stale reset.
    expect(armed.waiter.resetKind).toBe("bounded_refresh");
    expect(armed.waiter.nextCheckAt.getTime()).toBeLessThanOrEqual(armedAt + 15 * 60_000);

    const providerReset = Date.now() + 6 * DAY;
    const usageCalls = stubEarlyResetUsage(providerReset);
    const result = await reconcileCoreCodexCapacityWait(
      { db: client!.db, bus: new MemoryEventBus(), settings },
      {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        sessionId: turn.identity.sessionId,
        waiterId: armed.waiter.waiterId,
        generation: armed.waiter.generation,
      },
    );
    expect(usageCalls).toHaveLength(1);
    expect(await storedQuota(connectionId)).toMatchObject({
      source: "usage_endpoint",
      windows: [{ id: "secondary", usedPercent: 55, status: "ok" }],
    });
    expect(result).toEqual({ action: "resumed" });
    expect(await sessionStatus(turn.identity)).toMatchObject({ turn_status: "recovering" });
  });

  test("a recent reading is not re-read: provider calls stay bounded per connection", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org);
    const staleReset = Date.now() + 2 * DAY;
    await staleWeeklyExhaustion(org, connectionId, staleReset);
    // A reading taken a minute ago is fresh enough to trust.
    await shared!.admin`
      update subscription_connection_quota set updated_at = now() - interval '1 minute'
      where connection_id = ${connectionId}::uuid`;
    const turn = await runningTurn(org);
    const armed = await armSubscriptionCoreCodexCapacityWait(client!.db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      sessionId: turn.identity.sessionId,
      turnId: turn.identity.turnId,
      attemptId: turn.attemptId,
      waitReason: "no_eligible_capacity",
      earliestResetAt: new Date(staleReset),
      failurePayload: { code: "subscription_capacity_unavailable" },
    });
    if (armed.action !== "waiting") throw new Error(`arm returned ${armed.action}`);
    const usageCalls = stubEarlyResetUsage(Date.now() + 6 * DAY);
    const result = await reconcileCoreCodexCapacityWait(
      { db: client!.db, bus: new MemoryEventBus(), settings },
      {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        sessionId: turn.identity.sessionId,
        waiterId: armed.waiter.waiterId,
        generation: armed.waiter.generation,
      },
    );
    expect(usageCalls).toHaveLength(0);
    expect(result).toMatchObject({ action: "waiting" });
    expect(await sessionStatus(turn.identity)).toMatchObject({
      session_status: "waiting_capacity",
    });
  });

  test("a reading still at the limit is stored and not re-read again within the interval", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org);
    const staleReset = Date.now() + 2 * DAY;
    await staleWeeklyExhaustion(org, connectionId, staleReset);
    const parked = await park(org, staleReset);
    const usageCalls = stubEarlyResetUsage(staleReset, 100);
    expect(await reconcile(org, parked)).toMatchObject({ action: "waiting" });
    expect(usageCalls).toHaveLength(1);
    // Across workers (no in-process attempt record), the stored reading's age
    // alone keeps the connection from being read again.
    resetCodexCoreUsageProbeAttempts();
    expect(await reconcile(org, parked)).toMatchObject({ action: "waiting" });
    expect(usageCalls).toHaveLength(1);
    expect(await sessionStatus(parked.turn.identity)).toMatchObject({
      session_status: "waiting_capacity",
    });
  });

  test("a reading below the limit also ends a refusal's stored quota deadline", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org);
    const refusalDeadline = Date.now() + 2 * DAY;
    await staleWeeklyExhaustion(org, connectionId, refusalDeadline, true);
    const parked = await park(org, refusalDeadline);
    const usageCalls = stubEarlyResetUsage(Date.now() + 6 * DAY);
    expect(await reconcile(org, parked)).toEqual({ action: "resumed" });
    expect(usageCalls).toHaveLength(1);
    expect(await storedQuota(connectionId)).toMatchObject({ exhaustedUntil: null });
  });

  test.each([
    ["the account is still refused", { allowed: false }],
    ["a feature limit is spent", { additionalLimitPercent: 100 }],
  ] as const)(
    "a reading below the limit keeps a refusal's deadline when %s",
    async (_case, overrides) => {
      const org = await organization();
      const connectionId = await sharedConnection(org);
      const refusalDeadline = Date.now() + 2 * DAY;
      await staleWeeklyExhaustion(org, connectionId, refusalDeadline, true);
      const parked = await park(org, refusalDeadline);
      const usageCalls = stubEarlyResetUsage(Date.now() + 6 * DAY, 40, overrides);
      expect(await reconcile(org, parked)).toMatchObject({ action: "waiting" });
      expect(usageCalls).toHaveLength(1);
      // The reading is stored (so the interval holds), the refusal stands.
      expect(await storedQuota(connectionId)).toMatchObject({
        exhaustedUntil: refusalDeadline,
        exhaustedKind: "quota",
        windows: [{ id: "secondary", usedPercent: 40 }],
      });
      resetCodexCoreUsageProbeAttempts();
      expect(await reconcile(org, parked)).toMatchObject({ action: "waiting" });
      expect(usageCalls).toHaveLength(1);
    },
  );

  test("a probe that stores nothing is not repeated by every recheck in this worker", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org);
    const staleReset = Date.now() + 2 * DAY;
    await staleWeeklyExhaustion(org, connectionId, staleReset);
    const parked = await park(org, staleReset);
    const calls: string[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
    ) => {
      calls.push(input instanceof Request ? input.url : String(input));
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch);
    restoreFetch = () => fetchSpy.mockRestore();
    expect(await reconcile(org, parked)).toMatchObject({ action: "waiting" });
    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(await reconcile(org, parked)).toMatchObject({ action: "waiting" });
    expect(calls).toHaveLength(afterFirst);
  });
});
