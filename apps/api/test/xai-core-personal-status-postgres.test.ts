/**
 * A personal-only SuperGrok user on the shared core (design 5.3, "Personal
 * status and exhaustion re-read"), on real PostgreSQL as the non-owner
 * application role.
 *
 * - Status: their own personal connection counts as connected; in their own
 *   Personal workspace, and only for the verified owning person (browser
 *   sign-in, a verified external-identity assertion linked to them, or an
 *   agent with their full access), it is the effective account, validated
 *   by a live billing read. A read-only agent, a plain bearer and the
 *   person's own API keys get the stored count only. With personal
 *   connections turned off nothing is read live.
 * - Re-read: a stored exhaustion is re-read as the owner only for an exact
 *   accepted turn whose placement personal authorization admits the
 *   connection (the owner's own private turn with the frozen entry at the
 *   current generation, personal connections allowed). Nobody else
 *   re-reads it.
 *
 * The migrated fixture uses the production SuperGrok registration and
 * cutover receipt. Billing is scripted; real network is denied.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  organizationAccessPresetPermissions,
  signDelegatedAccessToken,
  type Permission,
} from "@opengeni/contracts";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { subscriptionCoreXaiProvider } from "../../../packages/db/src/subscription-core-xai-adapter";
import { encryptEnvironmentValue } from "../../../packages/db/src/environment-crypto";
import { rawRows } from "../../../packages/db/src/database";
import { installNetworkDenialGuard } from "../../../packages/db/test/fixtures/subscription-core-fake-api-key";

setDefaultTimeout(180_000);

const XAI = subscriptionCoreXaiProvider({
  refresh: (async () => {
    throw new Error("no token refresh is expected in this suite");
  }) as never,
});

const {
  armSubscriptionCoreCapacityWait,
  claimSessionWorkForAttempt,
  createDb,
  createManagedOrganization,
  createOrganizationWorkspace,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  readSubscriptionCoreTurnIdentity,
  subscriptionCorePersonalConnections,
  withSessionRlsActorContext,
} = await import("@opengeni/db");
const { stampDelegatedHumanAuthorization } = await import("@opengeni/core");
const { readXaiCoreStatus } = await import("../src/xai-subscription-core");
const { createApp } = await import("../src/app");
const { reconcileCoreCapacityWait } =
  await import("../../worker/src/activities/subscription-core-codex-waits");
const { XAI_CORE_WAIT_BINDING } =
  await import("../../worker/src/activities/subscription-core-xai-waits");
const workerQuota = await import("../../worker/src/activities/subscription-core-xai-quota");
type DbClient = Awaited<ReturnType<typeof createDb>>;
type TurnIdentity = NonNullable<Awaited<ReturnType<typeof readSubscriptionCoreTurnIdentity>>>;

const DELEGATION_SECRET = "xai-core-personal-status-delegation-secret";
const ORIGIN = "http://opengeni.test";
const key = Buffer.alloc(32, 83);
const settings = testSettings({
  environmentsEncryptionKey: key.toString("base64"),
  supergrokSubscriptionEnabled: true,
});

let shared: SharedTestDatabase;
let client: DbClient;
let network: ReturnType<typeof installNetworkDenialGuard>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("xai-core-personal-status-postgres");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 6 });
  network = installNetworkDenialGuard(() => []);
}, 180_000);

afterAll(async () => {
  network?.restore();
  network?.assertNoEscapes();
  await client?.close();
  await shared?.release();
}, 180_000);

type Org = {
  accountId: string;
  ownerSubjectId: string;
  ownerMembershipId: string;
  personalWorkspaceId: string;
  sharedWorkspaceId: string;
  memberSubjectId: string;
};

/** An organization on the SuperGrok core route: the owner and a plain member. */
async function organization(): Promise<Org> {
  const userId = `xai-personal-status-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "SuperGrok personal status",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const ownerSubjectId = `user:${userId}`;
  const [membership] = await shared.admin<{ id: string; personal_workspace_id: string }[]>`
    select id::text as id, personal_workspace_id::text as personal_workspace_id
    from organization_memberships
    where account_id = ${accountId}::uuid and subject_id = ${ownerSubjectId}
      and status = 'active' and revoked_at is null limit 1`;
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'SuperGrok shared workspace') returning id::text as id`;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}::uuid, ${accountId}::uuid) on conflict do nothing`;
  const memberSubjectId = `user:xai-personal-member-${crypto.randomUUID()}`;
  const [memberPersonal] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'Member Personal workspace') returning id::text as id`;
  await shared.admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${accountId}::uuid, ${memberSubjectId}, 'member', 'active', ${memberPersonal!.id}::uuid)`;
  for (const [workspaceId, subjectId, role] of [
    [workspace!.id, ownerSubjectId, "owner"],
    [workspace!.id, memberSubjectId, "member"],
    [memberPersonal!.id, memberSubjectId, "owner"],
  ] as const)
    await shared.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, ${role})
      on conflict do nothing`;
  await setCutover(accountId, true);
  return {
    accountId,
    ownerSubjectId,
    ownerMembershipId: membership!.id,
    personalWorkspaceId: membership!.personal_workspace_id,
    sharedWorkspaceId: workspace!.id,
    memberSubjectId,
  };
}

