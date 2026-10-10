import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  acquireSharedTestDatabase,
  type OwnerMigratedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { Settings } from "@opengeni/config";
import { CodexReloginRequired, isCodexAppsCredentialUnavailable } from "@opengeni/codex";
import { sql } from "drizzle-orm";
import {
  clearSubscriptionCoreCodexApps,
  createDb,
  claimSessionWorkForAttempt,
  createSession,
  deliverSubscriptionCoreCodexWake,
  enqueueSessionTurn,
  designateSubscriptionCoreCodexApps,
  ensureManagedAccessForUser,
  getSubscriptionCoreCodexAppsSettings,
  getSubscriptionCoreCodexSessionPointers,
  getSubscriptionCoreCodexWorkspaceProjection,
  getSubscriptionCoreOrganizationCodexProjection,
  getSubscriptionCoreSessionCodexAccounts,
  migrate,
  pinSubscriptionCoreSessionCodexAccount,
  provisionRoles,
  readCodexCutoverDisposition,
  renameSubscriptionCoreCodexConnection,
  resolveSubscriptionCoreCodexAppsDesignation,
  setSubscriptionCoreCodexAllocator,
  setSubscriptionCoreCodexExtraCredits,
  setSubscriptionCoreCodexPrimary,
  setSubscriptionCoreCodexRotation,
  setSubscriptionCoreWorkspaceCodexSource,
  subscriptionCoreCodexAppsRequestAuth,
  withRlsContext,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { rawRows } from "../src/database";
import { encryptEnvironmentValue } from "../src/environment-crypto";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const key = Buffer.alloc(32, 41);
const settings = { environmentsEncryptionKey: key.toString("base64") } as Settings;
const MODEL = "codex/gpt-5.5";

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("subscription-core-codex-consumers-v1");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 6 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

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
  const userId = `core-codex-consumers-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Core Codex consumers fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  // Migration 0680 seeds every organization enabled on the shared core. These
  // dormant-gate fixtures start from the pre-cutover world (no Codex row) and
  // enable or disable the gate explicitly.
  await shared!.admin`
    delete from subscription_provider_cutovers
    where account_id = ${accountId}::uuid and provider = 'codex'`;
  // ...and its seeded organization settings row, which the fixture writes itself.
  await shared!.admin`
    delete from subscription_settings
    where account_id = ${accountId}::uuid and workspace_id is null`;
  const ownerSubjectId = `user:${userId}`;
  const [membership] = await shared!.admin<{ id: string; personal_workspace_id: string }[]>`
    select id::text as id, personal_workspace_id::text as personal_workspace_id
    from organization_memberships
    where account_id = ${accountId}::uuid and subject_id = ${ownerSubjectId}
      and status = 'active' and revoked_at is null limit 1`;
  const [sharedWorkspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'Core Codex consumers shared workspace') returning id::text as id`;
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
  return {
    accountId,
    ownerSubjectId,
    ownerMembershipId: membership!.id,
    personalWorkspaceId: membership!.personal_workspace_id,
    sharedWorkspaceId: sharedWorkspace!.id,
  };
}

async function setCutover(accountId: string, enabled: boolean): Promise<void> {
  await shared!.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${accountId}::uuid, 'codex', ${enabled})
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
}

/** Seed historical/corrupt state to test independent reader defenses. */
async function seedHistoricalAppsDesignation(org: Org, connectionId: string): Promise<void> {
  await shared!.admin.begin(async (tx) => {
    // Only this synthetic, privileged transaction bypasses the new admission
    // fence. Real designation writers and all request readers remain guarded.
    await tx`alter table subscription_apps_designations disable trigger subscription_designation_disconnect_admission`;
    await tx`insert into subscription_apps_designations
      (account_id, workspace_id, connection_id, updated_by_subject_id)
      values (${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid,
        ${connectionId}::uuid, ${org.ownerSubjectId})
      on conflict (workspace_id) do update set connection_id = excluded.connection_id`;
    await tx`alter table subscription_apps_designations enable trigger subscription_designation_disconnect_admission`;
  });
}

async function sharedConnection(
  org: Org,
  label: string,
  options: {
    scope?: "organization" | "workspaces";
    workspaces?: string[];
    managedBy?: string | null;
    expiresAt?: Date;
    pool?: "workspace" | "organization";
  } = {},
): Promise<string> {
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      provider_account_id, plan_type, provider_state, expires_at, managed_by_workspace_id, label
    ) values (
      ${org.accountId}::uuid, 'codex', 'subscription', ${encryptedTokens(label)},
      'shared', ${options.scope ?? "organization"}, ${`chatgpt-${label}`}, 'pro',
      ${shared!.admin.json({ isFedramp: false, resetCreditAvailableCount: 2 })}::jsonb,
      ${(options.expiresAt ?? new Date(Date.now() + 86_400_000)).toISOString()}::timestamptz,
      ${options.managedBy ?? null}::uuid, ${label}
    ) returning id::text as id`;
  for (const workspaceId of options.workspaces ?? []) {
    await shared!.admin`
      insert into subscription_connection_workspaces (account_id, connection_id, workspace_id)
      values (${org.accountId}::uuid, ${row!.id}::uuid, ${workspaceId}::uuid)`;
  }
  for (const workspaceId of [org.personalWorkspaceId, org.sharedWorkspaceId]) {
    await shared!.admin`
      insert into subscription_connection_assignment_policies (
        account_id, connection_id, workspace_id, inference_pool
      ) values (${org.accountId}::uuid, ${row!.id}::uuid, ${workspaceId}::uuid,
        ${options.pool ?? "organization"})`;
  }
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
      ${connectionId}::uuid, ${org.accountId}::uuid, 'codex', ${encryptedTokens(label)},
      'personal', 'people', ${org.ownerMembershipId}::uuid, ${org.ownerSubjectId},
      ${authorityId}::uuid, 'subscription_connection', 1, ${`chatgpt-${label}`},
      ${shared!.admin.json({ isFedramp: false })}::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz
    )`;
  return connectionId;
}

/** A workspace administrator who is not an organization administrator. */
async function workspaceAdmin(org: Org, workspaceId: string): Promise<string> {
  const subjectId = `user:core-codex-manager-${crypto.randomUUID()}`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${org.accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, 'admin')`;
  return subjectId;
}

async function ownedSession(org: Org, workspaceId: string): Promise<string> {
  const session = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
    createSession(client!.db, {
      accountId: org.accountId,
      workspaceId,
      initialMessage: "core codex consumers fixture",
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
  return session.id;
}

async function queuedTurn(org: Org, workspaceId: string, sessionId: string): Promise<string> {
  const turn = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
    enqueueSessionTurn(client!.db, {
      accountId: org.accountId,
      workspaceId,
      sessionId,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${sessionId}`,
      source: "user",
      prompt: "core codex consumers fixture",
      resources: [],
      tools: [],
      model: MODEL,
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator: { kind: "subject", subjectId: org.ownerSubjectId },
    }),
  );
  return turn.id;
}

async function connectionRow(connectionId: string) {
  const [row] = await shared!.admin<
    {
      status: string;
      refresh_generation: string;
      allocator_enabled: boolean;
      label: string | null;
    }[]
  >`select status, refresh_generation::text as refresh_generation, allocator_enabled, label
    from subscription_connections where id = ${connectionId}::uuid`;
  return row!;
}

function readCredential(org: Org, workspaceId: string, connectionId: string) {
  return withRlsContext(client!.db, { accountId: org.accountId, workspaceId }, (tx) =>
    rawRows<{ status: string; credential_encrypted: string | null }>(
      tx,
      sql`select status, credential_encrypted from opengeni_private.read_subscription_codex_apps_credential(
        ${org.accountId}::uuid, ${workspaceId}::uuid, ${connectionId}::uuid)`,
    ),
  );
}

