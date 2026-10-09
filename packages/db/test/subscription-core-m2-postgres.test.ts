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
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  if (process.env.OPENGENI_REQUIRE_REAL_DB !== "1") return;
  shared = await acquireSharedTestDatabase("subscription-core-m2-v2");
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
  // Migration 0680 seeds every organization's settings row; these contracts
  // write the organization row themselves.
  await shared!.admin`
    delete from subscription_settings
    where account_id = ${access.workspaceGrants[0]!.accountId}::uuid and workspace_id is null`;
  return {
    accountId: access.workspaceGrants[0]!.accountId,
    workspaceId: access.workspaceGrants[0]!.workspaceId!,
    subjectId: `user:${userId}`,
  };
}

async function verifySubscriptionLifecycleRlsAsNonBypassOwner(connectionId: string) {
  const probeRole = `subscription_lifecycle_probe_${crypto.randomUUID().replaceAll("-", "")}`;
  const [owners] = await shared!.admin<{ function_owner: string }[]>`
    select pg_get_userbyid(proowner) as function_owner
    from pg_proc
    where oid = 'finalize_organization_retention_deletion(uuid,uuid,uuid,text)'::regprocedure`;
  expect(owners).toBeDefined();
  await shared!.admin.unsafe(
    `create role ${probeRole} nologin nosuperuser nobypassrls nocreatedb nocreaterole`,
  );
  try {
    await shared!.admin.begin(async (tx) => {
      await tx.unsafe(`grant create on schema public to ${probeRole}`);
      await tx.unsafe(
        `alter function finalize_organization_retention_deletion(uuid,uuid,uuid,text) owner to ${probeRole}`,
      );
      await tx.unsafe(`revoke create on schema public from ${probeRole}`);
      await tx.unsafe(`grant usage on schema public, opengeni_private to ${probeRole}`);
      await tx.unsafe(`grant select, delete on subscription_connections to ${probeRole}`);
      await tx.unsafe(
        `grant execute on function opengeni_private.subscription_connection_visible(uuid,uuid,uuid,text,text,uuid,text,text) to ${probeRole}`,
      );
      await tx.unsafe(
        `grant execute on function opengeni_private.subscription_organization_admin(uuid) to ${probeRole}`,
      );
      // Every SELECT on the table evaluates the refresh-only read policy too.
      await tx.unsafe(
        `grant execute on function opengeni_private.subscription_codex_refresh_write_allowed(uuid,uuid,uuid) to ${probeRole}`,
      );
      // ... and the owner-only Codex writer policy (M3 PR 3b).
      await tx.unsafe(
        `grant execute on function opengeni_private.subscription_codex_owner_capability_held(uuid,text[],text,uuid,boolean) to ${probeRole}`,
      );
      await tx.unsafe(`set local role ${probeRole}`);
      await tx.unsafe("set local search_path = pg_catalog, public, opengeni_private, pg_temp");
      const [attributes] = await tx<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
        select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
      expect(attributes).toEqual({ rolsuper: false, rolbypassrls: false });
      await tx`select set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true)`;
      const visible = await tx<{ id: string }[]>`
        select id::text as id from subscription_connections where id = ${connectionId}::uuid`;
      await tx`savepoint subscription_lifecycle_probe`;
      const deleted = await tx<{ id: string }[]>`
        delete from subscription_connections where id = ${connectionId}::uuid
        returning id::text as id`;
      await tx`rollback to savepoint subscription_lifecycle_probe`;
      expect(visible.length).toBe(1);
      expect(visible[0]?.id).toBe(connectionId);
      expect(deleted.length).toBe(1);
      expect(deleted[0]?.id).toBe(connectionId);
      await tx.unsafe("reset role");
      await tx.unsafe(`revoke usage on schema public, opengeni_private from ${probeRole}`);
      await tx.unsafe(`revoke select, delete on subscription_connections from ${probeRole}`);
      await tx.unsafe(
        `revoke execute on function opengeni_private.subscription_connection_visible(uuid,uuid,uuid,text,text,uuid,text,text) from ${probeRole}`,
      );
      await tx.unsafe(
        `revoke execute on function opengeni_private.subscription_organization_admin(uuid) from ${probeRole}`,
      );
      await tx.unsafe(
        `revoke execute on function opengeni_private.subscription_codex_refresh_write_allowed(uuid,uuid,uuid) from ${probeRole}`,
      );
      await tx.unsafe(
        `revoke execute on function opengeni_private.subscription_codex_owner_capability_held(uuid,text[],text,uuid,boolean) from ${probeRole}`,
      );
      await tx.unsafe(
        `alter function finalize_organization_retention_deletion(uuid,uuid,uuid,text) owner to ${owners!.function_owner}`,
      );
    });
  } finally {
    await shared!.admin.unsafe(`drop role if exists ${probeRole}`);
  }
}