async function setCutover(accountId: string, enabled: boolean): Promise<void> {
  await shared.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${accountId}::uuid, 'xai', ${enabled})
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
}

/** The organization's personal-connections rule (its organization-level settings row). */
async function setPersonalConnectionsAllowed(accountId: string, allowed: boolean): Promise<void> {
  await shared.admin`delete from subscription_settings
    where account_id = ${accountId}::uuid and workspace_id is null`;
  await shared.admin`
    insert into subscription_settings (
      account_id, rotation, providers, cross_provider_failover, fallback_order,
      personal_connections_allowed, personal_fallback_allowed
    ) values (${accountId}::uuid, '{}'::jsonb, '{}'::jsonb, false, '{}'::jsonb, ${allowed}, false)`;
}

/** The owner's own personal SuperGrok connection (a fresh, unexpired token). */
async function personalConnection(org: Org, label: string): Promise<string> {
  const connectionId = crypto.randomUUID();
  const authorityId = crypto.randomUUID();
  await shared.admin`
    insert into organization_user_resource_authorities (
      id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
    ) values (
      ${authorityId}::uuid, ${org.accountId}::uuid, ${org.ownerMembershipId}::uuid,
      'subscription_connection', ${connectionId}::uuid, 1, 'active'
    )`;
  const credential = encryptEnvironmentValue(
    key,
    JSON.stringify({
      version: 1,
      accessToken: `access-${label}`,
      refreshToken: `refresh-${label}`,
    }),
  );
  await shared.admin`
    insert into subscription_connections (
      id, account_id, provider, credential_encrypted, ownership, scope_kind,
      owner_organization_membership_id, owner_subject_id, authority_id,
      authority_resource_kind, authority_generation, provider_account_id, provider_state,
      expires_at, label
    ) values (
      ${connectionId}::uuid, ${org.accountId}::uuid, 'xai', ${credential}, 'personal', 'people',
      ${org.ownerMembershipId}::uuid, ${org.ownerSubjectId}, ${authorityId}::uuid,
      'subscription_connection', 1, ${`xai-user-${label}`}, '{}'::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz, ${label}
    )`;
  return connectionId;
}

/**
 * Scripted SuperGrok billing: records each request and answers
 * `usedPercent`. It joins its work for a signal (`abortAndJoin`), as the
 * administered read's custody requires of an injected transport.
 */
function billing(periodEnd = new Date(Date.now() + 7 * 86_400_000).toISOString()) {
  const state = { usedPercent: 40, fail: false, calls: [] as string[] };
  const fetchImpl = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.endsWith("/billing?format=credits")) throw new Error(`unexpected request ${url}`);
      state.calls.push(new Headers(init?.headers).get("authorization") ?? "");
      if (state.fail) return new Response("unavailable", { status: 503 });
      return Response.json({
        config: { creditUsagePercent: state.usedPercent, currentPeriod: { end: periodEnd } },
      });
    },
    { abortAndJoin: async (_signal: AbortSignal) => undefined },
  ) as unknown as typeof fetch;
  return { state, fetchImpl };
}

