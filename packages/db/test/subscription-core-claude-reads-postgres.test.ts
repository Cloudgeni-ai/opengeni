/**
 * Claude usage, catalog readiness and organization custom-model admission on
 * the shared core (design 5.3, Claude track C2a), on real PostgreSQL as the
 * non-owner application role.
 *
 * Claude stays unregistered in production until its cutover (C3); this file
 * registers the production binding in its own process, and its registry row
 * and cutover receipt on its own test database, after first asserting the
 * legacy route (no receipt) is unchanged. The usage endpoint is scripted
 * through the probe's transport; real network is denied.
 *
 * Run this file in its own process: the registration replaces module
 * bindings for the whole process.
 */
import { afterAll, beforeAll, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type { Settings } from "@opengeni/config";
import { sql } from "drizzle-orm";
import { subscriptionCoreProviderIds } from "../src/subscription-core-providers";
import {
  subscriptionCoreClaudeProvider,
  type SubscriptionCoreClaudeCredential,
} from "../src/subscription-core-claude-adapter";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import { installNetworkDenialGuard } from "./fixtures/subscription-core-fake-api-key";
import {
  admitTestSubscriptionCoreProvider,
  testSubscriptionCoreProviderModules,
} from "./helpers/subscription-core-test-provider";

setDefaultTimeout(180_000);

// Read before the test registration: what production registers.
const productionProviderIds = subscriptionCoreProviderIds();

const CLAUDE = subscriptionCoreClaudeProvider({
  fetch: (async () => {
    throw new Error("no OAuth refresh is expected in this suite");
  }) as unknown as typeof fetch,
});
for (const [specifier, factory] of testSubscriptionCoreProviderModules(CLAUDE))
  mock.module(specifier, factory);

const {
  bootstrapWorkspace,
  createDb,
  createOrganizationModelProviderCustomModel,
  lockActiveOrganizationModelProviderCustomModelForAdmission,
  readSubscriptionCoreClaudeCatalogReadiness,
  readSubscriptionCoreClaudeOrganizationUsageRow,
  readSubscriptionCoreClaudeWorkspaceUsageTarget,
  readSubscriptionCoreProviderRouteForWorkspace,
  refreshSubscriptionCoreClaudeWorkspaceUsage,
  resetSubscriptionCoreClaudeUsageThrottle,
  subscriptionCoreClaudeAcceptedAuthorityAdmitsOrganization,
  upsertOrganizationClaudeSubscription,
} = await import("../src");
const { rawRows, withRlsContext, withSessionActivityRlsContext, withWorkspaceSubjectRls } =
  await import("../src/database");
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

async function setSource(org: Org, inferenceSource: "automatic" | "workspace" | "organization") {
  await shared.admin`
    update subscription_settings
    set providers = ${shared.admin.json({ claude: { inferenceSource } })}::jsonb
    where account_id = ${org.accountId}::uuid and workspace_id is null`;
}

function credential(label: string, kind: "oauth" | "setup" = "oauth"): string {
  const value: SubscriptionCoreClaudeCredential = {
    version: 1,
    token: `sk-ant-oat01-${label}`,
    identity: { accountUuid: crypto.randomUUID(), deviceId: "d".repeat(64) },
    ...(kind === "oauth"
      ? {
          oauth: {
            refreshToken: `refresh-${label}`,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
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

/**
 * A stand-in for PR 0b's `read_subscription_authority_compat` (0716 is not
 * on this stack): answers per carrier from a table and records each call.
 * Removed by the returned function.
 */
async function installCompatReader() {
  await shared.admin.unsafe(`
    create table public.claude_reads_compat_answers (
      carrier_kind text not null, carrier_id uuid not null, answer jsonb,
      primary key (carrier_kind, carrier_id));
    create table public.claude_reads_compat_calls (
      provider text, carrier_kind text, carrier_id uuid, at timestamptz default clock_timestamp());
    create function opengeni_private.read_subscription_authority_compat(
      p_provider text, p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid,
      p_task_authority_revision bigint)
    returns jsonb language plpgsql security definer set search_path = public, pg_temp as $body$
    begin
      insert into public.claude_reads_compat_calls (provider, carrier_kind, carrier_id)
      values (p_provider, p_carrier_kind, p_carrier_id);
      return (select answer from public.claude_reads_compat_answers
        where carrier_kind = p_carrier_kind and carrier_id = p_carrier_id);
    end $body$;
    grant execute on function opengeni_private.read_subscription_authority_compat(
      text, text, uuid, uuid, bigint) to public;`);
  return {
    answer: async (kind: string, id: string, answer: Record<string, unknown>) => {
      await shared.admin`
        insert into public.claude_reads_compat_answers (carrier_kind, carrier_id, answer)
        values (${kind}, ${id}::uuid, ${shared.admin.json(answer as never)}::jsonb)
        on conflict (carrier_kind, carrier_id) do update set answer = excluded.answer`;
    },
    lastCall: async () => {
      const [call] = await shared.admin<
        { provider: string; carrier_kind: string; carrier_id: string }[]
      >`select provider, carrier_kind, carrier_id::text as carrier_id
        from public.claude_reads_compat_calls order by at desc limit 1`;
      return call ?? null;
    },
    remove: async () => {
      await shared.admin.unsafe(`
        drop function opengeni_private.read_subscription_authority_compat(
          text, text, uuid, uuid, bigint);
        drop table public.claude_reads_compat_answers;
        drop table public.claude_reads_compat_calls;`);
    },
  };
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
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== USAGE_URL) throw new Error(`unexpected request ${url}`);
    calls.push(new Headers(init?.headers).get("authorization") ?? "");
    return respond();
  }) as typeof fetch;
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
  test("production registers no Claude binding", () => {
    expect(productionProviderIds).not.toContain("claude");
  });

  test("the route is legacy and organization admission keeps its v1 rule", async () => {
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
    expect(await admit(org, org.opus, organizationSnapshot)).toBe(org.opus);
    expect(
      await admit(org, org.opus, { authoritySnapshot: { version: 1, scope: "workspace" } }),
    ).toBeNull();
    expect(await admit(org, org.opus, organizationSnapshot, { subject: false })).toBeNull();
  });
});

describe("on the Claude core route", () => {
  test("the test registration admits the binding and its receipt", async () => {
    await admitTestSubscriptionCoreProvider(shared.admin, CLAUDE);
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
    const compat = await installCompatReader();
    try {
      // A new session: its initial authority.
      const created = await session(org);
      expect(await admit(org, org.opus, { sessionId: created.sessionId })).toBeNull();
      expect(await compat.lastCall()).toEqual({
        provider: "claude",
        carrier_kind: "session_initial",
        carrier_id: created.sessionId,
      });
      await compat.answer("session_initial", created.sessionId, { authority: "none" });
      expect(await admit(org, org.opus, { sessionId: created.sessionId })).toBe(org.opus);
      await compat.answer("session_initial", created.sessionId, {
        authority: "record",
        sharedPool: "workspace",
        personal: [],
      });
      expect(await admit(org, org.opus, { sessionId: created.sessionId })).toBeNull();
      await compat.answer("session_initial", created.sessionId, {
        authority: "record",
        sharedPool: "organization",
        personal: [],
      });
      expect(await admit(org, org.opus, { sessionId: created.sessionId })).toBe(org.opus);
      // An edit: its source turn's authority, whatever the copied snapshot says.
      const edited = await session(org, { turn: true });
      await compat.answer("session_turn", edited.turnId!, {
        authority: "record",
        sharedPool: "workspace",
        personal: [],
      });
      const edit = {
        ...organizationSnapshot,
        acceptedSource: { kind: "session_turn" as const, turnId: edited.turnId! },
      };
      expect(await admit(org, org.opus, edit)).toBeNull();
      await compat.answer("session_turn", edited.turnId!, { authority: "v2" });
      expect(await admit(org, org.opus, edit)).toBe(org.opus);
      // Agent work: the receiving session's latest accepted turn, else its
      // initial authority.
      const receiving = (sessionId: string) => ({
        ...organizationSnapshot,
        acceptedSource: { kind: "receiving_session" as const, sessionId },
      });
      expect(await admit(org, org.opus, receiving(edited.sessionId))).toBe(org.opus);
      expect(await compat.lastCall()).toMatchObject({
        carrier_kind: "session_turn",
        carrier_id: edited.turnId,
      });
      const fresh = await session(org);
      expect(await admit(org, org.opus, receiving(fresh.sessionId))).toBeNull();
      expect(await compat.lastCall()).toMatchObject({
        carrier_kind: "session_initial",
        carrier_id: fresh.sessionId,
      });
      // A session this workspace cannot see admits nothing (no reader call).
      expect(await admit(org, org.opus, receiving(crypto.randomUUID()))).toBeNull();
      // A scheduled task's record.
      const taskId = crypto.randomUUID();
      await compat.answer("scheduled_task", taskId, {
        authority: "record",
        sharedPool: "organization",
        personal: [],
      });
      expect(await admit(org, org.opus, { ...organizationSnapshot, scheduledTaskId: taskId })).toBe(
        org.opus,
      );
      // A carrier that admits still needs the current source and a live connection.
      await setSource(org, "workspace");
      expect(await admit(org, org.opus, { sessionId: created.sessionId })).toBeNull();
    } finally {
      await compat.remove();
    }
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
