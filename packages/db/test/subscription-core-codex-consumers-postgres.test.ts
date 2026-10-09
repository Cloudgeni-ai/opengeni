import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
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
  pinSubscriptionCoreSessionCodexAccount,
  readCodexCutoverDisposition,
  renameSubscriptionCoreCodexConnection,
  resolveSubscriptionCoreCodexAppsDesignation,
  setSubscriptionCoreCodexAllocator,
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

describe.skipIf(!realDb)("remaining Codex consumers on the shared core", () => {
  test("runs as the non-superuser, non-bypass application role", async () => {
    const [role] = await rawRows<{ currentUser: string; superuser: boolean; bypassRls: boolean }>(
      client!.db,
      sql`select current_user as "currentUser", rolsuper as superuser,
          rolbypassrls as "bypassRls"
        from pg_catalog.pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ currentUser: "opengeni_app", superuser: false, bypassRls: false });
  });

  test("without a cutover row nothing on the core resolves, even with core rows present", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org, "gate-off");
    await shared!.admin`
      insert into subscription_apps_designations (account_id, workspace_id, connection_id, updated_by_subject_id)
      values (${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${connectionId}::uuid, ${org.ownerSubjectId})`;
    expect(await readCodexCutoverDisposition(client!.db, org.accountId)).toBe("legacy");
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

  test("an administrator designates Apps on the core; requests recheck and refresh by designation", async () => {
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
    expect(designated).toMatchObject({ kind: "updated", credentialId: connectionId, version: 1 });
    expect(
      (
        await designateSubscriptionCoreCodexApps(client!.db, {
          ...scope,
          connectionId,
          subjectId: org.ownerSubjectId,
          expectedVersion: 1,
        })
      ).kind,
    ).toBe("already_designated");
    expect(await getSubscriptionCoreCodexAppsSettings(client!.db, scope)).toMatchObject({
      credentialId: connectionId,
      version: 1,
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

    // Clearing ends authority for in-flight request auth.
    await shared!
      .admin`update subscription_connections set status = 'active' where id = ${connectionId}::uuid`;
    const cleared = await clearSubscriptionCoreCodexApps(client!.db, {
      ...scope,
      subjectId: org.ownerSubjectId,
      expectedVersion: 1,
    });
    expect(cleared).toMatchObject({ kind: "updated", credentialId: null, version: 0 });
    const error = await auth.withAuthorization(async (token) => token).catch((caught) => caught);
    expect(isCodexAppsCredentialUnavailable(error)).toBe(true);
  });

  test("designation authority, scope and personal-connection rules are enforced by the database", async () => {
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
    expect(
      await designateSubscriptionCoreCodexApps(client!.db, {
        ...scope,
        connectionId: managedHere,
        subjectId: manager,
        expectedVersion: 0,
      }),
    ).toMatchObject({ kind: "updated", credentialId: managedHere });
    // A stranger cannot clear it.
    expect(
      (
        await clearSubscriptionCoreCodexApps(client!.db, {
          ...scope,
          subjectId: stranger,
          expectedVersion: 1,
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
    await shared!.admin`
      insert into subscription_apps_designations (account_id, workspace_id, connection_id, updated_by_subject_id)
      values (${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${peopleScoped!.id}::uuid, ${org.ownerSubjectId})`;
    expect(await resolveSubscriptionCoreCodexAppsDesignation(client!.db, scope)).toBeNull();
    expect(await readCredential(org, org.sharedWorkspaceId, peopleScoped!.id)).toEqual([]);

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
    ).rejects.toThrow("missing permission");
    await expect(
      setSubscriptionCoreWorkspaceCodexSource(client!.db, {
        accountId: org.accountId,
        workspaceId: org.personalWorkspaceId,
        subjectId: org.ownerSubjectId,
        mode: "workspace",
      }),
    ).rejects.toThrow("personal workspaces");

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
});