async function storedQuota(connectionId: string) {
  const [row] = await shared.admin<
    { exhausted_kind: string | null; used: number | null; updated_at: Date }[]
  >`
    select quota->>'exhaustedKind' as exhausted_kind,
      (quota->'windows'->0->>'usedPercent')::float8 as used, updated_at
    from subscription_connection_quota where connection_id = ${connectionId}::uuid`;
  return row ?? null;
}

const MODELS = [{ id: "supergrok/grok-4.7" }];

/** The status read as the route makes it, for a caller who passed (or failed) the owner check. */
function status(
  org: Org,
  workspaceId: string,
  subjectId: string,
  fetchImpl: typeof fetch,
  ownerVerified = true,
) {
  return readXaiCoreStatus(
    { db: client.db, settings },
    {
      accountId: org.accountId,
      workspaceId,
      subjectId,
      models: async () => MODELS,
      ownerVerified: async () => ownerVerified,
      fetch: fetchImpl,
    },
  );
}

/** Store an exhaustion of the owner's connection through their own status read at the limit. */
async function exhaust(org: Org, connectionId: string, upstream: ReturnType<typeof billing>) {
  upstream.state.usedPercent = 100;
  expect(
    await status(org, org.personalWorkspaceId, org.ownerSubjectId, upstream.fetchImpl),
  ).toMatchObject({ connected: true, valid: true });
  expect((await storedQuota(connectionId))?.exhausted_kind).toBe("quota");
  upstream.state.usedPercent = 40;
  upstream.state.calls.length = 0;
}

const ownerEntry = (org: Org, authorityGeneration = 1) => ({
  version: 2,
  personal: [{ provider: "xai", ownerMembershipId: org.ownerMembershipId, authorityGeneration }],
});

/**
 * A real session the owner creates and a turn `initiatorSubjectId` submits,
 * through the runtime writers, then claimed. The frozen value is written
 * directly when it differs (it is immutable, so with triggers suspended):
 * this suite tests the re-read's authorization, not the acceptance writers.
 */
