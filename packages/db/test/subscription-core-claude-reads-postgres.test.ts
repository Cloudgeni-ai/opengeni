/**
 * Claude usage, catalog readiness and organization custom-model admission on
 * the shared core (design 5.3, Claude track C2a), on real PostgreSQL as the
 * non-owner application role.
 *
 * The production registry and migrated database admit Claude. A separate
 * historical fixture proves the pre-receipt legacy route. Only the adapter's
 * token transport is replaced; usage is scripted and real network is denied.
 *
 * Run this file in its own process: the registration replaces module
 * bindings for the whole process.
 */
import { afterAll, beforeAll, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { CLAUDE_OAUTH_TOKEN_URL, type Settings } from "@opengeni/config";
import { sql } from "drizzle-orm";
import * as productionRegistry from "../src/subscription-core-providers";
import {
  subscriptionCoreClaudeProvider,
  type SubscriptionCoreClaudeCredential,
} from "../src/subscription-core-claude-adapter";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import { installNetworkDenialGuard } from "./fixtures/subscription-core-fake-api-key";

setDefaultTimeout(180_000);

const productionProviderIds = productionRegistry.subscriptionCoreProviderIds();

/** The OAuth token endpoint; only the credential refresh tests script it. */
let tokenEndpoint: typeof fetch = (async () => {
  throw new Error("no OAuth refresh is expected here");
}) as unknown as typeof fetch;
const CLAUDE = subscriptionCoreClaudeProvider({
  fetch: ((input: string | URL | Request, init?: RequestInit) =>
    tokenEndpoint(input, init)) as unknown as typeof fetch,
});
const productionLookup = productionRegistry.subscriptionCoreProvider;
mock.module(Bun.resolveSync("../src/subscription-core-providers", import.meta.dir), () => ({
  ...productionRegistry,
  subscriptionCoreProvider: (id: string) => (id === "claude" ? CLAUDE : productionLookup(id)),
}));

const {
  bootstrapWorkspace,
  createDb,
  createOrganizationModelProviderCustomModel,
  createScheduledTask,
  lockActiveOrganizationModelProviderCustomModelForAdmission,
  readSubscriptionCoreClaudeCatalogReadiness,
  readSubscriptionCoreClaudeOrganizationUsageRow,
  readSubscriptionCoreClaudeWorkspaceUsageTarget,
  readSubscriptionCoreProviderRouteForWorkspace,
  refreshSubscriptionCoreClaudeOrganizationUsage,
  refreshSubscriptionCoreClaudeWorkspaceUsage,
  resetSubscriptionCoreClaudeUsageThrottle,
  subscriptionCoreClaudeAcceptedAuthorityAdmitsOrganization,
} = await import("../src");
const { upsertOrganizationClaudeSubscription } = await import("./fixtures/legacy-claude/accounts");
const {
  rawRows,
  setSubjectRlsContext,
  withRlsContext,
  withSessionActivityRlsContext,
  withSessionRlsActorContext,
  withWorkspaceSubjectRls,
} = await import("../src/database");
type DbClient = Awaited<ReturnType<typeof createDb>>;

const key = Buffer.alloc(32, 53);
const settings = { environmentsEncryptionKey: key.toString("base64") } as Settings;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

let shared: SharedTestDatabase;
let client: DbClient;
let network: ReturnType<typeof installNetworkDenialGuard>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("subscription-core-claude-reads-v1");
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
  workspaceId: string;
  personalWorkspaceId: string;
  ownerSubjectId: string;
  ownerMembershipId: string;
  opus: string;
  sonnet: string;
};

async function organization(): Promise<Org> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `claude-reads-${suffix}`,
    accountName: "Claude reads account",
    workspaceExternalSource: "test",
    workspaceExternalId: `claude-reads-${suffix}`,
    workspaceName: "Claude reads workspace",
    subjectId: `user:claude-reads-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const [personal] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${grant.accountId}, 'Claude reads Personal workspace') returning id::text as id`;
  const [membership] = await shared.admin<{ id: string }[]>`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${grant.accountId}, ${grant.subjectId}, 'owner', 'active', ${personal!.id})
    returning id::text as id`;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${grant.accountId}::uuid, ${personal!.id}::uuid, ${grant.subjectId}, 'owner')
    on conflict do nothing`;
  await shared.admin`
    delete from subscription_settings
    where account_id = ${grant.accountId}::uuid and workspace_id is null`;
  await shared.admin`
    insert into subscription_settings (
      account_id, rotation, providers, cross_provider_failover, fallback_order,
      personal_connections_allowed, personal_fallback_allowed
    ) values (
      ${grant.accountId}::uuid, ${shared.admin.json({ claude: { mode: "spread" } })}::jsonb,
      '{}'::jsonb, false, '{}'::jsonb, true, true
    )`;
  const actor = { organizationId: grant.accountId, actorSubjectId: grant.subjectId };
  const opus = await createOrganizationModelProviderCustomModel(client.db, {
    ...actor,
    providerKind: "claude_subscription",
    upstreamModelId: "claude-opus-4-5",
    operationId: crypto.randomUUID(),
  });
  const sonnet = await createOrganizationModelProviderCustomModel(client.db, {
    ...actor,
    providerKind: "claude_subscription",
    upstreamModelId: "claude-sonnet-4-5",
    operationId: crypto.randomUUID(),
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    personalWorkspaceId: personal!.id,
    ownerSubjectId: grant.subjectId,
    ownerMembershipId: membership!.id,
    opus: opus.upstreamModelId,
    sonnet: sonnet.upstreamModelId,
  };
}

async function setCutover(org: Org, enabled: boolean): Promise<void> {
  await shared.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${org.accountId}::uuid, 'claude', ${enabled})
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
}

/** Later cases also run alone under mutation probes, after the legacy checks. */
async function ensureTestClaudeRegistration(): Promise<void> {
  const [row] = await shared.admin<{ registered: boolean }[]>`
    select exists (select 1 from opengeni_private.subscription_core_providers
      where provider = 'claude') as registered`;
  expect(row!.registered).toBe(true);
}

async function setSource(org: Org, inferenceSource: "automatic" | "workspace" | "organization") {
  await shared.admin`
    update subscription_settings
    set providers = ${shared.admin.json({ claude: { inferenceSource } })}::jsonb
    where account_id = ${org.accountId}::uuid and workspace_id is null`;
}

function credential(
  label: string,
  kind: "oauth" | "setup" = "oauth",
  expiresInMs = 86_400_000,
): string {
  const value: SubscriptionCoreClaudeCredential = {
    version: 1,
    token: `sk-ant-oat01-${label}`,
    identity: { accountUuid: crypto.randomUUID(), deviceId: "d".repeat(64) },
    ...(kind === "oauth"
      ? {
          oauth: {
            refreshToken: `refresh-${label}`,
            expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
            scopes: ["user:inference", "user:profile"],
          },
        }
      : {}),
  };
  return encryptEnvironmentValue(key, JSON.stringify(value));
}

async function sharedConnection(
  org: Org,
  label: string,
  options: {
    pool?: "organization" | "workspace";
    kind?: "oauth" | "setup";
    allowedModelIds?: string[] | null;
    /** Assignment policies per pool (default: one for `pool`, allowing every model). */
    policies?: Array<{ pool: "organization" | "workspace"; allowedModelIds: string[] | null }>;
    /** Further workspaces assigned to the connection (organization pool). */
    workspaceIds?: string[];
  } = {},
): Promise<string> {
  const pool = options.pool ?? "organization";
  const [row] = await shared.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      provider_account_id, provider_state, expires_at, label, allowed_model_ids,
      managed_by_workspace_id
    ) values (
      ${org.accountId}::uuid, 'claude', 'subscription', ${credential(label, options.kind)},
      'shared', 'organization', ${`claude-${label}-${crypto.randomUUID()}`},
      ${shared.admin.json({
        oauthScopes: options.kind === "setup" ? [] : ["user:inference", "user:profile"],
      })}::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz, ${label},
      ${options.allowedModelIds ?? null}::text[],
      ${pool === "workspace" ? org.workspaceId : null}::uuid
    ) returning id::text as id`;
  for (const workspaceId of [org.workspaceId, ...(options.workspaceIds ?? [])])
    for (const policy of options.policies ?? [{ pool, allowedModelIds: null }])
      await shared.admin`
        insert into subscription_connection_assignment_policies (
          account_id, connection_id, workspace_id, inference_pool, allowed_model_ids
        ) values (
          ${org.accountId}::uuid, ${row!.id}::uuid, ${workspaceId}::uuid, ${policy.pool},
          ${policy.allowedModelIds}::text[]
        )`;
  return row!.id;
}

async function connectionVersion(connectionId: string): Promise<number> {
  const [row] = await shared.admin<{ version: number }[]>`
    select version::int as version from subscription_connections where id = ${connectionId}::uuid`;
  return row!.version;
}

