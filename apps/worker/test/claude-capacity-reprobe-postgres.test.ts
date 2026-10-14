/**
 * A Claude core waiter parked behind a limit whose stored reset is days away
 * re-reads Anthropic's usage endpoint while it waits, so an early reset
 * resumes the turn instead of leaving it parked until the stale reset. A
 * Claude 429 leaves both an exhausted account window (response headers) and
 * a cooldown of the refused model (headers and refusal settlement); only a
 * reading that confirms availability ends either, and a cooldown ends only
 * when the plan windows its refusal claimed are reported below the limit.
 * Real PostgreSQL; only the usage endpoint is stubbed, and no model is called.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { parseClaudeUsageHeaders } from "@opengeni/config";
import {
  armSubscriptionCoreCapacityWait,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  decodeSubscriptionCoreClaudeQuota,
  encryptEnvironmentValue,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  readSubscriptionCoreTurnIdentity,
  SUBSCRIPTION_CORE_CLAUDE,
  subscriptionCoreOperationConnections,
  subscriptionCoreProvider,
  subscriptionCoreTurns,
  withSessionRlsActorContext,
  type DbClient,
  type SubscriptionCoreProvider,
  type SubscriptionCoreTurnIdentity,
} from "@opengeni/db";
import { reconcileCoreCapacityWait } from "../src/activities/subscription-core-codex-waits";
import { CLAUDE_CORE_WAIT_BINDING } from "../src/activities/subscription-core-claude-waits";
// The Codex seam resets every provider's probe attempts (one shared limiter).
import { resetCodexCoreUsageProbeAttempts as resetCoreUsageProbeAttempts } from "../src/activities/subscription-core-codex-quota";
import { refreshBlockedCoreQuotaBeforeReconcile } from "../src/activities/subscription-core-usage-recheck";

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const key = Buffer.alloc(32, 43);
const settings = testSettings({ environmentsEncryptionKey: key.toString("base64") });
const CLAUDE = SUBSCRIPTION_CORE_CLAUDE as SubscriptionCoreProvider;
const UPSTREAM_MODEL = "claude-opus-4-6";
const MODEL = `organization-claude-subscription/${UPSTREAM_MODEL}`;
const WORKSPACE_MODEL = `workspace-claude-subscription/${UPSTREAM_MODEL}`;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const DAY = 86_400_000;

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("claude-capacity-reprobe");
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
  resetCoreUsageProbeAttempts();
});

type Org = { accountId: string; ownerSubjectId: string; workspaceId: string };

async function organization(): Promise<Org> {
  const userId = `claude-reprobe-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Claude reprobe fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const ownerSubjectId = `user:${userId}`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'Claude reprobe workspace') returning id::text as id`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${workspace!.id}::uuid, ${ownerSubjectId}, 'owner')`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}::uuid, ${accountId}::uuid)`;
  await shared!.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${accountId}::uuid, 'claude', true)
    on conflict (account_id, provider) do update set enabled = true`;
  return { accountId, ownerSubjectId, workspaceId: workspace!.id };
}

/** An organization Claude OAuth connection whose token is far from expiry (no refresh). */
async function sharedConnection(
  org: Org,
  scopes = ["user:inference", "user:profile"],
  workspaceIds: string[] | null = null,
) {
  const label = `claude-reprobe-${crypto.randomUUID()}`;
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      allow_personal_workspaces, provider_account_id, provider_subject_id, label, expires_at
    ) values (
      ${org.accountId}::uuid, 'claude', 'subscription',
      ${encryptEnvironmentValue(
        key,
        CLAUDE.adapter.credential.encode({
          version: 1,
          token: `sk-ant-oat01-${label}`,
          identity: { accountUuid: crypto.randomUUID(), deviceId: "d".repeat(64) },
          oauth: {
            refreshToken: `refresh-${label}`,
            expiresAt: new Date(Date.now() + DAY).toISOString(),
            scopes,
          },
        }),
      )},
      'shared', ${workspaceIds ? "workspaces" : "organization"}, ${!workspaceIds},
      ${label}, ${label}, ${label},
      ${new Date(Date.now() + DAY).toISOString()}::timestamptz
    ) returning id::text as id`;
  for (const workspaceId of workspaceIds ?? [])
    await shared!.admin`
      insert into subscription_connection_workspaces (account_id, connection_id, workspace_id)
      values (${org.accountId}::uuid, ${row!.id}::uuid, ${workspaceId}::uuid)`;
  return row!.id;
}

/**
 * The stored row a Claude 429 left days ago: the weekly account window
 * rejected until a far reset, and the refused model cooled until then (both
 * of its product ids, as the header decoder writes them), each cooldown
 * claiming the plan windows in `claims` (default: the weekly window; a model
 * missing from it has no claim).
 */
async function staleClaudeLimit(
  org: Org,
  connectionId: string,
  resetsAt: number,
  options: {
    window?: boolean;
    cooldowns?: Record<string, number>;
    claims?: Record<string, readonly string[]>;
  } = {},
) {
  const cooldowns = options.cooldowns ?? { [MODEL]: resetsAt, [WORKSPACE_MODEL]: resetsAt };
  const claims =
    options.claims ??
    Object.fromEntries(Object.keys(cooldowns).map((modelId) => [modelId, ["seven_day"]]));
  const observedAt = Date.now() - 4 * DAY;
  await shared!.admin`
    insert into subscription_connection_quota (
      account_id, connection_id, quota, observed_refresh_generation, revision, updated_at
    ) select ${org.accountId}::uuid, ${connectionId}::uuid, ${shared!.admin.json({
      windows:
        options.window === false
          ? []
          : [{ id: "seven_day", status: "exhausted", resetsAt, usedPercent: 100 }],
      modelCooldowns: cooldowns,
      modelCooldownClaims: Object.fromEntries(
        Object.entries(claims).map(([modelId, windowIds]) => [
          modelId,
          { until: cooldowns[modelId], observedAt, windowIds },
        ]),
      ),
      exhaustedUntil: null,
      exhaustedKind: null,
      source: "response_headers",
    } as never)}::jsonb, connection.refresh_generation, 1, now() - interval '4 days'
    from subscription_connections connection where connection.id = ${connectionId}::uuid`;
}

/**
 * The quota the real header decoder writes for one refused request of the
 * Opus model at `refusedAt` (the unified rate-limit headers of its 429, with
 * `extra` overriding them), its reset `staleReset`.
 */
function refusalQuota(staleReset: number, refusedAt: Date, extra: Record<string, string>) {
  const observation = parseClaudeUsageHeaders(
    new Headers({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": String(staleReset / 1000),
      "anthropic-ratelimit-unified-5h-utilization": "0.03",
      "anthropic-ratelimit-unified-7d-utilization": "0.41",
      ...extra,
    }),
    refusedAt,
    UPSTREAM_MODEL,
  );
  if (!observation) throw new Error("the refusal headers did not parse");
  return decodeSubscriptionCoreClaudeQuota({
    observation,
    refreshGeneration: 0,
    upstreamModelIds: [UPSTREAM_MODEL],
  });
}

/** Stores a quota document as the core writer stores it, observed 4 days ago. */
async function storeQuota(org: Org, connectionId: string, quota: Record<string, unknown>) {
  const { windows, modelCooldowns, modelCooldownClaims, exhaustedUntil, exhaustedKind, source } =
    quota;
  await shared!.admin`
    insert into subscription_connection_quota (
      account_id, connection_id, quota, observed_refresh_generation, revision, updated_at
    ) select ${org.accountId}::uuid, ${connectionId}::uuid, ${shared!.admin.json({
      windows,
      modelCooldowns,
      ...(modelCooldownClaims ? { modelCooldownClaims } : {}),
      exhaustedUntil,
      exhaustedKind,
      source,
    } as never)}::jsonb, connection.refresh_generation, 1, now() - interval '4 days'
    from subscription_connections connection where connection.id = ${connectionId}::uuid`;
}

/** Ages the stored reading past the per-connection re-read interval. */
async function ageReading(connectionId: string) {
  await shared!.admin`
    update subscription_connection_quota set updated_at = now() - interval '4 days'
    where connection_id = ${connectionId}::uuid`;
}

/**
 * A claimed running turn in `org.workspaceId`. `frozen` replaces the turn's
 * accepted subscription authority (immutable, so written with triggers
 * suspended): these tests exercise the re-read's authorization, not the
 * acceptance writers.
 */
async function runningTurn(org: Org, model = MODEL, frozen?: unknown) {
  const session = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
    createSession(client!.db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      initialMessage: "claude reprobe fixture",
      resources: [],
      metadata: {},
      model,
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
      prompt: "claude reprobe fixture",
      resources: [],
      tools: [],
      model,
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator: { kind: "subject", subjectId: org.ownerSubjectId },
    }),
  );
  if (frozen !== undefined)
    await shared!.admin.begin(async (admin) => {
      await admin`set local session_replication_role = replica`;
      await admin`update session_turns set subscription_authority = ${admin.json(frozen as never)}::jsonb
        where id = ${turn.id}::uuid`;
    });
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
  return { identity, attemptId, executionGeneration: claimed.turn.executionGeneration };
}

type UsageWindow = { utilization: number; resets_at: string | null } | null;

/** `/api/oauth/usage` as Anthropic answers after an early reset (overridable per window). */
function stubUsage(
  body: Record<string, UsageWindow> = {},
  respond?: () => Response,
): { calls: string[]; authorizations: (string | null)[] } {
  const calls: string[] = [];
  const authorizations: (string | null)[] = [];
  const original = globalThis.fetch;
  const later = new Date(Date.now() + 6 * DAY).toISOString();
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://api.anthropic.com/")) return await original(input, init);
    if (url !== USAGE_URL) throw new Error(`unexpected Anthropic call ${url}`);
    calls.push(url);
    authorizations.push(new Headers(init?.headers).get("authorization"));
    if (respond) return respond();
    return Response.json({
      five_hour: { utilization: 3, resets_at: later },
      seven_day: { utilization: 41, resets_at: later },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 12, resets_at: later },
      ...body,
    });
  }) as typeof fetch);
  restoreFetch = () => fetchSpy.mockRestore();
  return { calls, authorizations };
}

async function storedQuota(connectionId: string) {
  const [row] = await shared!.admin<
    {
      quota: {
        source: string;
        windows: { id: string; status: string; usedPercent: number | null }[];
        modelCooldowns: Record<string, number>;
        modelCooldownClaims?: Record<
          string,
          { until: number; observedAt: number; windowIds: string[] }
        >;
      };
    }[]
  >`select quota from subscription_connection_quota where connection_id = ${connectionId}::uuid`;
  return row!.quota;
}

async function sessionStatus(identity: SubscriptionCoreTurnIdentity) {
  const [row] = await shared!.admin<{ session_status: string; turn_status: string }[]>`
    select session.status as session_status, turn.status as turn_status
    from sessions session join session_turns turn on turn.session_id = session.id
    where session.id = ${identity.sessionId}::uuid and turn.id = ${identity.turnId}::uuid`;
  return row!;
}

async function park(org: Org, staleReset: number) {
  const turn = await runningTurn(org);
  const placement = await subscriptionCoreTurns(CLAUDE).evaluateSubscriptionCorePlacement(
    client!.db,
    { identity: turn.identity, productModelId: MODEL, reasoningLevel: "medium" },
  );
  expect(placement).toMatchObject({ kind: "wait", earliestResetAt: new Date(staleReset) });
  if (placement.kind !== "wait") throw new Error("expected a wait");
  const armedAt = Date.now();
  const armed = await armSubscriptionCoreCapacityWait(client!.db, "claude", {
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
  return { turn, waiter: armed.waiter, armedAt };
}

async function reconcile(org: Org, parked: Awaited<ReturnType<typeof park>>) {
  return await reconcileCoreCapacityWait(
    { db: client!.db, bus: new MemoryEventBus(), settings },
    CLAUDE_CORE_WAIT_BINDING,
    {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      sessionId: parked.turn.identity.sessionId,
      waiterId: parked.waiter.waiterId,
      generation: parked.waiter.generation,
    },
  );
}

describe.skipIf(!realDb)("Claude capacity waits re-read usage before a far reset", () => {
  test("an early provider reset resumes a turn parked behind a stale weekly limit and model cooldown", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org);
    const staleReset = Date.now() + 2 * DAY;
    await staleClaudeLimit(org, connectionId, staleReset);
    const parked = await park(org, staleReset);
    // The waiter checks again on the bounded backoff, not at the stale reset.
    expect(parked.waiter.resetKind).toBe("bounded_refresh");
    expect(parked.waiter.nextCheckAt.getTime()).toBeLessThanOrEqual(parked.armedAt + 15 * 60_000);

    const usage = stubUsage();
    expect(await reconcile(org, parked)).toEqual({ action: "resumed" });
    expect(usage.calls).toHaveLength(1);
    // The read used the connection's stored bearer; nothing was refreshed.
    expect(usage.authorizations[0]).toStartWith("Bearer sk-ant-oat01-claude-reprobe-");
    const quota = await storedQuota(connectionId);
    expect(quota.source).toBe("usage_endpoint");
    expect(quota.windows).toContainEqual(
      expect.objectContaining({ id: "seven_day", usedPercent: 41, status: "ok" }),
    );
    expect(quota.modelCooldowns).toEqual({});
    expect(await sessionStatus(parked.turn.identity)).toMatchObject({
      turn_status: "recovering",
    });
  });

  test("a recent reading is not re-read, and a reading at the limit is not re-read within the interval", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org);
    const staleReset = Date.now() + 2 * DAY;
    await staleClaudeLimit(org, connectionId, staleReset);
    const parked = await park(org, staleReset);
    await shared!.admin`
      update subscription_connection_quota set updated_at = now() - interval '1 minute'
      where connection_id = ${connectionId}::uuid`;
    const usage = stubUsage({ seven_day: { utilization: 100, resets_at: null } });
    expect(await reconcile(org, parked)).toMatchObject({ action: "waiting" });
    expect(usage.calls).toHaveLength(0);

    await shared!.admin`
      update subscription_connection_quota set updated_at = now() - interval '4 days'
      where connection_id = ${connectionId}::uuid`;
    resetCoreUsageProbeAttempts();
    expect(await reconcile(org, parked)).toMatchObject({ action: "waiting" });
    expect(usage.calls).toHaveLength(1);
    // Across workers (no in-process attempt record), the stored reading's age
    // alone keeps the connection from being read again.
    resetCoreUsageProbeAttempts();
    expect(await reconcile(org, parked)).toMatchObject({ action: "waiting" });
    expect(usage.calls).toHaveLength(1);
    expect((await storedQuota(connectionId)).modelCooldowns).toMatchObject({
      [MODEL]: staleReset,
    });
    expect(await sessionStatus(parked.turn.identity)).toMatchObject({
      session_status: "waiting_capacity",
    });
  });

  test("a probe that stores nothing is not repeated by every recheck in this worker", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org);
    const staleReset = Date.now() + 2 * DAY;
    await staleClaudeLimit(org, connectionId, staleReset);
    const parked = await park(org, staleReset);
    const usage = stubUsage({}, () => new Response("unavailable", { status: 503 }));
    expect(await reconcile(org, parked)).toMatchObject({ action: "waiting" });
    expect(usage.calls).toHaveLength(1);
    expect(await reconcile(org, parked)).toMatchObject({ action: "waiting" });
    expect(usage.calls).toHaveLength(1);
    expect((await storedQuota(connectionId)).modelCooldowns).toMatchObject({
      [MODEL]: staleReset,
    });
  });

  test.each([
    ["omits the weekly account window", { seven_day: undefined }],
    ["reports the weekly account window without a percentage", { seven_day: null }],
    ["omits the claimed family window", { seven_day_opus: undefined }],
    // The plan has no Opus limit now, but that never shows the limit that
    // refused the model has reset.
    ["answers the claimed family window as null", {}],
    [
      "reports the claimed family window at the limit",
      { seven_day_opus: { utilization: 100, resets_at: null } },
    ],
  ] as const)("a reading that %s keeps the refused model cooled", async (_case, override) => {
    const org = await organization();
    const connectionId = await sharedConnection(org);
    const staleReset = Date.now() + 2 * DAY;
    await staleClaudeLimit(org, connectionId, staleReset, {
      window: false,
      claims: { [MODEL]: ["seven_day_opus"], [WORKSPACE_MODEL]: ["seven_day_opus"] },
    });
    const parked = await park(org, staleReset);
    const later = new Date(Date.now() + 6 * DAY).toISOString();
    const original = globalThis.fetch;
    const calls: string[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://api.anthropic.com/")) return await original(input, init);
      calls.push(url);
      const body: Record<string, unknown> = {
        five_hour: { utilization: 3, resets_at: later },
        seven_day: { utilization: 41, resets_at: later },
        seven_day_opus: null,
        ...override,
      };
      for (const [id, value] of Object.entries(body)) if (value === undefined) delete body[id];
      return Response.json(body);
    }) as typeof fetch);
    restoreFetch = () => fetchSpy.mockRestore();
    expect(await reconcile(org, parked)).toMatchObject({ action: "waiting" });
    expect(calls).toHaveLength(1);
    expect((await storedQuota(connectionId)).modelCooldowns).toMatchObject({
      [MODEL]: expect.any(Number),
    });
    expect(await sessionStatus(parked.turn.identity)).toMatchObject({
      session_status: "waiting_capacity",
    });
  });

  test("a reading below the limit ends only the cooldowns it covers", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org);
    const staleReset = Date.now() + 2 * DAY;
    const sonnet = "organization-claude-subscription/claude-sonnet-4-6";
    await staleClaudeLimit(org, connectionId, staleReset, {
      window: false,
      cooldowns: { [MODEL]: staleReset, [sonnet]: staleReset, "codex/gpt-5.5": staleReset },
      claims: { [MODEL]: ["five_hour"], [sonnet]: ["seven_day_sonnet"] },
    });
    const parked = await park(org, staleReset);
    // The Sonnet weekly window the Sonnet cooldown claims is still full, so
    // it stands; a cooldown without a claim never ends early.
    stubUsage({
      seven_day_sonnet: { utilization: 100, resets_at: new Date(staleReset).toISOString() },
    });
    expect(await reconcile(org, parked)).toEqual({ action: "resumed" });
    const cooldowns = (await storedQuota(connectionId)).modelCooldowns;
    expect(cooldowns[MODEL]).toBeUndefined();
    expect(cooldowns[sonnet]).toBe(staleReset);
    expect(cooldowns["codex/gpt-5.5"]).toBe(staleReset);
  });

  test("a sign-in without the usage scope is never read and stays parked", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org, ["user:inference"]);
    const staleReset = Date.now() + 2 * DAY;
    await staleClaudeLimit(org, connectionId, staleReset);
    const parked = await park(org, staleReset);
    const usage = stubUsage();
    expect(await reconcile(org, parked)).toMatchObject({ action: "waiting" });
    expect(usage.calls).toHaveLength(0);
  });

  test("another organization's exhausted Claude connection is never read for this turn", async () => {
    const org = await organization();
    const other = await organization();
    const own = await sharedConnection(org);
    const foreign = await sharedConnection(other);
    const staleReset = Date.now() + 2 * DAY;
    await staleClaudeLimit(org, own, staleReset);
    await staleClaudeLimit(other, foreign, staleReset);
    const parked = await park(org, staleReset);
    const usage = stubUsage();
    expect(await reconcile(org, parked)).toEqual({ action: "resumed" });
    expect(usage.calls).toHaveLength(1);
    expect((await storedQuota(foreign)).modelCooldowns).toMatchObject({ [MODEL]: staleReset });
    expect((await storedQuota(foreign)).source).toBe("response_headers");
  });

  test("a connection assigned only to another workspace is never read for this turn", async () => {
    const org = await organization();
    const [elsewhere] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${org.accountId}::uuid, 'Claude reprobe elsewhere') returning id::text as id`;
    const own = await sharedConnection(org);
    const scoped = await sharedConnection(org, undefined, [elsewhere!.id]);
    const staleReset = Date.now() + 2 * DAY;
    await staleClaudeLimit(org, own, staleReset);
    await staleClaudeLimit(org, scoped, staleReset);
    const parked = await park(org, staleReset);
    const usage = stubUsage();
    expect(await reconcile(org, parked)).toEqual({ action: "resumed" });
    expect(usage.calls).toHaveLength(1);
    expect((await storedQuota(scoped)).source).toBe("response_headers");
  });
});

