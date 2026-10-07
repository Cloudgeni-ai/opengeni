import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { effectiveSettings, type SubscriptionSettingsPolicy } from "@opengeni/subscriptions";
import { sql } from "drizzle-orm";
import {
  createDb,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  readSubscriptionEffectiveSettings,
  transitionSessionVisibility,
  updateOrganizationMember,
  updateOrganizationPrivateSessionSettings,
  withRlsContext,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { rawRows } from "../src/database";

setDefaultTimeout(180_000);
const realTest = test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1");
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  if (process.env.OPENGENI_REQUIRE_REAL_DB !== "1") return;
  shared = await acquireSharedTestDatabase("subscription-core-m2");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 3 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function organizationFixture() {
  const suffix = crypto.randomUUID();
  const userId = `subscription-core-${suffix}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Subscription core fixture",
  });
  return {
    accountId: access.workspaceGrants[0]!.accountId,
    workspaceId: access.workspaceGrants[0]!.workspaceId!,
    subjectId: `user:${userId}`,
  };
}

describe("shared subscription core M2 PostgreSQL contracts", () => {
  realTest("SUB-SET-03 and SUB-SET-06: SQL settings resolution matches TypeScript, including locked fields", async () => {
    const fixture = await organizationFixture();
    const [connection] = await shared!.admin<{ id: string }[]>`
      insert into subscription_connections (
        account_id, provider, provider_account_id, credential_encrypted, scope_kind
      ) values (
        ${fixture.accountId}, 'codex', ${`provider-account-${crypto.randomUUID()}`}, 'v1:test', 'organization'
      ) returning id::text as id`;
    const rotation = {
      codex: { mode: "spread" },
      claude: { mode: "spread" },
      xai: { mode: "spread" },
    };
    const organizationProviders = {
      codex: { useOrganizationAccounts: true, enabled: true },
      claude: { useOrganizationAccounts: true, enabled: true },
      xai: { useOrganizationAccounts: true, enabled: true },
    };
    const workspaceProviders = { codex: { enabled: false, useOrganizationAccounts: false } };
    const organizationFallbackOrder = { "codex/model-a": ["claude/model-b"] };
    const workspaceFallbackOrder = { "codex/model-a": ["xai/model-c"] };
    const [jsonShapes] = await shared!.admin<{ rotation: string; providers: string; fallback: string }[]>`
      select jsonb_typeof(${shared!.admin.json(rotation)}::jsonb) as rotation,
        jsonb_typeof(${shared!.admin.json(organizationProviders)}::jsonb) as providers,
        jsonb_typeof(${shared!.admin.json(organizationFallbackOrder)}::jsonb) as fallback`;
    expect(jsonShapes).toEqual({ rotation: "object", providers: "object", fallback: "object" });
    await shared!.admin`
      insert into subscription_settings (
        account_id, workspace_id, rotation, providers, cross_provider_failover, fallback_order,
        personal_connections_allowed, personal_fallback_allowed, locked_settings
      ) values (
        ${fixture.accountId}, null, ${shared!.admin.json(rotation)}::jsonb,
        ${shared!.admin.json(organizationProviders)}::jsonb,
        false, ${shared!.admin.json(organizationFallbackOrder)}::jsonb, true, false,
        ARRAY['personalFallbackAllowed']::text[]
      )`;
    await shared!.admin`
      insert into subscription_settings (
        account_id, workspace_id, codex_primary_connection_id, rotation, providers,
        cross_provider_failover, fallback_order, personal_fallback_allowed
      ) values (
        ${fixture.accountId}, ${fixture.workspaceId}, ${connection!.id}::uuid,
        ${shared!.admin.json({ codex: { mode: "primary_first" } })}::jsonb,
        ${shared!.admin.json(workspaceProviders)}::jsonb, true,
        ${shared!.admin.json(workspaceFallbackOrder)}::jsonb, true
      )`;

    const policy: SubscriptionSettingsPolicy = {
      organization: {
        rotation: rotation as SubscriptionSettingsPolicy["organization"]["rotation"],
        providers: organizationProviders,
        crossProviderFailover: false,
        fallbackOrder: organizationFallbackOrder,
        personalConnectionsAllowed: true,
        personalFallbackAllowed: false,
      },
      locked: ["personalFallbackAllowed"],
      workspaces: {
        [fixture.workspaceId]: {
          rotation: { codex: { mode: "primary_first", primaryConnectionId: connection!.id } },
          providers: workspaceProviders,
          crossProviderFailover: true,
          fallbackOrder: workspaceFallbackOrder,
          personalFallbackAllowed: true,
        },
      },
    };
    const expected = effectiveSettings(policy, fixture.workspaceId);
    const actual = await withSessionRlsActorContext({ subjectId: fixture.subjectId }, () =>
      withRlsContext(
        client!.db,
        { accountId: fixture.accountId, workspaceId: fixture.workspaceId },
        (db) => readSubscriptionEffectiveSettings(db, fixture.accountId, fixture.workspaceId),
      ),
    );
    expect(actual).toEqual(expected);
    expect(actual.values.providers.codex).toEqual({ useOrganizationAccounts: false, enabled: false });
    expect(actual.sources.providers.codex).toBe("workspace");
    expect(actual.sources.personalFallbackAllowed).toBe("organization");
  }, 180_000);

  realTest("SUB-OWN-08: uniqueness is per organization, provider account, and owner", async () => {
    const fixture = await organizationFixture();
    const providerAccountId = `upstream-${crypto.randomUUID()}`;
    await shared!.admin`
      insert into subscription_connections (account_id, provider, provider_account_id, credential_encrypted)
      values (${fixture.accountId}, 'claude', ${providerAccountId}, 'v1:first')`;
    let uniqueViolation: unknown;
    try {
      await shared!.admin`
        insert into subscription_connections (account_id, provider, provider_account_id, credential_encrypted)
        values (${fixture.accountId}, 'claude', ${providerAccountId}, 'v1:duplicate')`;
    } catch (error) {
      uniqueViolation = error;
    }
    expect((uniqueViolation as { code?: string } | undefined)?.code).toBe("23505");
  }, 180_000);

  realTest("restricted application role cannot read another organization's connection", async () => {
    const first = await organizationFixture();
    const second = await organizationFixture();
    const [connection] = await shared!.admin<{ id: string }[]>`
      insert into subscription_connections (account_id, provider, credential_encrypted, scope_kind)
      values (${first.accountId}, 'xai', 'v1:test', 'organization') returning id::text as id`;
    const visibleFromOtherOrganization = await withSessionRlsActorContext(
      { subjectId: second.subjectId },
      () => withRlsContext(client!.db, { accountId: second.accountId }, async (db) => {
        const rows = await rawRows<{ id: string }>(
          db,
          sql`select id::text as id from subscription_connections where id = ${connection!.id}::uuid`,
        );
        return rows;
      }),
    );
    expect(visibleFromOtherOrganization).toEqual([]);
  }, 180_000);

  realTest("people scope requires the exact live session owner and does not widen private-session visibility", async () => {
    const fixture = await organizationFixture();
    const [membership] = await shared!.admin<{ id: string; personal_workspace_id: string }[]>`
      select id::text as id, personal_workspace_id::text as personal_workspace_id
      from organization_memberships where account_id = ${fixture.accountId}
        and subject_id = ${fixture.subjectId}`;
    const workspaceId = membership!.personal_workspace_id;
    await shared!.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (${fixture.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')
      on conflict (account_id) do nothing`;
    const privateSettings = await getOrganizationPrivateSessionSettings(client!.db, {
      organizationId: fixture.accountId,
      actorSubjectId: fixture.subjectId,
    });
    await updateOrganizationPrivateSessionSettings(client!.db, {
      organizationId: fixture.accountId,
      actorSubjectId: fixture.subjectId,
      enabled: true,
      expectedVersion: privateSettings.version,
      operationId: crypto.randomUUID(),
    });
    const session = await withSessionRlsActorContext({ subjectId: fixture.subjectId }, () =>
      createSession(client!.db, {
        accountId: fixture.accountId,
        workspaceId,
        initialMessage: "private subscription scope fixture",
        resources: [],
        metadata: {},
        model: "fixture-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: fixture.subjectId },
        createdByContext: {},
      }),
    );
    await transitionSessionVisibility(client!.db, {
      workspaceId,
      sessionId: session.id,
      actorSubjectId: fixture.subjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `subscription-core-private-${session.id}`,
    });
    const turn = await withSessionRlsActorContext({ subjectId: fixture.subjectId }, () =>
      enqueueSessionTurn(client!.db, {
        accountId: fixture.accountId,
        workspaceId,
        sessionId: session.id,
        triggerEventId: crypto.randomUUID(),
        temporalWorkflowId: `subscription-core-${session.id}`,
        source: "user",
        prompt: "private subscription scope fixture",
        resources: [],
        tools: [],
        model: "fixture-model",
        reasoningEffort: "medium",
        sandboxBackend: "none",
        metadata: {},
        initiator: { kind: "subject", subjectId: fixture.subjectId },
      }),
    );
    const [connection] = await shared!.admin<{ id: string }[]>`
      insert into subscription_connections (
        account_id, provider, credential_encrypted, scope_kind
      ) values (${fixture.accountId}, 'codex', 'v1:people-scope', 'people')
      returning id::text as id`;
    await shared!.admin`
      insert into subscription_connection_people (account_id, connection_id, organization_membership_id)
      values (${fixture.accountId}, ${connection!.id}::uuid, ${membership!.id}::uuid)`;

    const inspectAs = (initiatingHumanSubjectId: string, sessionOwnerSubjectId: string) =>
      withSessionRlsActorContext(
        { subjectId: "service:subscription-test", initiatingHumanSubjectId },
        () => withRlsContext(client!.db, { accountId: fixture.accountId, workspaceId }, async (db) => {
          const [authorization] = await rawRows<{ allowed: boolean }>(
            db,
            sql`select opengeni_private.authorize_subscription_session_access(
              ${fixture.accountId}::uuid, ${workspaceId}::uuid, ${session.id}::uuid,
              ${turn.id}::uuid, ${sessionOwnerSubjectId}, ${initiatingHumanSubjectId}
            ) as allowed`,
          );
          const visible = await rawRows<{ id: string }>(
            db,
            sql`select id::text as id from subscription_connections where id = ${connection!.id}::uuid`,
          );
          return { allowed: authorization?.allowed ?? false, visible };
        }),
      );

    expect(await inspectAs(fixture.subjectId, fixture.subjectId)).toEqual({
      allowed: true,
      visible: [{ id: connection!.id }],
    });
    expect(await inspectAs(fixture.subjectId, "user:another-person")).toEqual({
      allowed: false,
      visible: [],
    });
    expect(await inspectAs("user:private-session-outsider", fixture.subjectId)).toEqual({
      allowed: false,
      visible: [],
    });
  }, 180_000);

  realTest("membership offboarding retains a generic personal subscription authority without leaving it active", async () => {
    const fixture = await organizationFixture();
    const targetSubject = `user:subscription-core-member-${crypto.randomUUID()}`;
    const [personalWorkspace] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${fixture.accountId}, 'Subscription member Personal') returning id::text as id`;
    const [membership] = await shared!.admin<{ id: string; authorization_revision: number }[]>`
      insert into organization_memberships (
        account_id, subject_id, role, status, personal_workspace_id
      ) values (
        ${fixture.accountId}, ${targetSubject}, 'member', 'active', ${personalWorkspace!.id}::uuid
      ) returning id::text as id, authorization_revision`;
    const connectionId = crypto.randomUUID();
    const authorityId = crypto.randomUUID();
    await shared!.admin`
      insert into organization_user_resource_authorities (
        id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
      ) values (
        ${authorityId}::uuid, ${fixture.accountId}, ${membership!.id}::uuid,
        'subscription_connection', ${connectionId}::uuid, 1, 'active'
      )`;
    await shared!.admin`
      insert into subscription_connections (
        id, account_id, provider, credential_encrypted, ownership, scope_kind,
        owner_organization_membership_id, owner_subject_id, authority_id,
        authority_resource_kind, authority_generation
      ) values (
        ${connectionId}::uuid, ${fixture.accountId}, 'claude', 'v1:personal', 'personal', 'people',
        ${membership!.id}::uuid, ${targetSubject}, ${authorityId}::uuid,
        'subscription_connection', 1
      )`;

    const removed = await updateOrganizationMember(client!.db, {
      organizationId: fixture.accountId,
      actorSubjectId: fixture.subjectId,
      operationId: crypto.randomUUID(),
      membershipId: membership!.id,
      transition: {
        kind: "offboard",
        expectedAuthorizationRevision: membership!.authorization_revision,
        operationId: crypto.randomUUID(),
        reason: "subscription lifecycle test",
      },
    });
    expect(removed.status).not.toBe("active");
    const [revokedAuthority] = await shared!.admin<{ status: string }[]>`
      select status from organization_user_resource_authorities where id = ${authorityId}::uuid`;
    expect(revokedAuthority?.status).toBe("retained");
    const [deleted] = await shared!.admin.begin(async (tx) => {
      await tx`select set_config(
        'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
      )`;
      return await tx<{ subscription_count: number }[]>`
        select subscription_count from opengeni_private.delete_subscription_resources_for_membership(
          ${fixture.accountId}::uuid, ${membership!.id}::uuid
        )`;
    });
    expect(deleted?.subscription_count).toBe(1);
    const [remaining] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from subscription_connections where id = ${connectionId}::uuid`;
    expect(remaining?.count).toBe(0);
  }, 180_000);
});
