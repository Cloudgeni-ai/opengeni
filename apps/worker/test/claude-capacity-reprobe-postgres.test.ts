/**
 * A Claude core waiter parked behind a limit whose stored reset is days away
 * re-reads Anthropic's usage endpoint while it waits, so an early reset
 * resumes the turn instead of leaving it parked until the stale reset. A
 * Claude 429 leaves both an exhausted account window (response headers) and
 * a cooldown of the refused model (headers and refusal settlement); only a
 * reading that confirms availability ends either. Real PostgreSQL; only the
 * usage endpoint is stubbed, and no model is called.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  armSubscriptionCoreCapacityWait,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  encryptEnvironmentValue,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  readSubscriptionCoreTurnIdentity,
  SUBSCRIPTION_CORE_CLAUDE,
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
 * of its product ids, as the header decoder writes them).
 */
async function staleClaudeLimit(
  org: Org,
  connectionId: string,
  resetsAt: number,
  options: { window?: boolean; cooldowns?: Record<string, number> } = {},
) {
  await shared!.admin`
    insert into subscription_connection_quota (
      account_id, connection_id, quota, observed_refresh_generation, revision, updated_at
    ) select ${org.accountId}::uuid, ${connectionId}::uuid, ${shared!.admin.json({
      windows:
        options.window === false
          ? []
          : [{ id: "seven_day", status: "exhausted", resetsAt, usedPercent: 100 }],
      modelCooldowns: options.cooldowns ?? { [MODEL]: resetsAt, [WORKSPACE_MODEL]: resetsAt },
      exhaustedUntil: null,
      exhaustedKind: null,
      source: "response_headers",
    })}::jsonb, connection.refresh_generation, 1, now() - interval '4 days'
    from subscription_connections connection where connection.id = ${connectionId}::uuid`;
}

async function runningTurn(org: Org, model = MODEL) {
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
    expect(parked.waiter.nextCheckAt.getTime()).toBeLessThanOrEqual(
      parked.armedAt + 15 * 60_000,
    );

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
    ["omits the model's family window", { seven_day_opus: undefined }],
    ["reports the model's family window at the limit", { seven_day_opus: { utilization: 100, resets_at: null } }],
  ] as const)("a reading that %s keeps the refused model cooled", async (_case, override) => {
    const org = await organization();
    const connectionId = await sharedConnection(org);
    const staleReset = Date.now() + 2 * DAY;
    await staleClaudeLimit(org, connectionId, staleReset, { window: false });
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
    });
    const parked = await park(org, staleReset);
    // The Sonnet weekly window is still full, so the Sonnet cooldown stands;
    // a model id that is not Claude's never ends.
    stubUsage({ seven_day_sonnet: { utilization: 100, resets_at: new Date(staleReset).toISOString() } });
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