describe.skipIf(!realDb)("Claude capacity waits end only the limits a refusal claimed", () => {
  /** One usage-endpoint body: both account windows well below the limit, no Opus limit. */
  const recovered = {
    seven_day_opus: null,
  } as const;

  const cases: [string, Record<string, string>, boolean, number][] = [
    [
      "a five-hour claim the reading shows below the limit ends (control)",
      {
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
        "anthropic-ratelimit-unified-5h-utilization": "1.0",
      },
      true,
      1,
    ],
    [
      "a representative claim this build does not recognize stays parked, unread",
      { "anthropic-ratelimit-unified-representative-claim": "seven_day_new_limit" },
      false,
      0,
    ],
    ["a rejected status without a representative claim stays parked, unread", {}, false, 0],
    [
      "an Opus weekly claim at 100% stays parked when the reading answers it as null",
      {
        "anthropic-ratelimit-unified-representative-claim": "seven_day_opus",
        "anthropic-ratelimit-unified-7d-opus-utilization": "1.0",
      },
      false,
      1,
    ],
  ];
  test.each(cases)("%s", async (_name, headers, resumed, reads) => {
    const org = await organization();
    const connectionId = await sharedConnection(org);
    const staleReset = Math.floor((Date.now() + 2 * DAY) / 1000) * 1000;
    // The quota the real header decoder writes for that one 429.
    const quota = refusalQuota(staleReset, new Date(Date.now() - 4 * DAY), headers);
    expect(quota.modelCooldowns[MODEL]).toBe(staleReset);
    await storeQuota(org, connectionId, quota);
    const parked = await park(org, staleReset);
    const usage = stubUsage(recovered);
    const result = await reconcile(org, parked);
    expect(usage.calls).toHaveLength(reads);
    if (resumed) {
      expect(result).toEqual({ action: "resumed" });
      expect((await storedQuota(connectionId)).modelCooldowns[MODEL]).toBeUndefined();
    } else {
      expect(result).toMatchObject({ action: "waiting" });
      expect((await storedQuota(connectionId)).modelCooldowns[MODEL]).toBe(staleReset);
      expect(await sessionStatus(parked.turn.identity)).toMatchObject({
        session_status: "waiting_capacity",
      });
    }
  });

  test("a header-less 429's settlement cooldown is never ended by a reading", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org);
    const until = Date.now() + 3_600_000;
    const later = Date.now() + 6 * DAY;
    // An older reading below the limit, plus the cooldown the settlement
    // writer adds for a 429 without unified headers (no claim).
    await storeQuota(org, connectionId, {
      windows: [
        { id: "five_hour", usedPercent: 3, resetsAt: later, status: "ok" },
        { id: "seven_day", usedPercent: 41, resetsAt: later, status: "ok" },
      ],
      modelCooldowns: { [MODEL]: until },
      exhaustedUntil: null,
      exhaustedKind: null,
      source: "usage_endpoint",
    });
    const parked = await park(org, until);
    const usage = stubUsage(recovered);
    expect(await reconcile(org, parked)).toMatchObject({ action: "waiting" });
    expect(usage.calls).toHaveLength(0);
    expect((await storedQuota(connectionId)).modelCooldowns[MODEL]).toBe(until);
  });

  test("an unexplained cooldown never loops the turn into the false-resumption stop", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org);
    const staleReset = Math.floor((Date.now() + 2 * DAY) / 1000) * 1000;
    // A refusal naming no limit this build recognizes, while the weekly
    // account window was full until the same far reset.
    const quota = refusalQuota(staleReset, new Date(Date.now() - 4 * DAY), {
      "anthropic-ratelimit-unified-representative-claim": "seven_day_new_limit",
      "anthropic-ratelimit-unified-7d-utilization": "1.0",
      "anthropic-ratelimit-unified-7d-reset": String(staleReset / 1000),
    });
    expect(quota.windows).toContainEqual(
      expect.objectContaining({ id: "seven_day", status: "exhausted" }),
    );
    expect(quota.modelCooldownClaims?.[MODEL]).toBeUndefined();
    await storeQuota(org, connectionId, quota);
    const parked = await park(org, staleReset);
    const usage = stubUsage(recovered);
    // More rechecks than the false-resumption limit (10): none resumes, so
    // none can count toward the terminal stop.
    for (let round = 0; round < 12; round += 1) {
      await ageReading(connectionId);
      resetCoreUsageProbeAttempts();
      expect(await reconcile(org, parked)).toMatchObject({ action: "waiting" });
    }
    // One read ended the weekly window; the cooldown it cannot explain is
    // never read for again.
    expect(usage.calls).toHaveLength(1);
    const stored = await storedQuota(connectionId);
    expect(stored.windows).toContainEqual(
      expect.objectContaining({ id: "seven_day", status: "ok" }),
    );
    expect(stored.modelCooldowns[MODEL]).toBe(staleReset);
    expect(await sessionStatus(parked.turn.identity)).toMatchObject({
      session_status: "waiting_capacity",
      turn_status: "running",
    });
    const [turn] = await shared!.admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from session_turns where id = ${parked.turn.identity.turnId}::uuid`;
    expect(
      (turn!.metadata.codexCapacityRecoveryV1 as { falseResumptions?: number } | undefined)
        ?.falseResumptions ?? 0,
    ).toBe(0);
  });

  test("a refusal's settlement keeps its own header claim; a later refusal without one drops it", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org);
    const turn = await runningTurn(org);
    const runtime = subscriptionCoreTurns(CLAUDE);
    const holderId = `claude-turn:${turn.identity.sessionId}:${turn.identity.turnId}:${turn.attemptId}`;
    expect(
      await runtime.placeSubscriptionCoreTurn(client!.db, {
        identity: turn.identity,
        attemptId: turn.attemptId,
        executionGeneration: turn.executionGeneration,
        holderId,
        productModelId: MODEL,
        reasoningLevel: "medium",
        leaseTtlMs: 60_000,
      }),
    ).toMatchObject({ kind: "run", connectionId });
    const ref = { connectionId, holderId, generation: turn.executionGeneration };
    const [connection] = await shared!.admin<{ refresh_generation: string }[]>`
      select refresh_generation::text from subscription_connections where id = ${connectionId}::uuid`;
    const refreshGeneration = Number(connection!.refresh_generation);
    const staleReset = Math.floor((Date.now() + 2 * DAY) / 1000) * 1000;
    // The refused response's headers are joined first (the refusal path
    // joins observations before it settles).
    const refusedAt = Date.now() - 5_000;
    const header = refusalQuota(staleReset, new Date(refusedAt), {
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-5h-utilization": "1.0",
      "anthropic-ratelimit-unified-5h-reset": String(staleReset / 1000),
    });
    expect(
      await runtime.applySubscriptionCoreQuotaObservation(client!.db, turn.identity, ref, {
        ...header,
        observedRefreshGeneration: refreshGeneration,
        revision: 0,
      }),
    ).toMatchObject({ applied: true });
    // The same 429's settlement: its retry-after rounds the deadline up.
    expect(
      await runtime.recordSubscriptionCoreModelCooldown(client!.db, turn.identity, ref, {
        modelId: MODEL,
        until: new Date(staleReset + 1_500),
        refreshGeneration,
        refusedAt: Date.now(),
      }),
    ).toBe(true);
    // A later 429 without usage headers for the other product id: its own
    // deadline is earlier, but it still drops the older claim.
    expect(
      await runtime.recordSubscriptionCoreModelCooldown(client!.db, turn.identity, ref, {
        modelId: WORKSPACE_MODEL,
        until: new Date(staleReset - 60_000),
        refreshGeneration,
        refusedAt: Date.now() + 10 * 60_000,
      }),
    ).toBe(true);
    const stored = await storedQuota(connectionId);
    expect(stored.modelCooldowns).toMatchObject({
      [MODEL]: staleReset + 1_500,
      [WORKSPACE_MODEL]: staleReset,
    });
    expect(stored.modelCooldownClaims?.[MODEL]).toEqual({
      until: staleReset + 1_500,
      observedAt: refusedAt,
      windowIds: ["five_hour"],
    });
    expect(stored.modelCooldownClaims?.[WORKSPACE_MODEL]).toBeUndefined();

    // A reading that shows the five-hour window reset ends the claimed
    // cooldown and keeps the unexplained one.
    const usage = stubUsage(recovered);
    expect(
      await subscriptionCoreOperationConnections(CLAUDE).refreshExhaustedSubscriptionCoreQuota(
        client!.db,
        settings,
        {
          kind: "workspace",
          accountId: org.accountId,
          workspaceId: org.workspaceId,
          subjectId: "service:subscription-core",
        },
        { minIntervalMs: 0 },
      ),
    ).toEqual([connectionId]);
    expect(usage.calls).toHaveLength(1);
    const after = await storedQuota(connectionId);
    expect(after.modelCooldowns[MODEL]).toBeUndefined();
    expect(after.modelCooldowns[WORKSPACE_MODEL]).toBe(staleReset);
    expect(after.modelCooldownClaims).toBeUndefined();
  });

  test("a personal Claude turn's recheck ends its owner's claimed cooldown, never an unexplained one", async () => {
    const org = await organization();
    const [membership] = await shared!.admin<{ id: string; personal_workspace_id: string }[]>`
      select id::text as id, personal_workspace_id::text as personal_workspace_id
      from organization_memberships
      where account_id = ${org.accountId}::uuid and subject_id = ${org.ownerSubjectId}
        and status = 'active' and revoked_at is null limit 1`;
    const personalWorkspaceId = membership!.personal_workspace_id;
    const connectionId = crypto.randomUUID();
    const authorityId = crypto.randomUUID();
    const label = `claude-personal-${connectionId}`;
    await shared!.admin`
      insert into organization_user_resource_authorities (
        id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
      ) values (
        ${authorityId}::uuid, ${org.accountId}::uuid, ${membership!.id}::uuid,
        'subscription_connection', ${connectionId}::uuid, 1, 'active'
      )`;
    await shared!.admin`
      insert into subscription_connections (
        id, account_id, provider, kind, credential_encrypted, ownership, scope_kind,
        owner_organization_membership_id, owner_subject_id, authority_id,
        authority_resource_kind, authority_generation, provider_account_id,
        provider_subject_id, provider_state, expires_at, label
      ) values (
        ${connectionId}::uuid, ${org.accountId}::uuid, 'claude', 'subscription',
        ${encryptEnvironmentValue(
          key,
          CLAUDE.adapter.credential.encode({
            version: 1,
            token: `sk-ant-oat01-${label}`,
            identity: { accountUuid: crypto.randomUUID(), deviceId: "d".repeat(64) },
            oauth: {
              refreshToken: `refresh-${label}`,
              expiresAt: new Date(Date.now() + DAY).toISOString(),
              scopes: ["user:inference", "user:profile"],
            },
          }),
        )}, 'personal', 'people', ${membership!.id}::uuid, ${org.ownerSubjectId},
        ${authorityId}::uuid, 'subscription_connection', 1, ${label}, ${label}, '{}'::jsonb,
        ${new Date(Date.now() + DAY).toISOString()}::timestamptz, ${label}
      )`;
    const staleReset = Date.now() + 2 * DAY;
    const sonnet = "organization-claude-subscription/claude-sonnet-4-6";
    await staleClaudeLimit(org, connectionId, staleReset, {
      cooldowns: { [MODEL]: staleReset, [sonnet]: staleReset },
      claims: { [MODEL]: ["seven_day"] },
    });
    const personalOrg = { ...org, workspaceId: personalWorkspaceId };
    const turn = await runningTurn(personalOrg, MODEL, {
      version: 2,
      personal: [{ provider: "claude", ownerMembershipId: membership!.id, authorityGeneration: 1 }],
    });
    const usage = stubUsage();
    await refreshBlockedCoreQuotaBeforeReconcile({
      provider: CLAUDE,
      db: client!.db,
      settings,
      accountId: org.accountId,
      workspaceId: personalWorkspaceId,
      personalTurn: turn.identity,
    });
    // One read as the owner's own connection.
    expect(usage.authorizations).toEqual([`Bearer sk-ant-oat01-${label}`]);
    const stored = await storedQuota(connectionId);
    expect(stored.source).toBe("usage_endpoint");
    expect(stored.modelCooldowns[MODEL]).toBeUndefined();
    expect(stored.modelCooldowns[sonnet]).toBe(staleReset);
  });

  test("another provider's recheck neither reads Claude nor spends Claude's probe attempt", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org);
    const staleReset = Date.now() + 2 * DAY;
    await staleClaudeLimit(org, connectionId, staleReset);
    const parked = await park(org, staleReset);
    const usage = stubUsage();
    // The same workspace's Codex recheck (no Codex connection here) runs
    // first, in the same worker.
    await refreshBlockedCoreQuotaBeforeReconcile({
      provider: subscriptionCoreProvider("codex"),
      db: client!.db,
      settings,
      accountId: org.accountId,
      workspaceId: org.workspaceId,
    });
    expect(usage.calls).toHaveLength(0);
    expect((await storedQuota(connectionId)).source).toBe("response_headers");
    // Claude's own recheck still reads its connection.
    expect(await reconcile(org, parked)).toEqual({ action: "resumed" });
    expect(usage.calls).toHaveLength(1);
  });
});