/** Another shared workspace of the organization, with the owner as a member. */
async function secondWorkspace(org: Org): Promise<string> {
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${org.accountId}, 'Claude reads second workspace') returning id::text as id`;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${org.accountId}::uuid, ${workspace!.id}::uuid, ${org.ownerSubjectId}, 'owner')
    on conflict do nothing`;
  return workspace!.id;
}

/** A session of the workspace, optionally with one accepted turn. */
async function session(org: Org, options: { turn?: boolean } = {}) {
  const sessionId = crypto.randomUUID();
  const turnId = options.turn ? crypto.randomUUID() : null;
  await withSessionActivityRlsContext(
    client.db,
    { accountId: org.accountId, workspaceId: org.workspaceId },
    async (tx) => {
      await tx.execute(
        sql`insert into sessions (id, account_id, workspace_id, initial_message, model,
          reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, status, tool_policy)
        values (${sessionId}::uuid, ${org.accountId}::uuid, ${org.workspaceId}::uuid, 'carrier',
          'claude-carrier-test', 'high', 'standard', 'none', ${sessionId}::uuid, 'idle',
          '{"mode":"explicit","inheritedFromSessionId":null}'::jsonb)`,
      );
      if (turnId)
        await tx.execute(
          sql`insert into session_turns (id, account_id, workspace_id, session_id,
            trigger_event_id, temporal_workflow_id, status, source, position, prompt, model,
            reasoning_effort, latency_mode, sandbox_backend, finished_at)
          values (${turnId}::uuid, ${org.accountId}::uuid, ${org.workspaceId}::uuid,
            ${sessionId}::uuid, gen_random_uuid(), 'wf', 'completed', 'user', 1, 'go',
            'claude-carrier-test', 'high', 'standard', 'none', now())`,
        );
    },
  );
  return { sessionId, turnId };
}

type CompatCarrier = {
  kind: "session_initial" | "session_turn" | "scheduled_task";
  id: string;
};

/**
 * Fixtures for the real accepted-authority reader (0716's
 * `read_subscription_authority_compat`). The carrier slots are server-owned,
 * so these write as the owner: a compatibility record for a carrier (a shared
 * pool, no personal entry), a frozen v2 snapshot with a Claude entry on a
 * turn, and a carrier accepted before Claude's receipt (replica writes, as the
 * insertion marker is immutable).
 */
async function compatRecord(
  org: Org,
  carrier: CompatCarrier,
  sharedPool: "workspace" | "organization",
): Promise<void> {
  const column =
    carrier.kind === "session_initial"
      ? "session_id"
      : carrier.kind === "session_turn"
        ? "turn_id"
        : "scheduled_task_id";
  await shared.admin.unsafe(
    `insert into opengeni_private.subscription_authority_compat (
      account_id, workspace_id, provider, carrier_kind, ${column}, personal, shared_pool,
      legacy_scope
    ) values ($1::uuid, $2::uuid, 'claude', $3, $4::uuid, '[]'::jsonb, $5, $5)`,
    [org.accountId, org.workspaceId, carrier.kind, carrier.id, sharedPool],
  );
}

async function freezeClaudeV2(org: Org, turnId: string): Promise<void> {
  const snapshot = JSON.stringify({
    version: 2,
    personal: [
      { provider: "claude", ownerMembershipId: org.ownerMembershipId, authorityGeneration: 1 },
    ],
  });
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update session_turns set subscription_authority = ${snapshot}::text::jsonb
      where id = ${turnId}::uuid`;
  });
}

async function acceptedBeforeReceipt(sessionId: string): Promise<void> {
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update sessions set authority_inserted_at = '-infinity'
      where id = ${sessionId}::uuid`;
  });
}

/** The reader's answer for a carrier, as the app role in `org`'s workspace. */
async function readCompat(
  org: Org,
  carrier: CompatCarrier,
  workspaceId = org.workspaceId,
): Promise<unknown> {
  return await withRlsContext(
    client.db,
    { accountId: org.accountId, workspaceId: org.workspaceId },
    async (tx) => {
      const [row] = await rawRows<{ authority: unknown }>(
        tx,
        sql`select opengeni_private.read_subscription_authority_compat(
          'claude', ${carrier.kind}, ${workspaceId}::uuid, ${carrier.id}::uuid, null
        ) as authority`,
      );
      return row?.authority ?? null;
    },
  );
}

/** A scheduled task of `org`'s shared workspace, created by its owner. */
async function scheduledTask(org: Org): Promise<string> {
  const task = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
    createScheduledTask(client.db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      name: "claude carried authority",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "run", resources: [], tools: [], metadata: {} },
      metadata: {},
      createdBy: { kind: "subject" as const, subjectId: org.ownerSubjectId },
    }),
  );
  return task.id;
}

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
  await shared.admin`
    insert into subscription_connections (
      id, account_id, provider, credential_encrypted, ownership, scope_kind,
      owner_organization_membership_id, owner_subject_id, authority_id,
      authority_resource_kind, authority_generation, provider_account_id, provider_state, expires_at
    ) values (
      ${connectionId}::uuid, ${org.accountId}::uuid, 'claude', ${credential(label)},
      'personal', 'people', ${org.ownerMembershipId}::uuid, ${org.ownerSubjectId},
      ${authorityId}::uuid, 'subscription_connection', 1, ${`claude-${label}`},
      ${shared.admin.json({ oauthScopes: ["user:inference", "user:profile"] })}::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz
    )`;
  return connectionId;
}

async function storedQuota(connectionId: string) {
  const [row] = await shared.admin<{ quota: Record<string, unknown> | null }[]>`
    select quota from subscription_connection_quota where connection_id = ${connectionId}::uuid`;
  return row?.quota ?? null;
}

function scriptedUsage(respond: () => Response) {
  const calls: string[] = [];
  // An injected transport of the administered reads aborts and joins its
  // work for a signal; this one has none in flight after it returns.
  const fetchImpl = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url !== USAGE_URL) throw new Error(`unexpected request ${url}`);
      calls.push(new Headers(init?.headers).get("authorization") ?? "");
      return respond();
    },
    { abortAndJoin: async () => {} },
  ) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function admit(
  org: Org,
  upstreamModelId: string,
  claudeAuthority: Parameters<
    typeof lockActiveOrganizationModelProviderCustomModelForAdmission
  >[1]["claudeAuthority"],
  options: { subject?: boolean } = {},
) {
  const run = (tx: typeof client.db) =>
    lockActiveOrganizationModelProviderCustomModelForAdmission(tx, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      providerKind: "claude_subscription",
      upstreamModelId,
      ...(claudeAuthority ? { claudeAuthority } : {}),
    });
  const model =
    options.subject === false
      ? await withRlsContext(
          client.db,
          { accountId: org.accountId, workspaceId: org.workspaceId },
          run,
        )
      : await withWorkspaceSubjectRls(client.db, org.workspaceId, org.ownerSubjectId, run);
  return model?.upstreamModelId ?? null;
}

const organizationSnapshot = { authoritySnapshot: { version: 1, scope: "organization" } } as const;