async function acceptedTurn(
  org: Org,
  input: {
    workspaceId?: string;
    visibility?: "user_private" | "workspace_shared";
    initiatorSubjectId?: string;
    frozen?: unknown;
  } = {},
): Promise<TurnIdentity> {
  const workspaceId = input.workspaceId ?? org.personalWorkspaceId;
  const initiator = input.initiatorSubjectId ?? org.ownerSubjectId;
  const session = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
    createSession(client.db, {
      accountId: org.accountId,
      workspaceId,
      subjectId: org.ownerSubjectId,
      initialMessage: "Summarize the plan",
      resources: [],
      metadata: {},
      model: "supergrok/grok-4.7",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      visibility: input.visibility ?? "user_private",
      createdBy: { kind: "subject", subjectId: org.ownerSubjectId },
      createdByContext: {},
    } as never),
  );
  const turn = await withSessionRlsActorContext({ subjectId: initiator }, () =>
    enqueueSessionTurn(client.db, {
      accountId: org.accountId,
      workspaceId,
      sessionId: session.id,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${session.id}`,
      source: "user",
      prompt: "Summarize the plan",
      resources: [],
      tools: [],
      model: "supergrok/grok-4.7",
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator: { kind: "subject", subjectId: initiator },
    } as never),
  );
  const frozen = input.frozen ?? ownerEntry(org);
  await shared.admin.begin(async (admin) => {
    await admin`set local session_replication_role = replica`;
    await admin`update session_turns set subscription_authority = ${admin.json(frozen as never)}::jsonb
      where id = ${turn.id}::uuid and subscription_authority is distinct from ${admin.json(frozen as never)}::jsonb`;
  });
  const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    trigger: { kind: "next" },
  } as never);
  if (claimed.action !== "claimed") throw new Error(`claim failed: ${claimed.reason}`);
  const identity = await readSubscriptionCoreTurnIdentity(client.db, {
    accountId: org.accountId,
    workspaceId,
    sessionId: session.id,
    turnId: turn.id,
  });
  if (!identity) throw new Error("accepted turn identity was not readable");
  return identity;
}

/** The pre-placement personal re-read for an exact accepted turn. */
function reread(identity: TurnIdentity, fetchImpl: typeof fetch, minIntervalMs = 0) {
  return subscriptionCorePersonalConnections(XAI).refreshExhaustedSubscriptionCoreTurnPersonalQuota(
    client.db,
    settings,
    identity,
    { fetchImpl, minIntervalMs },
  );
}

describe("the test setup", () => {
  test("the application role is neither superuser nor RLS-bypassing", async () => {
    const [role] = await rawRows<{ rolsuper: boolean; rolbypassrls: boolean }>(
      client.db,
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe("a personal-only SuperGrok user's status on the core", () => {
  test("sees connected:true; their own Personal workspace validates the personal account live for the verified owner", async () => {
    const org = await organization();
    const connectionId = await personalConnection(org, "own");
    const upstream = billing();

    // Own Personal workspace: the personal account is the effective one,
    // validated by one billing read as its owner.
    expect(
      await status(org, org.personalWorkspaceId, org.ownerSubjectId, upstream.fetchImpl),
    ).toEqual({
      connected: true,
      valid: true,
      accountCount: 1,
      models: MODELS,
      activeAccount: {
        id: connectionId,
        label: "own",
        subject: "xai-user-own",
        scope: "user",
      },
    });
    expect(upstream.state.calls).toEqual(["Bearer access-own"]);
    expect((await storedQuota(connectionId))?.used).toBe(40);

    // A caller who fails the owner check: the stored count, no live read.
    upstream.state.calls.length = 0;
    expect(
      await status(org, org.personalWorkspaceId, org.ownerSubjectId, upstream.fetchImpl, false),
    ).toEqual({ connected: true, valid: false, accountCount: 1 });
    expect(upstream.state.calls).toEqual([]);

    // A failed live read: still connected, not valid.
    upstream.state.fail = true;
    expect(
      await status(org, org.personalWorkspaceId, org.ownerSubjectId, upstream.fetchImpl),
    ).toMatchObject({ connected: true, valid: false, accountCount: 1, models: [] });
    upstream.state.fail = false;

    // A shared workspace: connected, but a personal account is never the
    // workspace's effective account (no live read there).
    upstream.state.calls.length = 0;
    expect(
      await status(org, org.sharedWorkspaceId, org.ownerSubjectId, upstream.fetchImpl),
    ).toEqual({ connected: true, valid: false, accountCount: 1 });
    // Another member sees nothing of it, in the shared workspace.
    expect(
      await status(org, org.sharedWorkspaceId, org.memberSubjectId, upstream.fetchImpl),
    ).toEqual({ connected: false, valid: false, accountCount: 0 });
    expect(upstream.state.calls).toEqual([]);

    // An organization held for maintenance reads and reports nothing usable.
    await setCutover(org.accountId, false);
    upstream.state.calls.length = 0;
    expect(
      await status(org, org.personalWorkspaceId, org.ownerSubjectId, upstream.fetchImpl),
    ).toEqual({ connected: false, valid: false, accountCount: 0 });
    expect(upstream.state.calls).toEqual([]);
  });

  test("with personal connections turned off nothing is read live or recorded", async () => {
    const org = await organization();
    const connectionId = await personalConnection(org, "policy-off");
    const upstream = billing();
    await exhaust(org, connectionId, upstream);
    await setPersonalConnectionsAllowed(org.accountId, false);
    expect(
      await status(org, org.personalWorkspaceId, org.ownerSubjectId, upstream.fetchImpl),
    ).toMatchObject({ connected: true, valid: false });
    expect(upstream.state.calls).toEqual([]);
    expect((await storedQuota(connectionId))?.exhausted_kind).toBe("quota");
    await setPersonalConnectionsAllowed(org.accountId, true);
    expect(
      (await status(org, org.personalWorkspaceId, org.ownerSubjectId, upstream.fetchImpl))?.valid,
    ).toBe(true);
  });
});

describe("the pre-placement re-read of a stored personal exhaustion", () => {
  test("the worker resumes a real parked personal turn after billing recovers, before its stored reset", async () => {
    const org = await organization();
    const connectionId = await personalConnection(org, "parked");
    const upstream = billing();
    await exhaust(org, connectionId, upstream);
    const turn = await acceptedTurn(org);
    const [attempt] = await shared.admin<{ active_attempt_id: string }[]>`
      select active_attempt_id::text from session_turns where id = ${turn.turnId}::uuid`;
    const armed = await armSubscriptionCoreCapacityWait(client.db, "xai", {
      ...turn,
      attemptId: attempt!.active_attempt_id,
      waitReason: "no_eligible_capacity",
      earliestResetAt: new Date(Date.now() + 86_400_000),
      failurePayload: {},
    });
    expect(armed.action).toBe("waiting");
    if (armed.action !== "waiting") throw new Error("fixture failed to park the turn");
    const input = {
      accountId: org.accountId,
      workspaceId: turn.workspaceId,
      sessionId: turn.sessionId,
      waiterId: armed.waiter.waiterId,
      generation: armed.waiter.generation,
    };
    const ageReading = async () => {
      await shared.admin`update subscription_connection_quota
        set updated_at = clock_timestamp() - interval '31 seconds'
        where connection_id = ${connectionId}::uuid`;
    };
    const refresh = workerQuota.refreshExhaustedXaiCoreQuota;
    // Inject only the existing transport seam; keep the real worker hook,
    // exact-turn authorization, owner read, wake, placement and reconcile.
    const transport = spyOn(workerQuota, "refreshExhaustedXaiCoreQuota").mockImplementation(
      (quotaInput) => refresh({ ...quotaInput, fetch: upstream.fetchImpl }),
    );
    try {
      const reconcile = () =>
        reconcileCoreCapacityWait(
          { db: client.db, settings, bus: { publish: async () => undefined } as never },
          XAI_CORE_WAIT_BINDING,
          input,
        );
      upstream.state.usedPercent = 100;
      await ageReading();
      expect(await reconcile()).toMatchObject({ action: "waiting" });
      expect(upstream.state.calls).toEqual(["Bearer access-parked"]);
      expect((await storedQuota(connectionId))?.exhausted_kind).toBe("quota");
      upstream.state.fail = true;
      await ageReading();
      expect(await reconcile()).toMatchObject({ action: "waiting" });
      expect((await storedQuota(connectionId))?.exhausted_kind).toBe("quota");
      upstream.state.fail = false;
      upstream.state.usedPercent = 40;
      upstream.state.calls.length = 0;
      await ageReading();
      expect(await reconcile()).toEqual({ action: "resumed" });
      expect(upstream.state.calls).toEqual(["Bearer access-parked"]);
      expect(await storedQuota(connectionId)).toMatchObject({ exhausted_kind: null, used: 40 });
      const [stored] = await shared.admin<{ status: string }[]>`
        select status from session_turns where id = ${turn.turnId}::uuid`;
      expect(stored!.status).toBe("recovering");
      const [remaining] = await shared.admin<{ count: number }[]>`
        select count(*)::int as count from subscription_capacity_waiters
        where waiter_id = ${armed.waiter.waiterId}::uuid`;
      expect(remaining!.count).toBe(0);
    } finally {
      transport.mockRestore();
    }
  });

  test("the owner's own private turn re-reads it as the owner", async () => {
    const org = await organization();
    const connectionId = await personalConnection(org, "exhausted");
    const upstream = billing();
    await exhaust(org, connectionId, upstream);
    const turn = await acceptedTurn(org);
    expect(turn.initiatingHumanSubjectId).toBe(org.ownerSubjectId);

    // Observed moments ago: not due for a re-read yet.
    expect(await reread(turn, upstream.fetchImpl, 30_000)).toEqual([]);
    expect(upstream.state.calls).toEqual([]);
    // Billing still at the limit: the stored exhaustion stands.
    upstream.state.usedPercent = 100;
    expect(await reread(turn, upstream.fetchImpl)).toEqual([]);
    expect((await storedQuota(connectionId))?.exhausted_kind).toBe("quota");
    // A failed read keeps it too.
    upstream.state.fail = true;
    expect(await reread(turn, upstream.fetchImpl)).toEqual([]);
    expect((await storedQuota(connectionId))?.exhausted_kind).toBe("quota");
    upstream.state.fail = false;
    // Billing below the limit: the exhaustion ends and is reported.
    upstream.state.usedPercent = 40;
    upstream.state.calls.length = 0;
    expect(await reread(turn, upstream.fetchImpl)).toEqual([connectionId]);
    expect(upstream.state.calls).toEqual(["Bearer access-exhausted"]);
    expect(await storedQuota(connectionId)).toMatchObject({ exhausted_kind: null, used: 40 });
    // Nothing exhausted remains to re-read.
    upstream.state.calls.length = 0;
    expect(await reread(turn, upstream.fetchImpl)).toEqual([]);
    expect(upstream.state.calls).toEqual([]);
  });

  test("no turn placement would refuse re-reads it", async () => {
    const org = await organization();
    const connectionId = await personalConnection(org, "refused");
    const upstream = billing();
    await exhaust(org, connectionId, upstream);
    const refused: Array<[string, TurnIdentity]> = [
      // Another person submits the turn in the owner's shared session.
      [
        "another initiator",
        await acceptedTurn(org, {
          workspaceId: org.sharedWorkspaceId,
          visibility: "workspace_shared",
          initiatorSubjectId: org.memberSubjectId,
        }),
      ],
      // The owner's own turn, but in a shared session of a shared workspace.
      [
        "a shared session",
        await acceptedTurn(org, {
          workspaceId: org.sharedWorkspaceId,
          visibility: "workspace_shared",
        }),
      ],
      // No personal entry frozen (background or shared-only work).
      ["no frozen entry", await acceptedTurn(org, { frozen: { version: 2, personal: [] } })],
      // An entry for another membership.
      [
        "another membership's entry",
        await acceptedTurn(org, {
          frozen: {
            version: 2,
            personal: [
              {
                provider: "xai",
                ownerMembershipId: crypto.randomUUID(),
                authorityGeneration: 1,
              },
            ],
          },
        }),
      ],
      // Another provider's entry.
      [
        "another provider's entry",
        await acceptedTurn(org, {
          frozen: {
            version: 2,
            personal: [
              {
                provider: "codex",
                ownerMembershipId: org.ownerMembershipId,
                authorityGeneration: 1,
              },
            ],
          },
        }),
      ],
    ];
    // The same identity without its initiating human.
    const own = await acceptedTurn(org);
    refused.push([
      "no initiating human",
      { ...own, initiatingHumanSubjectId: null } as TurnIdentity,
    ]);
    for (const [label, turn] of refused) {
      expect({ label, recovered: await reread(turn, upstream.fetchImpl) }).toEqual({
        label,
        recovered: [],
      });
    }
    expect(upstream.state.calls).toEqual([]);
    expect((await storedQuota(connectionId))?.exhausted_kind).toBe("quota");
  });

  test("a frozen generation that is no longer current re-reads nothing", async () => {
    const org = await organization();
    const connectionId = await personalConnection(org, "reconnected");
    const upstream = billing();
    await exhaust(org, connectionId, upstream);
    const turn = await acceptedTurn(org);
    // A reconnect advances the connection's authority generation (written
    // directly, with the row guards suspended).
    await shared.admin.begin(async (admin) => {
      await admin`set local session_replication_role = replica`;
      await admin`update organization_user_resource_authorities set generation = 2
        where resource_id = ${connectionId}::uuid`;
      await admin`update subscription_connections set authority_generation = 2
        where id = ${connectionId}::uuid`;
    });
    expect(await reread(turn, upstream.fetchImpl)).toEqual([]);
    expect(upstream.state.calls).toEqual([]);
    expect((await storedQuota(connectionId))?.exhausted_kind).toBe("quota");
    // A turn frozen at the current generation does re-read it.
    const current = await acceptedTurn(org, { frozen: ownerEntry(org, 2) });
    expect(await reread(current, upstream.fetchImpl)).toEqual([connectionId]);
    expect(upstream.state.calls).toEqual(["Bearer access-reconnected"]);
  });

  test("with personal connections turned off nothing is re-read", async () => {
    const org = await organization();
    const connectionId = await personalConnection(org, "rule-off");
    const upstream = billing();
    await exhaust(org, connectionId, upstream);
    const turn = await acceptedTurn(org);
    await setPersonalConnectionsAllowed(org.accountId, false);
    expect(await reread(turn, upstream.fetchImpl)).toEqual([]);
    expect(upstream.state.calls).toEqual([]);
    expect((await storedQuota(connectionId))?.exhausted_kind).toBe("quota");
    await setPersonalConnectionsAllowed(org.accountId, true);
    expect(await reread(turn, upstream.fetchImpl)).toEqual([connectionId]);
  });

  test("a revoked personal authority re-reads and validates nothing", async () => {
    const org = await organization();
    const connectionId = await personalConnection(org, "revoked");
    const upstream = billing();
    await exhaust(org, connectionId, upstream);
    const turn = await acceptedTurn(org);
    await shared.admin`update organization_user_resource_authorities
      set status = 'revoked', revoked_at = now() where resource_id = ${connectionId}::uuid`;
    expect(await reread(turn, upstream.fetchImpl)).toEqual([]);
    expect(upstream.state.calls).toEqual([]);
    expect(
      (await status(org, org.personalWorkspaceId, org.ownerSubjectId, upstream.fetchImpl))?.valid,
    ).not.toBe(true);
  });

  test("a paused personal connection's stored exhaustion is not re-read", async () => {
    const org = await organization();
    const connectionId = await personalConnection(org, "paused");
    const upstream = billing();
    await exhaust(org, connectionId, upstream);
    const turn = await acceptedTurn(org);
    for (const paused of ["needs_relogin", "disabled"]) {
      await shared.admin`update subscription_connections set status = ${paused}
        where id = ${connectionId}::uuid`;
      upstream.state.calls.length = 0;
      expect(await reread(turn, upstream.fetchImpl)).toEqual([]);
      expect(upstream.state.calls).toEqual([]);
      expect((await storedQuota(connectionId))?.exhausted_kind).toBe("quota");
    }
  });
});

describe("the status route: only the verified owning person reads a personal account live", () => {
  const upstream = billing();
  function managedApp() {
    return createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        delegationSecret: DELEGATION_SECRET,
        environmentsEncryptionKey: key.toString("base64"),
        supergrokSubscriptionEnabled: true,
        sandboxBackend: "none",
        betterAuthSecret: "xai-core-personal-status-secret-32-bytes",
        publicBaseUrl: ORIGIN,
      }),
      db: client.db,
      bus: { publish: async () => undefined } as never,
      workflowClient: {
        wakeSessionWorkflow: async () => undefined,
        requestSessionWorkflowWakeDispatch: async () => undefined,
      } as never,
      xaiFetch: upstream.fetchImpl,
    } as never);
  }

  /** A person signed in through the browser, owning a new organization on the core route. */
  async function signedInOwner(api: ReturnType<typeof managedApp>) {
    const email = `xai-status-${crypto.randomUUID()}@example.test`;
    const password = "password1234";
    await api.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "SuperGrok Owner", email, password }),
    });
    await shared.admin`update auth_users set email_verified = true where email = ${email}`;
    const signedIn = await api.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    const cookie = signedIn.headers
      .getSetCookie()
      .find((value) => value.includes("better-auth.session_token="))!
      .split(";", 1)[0]!;
    const [user] = await shared.admin<{ id: string }[]>`
      select id from auth_users where email = ${email}`;
    const subjectId = `user:${user!.id}`;
    const created = await createManagedOrganization(client.db, {
      subjectId,
      subjectLabel: email,
      name: "SuperGrok status organization",
      operationId: crypto.randomUUID(),
    });
    const sharedWorkspace = await createOrganizationWorkspace(client.db, {
      organizationId: created.organization.id,
      actorSubjectId: subjectId,
      name: "SuperGrok status shared workspace",
      operationId: crypto.randomUUID(),
    });
    const accountId = created.organization.id;
    const [membership] = await shared.admin<{ id: string; personal_workspace_id: string }[]>`
      select id::text as id, personal_workspace_id::text as personal_workspace_id
      from organization_memberships
      where account_id = ${accountId}::uuid and subject_id = ${subjectId}`;
    await setCutover(accountId, true);
    const org: Org = {
      accountId,
      ownerSubjectId: subjectId,
      ownerMembershipId: membership!.id,
      personalWorkspaceId: membership!.personal_workspace_id,
      sharedWorkspaceId: sharedWorkspace.id,
      memberSubjectId: `user:xai-status-member-${crypto.randomUUID()}`,
    };
    return { org, cookie };
  }

  test("browser owner and full-access agent: live; read-only agent, plain bearer and API keys: stored only", async () => {
    const api = managedApp();
    const { org, cookie } = await signedInOwner(api);
    expect(org.personalWorkspaceId).toBeTruthy();
    const connectionId = await personalConnection(org, "route");
    const path = `/v1/workspaces/${org.personalWorkspaceId}/supergrok/status`;
    const browser = { cookie, origin: ORIGIN, "sec-fetch-site": "same-origin" };
    const read = async (init: RequestInit | Request) => {
      const response =
        init instanceof Request ? await api.request(init) : await api.request(path, init);
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    };
    const asAgent = (permissions: Permission[]) => {
      const request = new Request(`${ORIGIN}${path}`);
      stampDelegatedHumanAuthorization(request, {
        organizationId: org.accountId,
        subjectId: org.ownerSubjectId,
        permissions: permissions as never,
        workspaceScope: { kind: "all" },
      });
      return request;
    };
    const live = { connected: true, valid: true, accountCount: 1 };
    const storedOnly = { connected: true, valid: false, accountCount: 1 };

    // The signed-in owner in their own Personal workspace: one live read.
    upstream.state.calls.length = 0;
    expect(await read({ headers: browser })).toMatchObject({
      ...live,
      activeAccount: { id: connectionId, scope: "user" },
    });
    expect(upstream.state.calls).toEqual(["Bearer access-route"]);
    // An agent with the owner's full access may do what the owner can.
    upstream.state.calls.length = 0;
    expect(await read(asAgent(organizationAccessPresetPermissions("full")))).toMatchObject(live);
    expect(upstream.state.calls).toEqual(["Bearer access-route"]);

    // Callers who are not the verified owning person: the stored count only.
    const ownerBearer = await signDelegatedAccessToken(DELEGATION_SECRET, {
      accountId: org.accountId,
      workspaceId: org.personalWorkspaceId,
      subjectId: org.ownerSubjectId,
      permissions: ["workspace:read", "sessions:read", "connections:write", "workspace:admin"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const keys = `/v1/organizations/${org.accountId}/personal-api-keys`;
    const apiKey = async (preset: "read_only" | "full") => {
      const created = await api.request(keys, {
        method: "POST",
        headers: { ...browser, "content-type": "application/json" },
        body: JSON.stringify({
          name: `SuperGrok status ${preset}`,
          access: {
            preset,
            permissions: organizationAccessPresetPermissions(preset),
            workspaceScope: { kind: "all" },
          },
        }),
      });
      expect(created.status).toBe(201);
      return ((await created.json()) as { token: string }).token;
    };
    const refused: Array<[string, RequestInit | Request]> = [
      ["a read-only agent", asAgent(organizationAccessPresetPermissions("read_only"))],
      ["a plain bearer naming the owner", { headers: { authorization: `Bearer ${ownerBearer}` } }],
      [
        "the owner's read-only API key",
        { headers: { authorization: `Bearer ${await apiKey("read_only")}` } },
      ],
      [
        "the owner's full-access API key",
        { headers: { authorization: `Bearer ${await apiKey("full")}` } },
      ],
    ];
    upstream.state.calls.length = 0;
    for (const [label, init] of refused)
      expect({ label, status: await read(init) }).toEqual({ label, status: storedOnly });
    expect(upstream.state.calls).toEqual([]);

    // With personal connections turned off, the owner gets no live read either.
    await setPersonalConnectionsAllowed(org.accountId, false);
    expect(await read({ headers: browser })).toMatchObject({ connected: true, valid: false });
    expect(upstream.state.calls).toEqual([]);
  });
});
