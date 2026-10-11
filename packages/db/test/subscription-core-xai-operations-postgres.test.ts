/**
 * SuperGrok operations outside chat on the shared core (design 5.3, X2a):
 * candidate selection, operation leases for transcription, realtime and
 * video, refresh under the core lock, the per-connection quota probe and
 * the status read, on real PostgreSQL as the non-owner application role.
 *
 * SuperGrok stays unregistered in production until its cutover (X3); this
 * file registers the production binding (with a scripted OAuth refresh) in
 * its own process, plus the registry row and cutover receipt a cutover
 * migration ships, on its own test database.
 */
import { afterAll, beforeAll, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type { Settings } from "@opengeni/config";
import * as realRegistry from "../src/subscription-core-providers";
import { subscriptionCoreXaiProvider } from "../src/subscription-core-xai-adapter";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import { rawRows } from "../src/database";
import { sql } from "drizzle-orm";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const key = Buffer.alloc(32, 47);
const settings = { environmentsEncryptionKey: key.toString("base64") } as Settings;

let refreshCalls = 0;
const XAI = subscriptionCoreXaiProvider({
  refresh: (async () => {
    refreshCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      accessToken: `rotated-access-${refreshCalls}`,
      refreshToken: `rotated-refresh-${refreshCalls}`,
      expiresInSeconds: 3_600,
    };
  }) as never,
});
// Captured before mocking: the namespace is a live binding to the mock.
const realProviderIds = realRegistry.subscriptionCoreProviderIds;
const realProvider = realRegistry.subscriptionCoreProvider;
const realAdapter = realRegistry.subscriptionCoreAdapter;
mock.module(Bun.resolveSync("../src/subscription-core-providers", import.meta.dir), () => ({
  ...realRegistry,
  subscriptionCoreProviderIds: () => [...realProviderIds(), "xai"].sort(),
  subscriptionCoreProvider: (id: string) => (id === "xai" ? XAI : realProvider(id)),
  subscriptionCoreAdapter: (id: string) => (id === "xai" ? XAI.adapter : realAdapter(id)),
}));
const {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  readSubscriptionCoreTurnIdentity,
  subscriptionCoreOperationConnections,
  subscriptionCoreOperations,
  subscriptionCoreTurns,
  withSessionRlsActorContext,
} = await import("../src");
type DbClient = Awaited<ReturnType<typeof createDb>>;

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("subscription-core-xai-operations-v1");
  if (!shared) throw new Error("Real PostgreSQL is required");
  // What the SuperGrok cutover migration ships: the registry row and receipt.
  await shared.admin`
    insert into opengeni_private.subscription_core_providers
      (provider, extra_credits, primary_setting_column)
    values ('xai', false, 'xai_primary_connection_id')
    on conflict do nothing`;
  await shared.admin`
    insert into opengeni_private.subscription_provider_cutover_receipts
      (provider, migration, committed_at, seed_rotation)
    values ('xai', '9999_xai_operations_test.sql', clock_timestamp(), '{"mode":"spread"}'::jsonb)
    on conflict do nothing`;
  client = createDb(shared.appUrl, { max: 6 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

type Org = {
  accountId: string;
  ownerSubjectId: string;
  ownerMembershipId: string;
  workspaceId: string;
};

async function organization(): Promise<Org> {
  const userId = `core-xai-operations-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Core SuperGrok operations fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const ownerSubjectId = `user:${userId}`;
  await shared!.admin`
    delete from subscription_settings
    where account_id = ${accountId}::uuid and workspace_id is null`;
  const [membership] = await shared!.admin<{ id: string }[]>`
    select id::text as id from organization_memberships
    where account_id = ${accountId}::uuid and subject_id = ${ownerSubjectId}
      and status = 'active' and revoked_at is null limit 1`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'Core SuperGrok shared workspace') returning id::text as id`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${workspace!.id}::uuid, ${ownerSubjectId}, 'owner')`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}::uuid, ${accountId}::uuid)`;
  await shared!.admin`
    insert into subscription_settings (
      account_id, rotation, providers, cross_provider_failover, fallback_order,
      personal_connections_allowed, personal_fallback_allowed
    ) values (
      ${accountId}::uuid, ${shared!.admin.json({ xai: { mode: "spread" } })}::jsonb,
      '{}'::jsonb, false, '{}'::jsonb, true, true
    )`;
  await setCutover(accountId, true);
  return {
    accountId,
    ownerSubjectId,
    ownerMembershipId: membership!.id,
    workspaceId: workspace!.id,
  };
}

async function setCutover(accountId: string, enabled: boolean): Promise<void> {
  await shared!.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${accountId}::uuid, 'xai', ${enabled})
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
}