describe("the application role", () => {
  test("is neither superuser nor RLS-bypassing", async () => {
    const [role] = await rawRows<{ rolsuper: boolean; rolbypassrls: boolean }>(
      client.db,
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe("before the Claude cutover receipt (legacy route)", () => {
  let current: { shared: SharedTestDatabase; client: DbClient };
  beforeAll(async () => {
    current = { shared, client };
    const legacy = await acquireSharedTestDatabase("claude-reads-before-cutover", {
      withheldMigrations: ["0739_subscription_core_claude_cutover.sql"],
    });
    if (!legacy) throw new Error("Real PostgreSQL is required");
    shared = legacy;
    client = createDb(shared.appUrl, { max: 6 });
  }, 180_000);
  afterAll(async () => {
    await client.close();
    await shared.release();
    ({ shared, client } = current);
  }, 60_000);

  test("the production binding does not bypass the missing cutover receipt", () => {
    expect(productionProviderIds).toContain("claude");
  });

  test("without the cutover receipt admission fails closed even with a valid legacy pool", async () => {
    const org = await organization();
    await setCutover(org, true);
    expect(
      await readSubscriptionCoreProviderRouteForWorkspace(client.db, {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        provider: "claude",
      }),
    ).toBe("legacy");
    // A core connection is not read on the legacy route.
    await sharedConnection(org, "legacy-core-row");
    expect(await admit(org, org.opus, organizationSnapshot)).toBeNull();
    const secret = {
      version: 1 as const,
      token: "sk-ant-oat01-legacy-admission",
      identity: { accountUuid: crypto.randomUUID(), deviceId: "a".repeat(64) },
    };
    await upsertOrganizationClaudeSubscription(client.db, {
      organizationId: org.accountId,
      actorSubjectId: org.ownerSubjectId,
      encryptionKey: key,
      secret,
      providerAccountId: secret.identity.accountUuid,
      label: null,
      accountEmail: null,
      expiresAt: null,
    });
    expect(await admit(org, org.opus, organizationSnapshot)).toBeNull();
    expect(
      await admit(org, org.opus, { authoritySnapshot: { version: 1, scope: "workspace" } }),
    ).toBeNull();
    expect(await admit(org, org.opus, organizationSnapshot, { subject: false })).toBeNull();
  });
});

describe("on the Claude core route", () => {
  test("the production migration admits the binding and its receipt", async () => {
    await ensureTestClaudeRegistration();
    const org = await organization();
    await setCutover(org, true);
    expect(
      await readSubscriptionCoreProviderRouteForWorkspace(client.db, {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        provider: "claude",
      }),
    ).toBe("core");
    await setCutover(org, false);
    expect(
      await readSubscriptionCoreProviderRouteForWorkspace(client.db, {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        provider: "claude",
      }),
    ).toBe("maintenance");
  });

  test("usage targets: the workspace pool, aliases and the owner's own personal connection", async () => {
    const org = await organization();
    await setCutover(org, true);
    const organizationPool = await sharedConnection(org, "org-pool");
    const workspacePool = await sharedConnection(org, "ws-pool", { pool: "workspace" });
    const personal = await personalConnection(org, "personal");
    const target = (workspaceId: string, accountIdParam: string, subjectId = org.ownerSubjectId) =>
      readSubscriptionCoreClaudeWorkspaceUsageTarget(client.db, {
        accountId: org.accountId,
        workspaceId,
        subjectId,
        accountIdParam,
      });
    expect((await target(org.workspaceId, organizationPool))?.scope).toBe("organization");
    expect((await target(org.workspaceId, workspacePool))?.scope).toBe("workspace");
    // A legacy id kept as an alias resolves to the canonical connection.
    const legacyId = crypto.randomUUID();
    await shared.admin`
      insert into subscription_connection_aliases (account_id, provider, alias_connection_id, connection_id)
      values (${org.accountId}::uuid, 'claude', ${legacyId}::uuid, ${organizationPool}::uuid)`;
    expect((await target(org.workspaceId, legacyId))?.connectionId).toBe(organizationPool);
    expect(await target(org.workspaceId, crypto.randomUUID())).toBeNull();
    // Personal connections: only the owner, only in their own Personal workspace.
    expect(await target(org.workspaceId, personal)).toBeNull();
    const own = await target(org.personalWorkspaceId, personal);
    expect(own?.scope).toBe("user");
    expect(own?.row.id).toBe(personal);
    expect(await target(org.personalWorkspaceId, personal, "user:someone-else")).toBeNull();
    // Every target carries its row version (the owner-only reader's, for a
    // personal connection).
    expect(Number(own?.row.version)).toBe(await connectionVersion(personal));
    expect(Number((await target(org.workspaceId, organizationPool))?.row.version)).toBe(
      await connectionVersion(organizationPool),
    );
    // A personal alias resolves only through the owner-only routine: for its
    // owner, in their own Personal workspace.
    const personalAlias = crypto.randomUUID();
    await shared.admin`
      insert into subscription_connection_aliases (account_id, provider, alias_connection_id, connection_id)
      values (${org.accountId}::uuid, 'claude', ${personalAlias}::uuid, ${personal}::uuid)`;
    expect((await target(org.personalWorkspaceId, personalAlias))?.connectionId).toBe(personal);
    expect(await target(org.workspaceId, personalAlias)).toBeNull();
    expect(await target(org.personalWorkspaceId, personalAlias, "user:someone-else")).toBeNull();
    expect(await target(org.personalWorkspaceId, "not-a-uuid")).toBeNull();
    // The organization path: the organization's own connections, administrators only.
    const orgRow = (subjectId: string, accountIdParam: string) =>
      readSubscriptionCoreClaudeOrganizationUsageRow(client.db, {
        organizationId: org.accountId,
        subjectId,
        accountIdParam,
      });
    expect((await orgRow(org.ownerSubjectId, organizationPool))?.id).toBe(organizationPool);
    expect(Number((await orgRow(org.ownerSubjectId, organizationPool))?.version)).toBe(
      await connectionVersion(organizationPool),
    );
    expect((await orgRow(org.ownerSubjectId, legacyId))?.id).toBe(organizationPool);
    expect(await orgRow(org.ownerSubjectId, workspacePool)).toBeNull();
    expect(await orgRow(org.ownerSubjectId, personal)).toBeNull();
    expect(await orgRow("user:not-an-administrator", organizationPool)).toBeNull();
  });

  test("a live refresh records the reading with the catalog's models, and throttles", async () => {
    resetSubscriptionCoreClaudeUsageThrottle();
    const org = await organization();
    await setCutover(org, true);
    const connectionId = await sharedConnection(org, "refresh", { pool: "workspace" });
    const scope = {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      subjectId: org.ownerSubjectId,
    };
    const upstream = scriptedUsage(() =>
      Response.json({
        five_hour: { utilization: 40, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
        seven_day_opus: {
          utilization: 100,
          resets_at: new Date(Date.now() + 86_400_000).toISOString(),
        },
      }),
    );
    const fresh = (await readSubscriptionCoreClaudeWorkspaceUsageTarget(client.db, {
      ...scope,
      accountIdParam: connectionId,
    }))!;
    const result = await refreshSubscriptionCoreClaudeWorkspaceUsage(
      client.db,
      settings,
      { ...scope, target: fresh },
      { fetchImpl: upstream.fetchImpl },
    );
    expect(upstream.calls).toEqual(["Bearer sk-ant-oat01-refresh"]);
    expect(result.recovered).toBe(false);
    expect(result.usage.refreshStatus).toBe("available");
    expect(result.usage.source).toBe("provider");
    expect(result.usage.windows.map((window) => [window.id, window.status])).toEqual([
      // Legacy usage-endpoint windows carry no status.
      ["five_hour", null],
      ["seven_day_opus", null],
    ]);
    // The row version: what the account listing reports.
    expect(result.usage.credentialVersion).toBe(await connectionVersion(connectionId));
    // The family window cooled every listed Opus model of the catalog.
    const quota = (await storedQuota(connectionId))!;
    expect(Object.keys(quota.modelCooldowns as object).sort()).toEqual([
      `organization-claude-subscription/${org.opus}`,
      `workspace-claude-subscription/${org.opus}`,
    ]);
    // Within 30 seconds the stored reading answers without a provider call.
    const reread = (await readSubscriptionCoreClaudeWorkspaceUsageTarget(client.db, {
      ...scope,
      accountIdParam: connectionId,
    }))!;
    const again = await refreshSubscriptionCoreClaudeWorkspaceUsage(
      client.db,
      settings,
      { ...scope, target: reread },
      { fetchImpl: upstream.fetchImpl },
    );
    expect(upstream.calls).toHaveLength(1);
    expect(again.usage.refreshStatus).toBe("available");
    expect(again.usage.windows).toEqual(result.usage.windows);
  });

  test("failed reads are throttled; setup tokens and 401s never store a status", async () => {
    resetSubscriptionCoreClaudeUsageThrottle();
    const org = await organization();
    await setCutover(org, true);
    const scope = {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      subjectId: org.ownerSubjectId,
    };
    const refresh = async (connectionId: string, fetchImpl: typeof fetch) =>
      (
        await refreshSubscriptionCoreClaudeWorkspaceUsage(
          client.db,
          settings,
          {
            ...scope,
            target: (await readSubscriptionCoreClaudeWorkspaceUsageTarget(client.db, {
              ...scope,
              accountIdParam: connectionId,
            }))!,
          },
          { fetchImpl },
        )
      ).usage;
    const down = scriptedUsage(() => new Response("down", { status: 503 }));
    const failing = await sharedConnection(org, "failing");
    expect((await refresh(failing, down.fetchImpl)).refreshStatus).toBe("unavailable");
    expect((await refresh(failing, down.fetchImpl)).refreshStatus).toBe("unavailable");
    expect(down.calls).toHaveLength(1);
    expect(await storedQuota(failing)).toBeNull();

    const never = scriptedUsage(() => {
      throw new Error("a setup token is never sent to the usage endpoint");
    });
    const setup = await sharedConnection(org, "setup", { kind: "setup" });
    expect((await refresh(setup, never.fetchImpl)).refreshStatus).toBe("scope_required");
    expect(never.calls).toHaveLength(0);

    const revoked = scriptedUsage(() => new Response("revoked", { status: 401 }));
    const rejected = await sharedConnection(org, "revoked");
    const usage = await refresh(rejected, revoked.fetchImpl);
    expect(usage.refreshStatus).toBe("reconnect");
    expect(usage.windows).toEqual([]);
    expect(await storedQuota(rejected)).toBeNull();
    // Nothing about the refresh outcome is stored on the connection.
    const [row] = await shared.admin<{ status: string; provider_state: unknown }[]>`
      select status, provider_state from subscription_connections where id = ${rejected}::uuid`;
    expect(row).toEqual({
      status: "active",
      provider_state: { oauthScopes: ["user:inference", "user:profile"] },
    });
  });

  test("the throttle prefers a newer stored reading and is keyed by workspace and version", async () => {
    resetSubscriptionCoreClaudeUsageThrottle();
    const org = await organization();
    await setCutover(org, true);
    const other = await secondWorkspace(org);
    const connectionId = await sharedConnection(org, "keyed", { workspaceIds: [other] });
    const refresh = async (workspaceId: string, fetchImpl: typeof fetch) => {
      const scope = { accountId: org.accountId, workspaceId, subjectId: org.ownerSubjectId };
      return (
        await refreshSubscriptionCoreClaudeWorkspaceUsage(
          client.db,
          settings,
          {
            ...scope,
            target: (await readSubscriptionCoreClaudeWorkspaceUsageTarget(client.db, {
              ...scope,
              accountIdParam: connectionId,
            }))!,
          },
          { fetchImpl },
        )
      ).usage;
    };
    const down = scriptedUsage(() => new Response("down", { status: 503 }));
    expect((await refresh(org.workspaceId, down.fetchImpl)).refreshStatus).toBe("unavailable");
    // Another workspace's refresh of the same connection is not held back.
    expect((await refresh(other, down.fetchImpl)).refreshStatus).toBe("unavailable");
    expect(down.calls).toHaveLength(2);
    expect((await refresh(org.workspaceId, down.fetchImpl)).refreshStatus).toBe("unavailable");
    expect(down.calls).toHaveLength(2);
    // A reconnect moves the row version: the remembered failure no longer applies.
    await shared.admin`update subscription_connections set version = version + 1
      where id = ${connectionId}::uuid`;
    expect((await refresh(org.workspaceId, down.fetchImpl)).refreshStatus).toBe("unavailable");
    expect(down.calls).toHaveLength(3);
    // A usage reading stored since (another replica's) answers before the
    // remembered failure, without a provider call.
    await shared.admin`
      insert into subscription_connection_quota (
        account_id, connection_id, quota, observed_refresh_generation, revision, updated_at
      ) values (
        ${org.accountId}::uuid, ${connectionId}::uuid,
        ${shared.admin.json({
          windows: [{ id: "five_hour", usedPercent: 12, resetsAt: null, status: "ok" }],
          modelCooldowns: {},
          exhaustedUntil: null,
          exhaustedKind: null,
          source: "usage_endpoint",
        })}::jsonb, 1, 1, clock_timestamp() + interval '1 second'
      )`;
    const stored = await refresh(org.workspaceId, down.fetchImpl);
    expect(stored.refreshStatus).toBe("available");
    expect(stored.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["five_hour", 12],
    ]);
    expect(down.calls).toHaveLength(3);
  });

  test("past 30 seconds on the injected clock the provider is read again", async () => {
    resetSubscriptionCoreClaudeUsageThrottle();
    const org = await organization();
    await setCutover(org, true);
    const scope = {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      subjectId: org.ownerSubjectId,
    };
    const clock = { at: Date.now() };
    const refresh = async (connectionId: string, fetchImpl: typeof fetch) =>
      (
        await refreshSubscriptionCoreClaudeWorkspaceUsage(
          client.db,
          settings,
          {
            ...scope,
            target: (await readSubscriptionCoreClaudeWorkspaceUsageTarget(client.db, {
              ...scope,
              accountIdParam: connectionId,
            }))!,
          },
          { fetchImpl, now: () => clock.at },
        )
      ).usage;

    // After a remembered failure.
    const down = scriptedUsage(() => new Response("down", { status: 503 }));
    const failing = await sharedConnection(org, "clock-failing");
    expect((await refresh(failing, down.fetchImpl)).refreshStatus).toBe("unavailable");
    clock.at += 29_000;
    expect((await refresh(failing, down.fetchImpl)).refreshStatus).toBe("unavailable");
    expect(down.calls).toHaveLength(1);
    clock.at += 2_000;
    expect((await refresh(failing, down.fetchImpl)).refreshStatus).toBe("unavailable");
    expect(down.calls).toHaveLength(2);

    // After a stored reading: its freshness is the stored observation time
    // (the real clock) against the injected one.
    clock.at = Date.now();
    const upstream = scriptedUsage(() => Response.json({ five_hour: { utilization: 20 } }));
    const reading = await sharedConnection(org, "clock-reading");
    expect((await refresh(reading, upstream.fetchImpl)).refreshStatus).toBe("available");
    expect((await refresh(reading, upstream.fetchImpl)).refreshStatus).toBe("available");
    expect(upstream.calls).toHaveLength(1);
    clock.at = Date.now() + 31_000;
    const later = await refresh(reading, upstream.fetchImpl);
    expect(upstream.calls).toHaveLength(2);
    expect(later.refreshStatus).toBe("available");
  });

  test("a reading the core did not record is reported unavailable", async () => {
    resetSubscriptionCoreClaudeUsageThrottle();
    const org = await organization();
    await setCutover(org, true);
    const connectionId = await sharedConnection(org, "fenced", { pool: "workspace" });
    const scope = {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      subjectId: org.ownerSubjectId,
    };
    // The credential refreshes while the reading is in flight: the
    // generation fence refuses the older bearer's observation.
    const raced = scriptedUsage(() => Response.json({ five_hour: { utilization: 5 } }));
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      await shared.admin`update subscription_connections
        set refresh_generation = refresh_generation + 1 where id = ${connectionId}::uuid`;
      return await raced.fetchImpl(input, init);
    }) as typeof fetch;
    const result = await refreshSubscriptionCoreClaudeWorkspaceUsage(
      client.db,
      settings,
      {
        ...scope,
        target: (await readSubscriptionCoreClaudeWorkspaceUsageTarget(client.db, {
          ...scope,
          accountIdParam: connectionId,
        }))!,
      },
      { fetchImpl },
    );
    expect(raced.calls).toHaveLength(1);
    expect(result.usage.refreshStatus).toBe("unavailable");
    expect(result.usage.windows).toEqual([]);
    expect(await storedQuota(connectionId)).toBeNull();
  });

  test("readiness splits the core projection by the legacy prefixes", async () => {
    const org = await organization();
    await setCutover(org, true);
    const read = (workspaceId = org.workspaceId, subjectId: string | null = org.ownerSubjectId) =>
      readSubscriptionCoreClaudeCatalogReadiness(client.db, {
        accountId: org.accountId,
        workspaceId,
        subjectId,
      });
    expect(await read()).toEqual({
      workspace: false,
      organization: false,
      restrictions: {
        "organization-claude-subscription/": [],
        "workspace-claude-subscription/": [],
      },
    });
    await sharedConnection(org, "ready-org");
    expect(await read()).toEqual({
      workspace: false,
      organization: true,
      restrictions: {
        "organization-claude-subscription/": null,
        "workspace-claude-subscription/": [],
      },
    });
    const allowed = `workspace-claude-subscription/${org.sonnet}`;
    await sharedConnection(org, "ready-ws", { pool: "workspace", allowedModelIds: [allowed] });
    expect(await read()).toEqual({
      workspace: true,
      organization: true,
      restrictions: {
        "organization-claude-subscription/": null,
        "workspace-claude-subscription/": [allowed],
      },
    });
    // The workspace source serves only the workspace pool.
    await setSource(org, "workspace");
    expect((await read()).organization).toBe(false);
    expect((await read()).workspace).toBe(true);
    await setSource(org, "automatic");
    // A personal connection counts only for its owner in their own Personal workspace.
    await personalConnection(org, "ready-personal");
    expect((await read(org.personalWorkspaceId)).workspace).toBe(true);
    expect((await read(org.personalWorkspaceId, null)).workspace).toBe(false);
  });

  test("each prefix reads only its own pool's assignment policies", async () => {
    const org = await organization();
    await setCutover(org, true);
    const opus = `organization-claude-subscription/${org.opus}`;
    // One connection in both pools: the organization pool allows only Opus,
    // the workspace pool every model.
    await sharedConnection(org, "two-pools", {
      policies: [
        { pool: "organization", allowedModelIds: [opus] },
        { pool: "workspace", allowedModelIds: null },
      ],
    });
    expect(
      await readSubscriptionCoreClaudeCatalogReadiness(client.db, {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        subjectId: org.ownerSubjectId,
      }),
    ).toEqual({
      workspace: true,
      organization: true,
      restrictions: {
        "organization-claude-subscription/": [opus],
        "workspace-claude-subscription/": null,
      },
    });
    // The workspace pool's policy never widens organization admission.
    expect(await admit(org, org.opus, organizationSnapshot)).toBe(org.opus);
    expect(await admit(org, org.sonnet, organizationSnapshot)).toBeNull();
  });

  test("organization admission: the effective source and a live organization-pool connection", async () => {
    const org = await organization();
    await setCutover(org, true);
    expect(await admit(org, org.opus, organizationSnapshot)).toBeNull();
    // A personal connection never admits an organization model.
    await personalConnection(org, "admission-personal");
    expect(await admit(org, org.opus, organizationSnapshot)).toBeNull();
    const connectionId = await sharedConnection(org, "admission", {
      allowedModelIds: [`organization-claude-subscription/${org.opus}`],
    });
    expect(await admit(org, org.opus, organizationSnapshot)).toBe(org.opus);
    // A human's own new work resolves the current source; the v1 snapshot is
    // not read on the core.
    expect(
      await admit(org, org.opus, { authoritySnapshot: { version: 1, scope: "workspace" } }),
    ).toBe(org.opus);
    // Work whose authority was accepted before this request (a new session's
    // initial authority, an edit's source turn, agent work's receiving
    // session) needs the accepted-authority reader: without it (0716 is not
    // on this database) nothing is admitted.
    expect(await admit(org, org.opus, { sessionId: crypto.randomUUID() })).toBeNull();
    expect(
      await admit(org, org.opus, {
        ...organizationSnapshot,
        acceptedSource: { kind: "session_turn", turnId: crypto.randomUUID() },
      }),
    ).toBeNull();
    expect(
      await admit(org, org.opus, {
        ...organizationSnapshot,
        acceptedSource: { kind: "receiving_session", sessionId: crypto.randomUUID() },
      }),
    ).toBeNull();
    // The connection's allowlist bounds the model.
    expect(await admit(org, org.sonnet, organizationSnapshot)).toBeNull();
    // A caller that established no subject admits nothing; no person is inferred.
    expect(await admit(org, org.opus, organizationSnapshot, { subject: false })).toBeNull();
    expect(await admit(org, org.opus, undefined)).toBeNull();
    // A scheduled-task update whose accepted authority cannot be read admits nothing.
    expect(
      await admit(org, org.opus, { ...organizationSnapshot, scheduledTaskId: crypto.randomUUID() }),
    ).toBeNull();
    // The workspace source excludes organization connections.
    await setSource(org, "workspace");
    expect(await admit(org, org.opus, organizationSnapshot)).toBeNull();
    await setSource(org, "organization");
    expect(await admit(org, org.opus, organizationSnapshot)).toBe(org.opus);
    // Liveness: a paused or relogin-pending connection does not serve.
    await shared.admin`update subscription_connections set status = 'needs_relogin'
      where id = ${connectionId}::uuid`;
    expect(await admit(org, org.opus, organizationSnapshot)).toBeNull();
    await shared.admin`update subscription_connections set status = 'active'
      where id = ${connectionId}::uuid`;
    expect(await admit(org, org.opus, organizationSnapshot)).toBe(org.opus);
    // Maintenance admits nothing.
    await setCutover(org, false);
    expect(await admit(org, org.opus, organizationSnapshot)).toBeNull();
  });

  test("carried accepted authority decides through the accepted-authority reader", async () => {
    const org = await organization();
    await setCutover(org, true);
    await sharedConnection(org, "carried");
    const initial = (sessionId: string): CompatCarrier => ({
      kind: "session_initial",
      id: sessionId,
    });
    // A session accepted after Claude's receipt without a record: `none`
    // follows the source rule of new work.
    const created = await session(org);
    expect(await readCompat(org, initial(created.sessionId))).toEqual({ authority: "none" });
    expect(await admit(org, org.opus, { sessionId: created.sessionId })).toBe(org.opus);
    // A compatibility record admits only when its shared pool is the organization's.
    const workspaceRecord = await session(org);
    await compatRecord(org, initial(workspaceRecord.sessionId), "workspace");
    expect(await readCompat(org, initial(workspaceRecord.sessionId))).toMatchObject({
      authority: "record",
      sharedPool: "workspace",
      personal: [],
    });
    expect(await admit(org, org.opus, { sessionId: workspaceRecord.sessionId })).toBeNull();
    const organizationRecord = await session(org);
    await compatRecord(org, initial(organizationRecord.sessionId), "organization");
    expect(await admit(org, org.opus, { sessionId: organizationRecord.sessionId })).toBe(org.opus);
    // Accepted before the receipt without a record: `missing` admits nothing.
    const before = await session(org);
    await acceptedBeforeReceipt(before.sessionId);
    expect(await readCompat(org, initial(before.sessionId))).toEqual({
      authority: "missing",
      personal: [],
      sharedPool: "none",
    });
    expect(await admit(org, org.opus, { sessionId: before.sessionId })).toBeNull();
    // Another organization's carrier is not visible: the reader answers
    // nothing even when named with its own workspace, and nothing is admitted.
    const other = await organization();
    const foreign = await session(other);
    expect(await readCompat(org, initial(foreign.sessionId), other.workspaceId)).toBeNull();
    expect(await admit(org, org.opus, { sessionId: foreign.sessionId })).toBeNull();

    // An edit: its source turn's authority, whatever the copied snapshot says.
    const edited = await session(org, { turn: true });
    const edit = (turnId: string) => ({
      ...organizationSnapshot,
      acceptedSource: { kind: "session_turn" as const, turnId },
    });
    expect(await admit(org, org.opus, edit(edited.turnId!))).toBe(org.opus);
    await compatRecord(org, { kind: "session_turn", id: edited.turnId! }, "workspace");
    expect(await admit(org, org.opus, edit(edited.turnId!))).toBeNull();
    // A turn that froze a v2 entry for Claude: `v2` follows the source rule.
    const frozen = await session(org, { turn: true });
    await freezeClaudeV2(org, frozen.turnId!);
    expect(await readCompat(org, { kind: "session_turn", id: frozen.turnId! })).toEqual({
      authority: "v2",
    });
    expect(await admit(org, org.opus, edit(frozen.turnId!))).toBe(org.opus);

    // Agent work: the receiving session's latest accepted turn (here its
    // workspace record, though its initial authority is `none`), else its
    // initial authority.
    const receiving = (sessionId: string) => ({
      ...organizationSnapshot,
      acceptedSource: { kind: "receiving_session" as const, sessionId },
    });
    expect(await admit(org, org.opus, receiving(edited.sessionId))).toBeNull();
    expect(await admit(org, org.opus, receiving(workspaceRecord.sessionId))).toBeNull();
    expect(await admit(org, org.opus, receiving(organizationRecord.sessionId))).toBe(org.opus);
    expect(await admit(org, org.opus, receiving(before.sessionId))).toBeNull();
    expect(await admit(org, org.opus, receiving(foreign.sessionId))).toBeNull();
    expect(await admit(org, org.opus, receiving(crypto.randomUUID()))).toBeNull();

    // A scheduled task: `none` until it holds a workspace record.
    const taskId = await scheduledTask(org);
    const task = { ...organizationSnapshot, scheduledTaskId: taskId };
    expect(await admit(org, org.opus, task)).toBe(org.opus);
    await compatRecord(org, { kind: "scheduled_task", id: taskId }, "workspace");
    expect(await admit(org, org.opus, task)).toBeNull();

    // A carrier that admits still needs the current source and a live connection.
    await setSource(org, "workspace");
    expect(await admit(org, org.opus, { sessionId: organizationRecord.sessionId })).toBeNull();
  });

  test("which accepted authority admits an organization model", () => {
    const admits = subscriptionCoreClaudeAcceptedAuthorityAdmitsOrganization;
    expect(admits({ authority: "record", sharedPool: "organization", personal: [] })).toBe(true);
    expect(admits({ authority: "record", sharedPool: "workspace", personal: [] })).toBe(false);
    expect(admits({ authority: "record", sharedPool: "none", personal: [] })).toBe(false);
    expect(admits({ authority: "v2" })).toBe(true);
    expect(admits({ authority: "none" })).toBe(true);
    expect(admits({ authority: "missing", sharedPool: "none", personal: [] })).toBe(false);
    expect(admits({ authority: "v1" })).toBe(false);
    for (const value of [null, undefined, "record", [], {}, { authority: "other" }])
      expect(admits(value)).toBe(false);
  });
});

/** Another active organization member with their own Personal workspace, also in the shared workspace. */
async function member(org: Org, role: "member" | "admin" = "member") {
  const subjectId = `user:claude-reads-member-${crypto.randomUUID()}`;
  const [personal] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${org.accountId}, 'Claude reads member Personal workspace') returning id::text as id`;
  await shared.admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${org.accountId}, ${subjectId}, ${role}, 'active', ${personal!.id})`;
  for (const workspaceId of [personal!.id, org.workspaceId])
    await shared.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${org.accountId}::uuid, ${workspaceId}::uuid, ${subjectId},
        ${workspaceId === personal!.id ? "owner" : "member"})
      on conflict do nothing`;
  return { subjectId, personalWorkspaceId: personal!.id };
}

/**
 * Replace a connection's stored credential with one that expired a minute
 * ago; returns the refresh generation the write moved it to.
 */
async function expireCredential(connectionId: string, label: string): Promise<number> {
  await shared.admin`
    update subscription_connections
    set credential_encrypted = ${credential(label, "oauth", -60_000)},
      expires_at = clock_timestamp() - interval '1 minute'
    where id = ${connectionId}::uuid`;
  return await refreshGeneration(connectionId);
}

/** A scripted OAuth token endpoint for the duration of `use`. */
async function withTokenEndpoint<T>(use: (rotations: string[]) => Promise<T>): Promise<T> {
  const rotations: string[] = [];
  const previous = tokenEndpoint;
  tokenEndpoint = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== CLAUDE_OAUTH_TOKEN_URL) throw new Error(`unexpected request ${input}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as { refresh_token?: string };
    rotations.push(body.refresh_token ?? "");
    return Response.json({
      access_token: `sk-ant-oat01-rotated-${body.refresh_token}`,
      refresh_token: `refresh-rotated-${body.refresh_token}`,
      expires_in: 8 * 60 * 60,
      scope: "user:inference user:profile",
    });
  }) as unknown as typeof fetch;
  try {
    return await use(rotations);
  } finally {
    tokenEndpoint = previous;
  }
}