describe("shared subscription core M2 PostgreSQL contracts", () => {
  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "SUB-SET-03 and SUB-SET-06: SQL parity includes sparse provider defaults and locked fields",
    async () => {
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
        codex: {
          inferenceSource: "automatic" as const,
          useOrganizationAccounts: true,
          enabled: true,
        },
        claude: { useOrganizationAccounts: false, enabled: true },
      };
      const workspaceProviders = {
        codex: { useOrganizationAccounts: false, enabled: false },
      };
      const organizationFallbackOrder = { "codex/model-a": ["claude/model-b"] };
      const workspaceFallbackOrder = { "codex/model-a": ["xai/model-c"] };
      const [jsonShapes] = await shared!.admin<
        { rotation: string; providers: string; fallback: string }[]
      >`
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
      expect(actual.values.providers.codex).toEqual({
        inferenceSource: "workspace",
        useOrganizationAccounts: false,
        enabled: false,
      });
      expect(actual.values.providers.claude).toEqual({
        useOrganizationAccounts: false,
        enabled: true,
      });
      expect(actual.sources.providers.codex).toBe("workspace");
      expect(actual.sources.providers.claude).toBe("organization");
      expect(actual.sources.personalFallbackAllowed).toBe("organization");
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "subscription settings resolver cannot be shadowed by a temporary table",
    async () => {
      const fixture = await organizationFixture();
      await shared!.admin`
        insert into subscription_settings (
          account_id, workspace_id, rotation, providers, cross_provider_failover,
          fallback_order, personal_connections_allowed, personal_fallback_allowed
        ) values (
          ${fixture.accountId}, null,
          ${shared!.admin.json({ codex: { mode: "spread" }, claude: { mode: "spread" }, xai: { mode: "spread" } })}::jsonb,
          '{}'::jsonb, false, '{}'::jsonb, false, false
        )`;

      const personalConnectionsAllowed = await withSessionRlsActorContext(
        { subjectId: fixture.subjectId },
        () =>
          withRlsContext(
            client!.db,
            { accountId: fixture.accountId, workspaceId: fixture.workspaceId },
            async (db) => {
              await rawRows(
                db,
                sql`
                create temporary table subscription_settings (
                  account_id uuid,
                  workspace_id uuid,
                  rotation jsonb,
                  providers jsonb,
                  codex_primary_connection_id uuid,
                  claude_primary_connection_id uuid,
                  xai_primary_connection_id uuid,
                  cross_provider_failover boolean,
                  fallback_order jsonb,
                  personal_connections_allowed boolean,
                  personal_fallback_allowed boolean,
                  locked_settings text[]
                ) on commit drop
              `,
              );
              await rawRows(
                db,
                sql`
                insert into subscription_settings (
                  account_id, workspace_id, rotation, providers, fallback_order,
                  personal_connections_allowed, personal_fallback_allowed, locked_settings
                ) values (
                  ${fixture.accountId}::uuid, null, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                  true, false, '{}'::text[]
                )
              `,
              );
              const [row] = await rawRows<{ allowed: boolean }>(
                db,
                sql`
                select (subscription_effective_settings(
                  ${fixture.accountId}::uuid, ${fixture.workspaceId}::uuid
                ) #>> '{values,personalConnectionsAllowed}')::boolean as allowed
              `,
              );
              return row?.allowed;
            },
          ),
      );

      expect(personalConnectionsAllowed).toBe(false);
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "SUB-OWN-08: uniqueness is per organization, provider account, and owner",
    async () => {
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
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "SUB-SET-03: locked sparse maps ignore workspace-only keys in SQL parity",
    async () => {
      const fixture = await organizationFixture();
      const organization = {
        rotation: { codex: { mode: "spread" } },
        providers: {},
        crossProviderFailover: false,
        fallbackOrder: { "codex/model-a": ["claude/model-b"] },
      } as const;
      const workspace = {
        rotation: { claude: { mode: "spread" } },
        providers: { xai: { enabled: false } },
        fallbackOrder: { "xai/model-c": ["codex/model-a"] },
      } as const;
      const locked = ["rotation", "providers", "fallbackOrder"] as const;
      await shared!.admin`
        insert into subscription_settings (
          account_id, workspace_id, rotation, providers, cross_provider_failover,
          fallback_order, personal_connections_allowed, personal_fallback_allowed, locked_settings
        ) values (
          ${fixture.accountId}, null, ${shared!.admin.json(organization.rotation)}::jsonb,
          ${shared!.admin.json(organization.providers)}::jsonb, false,
          ${shared!.admin.json(organization.fallbackOrder)}::jsonb, true, false, ${locked}
        )`;
      await shared!.admin`
        insert into subscription_settings (
          account_id, workspace_id, rotation, providers, fallback_order
        ) values (
          ${fixture.accountId}, ${fixture.workspaceId},
          ${shared!.admin.json(workspace.rotation)}::jsonb,
          ${shared!.admin.json(workspace.providers)}::jsonb,
          ${shared!.admin.json(workspace.fallbackOrder)}::jsonb
        )`;

      const expected = effectiveSettings(
        {
          organization: {
            ...organization,
            personalConnectionsAllowed: true,
            personalFallbackAllowed: false,
          },
          locked,
          workspaces: { [fixture.workspaceId]: workspace },
        },
        fixture.workspaceId,
      );
      const actual = await withSessionRlsActorContext({ subjectId: fixture.subjectId }, () =>
        withRlsContext(
          client!.db,
          { accountId: fixture.accountId, workspaceId: fixture.workspaceId },
          (db) => readSubscriptionEffectiveSettings(db, fixture.accountId, fixture.workspaceId),
        ),
      );
      expect(actual).toEqual(expected);
      expect(actual.values.providers).toEqual({});
      expect(actual.values.rotation).toEqual(organization.rotation);
      expect(actual.values.fallbackOrder).toEqual(organization.fallbackOrder);
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "explicit session bindings remain pinned when their connection is deleted",
    async () => {
      const fixture = await organizationFixture();
      const session = await withSessionRlsActorContext({ subjectId: fixture.subjectId }, () =>
        createSession(client!.db, {
          accountId: fixture.accountId,
          workspaceId: fixture.workspaceId,
          initialMessage: "explicit subscription binding deletion fixture",
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
      const [connection] = await shared!.admin<{ id: string }[]>`
      insert into subscription_connections (
        account_id, provider, credential_encrypted, ownership, scope_kind
      ) values (${fixture.accountId}, 'codex', 'v1:explicit-binding', 'shared', 'organization')
      returning id::text as id`;
      await withSessionRlsActorContext(
        {
          subjectId: fixture.subjectId,
          initiatingHumanSubjectId: fixture.subjectId,
        },
        () =>
          withRlsContext(
            client!.db,
            { accountId: fixture.accountId, workspaceId: fixture.workspaceId },
            (db) =>
              rawRows(
                db,
                sql`insert into subscription_session_bindings (
                account_id, workspace_id, session_id, provider, connection_id, model_id, choice
              ) values (
                ${fixture.accountId}::uuid, ${fixture.workspaceId}::uuid, ${session.id}::uuid,
                'codex', ${connection!.id}::uuid, 'fixture-model', 'explicit'
              )`,
              ),
          ),
      );

      await shared!.admin`
      delete from subscription_connections where account_id = ${fixture.accountId}
        and id = ${connection!.id}::uuid`;
      const [binding] = await shared!.admin<{ connection_id: string | null; choice: string }[]>`
      select connection_id::text as connection_id, choice
      from subscription_session_bindings
      where workspace_id = ${fixture.workspaceId} and session_id = ${session.id}::uuid`;
      expect(binding).toEqual({ connection_id: null, choice: "explicit" });
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "restricted roles cannot bind or lease a connection outside the session pool",
    async () => {
      const fixture = await organizationFixture();
      const [otherWorkspace] = await shared!.admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${fixture.accountId}, 'Subscription out-of-scope workspace')
        returning id::text as id`;
      const session = await withSessionRlsActorContext({ subjectId: fixture.subjectId }, () =>
        createSession(client!.db, {
          accountId: fixture.accountId,
          workspaceId: fixture.workspaceId,
          initialMessage: "subscription connection target guard fixture",
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
      const turn = await withSessionRlsActorContext({ subjectId: fixture.subjectId }, () =>
        enqueueSessionTurn(client!.db, {
          accountId: fixture.accountId,
          workspaceId: fixture.workspaceId,
          sessionId: session.id,
          triggerEventId: crypto.randomUUID(),
          temporalWorkflowId: `subscription-target-${session.id}`,
          source: "user",
          prompt: "subscription connection target guard fixture",
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
          account_id, provider, credential_encrypted, ownership, scope_kind
        ) values (${fixture.accountId}, 'codex', 'v1:other-workspace', 'shared', 'workspaces')
        returning id::text as id`;
      await shared!.admin`
        insert into subscription_connection_workspaces (account_id, connection_id, workspace_id)
        values (${fixture.accountId}, ${connection!.id}::uuid, ${otherWorkspace!.id}::uuid)`;

      let bindingError: unknown;
      try {
        await withSessionRlsActorContext({ subjectId: fixture.subjectId }, () =>
          withRlsContext(
            client!.db,
            {
              accountId: fixture.accountId,
              workspaceId: fixture.workspaceId,
            },
            (db) =>
              rawRows(
                db,
                sql`insert into subscription_session_bindings (
                account_id, workspace_id, session_id, provider, connection_id, model_id, choice
              ) values (
                ${fixture.accountId}::uuid, ${fixture.workspaceId}::uuid, ${session.id}::uuid,
                'codex', ${connection!.id}::uuid, 'fixture-model', 'explicit'
              )`,
              ),
          ),
        );
      } catch (error) {
        bindingError = error;
      }
      const bindingCode =
        (bindingError as { code?: string; cause?: { code?: string } } | undefined)?.code ??
        (bindingError as { cause?: { code?: string } } | undefined)?.cause?.code;
      expect(bindingCode).toBe("42501");

      let leaseError: unknown;
      try {
        await withSessionRlsActorContext({ subjectId: fixture.subjectId }, () =>
          withRlsContext(
            client!.db,
            {
              accountId: fixture.accountId,
              workspaceId: fixture.workspaceId,
            },
            (db) =>
              rawRows(
                db,
                sql`insert into subscription_leases (
                account_id, workspace_id, session_id, turn_id, connection_id,
                provider, holder_id, generation, leased_until
              ) values (
                ${fixture.accountId}::uuid, ${fixture.workspaceId}::uuid, ${session.id}::uuid,
                ${turn.id}::uuid, ${connection!.id}::uuid, 'codex', 'fixture-holder', 1,
                now() + interval '1 minute'
              )`,
              ),
          ),
        );
      } catch (error) {
        leaseError = error;
      }
      const leaseCode =
        (leaseError as { code?: string; cause?: { code?: string } } | undefined)?.code ??
        (leaseError as { cause?: { code?: string } } | undefined)?.cause?.code;
      expect(leaseCode).toBe("42501");
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "SUB-OWN-05: binding capabilities cannot bypass frozen authority or disabled personal connections",
    async () => {
      const fixture = await organizationFixture();
      await shared!.admin`
        insert into subscription_settings (
          account_id, rotation, providers, cross_provider_failover, fallback_order,
          personal_connections_allowed, personal_fallback_allowed
        ) values (
          ${fixture.accountId}, '{}'::jsonb, '{}'::jsonb, false, '{}'::jsonb, true, false
        )`;
      const [membership] = await shared!.admin<{ id: string; personal_workspace_id: string }[]>`
        select id::text as id, personal_workspace_id::text as personal_workspace_id
        from organization_memberships
        where account_id = ${fixture.accountId} and subject_id = ${fixture.subjectId}`;
      const workspaceId = membership!.personal_workspace_id;
      const session = await withSessionRlsActorContext({ subjectId: fixture.subjectId }, () =>
        createSession(client!.db, {
          accountId: fixture.accountId,
          workspaceId,
          initialMessage: "subscription binding capability reuse fixture",
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
      const turn = await withSessionRlsActorContext({ subjectId: fixture.subjectId }, () =>
        enqueueSessionTurn(client!.db, {
          accountId: fixture.accountId,
          workspaceId,
          sessionId: session.id,
          triggerEventId: crypto.randomUUID(),
          temporalWorkflowId: `subscription-binding-capability-${session.id}`,
          source: "user",
          prompt: "subscription binding capability reuse fixture",
          resources: [],
          tools: [],
          model: "fixture-model",
          reasoningEffort: "medium",
          sandboxBackend: "none",
          metadata: {},
          initiator: { kind: "subject", subjectId: fixture.subjectId },
          claudeProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
        }),
      );

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
          ${connectionId}::uuid, ${fixture.accountId}, 'claude', 'v1:personal-binding-capability',
          'personal', 'people', ${membership!.id}::uuid, ${fixture.subjectId}, ${authorityId}::uuid,
          'subscription_connection', 1
        )`;
      const [eligibility] = await shared!.admin<
        {
          workspace_matches: boolean;
          owner_matches: boolean;
          owner_active: boolean;
          authority_matches: boolean;
          personal_enabled: boolean;
        }[]
      >`
        select session.workspace_id = ${workspaceId}::uuid as workspace_matches,
          session.owner_subject_id = ${fixture.subjectId} as owner_matches,
          membership.status = 'active' and membership.revoked_at is null as owner_active,
          authority.resource_id = connection.id
            and authority.organization_membership_id = membership.id
            and authority.generation = connection.authority_generation
            and authority.status = 'active' and authority.revoked_at is null as authority_matches,
          (subscription_effective_settings(${fixture.accountId}::uuid, ${workspaceId}::uuid)
            #>> '{values,personalConnectionsAllowed}')::boolean as personal_enabled
        from sessions session
        join organization_memberships membership on membership.account_id = session.account_id
          and membership.id = ${membership!.id}::uuid
        join subscription_connections connection on connection.id = ${connectionId}::uuid
        join organization_user_resource_authorities authority on authority.id = connection.authority_id
        where session.id = ${session.id}::uuid`;
      expect(eligibility).toEqual({
        workspace_matches: true,
        owner_matches: true,
        owner_active: true,
        authority_matches: true,
        personal_enabled: true,
      });

      let leaseError: unknown;
      await withSessionRlsActorContext(
        {
          subjectId: fixture.subjectId,
          initiatingHumanSubjectId: fixture.subjectId,
        },
        () =>
          withRlsContext(client!.db, { accountId: fixture.accountId, workspaceId }, async (db) => {
            await rawRows(
              db,
              sql`insert into subscription_session_bindings (
                  account_id, workspace_id, session_id, provider, connection_id, model_id, choice
                ) values (
                  ${fixture.accountId}::uuid, ${workspaceId}::uuid, ${session.id}::uuid,
                  'claude', ${connectionId}::uuid, 'fixture-model', 'explicit'
                )`,
            );
            try {
              await db.transaction((nested) =>
                rawRows(
                  nested as unknown as typeof db,
                  sql`insert into subscription_leases (
                      account_id, workspace_id, session_id, turn_id, connection_id, provider,
                      holder_id, generation, leased_until
                    ) values (
                      ${fixture.accountId}::uuid, ${workspaceId}::uuid, ${session.id}::uuid,
                      ${turn.id}::uuid, ${connectionId}::uuid, 'claude', 'test-holder', 1,
                      now() + interval '1 minute'
                    )`,
                ),
              );
            } catch (error) {
              leaseError = error;
            }
          }),
      );
      const leaseCode =
        (leaseError as { code?: string; cause?: { code?: string } } | undefined)?.code ??
        (leaseError as { cause?: { code?: string } } | undefined)?.cause?.code;
      expect(leaseCode).toBe("42501");

      const authorizedTurn = await withSessionRlsActorContext(
        { subjectId: fixture.subjectId },
        () =>
          enqueueSessionTurn(client!.db, {
            accountId: fixture.accountId,
            workspaceId,
            sessionId: session.id,
            triggerEventId: crypto.randomUUID(),
            temporalWorkflowId: `subscription-disabled-personal-${session.id}`,
            source: "user",
            prompt: "disabled personal connection fixture",
            resources: [],
            tools: [],
            model: "fixture-model",
            reasoningEffort: "medium",
            sandboxBackend: "none",
            metadata: {},
            initiator: { kind: "subject", subjectId: fixture.subjectId },
            claudeProviderAccountAuthoritySnapshot: {
              version: 1,
              scope: "user",
              authorityGeneration: 1,
            },
          }),
      );
      await shared!.admin`
        update subscription_settings set personal_connections_allowed = false
        where account_id = ${fixture.accountId} and workspace_id is null`;
      let disabledLeaseError: unknown;
      await withSessionRlsActorContext(
        {
          subjectId: fixture.subjectId,
          initiatingHumanSubjectId: fixture.subjectId,
        },
        () =>
          withRlsContext(client!.db, { accountId: fixture.accountId, workspaceId }, async (db) => {
            try {
              await db.transaction((nested) =>
                rawRows(
                  nested as unknown as typeof db,
                  sql`insert into subscription_leases (
                    account_id, workspace_id, session_id, turn_id, connection_id, provider,
                    holder_id, generation, leased_until
                  ) values (
                    ${fixture.accountId}::uuid, ${workspaceId}::uuid, ${session.id}::uuid,
                    ${authorizedTurn.id}::uuid, ${connectionId}::uuid, 'claude', 'disabled-holder', 1,
                    now() + interval '1 minute'
                  )`,
                ),
              );
            } catch (error) {
              disabledLeaseError = error;
            }
          }),
      );
      const disabledLeaseCode =
        (disabledLeaseError as { code?: string; cause?: { code?: string } } | undefined)?.code ??
        (disabledLeaseError as { cause?: { code?: string } } | undefined)?.cause?.code;
      expect(disabledLeaseCode).toBe("42501");
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "restricted application role cannot read another organization's connection",
    async () => {
      const first = await organizationFixture();
      const second = await organizationFixture();
      const [connection] = await shared!.admin<{ id: string }[]>`
      insert into subscription_connections (account_id, provider, credential_encrypted, scope_kind)
      values (${first.accountId}, 'xai', 'v1:test', 'organization') returning id::text as id`;
      const visibleFromOtherOrganization = await withSessionRlsActorContext(
        { subjectId: second.subjectId },
        () =>
          withRlsContext(client!.db, { accountId: second.accountId }, async (db) => {
            const rows = await rawRows<{ id: string }>(
              db,
              sql`select id::text as id from subscription_connections where id = ${connection!.id}::uuid`,
            );
            return rows;
          }),
      );
      expect(visibleFromOtherOrganization).toEqual([]);
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "SECURITY DEFINER membership checks ignore temporary-table shadows",
    async () => {
      const fixture = await organizationFixture();
      const subjectId = `user:subscription-nonadmin-${crypto.randomUUID()}`;
      const [personalWorkspace] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${fixture.accountId}, 'Subscription non-admin Personal')
      returning id::text as id`;
      await shared!.admin`
      insert into organization_memberships (
        account_id, subject_id, role, status, personal_workspace_id
      ) values (
        ${fixture.accountId}, ${subjectId}, 'member', 'active', ${personalWorkspace!.id}::uuid
      )`;
      const isAdmin = await withSessionRlsActorContext({ subjectId }, () =>
        withRlsContext(client!.db, { accountId: fixture.accountId }, async (db) => {
          await rawRows(
            db,
            sql`create temporary table organization_memberships (
          account_id uuid, subject_id text, status text, revoked_at timestamptz, role text
        ) ON COMMIT DROP`,
          );
          await rawRows(
            db,
            sql`insert into organization_memberships
          values (${fixture.accountId}::uuid, ${subjectId}, 'active', null, 'admin')`,
          );
          const [row] = await rawRows<{ allowed: boolean }>(
            db,
            sql`select opengeni_private.subscription_organization_admin(${fixture.accountId}::uuid) as allowed`,
          );
          return row?.allowed ?? false;
        }),
      );
      expect(isAdmin).toBe(false);
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "SUB-OWN-04 and SUB-APPS-01: delegated managers cannot widen model scope and can clear out-of-scope Apps designations",
    async () => {
      const fixture = await organizationFixture();
      const managerSubject = `user:subscription-manager-${crypto.randomUUID()}`;
      const [personalWorkspace] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${fixture.accountId}, 'Subscription manager Personal')
      returning id::text as id`;
      await shared!.admin`
      insert into organization_memberships (
        account_id, subject_id, role, status, personal_workspace_id
      ) values (
        ${fixture.accountId}, ${managerSubject}, 'member', 'active', ${personalWorkspace!.id}::uuid
      )`;
      await shared!.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${fixture.accountId}, ${fixture.workspaceId}, ${managerSubject}, 'admin')`;
      const [connection] = await shared!.admin<{ id: string }[]>`
      insert into subscription_connections (
        account_id, provider, credential_encrypted, scope_kind, managed_by_workspace_id,
        allowed_model_ids
      ) values (
        ${fixture.accountId}, 'codex', 'v1:delegated', 'workspaces',
        ${fixture.workspaceId}::uuid, ARRAY['model-a']::text[]
      ) returning id::text as id`;
      await shared!.admin`
      insert into subscription_connection_workspaces (account_id, connection_id, workspace_id)
      values (${fixture.accountId}, ${connection!.id}::uuid, ${fixture.workspaceId}::uuid)`;
      let error: unknown;
      try {
        await withSessionRlsActorContext({ subjectId: managerSubject }, () =>
          withRlsContext(
            client!.db,
            {
              accountId: fixture.accountId,
              workspaceId: fixture.workspaceId,
            },
            (db) =>
              rawRows(
                db,
                sql`update subscription_connections
          set allowed_model_ids = ARRAY['model-b']::text[]
          where id = ${connection!.id}::uuid`,
              ),
          ),
        );
      } catch (caught) {
        error = caught;
      }
      const pgCode =
        (error as { code?: string; cause?: { code?: string } } | undefined)?.code ??
        (error as { cause?: { code?: string } } | undefined)?.cause?.code;
      expect(pgCode).toBe("42501");

      await shared!.admin`
        insert into subscription_apps_designations (account_id, workspace_id, connection_id, updated_by_subject_id)
        values (${fixture.accountId}, ${fixture.workspaceId}::uuid, ${connection!.id}::uuid, ${managerSubject})`;
      await shared!.admin`
        delete from subscription_connection_workspaces
        where account_id = ${fixture.accountId} and connection_id = ${connection!.id}::uuid
          and workspace_id = ${fixture.workspaceId}::uuid`;
      await withSessionRlsActorContext({ subjectId: managerSubject }, () =>
        withRlsContext(
          client!.db,
          { accountId: fixture.accountId, workspaceId: fixture.workspaceId },
          (db) =>
            rawRows(
              db,
              sql`delete from subscription_apps_designations
                where account_id = ${fixture.accountId}::uuid
                  and workspace_id = ${fixture.workspaceId}::uuid`,
            ),
        ),
      );
      const [designationCount] = await shared!.admin<{ count: number }[]>`
        select count(*)::int as count from subscription_apps_designations
        where workspace_id = ${fixture.workspaceId}::uuid`;
      expect(designationCount?.count).toBe(0);
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "people scope requires the exact live session owner and does not widen private-session visibility",
    async () => {
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
      await withSessionRlsActorContext({ subjectId: fixture.subjectId }, () =>
        withRlsContext(client!.db, { accountId: fixture.accountId, workspaceId }, (db) =>
          rawRows(
            db,
            sql`insert into subscription_apps_designations (
                account_id, workspace_id, connection_id, updated_by_subject_id
              ) values (
                ${fixture.accountId}::uuid, ${workspaceId}::uuid,
                ${connection!.id}::uuid, ${fixture.subjectId}
              )`,
          ),
        ),
      );
      const [designation] = await shared!.admin<{ connection_id: string }[]>`
      select connection_id::text as connection_id from subscription_apps_designations
      where workspace_id = ${workspaceId}::uuid`;
      expect(designation?.connection_id).toBe(connection!.id);
      await withSessionRlsActorContext(
        {
          subjectId: "service:subscription-test",
          initiatingHumanSubjectId: fixture.subjectId,
        },
        () =>
          withRlsContext(client!.db, { accountId: fixture.accountId, workspaceId }, (db) =>
            rawRows(
              db,
              sql`insert into subscription_session_bindings (
                  account_id, workspace_id, session_id, provider, connection_id, model_id, choice
                ) values (
                  ${fixture.accountId}::uuid, ${workspaceId}::uuid, ${session.id}::uuid,
                  'codex', ${connection!.id}::uuid, 'fixture-model', 'explicit'
                )`,
            ),
          ),
      );
      await shared!.admin`
      insert into subscription_person_preferences (
        account_id, organization_membership_id, personal_fallback_opt_in
      ) values (${fixture.accountId}, ${membership!.id}::uuid, false)`;

      const inspectAs = (initiatingHumanSubjectId: string, sessionOwnerSubjectId: string) =>
        withSessionRlsActorContext(
          { subjectId: "service:subscription-test", initiatingHumanSubjectId },
          () =>
            withRlsContext(
              client!.db,
              { accountId: fixture.accountId, workspaceId },
              async (db) => {
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
                const preferences = await rawRows<{ personal_fallback_opt_in: boolean }>(
                  db,
                  sql`select personal_fallback_opt_in from subscription_person_preferences
                    where account_id = ${fixture.accountId}::uuid
                      and organization_membership_id = ${membership!.id}::uuid`,
                );
                return { allowed: authorization?.allowed ?? false, visible, preferences };
              },
            ),
        );

      expect(await inspectAs(fixture.subjectId, fixture.subjectId)).toEqual({
        allowed: true,
        visible: [{ id: connection!.id }],
        preferences: [{ personal_fallback_opt_in: false }],
      });
      expect(await inspectAs(fixture.subjectId, "user:another-person")).toEqual({
        allowed: false,
        visible: [],
        preferences: [],
      });
      expect(await inspectAs("user:private-session-outsider", fixture.subjectId)).toEqual({
        allowed: false,
        visible: [],
        preferences: [],
      });

      const otherSession = await withSessionRlsActorContext({ subjectId: fixture.subjectId }, () =>
        createSession(client!.db, {
          accountId: fixture.accountId,
          workspaceId,
          initialMessage: "mismatched subscription turn fixture",
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
      const otherTurn = await withSessionRlsActorContext({ subjectId: fixture.subjectId }, () =>
        enqueueSessionTurn(client!.db, {
          accountId: fixture.accountId,
          workspaceId,
          sessionId: otherSession.id,
          triggerEventId: crypto.randomUUID(),
          temporalWorkflowId: `subscription-core-mismatch-${otherSession.id}`,
          source: "user",
          prompt: "mismatched subscription turn fixture",
          resources: [],
          tools: [],
          model: "fixture-model",
          reasoningEffort: "medium",
          sandboxBackend: "none",
          metadata: {},
          initiator: { kind: "subject", subjectId: fixture.subjectId },
        }),
      );
      let mismatchedTurnError: unknown;
      try {
        await shared!.admin`
        insert into subscription_leases (
          account_id, workspace_id, session_id, turn_id, connection_id, provider,
          holder_id, generation, leased_until
        ) values (
          ${fixture.accountId}, ${workspaceId}::uuid, ${session.id}::uuid,
          ${otherTurn.id}::uuid, ${connection!.id}::uuid, 'xai', 'test-holder', 1, now() + interval '1 minute'
        )`;
      } catch (error) {
        mismatchedTurnError = error;
      }
      expect((mismatchedTurnError as { code?: string } | undefined)?.code).toBe("42501");

      const serviceTurn = await withSessionRlsActorContext(
        { subjectId: "service:subscription-core", initiatingHumanSubjectId: fixture.subjectId },
        () =>
          enqueueSessionTurn(client!.db, {
            accountId: fixture.accountId,
            workspaceId,
            sessionId: session.id,
            triggerEventId: crypto.randomUUID(),
            temporalWorkflowId: `subscription-service-turn-${session.id}`,
            source: "user",
            prompt: "subscription service pool fixture",
            resources: [],
            tools: [],
            model: "fixture-model",
            reasoningEffort: "medium",
            sandboxBackend: "none",
            metadata: {},
            initiator: { kind: "service", subjectId: "service:subscription-core" },
          }),
      );
      await withSessionRlsActorContext(
        { subjectId: "service:subscription-core", initiatingHumanSubjectId: fixture.subjectId },
        () =>
          withRlsContext(client!.db, { accountId: fixture.accountId, workspaceId }, (db) =>
            rawRows(
              db,
              sql`insert into subscription_leases (
                  account_id, workspace_id, session_id, turn_id, connection_id, provider,
                  holder_id, generation, leased_until
                ) values (
                  ${fixture.accountId}::uuid, ${workspaceId}::uuid, ${session.id}::uuid,
                  ${serviceTurn.id}::uuid, ${connection!.id}::uuid, 'codex', 'service-holder', 1,
                  now() + interval '1 minute'
                )`,
            ),
          ),
      );
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "membership offboarding revokes SUB-OWN-04 generic personal connection authority",
    async () => {
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
      await verifySubscriptionLifecycleRlsAsNonBypassOwner(connectionId);
      const legacyClaudeId = crypto.randomUUID();
      const legacyClaudeAuthorityId = crypto.randomUUID();
      await shared!.admin`
      insert into organization_user_resource_authorities (
        id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
      ) values (
        ${legacyClaudeAuthorityId}::uuid, ${fixture.accountId}, ${membership!.id}::uuid,
        'claude_subscription', ${legacyClaudeId}::uuid, 1, 'active'
      )`;
      await shared!.admin`
      insert into claude_subscription_credentials (
        id, account_id, workspace_id, credential_encrypted, status,
        authority_scope, owner_organization_membership_id,
        organization_user_resource_authority_id, organization_user_resource_kind,
        organization_user_resource_authority_generation
      ) values (
        ${legacyClaudeId}::uuid, ${fixture.accountId}, ${personalWorkspace!.id}::uuid,
        'v1:legacy-claude', 'active', 'user', ${membership!.id}::uuid,
        ${legacyClaudeAuthorityId}::uuid, 'claude_subscription', 1
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
      await shared!.admin`
      update organization_memberships
      set personal_retention_until = now() - interval '1 day'
      where id = ${membership!.id}::uuid`;
      const retentionOperationId = crypto.randomUUID();
      await shared!.admin`
      insert into organization_user_retention_deletions (
        account_id, membership_id, retention_until, state,
        claim_operation_id, claim_expires_at
      ) select account_id, id, personal_retention_until, 'claimed',
        ${retentionOperationId}::uuid, now() + interval '15 minutes'
        from organization_memberships where id = ${membership!.id}::uuid`;
      const [finalized] = await withSessionRlsActorContext({ subjectId: fixture.subjectId }, () =>
        withRlsContext(client!.db, { accountId: fixture.accountId }, (db) =>
          rawRows<{ subscriptions: string; claude: string }>(
            db,
            sql`with finalized as (
            select finalize_organization_retention_deletion(
              ${fixture.accountId}::uuid, ${membership!.id}::uuid,
              ${retentionOperationId}::uuid, 'subscription-core-test-bucket'
            ) as result
          ) select result->'deletedResources'->>'subscriptionConnections' as subscriptions,
            result->'deletedResources'->>'claudeSubscriptions' as claude from finalized`,
          ),
        ),
      );
      expect(finalized).toEqual({ subscriptions: "1", claude: "1" });
      const [remaining] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from subscription_connections where id = ${connectionId}::uuid`;
      expect(remaining?.count).toBe(0);
      const [revokedAuthority] = await shared!.admin<{ status: string }[]>`
      select status from organization_user_resource_authorities where id = ${authorityId}::uuid`;
      expect(revokedAuthority?.status).toBe("revoked");
    },
    180_000,
  );
});