/**
 * Authorization of the 0670 routines. Run against two harnesses: the shared
 * template, whose routines are owned by a role that bypasses row-level
 * security (a superuser), and an owner-migrated database, whose routine owner
 * is an ordinary role subject to FORCE RLS. Every check must be an explicit
 * predicate, so both must agree.
 */
function authorizationCases(harness: "template" | "owner-migrated") {
  test(`${harness}: the 0670 routines' owner ${harness === "template" ? "bypasses" : "is subject to"} row-level security`, async () => {
    const [owner] = await shared!.admin<{ bypasses: boolean }[]>`
      select (role.rolsuper or role.rolbypassrls) as bypasses
      from pg_proc proc join pg_roles role on role.oid = proc.proowner
      where proc.proname = 'subscription_codex_apps_designation_target'`;
    expect(owner!.bypasses).toBe(harness === "template");
  });

  test(`${harness}: runs as the non-superuser, non-bypass application role`, async () => {
    const [role] = await rawRows<{ currentUser: string; superuser: boolean; bypassRls: boolean }>(
      client!.db,
      sql`select current_user as "currentUser", rolsuper as superuser,
          rolbypassrls as "bypassRls"
        from pg_catalog.pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ currentUser: "opengeni_app", superuser: false, bypassRls: false });
  });

  test(`${harness}: without a cutover row nothing on the core resolves, even with core rows present`, async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org, "gate-off");
    await seedHistoricalAppsDesignation(org, connectionId);
    expect(await readCodexCutoverDisposition(client!.db, org.accountId)).toBe("maintenance");
    const scope = { accountId: org.accountId, workspaceId: org.sharedWorkspaceId };
    expect(await resolveSubscriptionCoreCodexAppsDesignation(client!.db, scope)).toBeNull();
    expect(await readCredential(org, org.sharedWorkspaceId, connectionId)).toEqual([]);
    const begun = await withRlsContext(client!.db, scope, (tx) =>
      rawRows(
        tx,
        sql`select * from opengeni_private.begin_subscription_codex_apps_refresh(
          ${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${connectionId}::uuid)`,
      ),
    );
    expect(begun).toEqual([]);

    // A disabled row is maintenance: still nothing resolves.
    await setCutover(org.accountId, false);
    expect(await readCodexCutoverDisposition(client!.db, org.accountId)).toBe("maintenance");
    expect(await resolveSubscriptionCoreCodexAppsDesignation(client!.db, scope)).toBeNull();
    expect(await readCredential(org, org.sharedWorkspaceId, connectionId)).toEqual([]);
  });

  test(`${harness}: an administrator designates Apps on the core; requests recheck and refresh by designation`, async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    expect(await readCodexCutoverDisposition(client!.db, org.accountId)).toBe("core");
    const connectionId = await sharedConnection(org, "apps-admin");
    const scope = { accountId: org.accountId, workspaceId: org.sharedWorkspaceId };

    const stale = await designateSubscriptionCoreCodexApps(client!.db, {
      ...scope,
      connectionId,
      subjectId: org.ownerSubjectId,
      expectedVersion: 3,
    });
    expect(stale.kind).toBe("conflict");
    const designated = await designateSubscriptionCoreCodexApps(client!.db, {
      ...scope,
      connectionId,
      subjectId: org.ownerSubjectId,
      expectedVersion: 0,
    });
    expect(designated).toMatchObject({ kind: "updated", credentialId: connectionId });
    const designatedVersion = (designated as { version: number }).version;
    expect(designatedVersion).toBeGreaterThan(0);
    expect(
      (
        await designateSubscriptionCoreCodexApps(client!.db, {
          ...scope,
          connectionId,
          subjectId: org.ownerSubjectId,
          expectedVersion: designatedVersion,
        })
      ).kind,
    ).toBe("already_designated");
    expect(await getSubscriptionCoreCodexAppsSettings(client!.db, scope)).toMatchObject({
      credentialId: connectionId,
      version: designatedVersion,
    });
    expect(await resolveSubscriptionCoreCodexAppsDesignation(client!.db, scope)).toEqual({
      connectionId,
      status: "active",
    });
    // The designation is per workspace: the Personal workspace has none.
    expect(
      await resolveSubscriptionCoreCodexAppsDesignation(client!.db, {
        accountId: org.accountId,
        workspaceId: org.personalWorkspaceId,
      }),
    ).toBeNull();

    const auth = subscriptionCoreCodexAppsRequestAuth(client!.db, settings, {
      ...scope,
      connectionId,
    });
    expect(await auth.withAuthorization(async (token) => token)).toEqual({
      accessToken: "access-apps-admin",
      chatgptAccountId: "chatgpt-apps-admin",
    });

    // A stale token refreshes through the designation seam, under the
    // refresh-generation compare-and-swap.
    await shared!.admin`update subscription_connections set expires_at = now() - interval '1 hour'
      where id = ${connectionId}::uuid`;
    const generationBefore = Number((await connectionRow(connectionId)).refresh_generation);
    const refreshed = subscriptionCoreCodexAppsRequestAuth(
      client!.db,
      settings,
      { ...scope, connectionId },
      {
        refresh: async (refreshToken) => {
          expect(refreshToken).toBe("refresh-apps-admin");
          return { accessToken: "access-rotated", refreshToken: "refresh-rotated" };
        },
      },
    );
    expect((await refreshed.withAuthorization(async (token) => token)).accessToken).toBe(
      "access-rotated",
    );
    expect(Number((await connectionRow(connectionId)).refresh_generation)).toBe(
      generationBefore + 1,
    );

    // A permanent OAuth refusal marks the connection for a new sign-in.
    await shared!.admin`update subscription_connections set expires_at = now() - interval '1 hour'
      where id = ${connectionId}::uuid`;
    const refused = subscriptionCoreCodexAppsRequestAuth(
      client!.db,
      settings,
      { ...scope, connectionId },
      {
        refresh: async () => {
          throw new CodexReloginRequired("sign in again");
        },
      },
    );
    await expect(refused.withAuthorization(async (token) => token)).rejects.toBeInstanceOf(
      CodexReloginRequired,
    );
    expect((await connectionRow(connectionId)).status).toBe("needs_relogin");
    expect(await resolveSubscriptionCoreCodexAppsDesignation(client!.db, scope)).toEqual({
      connectionId,
      status: "needs_relogin",
    });
    // No credential material for an unusable connection.
    expect(await readCredential(org, org.sharedWorkspaceId, connectionId)).toEqual([
      { status: "needs_relogin", credential_encrypted: null },
    ]);

    await shared!.admin`update subscription_connections
      set status = 'active', expires_at = now() + interval '1 hour'
      where id = ${connectionId}::uuid`;
    // Maintenance (a disabled cutover row) ends authority for in-flight
    // request auth too; re-enabling restores it.
    await setCutover(org.accountId, false);
    const paused = await auth.withAuthorization(async (token) => token).catch((caught) => caught);
    expect(isCodexAppsCredentialUnavailable(paused)).toBe(true);
    await setCutover(org.accountId, true);
    expect((await auth.withAuthorization(async (token) => token)).accessToken).toBe(
      "access-rotated",
    );
    // Clearing ends authority for in-flight request auth.
    const cleared = await clearSubscriptionCoreCodexApps(client!.db, {
      ...scope,
      subjectId: org.ownerSubjectId,
      expectedVersion: designatedVersion,
    });
    expect(cleared).toMatchObject({ kind: "updated", credentialId: null, version: 0 });
    const error = await auth.withAuthorization(async (token) => token).catch((caught) => caught);
    expect(isCodexAppsCredentialUnavailable(error)).toBe(true);
  });

  test(`${harness}: designation authority, scope and personal-connection rules are enforced by the database`, async () => {
    const org = await organization();
    const other = await organization();
    await setCutover(org.accountId, true);
    await setCutover(other.accountId, true);
    const scope = { accountId: org.accountId, workspaceId: org.sharedWorkspaceId };
    const organizationScoped = await sharedConnection(org, "org-scoped");
    const managedHere = await sharedConnection(org, "managed-here", {
      scope: "workspaces",
      workspaces: [org.sharedWorkspaceId],
      managedBy: org.sharedWorkspaceId,
    });
    const manager = await workspaceAdmin(org, org.sharedWorkspaceId);
    const stranger = `user:core-codex-stranger-${crypto.randomUUID()}`;

    // A stranger and a manager of another connection may not designate.
    expect(
      (
        await designateSubscriptionCoreCodexApps(client!.db, {
          ...scope,
          connectionId: organizationScoped,
          subjectId: stranger,
          expectedVersion: 0,
        })
      ).kind,
    ).toBe("forbidden");
    expect(
      (
        await designateSubscriptionCoreCodexApps(client!.db, {
          ...scope,
          connectionId: organizationScoped,
          subjectId: manager,
          expectedVersion: 0,
        })
      ).kind,
    ).toBe("forbidden");
    // The delegated manager may designate the connection its workspace manages.
    const managerDesignation = await designateSubscriptionCoreCodexApps(client!.db, {
      ...scope,
      connectionId: managedHere,
      subjectId: manager,
      expectedVersion: 0,
    });
    expect(managerDesignation).toMatchObject({ kind: "updated", credentialId: managedHere });
    // A stranger cannot clear it.
    expect(
      (
        await clearSubscriptionCoreCodexApps(client!.db, {
          ...scope,
          subjectId: stranger,
          expectedVersion: (managerDesignation as { version: number }).version,
        })
      ).kind,
    ).toBe("forbidden");

    // Another organization sees nothing, by context or by forged arguments.
    expect(
      await resolveSubscriptionCoreCodexAppsDesignation(client!.db, {
        accountId: other.accountId,
        workspaceId: org.sharedWorkspaceId,
      }),
    ).toBeNull();
    const forged = await withRlsContext(
      client!.db,
      { accountId: other.accountId, workspaceId: other.sharedWorkspaceId },
      (tx) =>
        rawRows(
          tx,
          sql`select * from opengeni_private.read_subscription_codex_apps_credential(
            ${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${managedHere}::uuid)`,
        ),
    );
    expect(forged).toEqual([]);
    expect(
      (
        await designateSubscriptionCoreCodexApps(client!.db, {
          accountId: other.accountId,
          workspaceId: other.sharedWorkspaceId,
          connectionId: organizationScoped,
          subjectId: other.ownerSubjectId,
          expectedVersion: 0,
        })
      ).kind,
    ).toBe("not_found");

    // Leaving the workspace's scope ends the designation at the next request.
    await shared!.admin`delete from subscription_connection_workspaces
      where connection_id = ${managedHere}::uuid`;
    expect(await resolveSubscriptionCoreCodexAppsDesignation(client!.db, scope)).toBeNull();

    // Personal connections can never be designated.
    const personal = await personalConnection(org, "personal-apps");
    expect(
      (
        await designateSubscriptionCoreCodexApps(client!.db, {
          accountId: org.accountId,
          workspaceId: org.personalWorkspaceId,
          connectionId: personal,
          subjectId: org.ownerSubjectId,
          expectedVersion: 0,
        })
      ).kind,
    ).toBe("not_found");

    // A people-scoped shared connection never backs Apps for a workspace,
    // even when a designation row names it (Apps serve every caller there,
    // including ownerless and service sessions).
    const [peopleScoped] = await shared!.admin<{ id: string }[]>`
      insert into subscription_connections (
        account_id, provider, kind, credential_encrypted, ownership, scope_kind, provider_account_id
      ) values (
        ${org.accountId}::uuid, 'codex', 'subscription', ${encryptedTokens("people-apps")},
        'shared', 'people', 'chatgpt-people-apps'
      ) returning id::text as id`;
    await shared!.admin`
      insert into subscription_connection_people (account_id, connection_id, organization_membership_id)
      values (${org.accountId}::uuid, ${peopleScoped!.id}::uuid, ${org.ownerMembershipId}::uuid)`;
    await shared!.admin`
      delete from subscription_apps_designations where workspace_id = ${org.sharedWorkspaceId}::uuid`;
    await seedHistoricalAppsDesignation(org, peopleScoped!.id);
    expect(await resolveSubscriptionCoreCodexAppsDesignation(client!.db, scope)).toBeNull();
    expect(await readCredential(org, org.sharedWorkspaceId, peopleScoped!.id)).toEqual([]);

    // Explicit predicates, not row visibility, refuse everything else: a
    // designation naming another provider's or a non-subscription connection,
    // a workspace argument that is not the caller's, and a refresh write
    // without its begin in the same transaction.
    for (const [provider, kind] of [
      ["claude", "subscription"],
      ["codex", "api_key"],
    ] as const) {
      const [foreignKind] = await shared!.admin<{ id: string }[]>`
        insert into subscription_connections (
          account_id, provider, kind, credential_encrypted, ownership, scope_kind, provider_account_id
        ) values (
          ${org.accountId}::uuid, ${provider}, ${kind}, ${encryptedTokens(`${provider}-${kind}`)},
          'shared', 'organization', ${`${provider}-${kind}-account`}
        ) returning id::text as id`;
      await seedHistoricalAppsDesignation(org, foreignKind!.id);
      expect(await resolveSubscriptionCoreCodexAppsDesignation(client!.db, scope)).toBeNull();
      expect(await readCredential(org, org.sharedWorkspaceId, foreignKind!.id)).toEqual([]);
    }
    await seedHistoricalAppsDesignation(org, organizationScoped);
    expect(await resolveSubscriptionCoreCodexAppsDesignation(client!.db, scope)).toEqual({
      connectionId: organizationScoped,
      status: "active",
    });
    const crossWorkspace = await withRlsContext(
      client!.db,
      { accountId: org.accountId, workspaceId: org.personalWorkspaceId },
      (tx) =>
        rawRows(
          tx,
          sql`select * from opengeni_private.read_subscription_codex_apps_credential(
            ${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${organizationScoped}::uuid)`,
        ),
    );
    expect(crossWorkspace).toEqual([]);
    const generation = Number((await connectionRow(organizationScoped)).refresh_generation);
    const unbegun = await withRlsContext(client!.db, scope, (tx) =>
      rawRows<{ persisted: boolean; failed: boolean }>(
        tx,
        sql`select opengeni_private.persist_subscription_codex_apps_refresh(
            ${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${organizationScoped}::uuid,
            ${generation}::bigint, ${encryptedTokens("forged")}, null, now()) as persisted,
          opengeni_private.fail_subscription_codex_apps_refresh(
            ${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${organizationScoped}::uuid,
            ${generation}::bigint, 'forged') as failed`,
      ),
    );
    expect(unbegun).toEqual([{ persisted: false, failed: false }]);
    expect(await connectionRow(organizationScoped)).toMatchObject({
      status: "active",
      refresh_generation: String(generation),
    });

    // The internal target helper (full connection row) is owner-only.
    const direct = await withRlsContext(client!.db, scope, (tx) =>
      rawRows(
        tx,
        sql`select id from opengeni_private.subscription_codex_apps_designation_target(
          ${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid)`,
      ),
    ).catch((error: unknown) => error);
    expect(String((direct as { cause?: unknown })?.cause ?? direct)).toContain("permission denied");
  });

  test(`${harness}: designate refuses a target the Apps resolver could never serve`, async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const scope = { accountId: org.accountId, workspaceId: org.sharedWorkspaceId };
    const admin = { ...scope, subjectId: org.ownerSubjectId };
    const [other] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${org.accountId}::uuid, 'Core Codex Apps elsewhere') returning id::text as id`;
    const [peopleScoped] = await shared!.admin<{ id: string }[]>`
      insert into subscription_connections (
        account_id, provider, kind, credential_encrypted, ownership, scope_kind, provider_account_id
      ) values (
        ${org.accountId}::uuid, 'codex', 'subscription', ${encryptedTokens("designate-people")},
        'shared', 'people', 'chatgpt-designate-people'
      ) returning id::text as id`;
    await shared!.admin`
      insert into subscription_connection_people (account_id, connection_id, organization_membership_id)
      values (${org.accountId}::uuid, ${peopleScoped!.id}::uuid, ${org.ownerMembershipId}::uuid)`;
    const elsewhere = await sharedConnection(org, "designate-elsewhere", {
      scope: "workspaces",
      workspaces: [other!.id],
      managedBy: other!.id,
    });
    const personal = await personalConnection(org, "designate-personal");
    for (const connectionId of [peopleScoped!.id, elsewhere, personal]) {
      expect(
        await designateSubscriptionCoreCodexApps(client!.db, {
          ...admin,
          connectionId,
          expectedVersion: 0,
        }),
      ).toEqual({ kind: "not_found" });
    }
    // Settings never show an inert designation.
    expect(await getSubscriptionCoreCodexAppsSettings(client!.db, scope)).toEqual({
      credentialId: null,
      version: 0,
      designatedAt: null,
    });
    const organizationScoped = await sharedConnection(org, "designate-organization");
    expect(
      await designateSubscriptionCoreCodexApps(client!.db, {
        ...admin,
        connectionId: organizationScoped,
        expectedVersion: 0,
      }),
    ).toMatchObject({ kind: "updated", credentialId: organizationScoped });
  });
}

describe.skipIf(!realDb)("Codex Apps routine authorization (shared template)", () => {
  authorizationCases("template");
});

describe.skipIf(!realDb)("remaining Codex consumers on the shared core", () => {
  test("workspace and organization projections keep the legacy shapes and hide personal connections", async () => {
    const org = await organization();
    const other = await organization();
    await setCutover(org.accountId, true);
    const first = await sharedConnection(org, "projection-a");
    const second = await sharedConnection(org, "projection-b", {
      scope: "workspaces",
      workspaces: [org.sharedWorkspaceId],
      managedBy: org.sharedWorkspaceId,
      pool: "workspace",
    });
    await personalConnection(org, "projection-personal");
    await sharedConnection(other, "projection-other");
    await shared!.admin`
      insert into subscription_connection_quota (account_id, connection_id, quota, observed_refresh_generation)
      values (${org.accountId}::uuid, ${first}::uuid, ${shared!.admin.json({
        windows: [
          { id: "primary", usedPercent: 42, resetsAt: Date.now() + 3_600_000, status: "ok" },
          { id: "secondary", usedPercent: 7, resetsAt: null, status: "ok" },
        ],
        modelCooldowns: {},
        exhaustedUntil: null,
        exhaustedKind: null,
        source: "response_headers",
      })}::jsonb, 1)`;
    const scope = { accountId: org.accountId, workspaceId: org.sharedWorkspaceId };
    const projection = await getSubscriptionCoreCodexWorkspaceProjection(client!.db, scope);
    expect(projection.accounts.map((account) => account.id).sort()).toEqual([first, second].sort());
    const a = projection.accounts.find((account) => account.id === first)!;
    expect(a).toMatchObject({
      source: "organization",
      chatgptAccountId: "chatgpt-projection-a",
      label: "projection-a",
      planType: "pro",
      status: "active",
      allocatorEnabled: true,
      primaryUsedPercent: 42,
      secondaryUsedPercent: 7,
      resetCreditAvailableCount: 2,
      isActive: false,
    });
    expect(projection.accounts.find((account) => account.id === second)!.source).toBe("workspace");
    expect(projection.rotation).toEqual({
      activeCredentialId: null,
      rotationEnabled: true,
      rotationStrategy: "sharded",
    });
    expect(projection.source).toMatchObject({
      mode: "automatic",
      effectiveSource: "workspace",
      workspaceKind: "shared",
      workspaceAvailable: true,
      organizationAvailable: true,
    });
    // The Personal workspace sees only the organization-scoped connection.
    const personalProjection = await getSubscriptionCoreCodexWorkspaceProjection(client!.db, {
      accountId: org.accountId,
      workspaceId: org.personalWorkspaceId,
    });
    expect(personalProjection.accounts.map((account) => account.id)).toEqual([first]);

    // Settings writes: primary, rotation and source, by an administrator only.
    const admin = { ...scope, subjectId: org.ownerSubjectId };
    const stranger = { ...scope, subjectId: `user:core-codex-stranger-${crypto.randomUUID()}` };
    expect(
      (await setSubscriptionCoreCodexPrimary(client!.db, { ...stranger, connectionId: first }))
        .activated,
    ).toBeNull();
    const primary = await setSubscriptionCoreCodexPrimary(client!.db, {
      ...admin,
      connectionId: first,
    });
    expect(primary.activated).toBe(first);
    expect(primary.wake).toMatchObject({
      reason: "core_codex_primary_changed",
      workspaceIds: [org.sharedWorkspaceId],
    });
    const rotation = await setSubscriptionCoreCodexRotation(client!.db, {
      ...admin,
      rotationEnabled: false,
    });
    expect(rotation.rotation).toEqual({
      activeCredentialId: first,
      rotationEnabled: false,
      rotationStrategy: "sharded",
    });
    expect(
      (await setSubscriptionCoreCodexRotation(client!.db, { ...stranger, rotationEnabled: true }))
        .rotation,
    ).toBeNull();
    const afterSettings = await getSubscriptionCoreCodexWorkspaceProjection(client!.db, scope);
    expect(afterSettings.rotation).toEqual({
      activeCredentialId: first,
      rotationEnabled: false,
      rotationStrategy: "sharded",
    });
    expect(afterSettings.accounts.find((account) => account.id === first)!.isActive).toBe(true);
    const source = await setSubscriptionCoreWorkspaceCodexSource(client!.db, {
      ...admin,
      mode: "organization",
    });
    expect(source.source).toMatchObject({ mode: "organization", effectiveSource: "organization" });
    // Only the effective pool is listed (legacy parity).
    const listed = async () =>
      (await getSubscriptionCoreCodexWorkspaceProjection(client!.db, scope)).accounts
        .map((account) => account.id)
        .sort();
    expect(await listed()).toEqual([first]);
    await setSubscriptionCoreWorkspaceCodexSource(client!.db, { ...admin, mode: "workspace" });
    expect(await listed()).toEqual([second]);
    expect(
      (await setSubscriptionCoreWorkspaceCodexSource(client!.db, { ...admin, mode: "disabled" }))
        .source,
    ).toMatchObject({
      mode: "disabled",
      effectiveSource: "disabled",
    });
    expect(await listed()).toEqual([]);
    expect(
      (await setSubscriptionCoreWorkspaceCodexSource(client!.db, { ...admin, mode: "automatic" }))
        .source.mode,
    ).toBe("automatic");
    await expect(
      setSubscriptionCoreWorkspaceCodexSource(client!.db, { ...stranger, mode: "workspace" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("missing permission"),
      reason: "forbidden",
    });
    await expect(
      setSubscriptionCoreWorkspaceCodexSource(client!.db, {
        accountId: org.accountId,
        workspaceId: org.personalWorkspaceId,
        subjectId: org.ownerSubjectId,
        mode: "workspace",
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("personal workspaces"),
      reason: "personal_workspace",
    });

    // Allocator: legacy optimistic concurrency; strangers see nothing.
    expect(
      (
        await setSubscriptionCoreCodexAllocator(client!.db, {
          ...stranger,
          connectionId: first,
          enabled: false,
          expectedVersion: 1,
        })
      ).result.kind,
    ).toBe("not_found");
    expect(
      (
        await setSubscriptionCoreCodexAllocator(client!.db, {
          ...admin,
          connectionId: first,
          enabled: false,
          expectedVersion: 9,
        })
      ).result.kind,
    ).toBe("conflict");
    const disabled = await setSubscriptionCoreCodexAllocator(client!.db, {
      ...admin,
      connectionId: first,
      enabled: false,
      expectedVersion: 1,
    });
    expect(disabled.result).toMatchObject({
      kind: "updated",
      allocatorEnabled: false,
      allocatorVersion: 2,
    });
    expect(disabled.wake?.reason).toBe("core_codex_allocator_changed");
    expect(
      (
        await setSubscriptionCoreCodexAllocator(client!.db, {
          ...admin,
          connectionId: first,
          enabled: false,
          expectedVersion: 1,
        })
      ).result.kind,
    ).toBe("unchanged");
    expect((await connectionRow(first)).allocator_enabled).toBe(false);

    // Spending consent is separate from the allocator and credential version.
    expect(
      (
        await setSubscriptionCoreCodexExtraCredits(client!.db, {
          ...admin,
          connectionId: first,
          enabled: false,
          expectedVersion: 1,
        })
      ).result.kind,
    ).toBe("unchanged");
    expect(
      (
        await setSubscriptionCoreCodexExtraCredits(client!.db, {
          ...admin,
          connectionId: first,
          enabled: true,
          expectedVersion: 1,
        })
      ).result,
    ).toMatchObject({ kind: "updated", extraCreditsEnabled: true, extraCreditsVersion: 2 });
    expect(
      (
        await setSubscriptionCoreCodexExtraCredits(client!.db, {
          ...admin,
          connectionId: first,
          enabled: false,
          expectedVersion: 1,
        })
      ).result.kind,
    ).toBe("conflict");
    expect(
      (
        await setSubscriptionCoreCodexExtraCredits(client!.db, {
          ...stranger,
          connectionId: first,
          enabled: false,
          expectedVersion: 2,
        })
      ).result.kind,
    ).toBe("not_found");
    expect((await connectionRow(first)).allocator_enabled).toBe(false);

    // Rename: the delegated manager may rename the connection it manages only.
    const manager = await workspaceAdmin(org, org.sharedWorkspaceId);
    expect(
      await renameSubscriptionCoreCodexConnection(client!.db, {
        ...scope,
        subjectId: manager,
        connectionId: first,
        label: "nope",
      }),
    ).toBeNull();
    expect(
      await renameSubscriptionCoreCodexConnection(client!.db, {
        ...scope,
        subjectId: manager,
        connectionId: second,
        label: " Team ",
      }),
    ).toBe(second);
    expect((await connectionRow(second)).label).toBe("Team");
    expect((await connectionRow(first)).label).toBe("projection-a");

    // Organization projection: administrators see unmanaged shared accounts.
    const orgProjection = await getSubscriptionCoreOrganizationCodexProjection(client!.db, {
      organizationId: org.accountId,
      subjectId: org.ownerSubjectId,
    });
    expect(orgProjection.accounts.map((account) => account.id)).toEqual([first]);
    expect(
      (
        await getSubscriptionCoreOrganizationCodexProjection(client!.db, {
          organizationId: org.accountId,
          subjectId: manager,
        })
      ).accounts,
    ).toEqual([]);
  });

  test("session pins are core bindings; Running on and the legacy pointers project from them", async () => {
    const org = await organization();
    const other = await organization();
    await setCutover(org.accountId, true);
    const connectionId = await sharedConnection(org, "pin-shared");
    const personal = await personalConnection(org, "pin-personal");
    const foreign = await sharedConnection(other, "pin-foreign");
    const sessionId = await ownedSession(org, org.sharedWorkspaceId);
    const base = {
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      sessionId,
      subjectId: org.ownerSubjectId,
    };

    expect(
      (await pinSubscriptionCoreSessionCodexAccount(client!.db, { ...base, connectionId: foreign }))
        .result.changed,
    ).toBe(false);
    // A personal connection is not usable in a shared-workspace session.
    expect(
      (
        await pinSubscriptionCoreSessionCodexAccount(client!.db, {
          ...base,
          connectionId: personal,
        })
      ).result.changed,
    ).toBe(false);
    const pinned = await pinSubscriptionCoreSessionCodexAccount(client!.db, {
      ...base,
      connectionId,
    });
    expect(pinned.result.changed).toBe(true);
    expect(pinned.result.events.map((event) => event.type)).toEqual([
      "codex.account.selection.changed",
    ]);
    expect(pinned.result.events[0]!.payload).toMatchObject({
      credentialId: connectionId,
      subjectId: org.ownerSubjectId,
    });
    expect(pinned.wake).toMatchObject({ reason: "core_codex_session_pin_changed" });
    const [binding] = await shared!.admin<{ connection_id: string; choice: string }[]>`
      select connection_id::text as connection_id, choice from subscription_session_bindings
      where session_id = ${sessionId}::uuid`;
    expect(binding).toEqual({ connection_id: connectionId, choice: "explicit" });
    // The legacy pointer column is never written with a core id.
    const [legacy] = await shared!.admin<{ pinned: string | null; last: string | null }[]>`
      select codex_pinned_credential_id::text as pinned, codex_last_credential_id::text as last
      from sessions where id = ${sessionId}::uuid`;
    expect(legacy).toEqual({ pinned: null, last: null });

    const pointers = await getSubscriptionCoreCodexSessionPointers(client!.db, {
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      sessionIds: [sessionId, crypto.randomUUID()],
    });
    expect(pointers.get(sessionId)).toEqual({
      pinnedCredentialId: connectionId,
      lastCredentialId: connectionId,
    });
    const view = await getSubscriptionCoreSessionCodexAccounts(client!.db, {
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      sessionId,
    });
    expect(view).toMatchObject({ pinnedAccountId: connectionId, lastAccountId: connectionId });
    expect(view!.accounts.map((account) => account.id)).toEqual([connectionId]);

    // A live core lease is the "Running on" account of the active turn.
    const turn = { id: await queuedTurn(org, org.sharedWorkspaceId, sessionId) };
    const claimed = await claimSessionWorkForAttempt(client!.db, org.sharedWorkspaceId, {
      sessionId,
      workflowId: `session-${sessionId}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");
    // Fixture only: the placement path that writes leases is PR 1's, tested there.
    await shared!.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`
        insert into subscription_leases (account_id, workspace_id, session_id, turn_id, connection_id,
          provider, holder_id, generation, leased_until)
        values (${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${sessionId}::uuid,
          ${turn!.id}::uuid, ${connectionId}::uuid, 'codex', 'holder', 1, now() + interval '5 minutes')`;
    });
    const running = await getSubscriptionCoreSessionCodexAccounts(client!.db, {
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      sessionId,
    });
    expect(running!.currentSelection).toEqual({ waiting: false, credentialId: connectionId });
    expect(running!.currentAccount?.id).toBe(connectionId);

    // "auto" returns the binding to automatic and keeps the last account.
    const unpinned = await pinSubscriptionCoreSessionCodexAccount(client!.db, {
      ...base,
      connectionId: null,
    });
    expect(unpinned.result.changed).toBe(true);
    expect(
      (
        await getSubscriptionCoreCodexSessionPointers(client!.db, {
          accountId: org.accountId,
          workspaceId: org.sharedWorkspaceId,
          sessionIds: [sessionId],
        })
      ).get(sessionId),
    ).toEqual({ pinnedCredentialId: null, lastCredentialId: connectionId });

    // In the owner's own Personal workspace session the personal connection
    // is a valid explicit choice.
    const personalSession = await ownedSession(org, org.personalWorkspaceId);
    expect(
      (
        await pinSubscriptionCoreSessionCodexAccount(client!.db, {
          ...base,
          workspaceId: org.personalWorkspaceId,
          sessionId: personalSession,
          connectionId: personal,
        })
      ).result.changed,
    ).toBe(true);
    // Another person cannot pin it in that session.
    expect(
      (
        await pinSubscriptionCoreSessionCodexAccount(client!.db, {
          ...base,
          workspaceId: org.personalWorkspaceId,
          sessionId: personalSession,
          connectionId: personal,
          subjectId: `user:core-codex-stranger-${crypto.randomUUID()}`,
        })
      ).result.changed,
    ).toBe(false);

    // Another organization's context cannot see this session's binding.
    expect(
      (
        await getSubscriptionCoreCodexSessionPointers(client!.db, {
          accountId: other.accountId,
          workspaceId: org.sharedWorkspaceId,
          sessionIds: [sessionId],
        })
      ).get(sessionId),
    ).toEqual({ pinnedCredentialId: null, lastCredentialId: null });
  });

  test("route wakes reach waiting core waiters only with an enabled cutover", async () => {
    const org = await organization();
    const sessionId = await ownedSession(org, org.sharedWorkspaceId);
    const turn = { id: await queuedTurn(org, org.sharedWorkspaceId, sessionId) };
    await shared!.admin`
      insert into subscription_capacity_waiters (account_id, workspace_id, session_id, turn_id, provider, wait_reason)
      values (${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${sessionId}::uuid,
        ${turn!.id}::uuid, 'codex', 'capacity')`;
    const revision = async () =>
      Number(
        (
          await shared!.admin<{ wake_revision: string }[]>`
            select wake_revision::text as wake_revision from subscription_capacity_waiters
            where session_id = ${sessionId}::uuid`
        )[0]!.wake_revision,
      );
    const wake = {
      accountId: org.accountId,
      reason: "core_codex_allocator_changed",
      workspaceIds: [org.sharedWorkspaceId],
    };
    await deliverSubscriptionCoreCodexWake(client!.db, wake);
    expect(await revision()).toBe(1);
    await setCutover(org.accountId, true);
    await deliverSubscriptionCoreCodexWake(client!.db, wake);
    expect(await revision()).toBe(2);
    const [reason] = await shared!.admin<{ last_wake_reason: string }[]>`
      select last_wake_reason from subscription_capacity_waiters where session_id = ${sessionId}::uuid`;
    expect(reason!.last_wake_reason).toBe("core_codex_allocator_changed");
  });

  test("organization activate and rotation write the organization row (H1, L5)", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const orgAccount = await sharedConnection(org, "org-write-a");
    const workspaceManaged = await sharedConnection(org, "org-write-managed", {
      scope: "workspaces",
      workspaces: [org.sharedWorkspaceId],
      managedBy: org.sharedWorkspaceId,
      pool: "workspace",
    });
    const admin = { accountId: org.accountId, workspaceId: null, subjectId: org.ownerSubjectId };
    const orgRow = async () =>
      (
        await shared!.admin<
          {
            rotation: Record<string, unknown>;
            providers: Record<string, unknown>;
            primary_id: string | null;
            cross_provider_failover: boolean;
            fallback_order: Record<string, unknown>;
            personal_connections_allowed: boolean;
            personal_fallback_allowed: boolean;
          }[]
        >`select rotation, providers, codex_primary_connection_id::text as primary_id,
            cross_provider_failover, fallback_order, personal_connections_allowed,
            personal_fallback_allowed
          from subscription_settings
          where account_id = ${org.accountId}::uuid and workspace_id is null`
      )[0];

    // Activate keeps the organization's rotation mode; the toggle keeps the primary.
    const activated = await setSubscriptionCoreCodexPrimary(client!.db, {
      ...admin,
      connectionId: orgAccount,
    });
    expect(activated.activated).toBe(orgAccount);
    expect(activated.wake).toEqual({
      accountId: org.accountId,
      reason: "core_codex_primary_changed",
    });
    expect(await orgRow()).toMatchObject({
      rotation: { codex: { mode: "spread" } },
      primary_id: orgAccount,
      personal_fallback_allowed: true,
    });
    const rotation = await setSubscriptionCoreCodexRotation(client!.db, {
      ...admin,
      rotationEnabled: false,
    });
    expect(rotation.rotation).toEqual({
      activeCredentialId: orgAccount,
      rotationEnabled: false,
      rotationStrategy: "sharded",
    });
    expect(
      await getSubscriptionCoreOrganizationCodexProjection(client!.db, {
        organizationId: org.accountId,
        subjectId: org.ownerSubjectId,
      }),
    ).toMatchObject({ rotation: { activeCredentialId: orgAccount, rotationEnabled: false } });

    // Organization routes manage organization accounts only (legacy parity):
    // a workspace-managed connection is refused before anything is written.
    expect(
      (
        await setSubscriptionCoreCodexPrimary(client!.db, {
          ...admin,
          connectionId: workspaceManaged,
        })
      ).activated,
    ).toBeNull();
    expect(
      await renameSubscriptionCoreCodexConnection(client!.db, {
        ...admin,
        connectionId: workspaceManaged,
        label: "renamed by the organization route",
      }),
    ).toBeNull();
    expect((await connectionRow(workspaceManaged)).label).toBe("org-write-managed");
    expect((await orgRow())!.primary_id).toBe(orgAccount);
    expect(
      await renameSubscriptionCoreCodexConnection(client!.db, {
        ...admin,
        connectionId: orgAccount,
        label: "Organization A",
      }),
    ).toBe(orgAccount);

    // A non-administrator writes nothing.
    const manager = await workspaceAdmin(org, org.sharedWorkspaceId);
    expect(
      (
        await setSubscriptionCoreCodexRotation(client!.db, {
          ...admin,
          subjectId: manager,
          rotationEnabled: true,
        })
      ).rotation,
    ).toBeNull();
    expect((await orgRow())!.rotation).toEqual({ codex: { mode: "primary_first" } });

    // A missing organization row is created with the resolver's defaults.
    await shared!.admin`delete from subscription_settings
      where account_id = ${org.accountId}::uuid and workspace_id is null`;
    expect(
      (
        await setSubscriptionCoreCodexRotation(client!.db, {
          ...admin,
          subjectId: manager,
          rotationEnabled: true,
        })
      ).rotation,
    ).toBeNull();
    expect(await orgRow()).toBeUndefined();
    const created = await setSubscriptionCoreCodexRotation(client!.db, {
      ...admin,
      rotationEnabled: false,
    });
    expect(created.rotation).toEqual({
      activeCredentialId: null,
      rotationEnabled: false,
      rotationStrategy: "sharded",
    });
    expect(await orgRow()).toEqual({
      rotation: { codex: { mode: "primary_first" } },
      providers: {},
      primary_id: null,
      cross_provider_failover: false,
      fallback_order: {},
      personal_connections_allowed: true,
      personal_fallback_allowed: false,
    });
    expect(
      (await setSubscriptionCoreCodexPrimary(client!.db, { ...admin, connectionId: orgAccount }))
        .activated,
    ).toBe(orgAccount);
    expect(
      (
        await getSubscriptionCoreCodexWorkspaceProjection(client!.db, {
          accountId: org.accountId,
          workspaceId: org.sharedWorkspaceId,
        })
      ).rotation,
    ).toEqual({
      activeCredentialId: orgAccount,
      rotationEnabled: false,
      rotationStrategy: "sharded",
    });
  });

  test("the workspace rotation toggle keeps the inherited primary (M1)", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const a = await sharedConnection(org, "inherit-a");
    const orgAdmin = { accountId: org.accountId, workspaceId: null, subjectId: org.ownerSubjectId };
    const scope = { accountId: org.accountId, workspaceId: org.sharedWorkspaceId };
    const workspaceAdministration = { ...scope, subjectId: org.ownerSubjectId };
    await setSubscriptionCoreCodexPrimary(client!.db, { ...orgAdmin, connectionId: a });
    await setSubscriptionCoreCodexRotation(client!.db, { ...orgAdmin, rotationEnabled: false });
    const effectivePrimary = async () =>
      (
        await withRlsContext(client!.db, scope, (tx) =>
          rawRows<{ primary_id: string | null; mode: string | null }>(
            tx,
            sql`select effective->'values'->'rotation'->'codex'->>'primaryConnectionId' as primary_id,
                effective->'values'->'rotation'->'codex'->>'mode' as mode
              from subscription_effective_settings(${org.accountId}::uuid,
                ${org.sharedWorkspaceId}::uuid) effective`,
          ),
        )
      )[0];
    expect(await effectivePrimary()).toEqual({ primary_id: a, mode: "primary_first" });

    // Toggling with inherited settings creates an override that keeps A.
    const toggled = await setSubscriptionCoreCodexRotation(client!.db, {
      ...workspaceAdministration,
      rotationEnabled: false,
    });
    expect(toggled.rotation).toEqual({
      activeCredentialId: a,
      rotationEnabled: false,
      rotationStrategy: "sharded",
    });
    expect(await effectivePrimary()).toEqual({ primary_id: a, mode: "primary_first" });
    const projected = await getSubscriptionCoreCodexWorkspaceProjection(client!.db, scope);
    expect(projected.rotation.activeCredentialId).toBe(a);
    expect(projected.accounts.find((account) => account.id === a)!.isActive).toBe(true);
    // Turning rotation on and off again keeps the workspace's own primary.
    await setSubscriptionCoreCodexRotation(client!.db, {
      ...workspaceAdministration,
      rotationEnabled: true,
    });
    await setSubscriptionCoreCodexRotation(client!.db, {
      ...workspaceAdministration,
      rotationEnabled: false,
    });
    expect(await effectivePrimary()).toEqual({ primary_id: a, mode: "primary_first" });

    // Before any primary exists, the toggle works and carries none; a later
    // workspace activate sets the workspace's own.
    const fresh = await organization();
    await setCutover(fresh.accountId, true);
    const c = await sharedConnection(fresh, "inherit-c");
    const freshScope = { accountId: fresh.accountId, workspaceId: fresh.sharedWorkspaceId };
    const none = await setSubscriptionCoreCodexRotation(client!.db, {
      ...freshScope,
      subjectId: fresh.ownerSubjectId,
      rotationEnabled: false,
    });
    expect(none.rotation).toEqual({
      activeCredentialId: null,
      rotationEnabled: false,
      rotationStrategy: "sharded",
    });
    expect(
      (
        await setSubscriptionCoreCodexPrimary(client!.db, {
          ...freshScope,
          subjectId: fresh.ownerSubjectId,
          connectionId: c,
        })
      ).activated,
    ).toBe(c);
    expect(
      (
        await setSubscriptionCoreCodexRotation(client!.db, {
          ...freshScope,
          subjectId: fresh.ownerSubjectId,
          rotationEnabled: true,
        })
      ).rotation,
    ).toEqual({ activeCredentialId: c, rotationEnabled: true, rotationStrategy: "sharded" });
  });

  test("workspace routes manage only the workspace's projected pool (M3, L5)", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const [other] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${org.accountId}::uuid, 'Core Codex consumers second workspace')
      returning id::text as id`;
    await shared!.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${org.accountId}::uuid, ${other!.id}::uuid, ${org.ownerSubjectId}, 'owner')`;
    const elsewhere = await sharedConnection(org, "pool-elsewhere", {
      scope: "workspaces",
      workspaces: [other!.id],
      managedBy: other!.id,
      pool: "workspace",
    });
    const here = await sharedConnection(org, "pool-here");
    const admin = {
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      subjectId: org.ownerSubjectId,
    };
    expect(
      (
        await getSubscriptionCoreCodexWorkspaceProjection(client!.db, {
          accountId: org.accountId,
          workspaceId: org.sharedWorkspaceId,
        })
      ).accounts.map((account) => account.id),
    ).toEqual([here]);
    // An organization administrator still cannot pick an account outside this
    // workspace's pool on a workspace route.
    expect(
      (await setSubscriptionCoreCodexPrimary(client!.db, { ...admin, connectionId: elsewhere }))
        .activated,
    ).toBeNull();
    const [settingsRow] = await shared!.admin<{ count: string }[]>`
      select count(*)::text as count from subscription_settings
      where account_id = ${org.accountId}::uuid and workspace_id = ${org.sharedWorkspaceId}::uuid`;
    expect(settingsRow!.count).toBe("0");
    // Rename checks the pool before writing: the label is not committed.
    expect(
      await renameSubscriptionCoreCodexConnection(client!.db, {
        ...admin,
        connectionId: elsewhere,
        label: "renamed from the wrong workspace",
      }),
    ).toBeNull();
    expect((await connectionRow(elsewhere)).label).toBe("pool-elsewhere");
    expect(
      (
        await setSubscriptionCoreCodexAllocator(client!.db, {
          ...admin,
          connectionId: elsewhere,
          enabled: false,
          expectedVersion: 1,
        })
      ).result.kind,
    ).toBe("not_found");
    expect((await connectionRow(elsewhere)).allocator_enabled).toBe(true);
    // The same calls succeed from the workspace whose pool lists it.
    expect(
      (
        await setSubscriptionCoreCodexPrimary(client!.db, {
          ...admin,
          workspaceId: other!.id,
          connectionId: elsewhere,
        })
      ).activated,
    ).toBe(elsewhere);
    expect(
      await renameSubscriptionCoreCodexConnection(client!.db, {
        ...admin,
        workspaceId: other!.id,
        connectionId: elsewhere,
        label: "Team elsewhere",
      }),
    ).toBe(elsewhere);
  });

  test("a stale Apps clear cannot remove a newer designation (L1)", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const x = await sharedConnection(org, "stale-clear-x");
    const y = await sharedConnection(org, "stale-clear-y");
    const scope = { accountId: org.accountId, workspaceId: org.sharedWorkspaceId };
    const admin = { ...scope, subjectId: org.ownerSubjectId };
    const first = await designateSubscriptionCoreCodexApps(client!.db, {
      ...admin,
      connectionId: x,
      expectedVersion: 0,
    });
    expect(first.kind).toBe("updated");
    const staleVersion = (first as { version: number }).version;
    expect(
      await clearSubscriptionCoreCodexApps(client!.db, { ...admin, expectedVersion: staleVersion }),
    ).toMatchObject({ kind: "updated", version: 0 });
    const second = await designateSubscriptionCoreCodexApps(client!.db, {
      ...admin,
      connectionId: y,
      expectedVersion: 0,
    });
    expect(second).toMatchObject({ kind: "updated", credentialId: y });
    expect((second as { version: number }).version).toBeGreaterThan(staleVersion);
    // A client that still holds the first designation's version conflicts.
    expect(
      await clearSubscriptionCoreCodexApps(client!.db, { ...admin, expectedVersion: staleVersion }),
    ).toMatchObject({ kind: "conflict", credentialId: y });
    expect(await getSubscriptionCoreCodexAppsSettings(client!.db, scope)).toMatchObject({
      credentialId: y,
      version: (second as { version: number }).version,
    });
  });

  test("a pin waits for a concurrent binding write instead of reporting not found (L2)", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const connectionId = await sharedConnection(org, "pin-race");
    const sessionId = await ownedSession(org, org.sharedWorkspaceId);
    const base = {
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      sessionId,
      subjectId: org.ownerSubjectId,
    };
    expect(
      (await pinSubscriptionCoreSessionCodexAccount(client!.db, { ...base, connectionId })).result
        .changed,
    ).toBe(true);
    // A running turn's binding write (placement or cache-warmth touch) holds
    // the binding row and advances its version while the pin runs.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const writer = shared!.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update subscription_session_bindings
        set version = version + 1, last_model_call_at = clock_timestamp()
        where session_id = ${sessionId}::uuid`;
      locked();
      await released;
    });
    await holding;
    const pin = pinSubscriptionCoreSessionCodexAccount(client!.db, { ...base, connectionId: null });
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [waiting] = await shared!.admin<{ count: string }[]>`
        select count(*)::text as count from pg_stat_activity
        where datname = current_database() and usename = 'opengeni_app'
          and wait_event_type = 'Lock'`;
      if (Number(waiting!.count) > 0 || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await writer;
    expect((await pin).result.changed).toBe(true);
    const [binding] = await shared!.admin<{ choice: string; version: string }[]>`
      select choice, version::text as version from subscription_session_bindings
      where session_id = ${sessionId}::uuid`;
    expect(binding).toEqual({ choice: "automatic", version: "3" });
  });

  test("one workspace's ended Apps designation never fails another's refresh (L3)", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const connectionId = await sharedConnection(org, "flight-shared");
    const first = { accountId: org.accountId, workspaceId: org.sharedWorkspaceId };
    const second = { accountId: org.accountId, workspaceId: org.personalWorkspaceId };
    for (const scope of [first, second]) {
      expect(
        (
          await designateSubscriptionCoreCodexApps(client!.db, {
            ...scope,
            connectionId,
            subjectId: org.ownerSubjectId,
            expectedVersion: 0,
          })
        ).kind,
      ).toBe("updated");
    }
    await shared!.admin`update subscription_connections set expires_at = now() - interval '1 hour'
      where id = ${connectionId}::uuid`;
    let refreshes = 0;
    const deps = {
      refresh: async () => {
        refreshes += 1;
        return { accessToken: "access-flight-rotated", refreshToken: "refresh-flight-rotated" };
      },
    };
    // Hold the per-connection refresh key so both requests reach refresh together.
    const locker = await shared!.admin.reserve();
    const refreshKey = `subscription-refresh:${connectionId}`;
    await locker`select pg_advisory_lock(hashtextextended(${refreshKey}, 0))`;
    const advisoryWaiters = async () =>
      Number(
        (
          await shared!.admin<{ count: string }[]>`
            select count(*)::text as count from pg_locks
            where locktype = 'advisory' and not granted
              and database = (select oid from pg_database where datname = current_database())`
        )[0]!.count,
      );
    const waitFor = async (count: number, ms: number) => {
      const deadline = Date.now() + ms;
      while ((await advisoryWaiters()) < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    try {
      const firstRequest = subscriptionCoreCodexAppsRequestAuth(
        client!.db,
        settings,
        { ...first, connectionId },
        deps,
      )
        .withAuthorization(async (token) => token)
        .then(
          (token) => ({ ok: true as const, token }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      await waitFor(1, 10_000);
      // The first workspace's designation ends while its refresh waits.
      await shared!.admin`delete from subscription_apps_designations
        where workspace_id = ${first.workspaceId}::uuid`;
      const secondRequest = subscriptionCoreCodexAppsRequestAuth(
        client!.db,
        settings,
        { ...second, connectionId },
        deps,
      )
        .withAuthorization(async (token) => token)
        .then(
          (token) => ({ ok: true as const, token }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      await waitFor(2, 1_000);
      await locker`select pg_advisory_unlock(hashtextextended(${refreshKey}, 0))`;
      const [firstOutcome, secondOutcome] = await Promise.all([firstRequest, secondRequest]);
      expect(firstOutcome.ok).toBe(false);
      expect(!firstOutcome.ok && isCodexAppsCredentialUnavailable(firstOutcome.error)).toBe(true);
      expect(secondOutcome).toEqual({
        ok: true,
        token: { accessToken: "access-flight-rotated", chatgptAccountId: "chatgpt-flight-shared" },
      });
      expect(refreshes).toBe(1);
    } finally {
      locker.release();
    }
  });

  test("a session pin wakes only that session's waiter; failed wakes are logged (L4)", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const connectionId = await sharedConnection(org, "pin-wake");
    const pinnedSession = await ownedSession(org, org.sharedWorkspaceId);
    const otherSession = await ownedSession(org, org.sharedWorkspaceId);
    for (const sessionId of [pinnedSession, otherSession]) {
      const turnId = await queuedTurn(org, org.sharedWorkspaceId, sessionId);
      await shared!.admin`
        insert into subscription_capacity_waiters (account_id, workspace_id, session_id, turn_id, provider, wait_reason)
        values (${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${sessionId}::uuid,
          ${turnId}::uuid, 'codex', 'capacity')`;
    }
    const pinned = await pinSubscriptionCoreSessionCodexAccount(client!.db, {
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      sessionId: pinnedSession,
      connectionId,
      subjectId: org.ownerSubjectId,
    });
    expect(pinned.result.changed).toBe(true);
    expect(pinned.wake).toEqual({
      accountId: org.accountId,
      reason: "core_codex_session_pin_changed",
      workspaceIds: [org.sharedWorkspaceId],
      sessionIds: [pinnedSession],
    });
    const revisions = async () =>
      Object.fromEntries(
        (
          await shared!.admin<{ session_id: string; wake_revision: string }[]>`
            select session_id::text as session_id, wake_revision::text as wake_revision
            from subscription_capacity_waiters where account_id = ${org.accountId}::uuid`
        ).map((row) => [row.session_id, Number(row.wake_revision)]),
      );
    const outbox = async (sessionId: string) =>
      Number(
        (
          await shared!.admin<{ count: string }[]>`
            select count(*)::text as count from subscription_capacity_wake_outbox
            where account_id = ${org.accountId}::uuid and session_id = ${sessionId}::uuid`
        )[0]!.count,
      );
    const before = await revisions();
    const outboxBefore = [await outbox(pinnedSession), await outbox(otherSession)];
    await deliverSubscriptionCoreCodexWake(client!.db, pinned.wake);
    expect(await revisions()).toEqual({
      [pinnedSession]: before[pinnedSession]! + 1,
      [otherSession]: before[otherSession]!,
    });
    expect([await outbox(pinnedSession), await outbox(otherSession)]).toEqual([
      outboxBefore[0]! + 1,
      outboxBefore[1]!,
    ]);

    // A failed wake never fails the committed change, and it is logged.
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await deliverSubscriptionCoreCodexWake(client!.db, {
        accountId: org.accountId,
        reason: "Not A Valid Reason",
        workspaceIds: [org.sharedWorkspaceId],
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("core Codex wake delivery failed");
      expect(warn.mock.calls[0]![1]).toMatchObject({
        accountId: org.accountId,
        reason: "Not A Valid Reason",
      });
    } finally {
      warn.mockRestore();
    }
  });
});

describe.skipIf(!realDb)("Codex Apps routine authorization (owner-migrated database)", () => {
  let template: { shared: SharedTestDatabase | null; client: DbClient | null } | null = null;
  let owned: OwnerMigratedTestDatabase | null = null;
  let ownedClient: DbClient | null = null;

  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("codex-apps-routine-owner");
    if (!owned) throw new Error("Owner-migrated PostgreSQL database unavailable");
    await migrate(owned.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
    await provisionRoles(owned.adminUrl, {
      appRole: "opengeni_app",
      appPassword: owned.appPassword,
      rlsStrategy: "force",
    });
    const runtimeUrl = new URL(owned.adminUrl);
    runtimeUrl.username = "opengeni_app";
    runtimeUrl.password = owned.appPassword;
    ownedClient = createDb(runtimeUrl.toString(), { max: 6 });
    template = { shared, client };
    shared = {
      admin: owned.admin,
      adminUrl: owned.adminUrl,
      appUrl: runtimeUrl.toString(),
      release: async () => undefined,
    } as SharedTestDatabase;
    client = ownedClient;
  }, 180_000);

  afterAll(async () => {
    if (template) ({ shared, client } = template);
    await ownedClient?.close();
    await owned?.release();
  }, 180_000);

  authorizationCases("owner-migrated");
});