async function refreshGeneration(connectionId: string): Promise<number> {
  const [row] = await shared.admin<{ generation: number }[]>`
    select refresh_generation::int as generation from subscription_connections
    where id = ${connectionId}::uuid`;
  return row!.generation;
}

const liveUsage = () =>
  scriptedUsage(() =>
    Response.json({
      five_hour: { utilization: 40, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
      seven_day_opus: {
        utilization: 100,
        resets_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    }),
  );

describe("live refresh outside a workspace pool (C2c)", () => {
  const organizationRow = async (org: Org, connectionId: string) =>
    (await readSubscriptionCoreClaudeOrganizationUsageRow(client.db, {
      organizationId: org.accountId,
      subjectId: org.ownerSubjectId,
      accountIdParam: connectionId,
    }))!;
  const organizationRefresh = async (
    input: Parameters<typeof refreshSubscriptionCoreClaudeOrganizationUsage>[2],
    fetchImpl: typeof fetch,
  ) => {
    resetSubscriptionCoreClaudeUsageThrottle();
    return (
      await refreshSubscriptionCoreClaudeOrganizationUsage(client.db, settings, input, {
        fetchImpl,
      })
    ).usage;
  };

  test("the organization route: an administrator reads organization-pool connections live", async () => {
    resetSubscriptionCoreClaudeUsageThrottle();
    const org = await organization();
    await setCutover(org, true);
    const connectionId = await sharedConnection(org, "admin-live");
    const workspaceManaged = await sharedConnection(org, "admin-managed", { pool: "workspace" });
    const row = await organizationRow(org, connectionId);
    const upstream = liveUsage();
    // Refused without a provider call: a member who is not an administrator,
    // another organization's administrator (for this organization, or with
    // this organization's connection on their own), a connection a
    // workspace manages, and a cutover in maintenance.
    const plain = await member(org);
    const otherOrg = await organization();
    await setCutover(otherOrg, true);
    for (const input of [
      { organizationId: org.accountId, subjectId: plain.subjectId, row },
      { organizationId: org.accountId, subjectId: otherOrg.ownerSubjectId, row },
      { organizationId: otherOrg.accountId, subjectId: otherOrg.ownerSubjectId, row },
      {
        organizationId: org.accountId,
        subjectId: org.ownerSubjectId,
        row: { ...row, id: workspaceManaged },
      },
    ])
      expect((await organizationRefresh(input, upstream.fetchImpl)).refreshStatus).toBe(
        "unavailable",
      );
    await setCutover(org, false);
    expect(
      (
        await organizationRefresh(
          { organizationId: org.accountId, subjectId: org.ownerSubjectId, row },
          upstream.fetchImpl,
        )
      ).refreshStatus,
    ).toBe("unavailable");
    await setCutover(org, true);
    expect(upstream.calls).toHaveLength(0);
    expect(await storedQuota(connectionId)).toBeNull();
    expect(await storedQuota(workspaceManaged)).toBeNull();

    // The administrator: a live read, stored with the organization's models.
    resetSubscriptionCoreClaudeUsageThrottle();
    const input = { organizationId: org.accountId, subjectId: org.ownerSubjectId, row };
    const result = await refreshSubscriptionCoreClaudeOrganizationUsage(
      client.db,
      settings,
      input,
      {
        fetchImpl: upstream.fetchImpl,
      },
    );
    expect(upstream.calls).toEqual(["Bearer sk-ant-oat01-admin-live"]);
    expect(result.recovered).toBe(false);
    expect(result.usage.refreshStatus).toBe("available");
    expect(result.usage.credentialVersion).toBe(await connectionVersion(connectionId));
    expect(result.usage.windows.map((window) => window.id)).toEqual([
      "five_hour",
      "seven_day_opus",
    ]);
    const quota = (await storedQuota(connectionId))!;
    // The organization's Opus model, under both Claude prefixes (the decoder's rule).
    expect(Object.keys(quota.modelCooldowns as object).sort()).toEqual([
      `organization-claude-subscription/${org.opus}`,
      `workspace-claude-subscription/${org.opus}`,
    ]);
    // Within 30 seconds the stored reading answers without a provider call.
    const again = await refreshSubscriptionCoreClaudeOrganizationUsage(
      client.db,
      settings,
      { ...input, row: await organizationRow(org, connectionId) },
      { fetchImpl: upstream.fetchImpl },
    );
    expect(upstream.calls).toHaveLength(1);
    expect(again.usage.refreshStatus).toBe("available");
    expect(again.usage.windows).toEqual(result.usage.windows);
  });

  test("the organization route: an expired credential rotates under the administrator; a 401 asks for reconnect", async () => {
    const org = await organization();
    await setCutover(org, true);
    const connectionId = await sharedConnection(org, "admin-rotate");
    const generation = await expireCredential(connectionId, "admin-rotate");
    const upstream = liveUsage();
    await withTokenEndpoint(async (rotations) => {
      const usage = await organizationRefresh(
        {
          organizationId: org.accountId,
          subjectId: org.ownerSubjectId,
          row: await organizationRow(org, connectionId),
        },
        upstream.fetchImpl,
      );
      expect(rotations).toEqual(["refresh-admin-rotate"]);
      expect(upstream.calls).toEqual(["Bearer sk-ant-oat01-rotated-refresh-admin-rotate"]);
      expect(usage.refreshStatus).toBe("available");
    });
    expect(await refreshGeneration(connectionId)).toBe(generation + 1);
    const [stored] = await shared.admin<{ generation: number }[]>`
      select observed_refresh_generation::int as generation from subscription_connection_quota
      where connection_id = ${connectionId}::uuid`;
    expect(stored?.generation).toBe(generation + 1);

    const revokedId = await sharedConnection(org, "admin-revoked");
    const revoked = scriptedUsage(() => new Response("revoked", { status: 401 }));
    const usage = await organizationRefresh(
      {
        organizationId: org.accountId,
        subjectId: org.ownerSubjectId,
        row: await organizationRow(org, revokedId),
      },
      revoked.fetchImpl,
    );
    expect(usage.refreshStatus).toBe("reconnect");
    expect(await storedQuota(revokedId)).toBeNull();
  });

  test("the owner refreshes their own personal connection, only in their own Personal workspace", async () => {
    const org = await organization();
    await setCutover(org, true);
    const personal = await personalConnection(org, "own-live");
    const own = (await readSubscriptionCoreClaudeWorkspaceUsageTarget(client.db, {
      accountId: org.accountId,
      workspaceId: org.personalWorkspaceId,
      subjectId: org.ownerSubjectId,
      accountIdParam: personal,
    }))!;
    expect(own.scope).toBe("user");
    const upstream = liveUsage();
    const refresh = async (workspaceId: string, subjectId: string) => {
      resetSubscriptionCoreClaudeUsageThrottle();
      return await refreshSubscriptionCoreClaudeWorkspaceUsage(
        client.db,
        settings,
        { accountId: org.accountId, workspaceId, subjectId, target: own },
        { fetchImpl: upstream.fetchImpl },
      );
    };
    // Refused without a provider call: another member (in their own Personal
    // workspace, or in the owner's), the owner in a shared workspace, a
    // revoked authority, a stale authority generation and maintenance.
    const other = await member(org);
    expect((await refresh(other.personalWorkspaceId, other.subjectId)).usage.refreshStatus).toBe(
      "unavailable",
    );
    expect((await refresh(org.personalWorkspaceId, other.subjectId)).usage.refreshStatus).toBe(
      "unavailable",
    );
    expect((await refresh(org.workspaceId, org.ownerSubjectId)).usage.refreshStatus).toBe(
      "unavailable",
    );
    await shared.admin`update organization_user_resource_authorities
      set status = 'revoked', revoked_at = now() where resource_id = ${personal}::uuid`;
    expect((await refresh(org.personalWorkspaceId, org.ownerSubjectId)).usage.refreshStatus).toBe(
      "unavailable",
    );
    await shared.admin`update organization_user_resource_authorities
      set status = 'active', revoked_at = null where resource_id = ${personal}::uuid`;
    await shared.admin`update organization_user_resource_authorities
      set generation = 2 where resource_id = ${personal}::uuid`;
    expect((await refresh(org.personalWorkspaceId, org.ownerSubjectId)).usage.refreshStatus).toBe(
      "unavailable",
    );
    await shared.admin`update organization_user_resource_authorities
      set generation = 1 where resource_id = ${personal}::uuid`;
    await setCutover(org, false);
    expect((await refresh(org.personalWorkspaceId, org.ownerSubjectId)).usage.refreshStatus).toBe(
      "unavailable",
    );
    await setCutover(org, true);
    expect(upstream.calls).toHaveLength(0);
    expect(await storedQuota(personal)).toBeNull();

    // The owner, in their own Personal workspace: a live read, stored.
    const result = await refresh(org.personalWorkspaceId, org.ownerSubjectId);
    expect(upstream.calls).toEqual(["Bearer sk-ant-oat01-own-live"]);
    expect(result.usage.refreshStatus).toBe("available");
    expect(result.usage.credentialVersion).toBe(await connectionVersion(personal));
    const quota = (await storedQuota(personal))!;
    expect(Object.keys(quota.modelCooldowns as object).sort()).toEqual([
      `organization-claude-subscription/${org.opus}`,
      `workspace-claude-subscription/${org.opus}`,
    ]);
    // The stored reading answers the next refresh within 30 seconds.
    const reread = (await readSubscriptionCoreClaudeWorkspaceUsageTarget(client.db, {
      accountId: org.accountId,
      workspaceId: org.personalWorkspaceId,
      subjectId: org.ownerSubjectId,
      accountIdParam: personal,
    }))!;
    const again = await refreshSubscriptionCoreClaudeWorkspaceUsage(
      client.db,
      settings,
      {
        accountId: org.accountId,
        workspaceId: org.personalWorkspaceId,
        subjectId: org.ownerSubjectId,
        target: reread,
      },
      { fetchImpl: upstream.fetchImpl },
    );
    expect(upstream.calls).toHaveLength(1);
    expect(again.usage.windows).toEqual(result.usage.windows);
  });

  test("the owner's personal refresh rotates an expired credential through the owner-only routine; a 401 asks for reconnect", async () => {
    const org = await organization();
    await setCutover(org, true);
    const personal = await personalConnection(org, "own-rotate");
    const generation = await expireCredential(personal, "own-rotate");
    const scope = {
      accountId: org.accountId,
      workspaceId: org.personalWorkspaceId,
      subjectId: org.ownerSubjectId,
    };
    const refresh = async (fetchImpl: typeof fetch) => {
      resetSubscriptionCoreClaudeUsageThrottle();
      return (
        await refreshSubscriptionCoreClaudeWorkspaceUsage(
          client.db,
          settings,
          {
            ...scope,
            target: (await readSubscriptionCoreClaudeWorkspaceUsageTarget(client.db, {
              ...scope,
              accountIdParam: personal,
            }))!,
          },
          { fetchImpl },
        )
      ).usage;
    };
    const upstream = liveUsage();
    await withTokenEndpoint(async (rotations) => {
      expect((await refresh(upstream.fetchImpl)).refreshStatus).toBe("available");
      expect(rotations).toEqual(["refresh-own-rotate"]);
      expect(upstream.calls).toEqual(["Bearer sk-ant-oat01-rotated-refresh-own-rotate"]);
    });
    expect(await refreshGeneration(personal)).toBe(generation + 1);
    const [stored] = await shared.admin<{ generation: number }[]>`
      select observed_refresh_generation::int as generation from subscription_connection_quota
      where connection_id = ${personal}::uuid`;
    expect(stored?.generation).toBe(generation + 1);
    // A 401 asks for a new sign-in; nothing is stored.
    const revokedId = await personalConnection(org, "own-revoked");
    const revoked = scriptedUsage(() => new Response("revoked", { status: 401 }));
    const usage = (
      await refreshSubscriptionCoreClaudeWorkspaceUsage(
        client.db,
        settings,
        {
          ...scope,
          target: (await readSubscriptionCoreClaudeWorkspaceUsageTarget(client.db, {
            ...scope,
            accountIdParam: revokedId,
          }))!,
        },
        { fetchImpl: revoked.fetchImpl },
      )
    ).usage;
    expect(usage.refreshStatus).toBe("reconnect");
    expect(await storedQuota(revokedId)).toBeNull();
  });

  test("a refusing seam answers the stored projection with no check time, keeps scope_required, and is not remembered", async () => {
    resetSubscriptionCoreClaudeUsageThrottle();
    // This case must also work in isolation for the refusal mutation probe.
    await ensureTestClaudeRegistration();
    const org = await organization();
    await setCutover(org, true);
    const oauthId = await sharedConnection(org, "refused-oauth");
    const setupId = await sharedConnection(org, "refused-setup", { kind: "setup" });
    const personal = await personalConnection(org, "refused-own");
    const upstream = liveUsage();
    // Age each prior success once, never between a refusal and its retry.
    // The retry must use the identical scope/id/version and a warm throttle.
    let clock = Date.now();
    const organizationUsage = async (connectionId: string) => {
      return await refreshSubscriptionCoreClaudeOrganizationUsage(
        client.db,
        settings,
        {
          organizationId: org.accountId,
          subjectId: org.ownerSubjectId,
          row: await organizationRow(org, connectionId),
        },
        { fetchImpl: upstream.fetchImpl, now: () => clock },
      );
    };
    const ownUsage = async () => {
      const target = (await readSubscriptionCoreClaudeWorkspaceUsageTarget(client.db, {
        accountId: org.accountId,
        workspaceId: org.personalWorkspaceId,
        subjectId: org.ownerSubjectId,
        accountIdParam: personal,
      }))!;
      return await refreshSubscriptionCoreClaudeWorkspaceUsage(
        client.db,
        settings,
        {
          accountId: org.accountId,
          workspaceId: org.personalWorkspaceId,
          subjectId: org.ownerSubjectId,
          target,
        },
        { fetchImpl: upstream.fetchImpl, now: () => clock },
      );
    };
    // A stored reading on each OAuth connection first.
    const organizationRead = await organizationUsage(oauthId);
    const ownRead = await ownUsage();
    expect(organizationRead.usage.refreshStatus).toBe("available");
    expect(ownRead.usage.refreshStatus).toBe("available");
    expect(upstream.calls).toHaveLength(2);
    const stored = {
      organization: await storedQuota(oauthId),
      own: await storedQuota(personal),
    };
    const refusedAs = (
      result: Awaited<ReturnType<typeof ownUsage>>,
      previous: Awaited<ReturnType<typeof ownUsage>>,
    ) => {
      expect(result.recovered).toBe(false);
      expect(result.usage.refreshStatus).toBe("unavailable");
      expect(result.usage.refreshCheckedAt).toBeNull();
      expect(result.usage.windows.map((window) => window.id)).toEqual(
        previous.usage.windows.map((window) => window.id),
      );
    };

    // Maintenance: the organization route refuses (stored usage, no check
    // time; the setup token keeps `scope_required`), then reads live again
    // once the cutover is enabled.
    clock += 31_000;
    await setCutover(org, false);
    refusedAs(await organizationUsage(oauthId), organizationRead);
    const setup = await organizationUsage(setupId);
    expect(setup.usage.refreshStatus).toBe("scope_required");
    expect(setup.usage.refreshCheckedAt).toBeNull();
    await setCutover(org, true);
    expect(upstream.calls).toHaveLength(2);
    expect(await storedQuota(oauthId)).toEqual(stored.organization);
    expect(await storedQuota(setupId)).toBeNull();
    clock += 1_000;
    const organizationRetry = await organizationUsage(oauthId);
    expect(organizationRetry.usage.refreshStatus).toBe("available");
    expect(organizationRetry.usage.credentialVersion).toBe(
      organizationRead.usage.credentialVersion,
    );
    expect(upstream.calls).toHaveLength(3);

    // A revoked authority: the owner's refresh refuses, then reads again
    // once the authority is restored.
    await shared.admin`update organization_user_resource_authorities
      set status = 'revoked', revoked_at = now() where resource_id = ${personal}::uuid`;
    refusedAs(await ownUsage(), ownRead);
    await shared.admin`update organization_user_resource_authorities
      set status = 'active', revoked_at = null where resource_id = ${personal}::uuid`;
    expect(upstream.calls).toHaveLength(3);
    expect(await storedQuota(personal)).toEqual(stored.own);
    clock += 1_000;
    const ownRetry = await ownUsage();
    expect(ownRetry.usage.refreshStatus).toBe("available");
    expect(ownRetry.usage.credentialVersion).toBe(ownRead.usage.credentialVersion);
    expect(upstream.calls).toHaveLength(4);

    // Personal connections switched off for the organization: refused, and
    // a connection without the usage scope keeps `scope_required`.
    const ownBefore = await storedQuota(personal);
    clock += 31_000;
    await shared.admin`update subscription_settings set personal_connections_allowed = false
      where account_id = ${org.accountId}::uuid and workspace_id is null`;
    refusedAs(await ownUsage(), ownRead);
    await shared.admin`update subscription_connections
      set provider_state = ${shared.admin.json({ oauthScopes: ["user:inference"] })}::jsonb
      where id = ${personal}::uuid`;
    const scopeless = await ownUsage();
    expect(scopeless.usage.refreshStatus).toBe("scope_required");
    expect(scopeless.usage.refreshCheckedAt).toBeNull();
    expect(upstream.calls).toHaveLength(4);
    expect(await storedQuota(personal)).toEqual(ownBefore);
    await shared.admin`update subscription_connections
      set provider_state = ${shared.admin.json({ oauthScopes: ["user:inference", "user:profile"] })}::jsonb
      where id = ${personal}::uuid`;
    await shared.admin`update subscription_settings set personal_connections_allowed = true
      where account_id = ${org.accountId}::uuid and workspace_id is null`;
    clock += 1_000;
    const enabledRetry = await ownUsage();
    expect(enabledRetry.usage.refreshStatus).toBe("available");
    expect(enabledRetry.usage.credentialVersion).toBe(ownRead.usage.credentialVersion);
    expect(upstream.calls).toHaveLength(5);
  });

  test("actual failed transports remain remembered within 30 seconds on organization and personal paths", async () => {
    resetSubscriptionCoreClaudeUsageThrottle();
    await ensureTestClaudeRegistration();
    const org = await organization();
    await setCutover(org, true);
    const connectionId = await sharedConnection(org, "remember-failure-org");
    const personal = await personalConnection(org, "remember-failure-own");
    let clock = Date.now();
    let fails = true;
    const upstream = scriptedUsage(() => {
      if (fails) throw new Error("injected transport failure");
      return Response.json({ five_hour: { utilization: 12, resets_at: null } });
    });
    const refreshes = [
      async () =>
        refreshSubscriptionCoreClaudeOrganizationUsage(
          client.db,
          settings,
          {
            organizationId: org.accountId,
            subjectId: org.ownerSubjectId,
            row: await organizationRow(org, connectionId),
          },
          { fetchImpl: upstream.fetchImpl, now: () => clock },
        ),
      async () => {
        const scope = {
          accountId: org.accountId,
          workspaceId: org.personalWorkspaceId,
          subjectId: org.ownerSubjectId,
        };
        const target = (await readSubscriptionCoreClaudeWorkspaceUsageTarget(client.db, {
          ...scope,
          accountIdParam: personal,
        }))!;
        return refreshSubscriptionCoreClaudeWorkspaceUsage(
          client.db,
          settings,
          { ...scope, target },
          { fetchImpl: upstream.fetchImpl, now: () => clock },
        );
      },
    ];
    for (const refresh of refreshes) {
      fails = true;
      const callsBefore = upstream.calls.length;
      const failed = await refresh();
      expect(failed.usage.refreshStatus).toBe("unavailable");
      expect(failed.usage.refreshCheckedAt).not.toBeNull();
      expect(upstream.calls).toHaveLength(callsBefore + 1);
      fails = false;
      clock += 1_000;
      const remembered = await refresh();
      expect(remembered.usage.refreshStatus).toBe("unavailable");
      expect(remembered.usage.refreshCheckedAt).toBe(failed.usage.refreshCheckedAt);
      expect(upstream.calls).toHaveLength(callsBefore + 1);
      clock += 30_000;
      expect((await refresh()).usage.refreshStatus).toBe("available");
      expect(upstream.calls).toHaveLength(callsBefore + 2);
    }
  });

  test("a stored needs_relogin answers reconnect on both new paths, with no provider call and no quota", async () => {
    resetSubscriptionCoreClaudeUsageThrottle();
    const org = await organization();
    await setCutover(org, true);
    const organizationId = await sharedConnection(org, "relogin-org");
    const personal = await personalConnection(org, "relogin-own");
    await shared.admin`update subscription_connections
      set status = 'needs_relogin', last_error = 'Sign-in expired'
      where id in (${organizationId}::uuid, ${personal}::uuid)`;
    const upstream = liveUsage();
    const organizationResult = await refreshSubscriptionCoreClaudeOrganizationUsage(
      client.db,
      settings,
      {
        organizationId: org.accountId,
        subjectId: org.ownerSubjectId,
        row: await organizationRow(org, organizationId),
      },
      { fetchImpl: upstream.fetchImpl },
    );
    const target = (await readSubscriptionCoreClaudeWorkspaceUsageTarget(client.db, {
      accountId: org.accountId,
      workspaceId: org.personalWorkspaceId,
      subjectId: org.ownerSubjectId,
      accountIdParam: personal,
    }))!;
    expect(target.scope).toBe("user");
    const ownResult = await refreshSubscriptionCoreClaudeWorkspaceUsage(
      client.db,
      settings,
      {
        accountId: org.accountId,
        workspaceId: org.personalWorkspaceId,
        subjectId: org.ownerSubjectId,
        target,
      },
      { fetchImpl: upstream.fetchImpl },
    );
    for (const result of [organizationResult, ownResult]) {
      expect(result.usage.refreshStatus).toBe("reconnect");
      expect(result.recovered).toBe(false);
    }
    expect(upstream.calls).toEqual([]);
    expect(await storedQuota(organizationId)).toBeNull();
    expect(await storedQuota(personal)).toBeNull();
  });

  test("the owner-only routines refuse every other context", async () => {
    const org = await organization();
    await setCutover(org, true);
    const personal = await personalConnection(org, "routines");
    const other = await member(org);
    const call = async (
      context: { workspaceId: string; subjectId: string },
      args: { workspaceId: string; subjectId: string },
    ) =>
      await withRlsContext(
        client.db,
        { accountId: org.accountId, workspaceId: context.workspaceId },
        async (tx) => {
          await setSubjectRlsContext(tx, context.subjectId);
          const owner = sql`'claude', ${org.accountId}::uuid, ${args.workspaceId}::uuid,
            ${args.subjectId}, ${personal}::uuid`;
          const read = await rawRows<{ status: string }>(
            tx,
            sql`select status from opengeni_private.read_subscription_core_owned_connection_credential(${owner})`,
          );
          const begun = await rawRows<{ refresh_generation: number }>(
            tx,
            sql`select refresh_generation from opengeni_private.begin_subscription_core_owned_connection_refresh(${owner})`,
          );
          const record = async () =>
            (
              await rawRows<{ recorded: boolean }>(
                tx,
                sql`select opengeni_private.record_subscription_core_owned_connection_quota(${owner},
                  1::bigint, null::bigint, ${JSON.stringify({ windows: [], modelCooldowns: {}, exhaustedUntil: null, exhaustedKind: null, source: "usage_endpoint" })}::jsonb,
                  now()) as recorded`,
              )
            )[0];
          const recorded = await record();
          // The same write again: the stored revision moved, so it is refused.
          if (recorded?.recorded === true) expect((await record())?.recorded).toBe(false);
          throw Object.assign(new Error("rollback"), {
            outcome: {
              read: read.length,
              begun: begun.length,
              recorded: recorded?.recorded === true,
            },
          });
        },
      ).catch((error: { outcome?: unknown }) => {
        if (!error.outcome) throw error;
        return error.outcome;
      });
    const none = { read: 0, begun: 0, recorded: false };
    const owner = { workspaceId: org.personalWorkspaceId, subjectId: org.ownerSubjectId };
    // The owner, in their own Personal workspace.
    expect(await call(owner, owner)).toEqual({ read: 1, begun: 1, recorded: true });
    // Arguments that differ from the transaction's context.
    expect(await call(owner, { ...owner, subjectId: other.subjectId })).toEqual(none);
    expect(await call(owner, { ...owner, workspaceId: org.workspaceId })).toEqual(none);
    // Another member, in their own context; the owner in a shared workspace.
    const otherContext = { workspaceId: other.personalWorkspaceId, subjectId: other.subjectId };
    expect(await call(otherContext, otherContext)).toEqual(none);
    const sharedContext = { workspaceId: org.workspaceId, subjectId: org.ownerSubjectId };
    expect(await call(sharedContext, sharedContext)).toEqual(none);
    // A subject that is not a person (an ownerless session's service actor).
    const service = { workspaceId: org.personalWorkspaceId, subjectId: "service:scheduler" };
    expect(await call(service, service)).toEqual(none);
    // Not a disconnected connection.
    await shared.admin`update subscription_connections
      set disconnected_at = now(), status = 'disabled', credential_encrypted = '',
        provider_account_id = null, allocator_enabled = false
      where id = ${personal}::uuid`;
    expect(await call(owner, owner)).toEqual(none);
  });
});