function encryptedTokens(label: string): string {
  return encryptEnvironmentValue(
    key,
    JSON.stringify({
      version: 1,
      accessToken: `access-${label}`,
      refreshToken: `refresh-${label}`,
    }),
  );
}

async function sharedConnection(
  org: Org,
  label: string,
  options: { scope?: "organization" | "workspaces"; assigned?: boolean } = {},
): Promise<string> {
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      provider_account_id, provider_state, expires_at, label
    ) values (
      ${org.accountId}::uuid, 'xai', 'subscription', ${encryptedTokens(label)},
      'shared', ${options.scope ?? "organization"}, ${`xai-user-${label}`}, '{}'::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz, ${label}
    ) returning id::text as id`;
  if (options.scope === "workspaces" && options.assigned !== false) {
    await shared!.admin`
      insert into subscription_connection_workspaces (account_id, connection_id, workspace_id)
      values (${org.accountId}::uuid, ${row!.id}::uuid, ${org.workspaceId}::uuid)`;
  }
  await shared!.admin`
    insert into subscription_connection_assignment_policies (
      account_id, connection_id, workspace_id, inference_pool
    ) values (${org.accountId}::uuid, ${row!.id}::uuid, ${org.workspaceId}::uuid, 'organization')`;
  return row!.id;
}

async function personalConnection(org: Org, label: string): Promise<string> {
  const connectionId = crypto.randomUUID();
  const authorityId = crypto.randomUUID();
  await shared!.admin`
    insert into organization_user_resource_authorities (
      id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
    ) values (
      ${authorityId}::uuid, ${org.accountId}::uuid, ${org.ownerMembershipId}::uuid,
      'subscription_connection', ${connectionId}::uuid, 1, 'active'
    )`;
  await shared!.admin`
    insert into subscription_connections (
      id, account_id, provider, credential_encrypted, ownership, scope_kind,
      owner_organization_membership_id, owner_subject_id, authority_id,
      authority_resource_kind, authority_generation, provider_account_id, provider_state, expires_at
    ) values (
      ${connectionId}::uuid, ${org.accountId}::uuid, 'xai', ${encryptedTokens(label)},
      'personal', 'people', ${org.ownerMembershipId}::uuid, ${org.ownerSubjectId},
      ${authorityId}::uuid, 'subscription_connection', 1, ${`xai-user-${label}`}, '{}'::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz
    )`;
  return connectionId;
}

async function setPrimary(org: Org, connectionId: string): Promise<void> {
  await shared!.admin`
    update subscription_settings set xai_primary_connection_id = ${connectionId}::uuid
    where account_id = ${org.accountId}::uuid and workspace_id is null`;
}

async function session(org: Org, owner: "owner" | "none"): Promise<string> {
  const create = () =>
    createSession(client!.db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      initialMessage: "core SuperGrok operations fixture",
      resources: [],
      metadata: {},
      model: "xai/grok-4",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      ...(owner === "owner"
        ? {
            subjectId: org.ownerSubjectId,
            createdBy: { kind: "subject" as const, subjectId: org.ownerSubjectId },
            createdByContext: {},
          }
        : {}),
    });
  const created =
    owner === "owner"
      ? await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, create)
      : await create();
  return created.id;
}

const operations = () => subscriptionCoreOperationConnections(XAI);
const workspaceScope = (org: Org) => ({
  kind: "workspace" as const,
  accountId: org.accountId,
  workspaceId: org.workspaceId,
  subjectId: org.ownerSubjectId,
});
const sessionScope = (org: Org, sessionId: string, owner: string | null) => ({
  kind: "session" as const,
  accountId: org.accountId,
  workspaceId: org.workspaceId,
  sessionId,
  sessionOwnerSubjectId: owner,
});

async function bindingCount(sessionId: string): Promise<number> {
  const [row] = await shared!.admin<{ count: number }[]>`
    select count(*)::int as count from subscription_session_bindings
    where session_id = ${sessionId}::uuid`;
  return row!.count;
}

const TURN_MODEL = "supergrok/grok-4.7";

/** An accepted, claimed SuperGrok turn in an owned session, placed on the core. */
async function placedTurn(org: Org) {
  const owned = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
    createSession(client!.db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      initialMessage: "core SuperGrok image fixture",
      resources: [],
      metadata: {},
      model: TURN_MODEL,
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
      sessionId: owned.id,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${owned.id}`,
      source: "user",
      prompt: "core SuperGrok image fixture",
      resources: [],
      tools: [],
      model: TURN_MODEL,
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator: { kind: "subject", subjectId: org.ownerSubjectId },
    }),
  );
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client!.db, org.workspaceId, {
    sessionId: owned.id,
    workflowId: `session-${owned.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`claim failed: ${claimed.reason}`);
  const identity = await readSubscriptionCoreTurnIdentity(client!.db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    sessionId: owned.id,
    turnId: turn.id,
  });
  if (!identity) throw new Error("accepted turn identity was not readable");
  const executionGeneration = claimed.turn.executionGeneration;
  const placed = await subscriptionCoreTurns(XAI).placeSubscriptionCoreTurn(client!.db, {
    identity,
    attemptId,
    executionGeneration,
    holderId: `xai-turn:${owned.id}:${turn.id}:${attemptId}`,
    productModelId: TURN_MODEL,
    reasoningLevel: "medium",
    leaseTtlMs: 120_000,
  });
  if (placed.kind !== "run") throw new Error(`placement did not run: ${placed.kind}`);
  return { identity, attemptId, executionGeneration, connectionId: placed.connectionId };
}

async function runOn(
  org: Org,
  scope: Parameters<ReturnType<typeof operations>["runSubscriptionCoreOperation"]>[2],
  connectionId: string,
  operationKind: "transcription" | "realtime" | "video",
) {
  return await operations().runSubscriptionCoreOperation(
    client!.db,
    settings,
    scope,
    { candidates: [connectionId], operationKind, holderId: `${operationKind}:test` },
    async ({ resolver }) => {
      const token = await resolver.getToken();
      return { accessToken: (token.credential as { accessToken: string }).accessToken };
    },
  );
}

describe.skipIf(!realDb)("SuperGrok operations on the shared core (X2a)", () => {
  test("runs as the non-owner application role", async () => {
    const [role] = await rawRows<{ rolsuper: boolean; rolbypassrls: boolean }>(
      client!.db,
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  test("operation candidates are shared only, primary first, and empty without the cutover", async () => {
    const org = await organization();
    const first = await sharedConnection(org, "first");
    const assigned = await sharedConnection(org, "assigned", { scope: "workspaces" });
    await sharedConnection(org, "unassigned", { scope: "workspaces", assigned: false });
    await personalConnection(org, "personal");
    await setPrimary(org, assigned);
    const candidates = await operations().listSubscriptionCoreOperationCandidates(
      client!.db,
      workspaceScope(org),
    );
    expect(candidates.map((candidate) => candidate.connectionId)).toEqual([assigned, first]);
    const status = await operations().readSubscriptionCoreWorkspaceConnections(
      client!.db,
      workspaceScope(org),
    );
    expect(status.primaryConnectionId).toBe(assigned);
    expect(status.connections.map((connection) => connection.connectionId).sort()).toEqual(
      [first, assigned].sort(),
    );
    await setCutover(org.accountId, false);
    expect(
      await operations().listSubscriptionCoreOperationCandidates(client!.db, workspaceScope(org)),
    ).toEqual([]);
    expect(await runOn(org, workspaceScope(org), first, "transcription")).toEqual({
      kind: "unavailable",
    });
  });

  test("transcription and realtime lease shared connections, refuse personal ones, and never write the binding", async () => {
    const org = await organization();
    const connection = await sharedConnection(org, "shared");
    const personal = await personalConnection(org, "mine");
    expect(await runOn(org, workspaceScope(org), connection, "transcription")).toEqual({
      kind: "ran",
      value: { accessToken: "access-shared" },
    });
    expect(await runOn(org, workspaceScope(org), personal, "transcription")).toEqual({
      kind: "unavailable",
    });
    const sessionId = await session(org, "owner");
    const scope = sessionScope(org, sessionId, org.ownerSubjectId);
    expect((await runOn(org, scope, connection, "realtime")).kind).toBe("ran");
    expect(await runOn(org, scope, personal, "realtime")).toEqual({ kind: "unavailable" });
    expect(await bindingCount(sessionId)).toBe(0);
  });

  test("video leases an organization-scope connection in owned and ownerless sessions (EP-N13, 0716)", async () => {
    const org = await organization();
    const connection = await sharedConnection(org, "org-video");
    const personal = await personalConnection(org, "personal-video");
    const owned = await session(org, "owner");
    expect(
      await runOn(org, sessionScope(org, owned, org.ownerSubjectId), connection, "video"),
    ).toEqual({ kind: "ran", value: { accessToken: "access-org-video" } });
    // A video outlives its turn: a personal connection has no turn authority.
    expect(
      await runOn(org, sessionScope(org, owned, org.ownerSubjectId), personal, "video"),
    ).toEqual({ kind: "unavailable" });
    const ownerless = await session(org, "none");
    expect(await runOn(org, sessionScope(org, ownerless, null), connection, "video")).toEqual({
      kind: "ran",
      value: { accessToken: "access-org-video" },
    });
    expect(await runOn(org, sessionScope(org, ownerless, null), personal, "video")).toEqual({
      kind: "unavailable",
    });
    // Ownerless sessions still admit no other non-turn operation.
    const image = await subscriptionCoreOperations(XAI).acquireSubscriptionCoreOperationLease(
      client!.db,
      sessionScope(org, ownerless, null),
      {
        operationId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        operationKind: "image",
        connectionId: connection,
        holderId: "image:test",
        generation: 1,
      },
    );
    expect(image.kind).toBe("refused");
    expect(await bindingCount(owned)).toBe(0);
    expect(await bindingCount(ownerless)).toBe(0);
  });

  test("a placed SuperGrok turn's image lease is admitted at its execution generation only (EP-N09/N10)", async () => {
    const org = await organization();
    const connection = await sharedConnection(org, "image");
    const turn = await placedTurn(org);
    expect(turn.connectionId).toBe(connection);
    const image = (generation: number) =>
      operations().runSubscriptionCoreOperation(
        client!.db,
        settings,
        { kind: "turn", identity: turn.identity },
        {
          candidates: [connection],
          operationKind: "image",
          operationId: crypto.randomUUID(),
          attemptId: turn.attemptId,
          generation,
          holderId: `image:${crypto.randomUUID()}`,
        },
        async ({ resolver, fence }) => {
          const token = await resolver.getToken();
          return {
            accessToken: (token.credential as { accessToken: string }).accessToken,
            fenced: await fence(),
          };
        },
      );
    expect(await image(turn.executionGeneration)).toEqual({
      kind: "ran",
      value: { accessToken: "access-image", fenced: true },
    });
    // A stale or future execution generation is refused by the database guard.
    expect(await image(turn.executionGeneration + 1)).toEqual({ kind: "unavailable" });
    if (turn.executionGeneration > 1) {
      expect(await image(turn.executionGeneration - 1)).toEqual({ kind: "unavailable" });
    }
    // Every image lease was released when its operation ended.
    const [lease] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from subscription_operation_leases
      where turn_id = ${turn.identity.turnId}::uuid`;
    expect(lease!.count).toBe(0);
  });

  test("a video operation refreshes only under the core lock, once for concurrent callers (EP-N14)", async () => {
    const org = await organization();
    const connection = await sharedConnection(org, "refresh");
    const owned = await session(org, "owner");
    const before = refreshCalls;
    const ran = await operations().runSubscriptionCoreOperation(
      client!.db,
      settings,
      sessionScope(org, owned, org.ownerSubjectId),
      { candidates: [connection], operationKind: "video", holderId: "video:refresh" },
      async ({ resolver }) => {
        const first = await resolver.getToken();
        const [a, b] = await Promise.all([resolver.refresh(), resolver.refresh()]);
        return { first, a, b };
      },
    );
    if (ran.kind !== "ran") throw new Error("video lease was not granted");
    expect(refreshCalls - before).toBe(1);
    expect(ran.value.a.credentialVersion).toBe(ran.value.first.credentialVersion + 1);
    expect(ran.value.b.credentialVersion).toBe(ran.value.a.credentialVersion);
    const [row] = await shared!.admin<{ refresh_generation: number }[]>`
      select refresh_generation::int as refresh_generation from subscription_connections
      where id = ${connection}::uuid`;
    expect(row!.refresh_generation).toBe(ran.value.a.credentialVersion);
    const after = await runOn(
      org,
      sessionScope(org, owned, org.ownerSubjectId),
      connection,
      "video",
    );
    expect(after).toEqual({
      kind: "ran",
      value: { accessToken: `rotated-access-${refreshCalls}` },
    });
  });

  test("the quota probe reads one connection at a time in an explicit workspace context (EP-N22)", async () => {
    const org = await organization();
    const exhausted = await sharedConnection(org, "exhausted");
    const fresh = await sharedConnection(org, "fresh");
    // The worker probes as the core's service subject (never a person).
    const serviceScope = { ...workspaceScope(org), subjectId: "service:subscription-core" };
    const periodEnd = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const seen: string[] = [];
    let usedPercent = 100;
    let period: { end: string } | null = { end: periodEnd };
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      seen.push(`${String(input).replace(/^.*\//, "")} ${authorization}`);
      return Response.json({
        config: {
          creditUsagePercent: usedPercent,
          ...(period ? { currentPeriod: period } : {}),
        },
      });
    }) as typeof fetch;
    const first = await operations().probeSubscriptionCoreConnectionUsage(
      client!.db,
      settings,
      workspaceScope(org),
      exhausted,
      { fetchImpl },
    );
    expect(first).toMatchObject({ kind: "read", recovered: false });
    expect(seen).toEqual(["billing?format=credits Bearer access-exhausted"]);
    // Video funding skips a connection whose stored quota is exhausted now,
    // read in a session's scope (owned and ownerless).
    const owned = await session(org, "owner");
    const ownerless = await session(org, "none");
    for (const scope of [
      sessionScope(org, owned, org.ownerSubjectId),
      sessionScope(org, ownerless, null),
    ]) {
      expect([
        ...(await operations().readSubscriptionCoreExhaustedConnectionIds(client!.db, scope, [
          exhausted,
          fresh,
        ])),
      ]).toEqual([exhausted]);
    }
    // Once the stored exhaustion has passed, it no longer excludes the connection.
    expect(
      (
        await operations().readSubscriptionCoreExhaustedConnectionIds(
          client!.db,
          sessionScope(org, owned, org.ownerSubjectId),
          [exhausted],
          Date.parse(periodEnd) + 1,
        )
      ).size,
    ).toBe(0);
    // Nothing exhausted is due for a re-read yet; the fresh connection is never read.
    seen.length = 0;
    usedPercent = 40;
    expect(
      await operations().refreshExhaustedSubscriptionCoreQuota(client!.db, settings, serviceScope, {
        fetchImpl,
      }),
    ).toEqual([]);
    expect(seen).toEqual([]);
    // An at-limit reading without a known period end is not below the limit:
    // the stored exhaustion and its deadline stand.
    period = null;
    usedPercent = 100;
    expect(
      await operations().refreshExhaustedSubscriptionCoreQuota(client!.db, settings, serviceScope, {
        fetchImpl,
        minIntervalMs: 0,
      }),
    ).toEqual([]);
    expect(seen).toEqual(["billing?format=credits Bearer access-exhausted"]);
    const [stored] = await shared!.admin<
      { exhausted_until: unknown; exhausted_kind: string | null }[]
    >`
      select quota->'exhaustedUntil' as exhausted_until, quota->>'exhaustedKind' as exhausted_kind
      from subscription_connection_quota where connection_id = ${exhausted}::uuid`;
    expect(stored).toEqual({ exhausted_until: Date.parse(periodEnd), exhausted_kind: "quota" });
    seen.length = 0;
    period = { end: periodEnd };
    usedPercent = 40;
    expect(
      await operations().refreshExhaustedSubscriptionCoreQuota(client!.db, settings, serviceScope, {
        fetchImpl,
        minIntervalMs: 0,
      }),
    ).toEqual([exhausted]);
    expect(seen).toEqual(["billing?format=credits Bearer access-exhausted"]);
    expect(
      (
        await operations().readSubscriptionCoreExhaustedConnectionIds(
          client!.db,
          sessionScope(org, owned, org.ownerSubjectId),
          [exhausted, fresh],
        )
      ).size,
    ).toBe(0);
    // A personal connection is not visible to a workspace probe.
    const personal = await personalConnection(org, "personal-quota");
    expect(
      (
        await operations().probeSubscriptionCoreConnectionUsage(
          client!.db,
          settings,
          workspaceScope(org),
          personal,
          { fetchImpl },
        )
      ).kind,
    ).toBe("not_visible");
  });
});
