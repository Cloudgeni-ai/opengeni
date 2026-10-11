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
  subscriptionCoreClaudeTaskAuthorityAdmitsOrganization,
  upsertOrganizationClaudeSubscription,
} = await import("../src");
const { rawRows, withRlsContext, withWorkspaceSubjectRls } = await import("../src/database");
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
  await shared.admin`
    insert into subscription_connection_assignment_policies (
      account_id, connection_id, workspace_id, inference_pool
    ) values (${org.accountId}::uuid, ${row!.id}::uuid, ${org.workspaceId}::uuid, ${pool})`;
  return row!.id;
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
    // The organization path: the organization's own connections, administrators only.
    const orgRow = (subjectId: string, accountIdParam: string) =>
      readSubscriptionCoreClaudeOrganizationUsageRow(client.db, {
        organizationId: org.accountId,
        subjectId,
        accountIdParam,
      });
    expect((await orgRow(org.ownerSubjectId, organizationPool))?.id).toBe(organizationPool);
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
      ["five_hour", "allowed"],
      ["seven_day_opus", null],
    ]);
    expect(result.usage.credentialVersion).toBeGreaterThan(0);
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
    // The v1 snapshot and the session's frozen snapshot are not read on the core.
    expect(
      await admit(org, org.opus, { authoritySnapshot: { version: 1, scope: "workspace" } }),
    ).toBe(org.opus);
    expect(await admit(org, org.opus, { sessionId: crypto.randomUUID() })).toBe(org.opus);
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

  test("a task's accepted authority decides a scheduled-task update", () => {
    const admits = subscriptionCoreClaudeTaskAuthorityAdmitsOrganization;
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
