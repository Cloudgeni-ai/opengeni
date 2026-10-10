import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { decidePlacement } from "@opengeni/subscriptions";
import { sql } from "drizzle-orm";
import {
  acquireSubscriptionTurnLease,
  acquireSubscriptionOperationLease,
  assertSubscriptionTurnLeaseCurrent,
  assertSubscriptionOperationLeaseCurrent,
  claimSubscriptionCapacityWakeDeliveries,
  createDb,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  listSubscriptionConnectionAssignmentPolicies,
  listSubscriptionConnectionsForPlacement,
  isSubscriptionProviderCutoverEnabled,
  readSubscriptionProviderCutoverState,
  markSubscriptionCapacityWakeDelivered,
  observeSubscriptionCapacityWaiterWake,
  persistSubscriptionCodexRefresh,
  readSubscriptionSessionBinding,
  writeSubscriptionSessionBinding,
  releaseSubscriptionOperationLease,
  releaseSubscriptionTurnLease,
  renewSubscriptionOperationLease,
  renewSubscriptionTurnLease,
  withSubscriptionCorePlacementWorld,
  withSubscriptionCoreCodexRefreshLock,
  upsertSubscriptionCapacityWaiter,
  wakeSubscriptionCapacityWaiter,
  withRlsContext,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { rawRows } from "../src/database";
import { withPoolWakeServiceScopeInTransaction } from "../src/subscription-session-access";

setDefaultTimeout(180_000);
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const dbPackageRoot = resolve(import.meta.dir, "..");

function sourcePrivateFunctionReferences(): string[] {
  const references = new Set<string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (/\.[cm]?tsx?$/.test(entry.name)) {
        const source = readFileSync(path, "utf8");
        for (const match of source.matchAll(/opengeni_private\.([a-z_][a-z0-9_]*)\s*\(/gi)) {
          references.add(match[1]!.toLowerCase());
        }
      }
    }
  };
  visit(join(dbPackageRoot, "src"));
  return [...references].sort();
}

beforeAll(async () => {
  if (process.env.OPENGENI_REQUIRE_REAL_DB !== "1") return;
  shared = await acquireSharedTestDatabase("subscription-core-runtime-v4");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

/**
 * Fixture only: make an accepted turn's attempt live for a turn-bound
 * (image) operation lease, which since M3 PR 2c must belong to the turn's
 * running attempt and execution generation with a live chat-turn lease on
 * the same connection.
 */
async function liveTurnAttempt(input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  connectionId: string;
  attemptId: string;
  generation: number;
}): Promise<void> {
  await shared!.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update session_turns set status = 'running', active_attempt_id = ${input.attemptId}::uuid,
        execution_generation = ${input.generation}
      where account_id = ${input.accountId}::uuid and id = ${input.turnId}::uuid`;
    await tx`delete from subscription_leases
      where account_id = ${input.accountId}::uuid and turn_id = ${input.turnId}::uuid`;
    await tx`insert into subscription_leases (
        account_id, workspace_id, session_id, turn_id, provider, connection_id,
        holder_id, generation, leased_until
      ) values (
        ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.sessionId}::uuid,
        ${input.turnId}::uuid, 'codex', ${input.connectionId}::uuid,
        ${`chat-${input.attemptId}`}, ${input.generation}, clock_timestamp() + interval '5 minutes'
      )`;
  });
}

async function fixture(connectionKind: "subscription" | "api_key" = "subscription") {
  const userId = `subscription-runtime-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Subscription runtime fixture",
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
  const workspaceId = access.workspaceGrants[0]!.workspaceId!;
  const subjectId = `user:${userId}`;
  const [connection] = await shared!.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind
    ) values (
      ${accountId}::uuid, 'codex', ${connectionKind}, 'v1:test', 'shared', 'organization'
    )
    returning id::text as id`;
  const session = await withSessionRlsActorContext({ subjectId }, () =>
    createSession(client!.db, {
      accountId,
      workspaceId,
      initialMessage: "subscription runtime operation fixture",
      resources: [],
      metadata: {},
      model: "fixture-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId },
      createdByContext: {},
    }),
  );
  const turn = await withSessionRlsActorContext({ subjectId }, () =>
    enqueueSessionTurn(client!.db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `subscription-runtime-${session.id}`,
      source: "user",
      prompt: "subscription runtime operation fixture",
      resources: [],
      tools: [],
      model: "fixture-model",
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator: { kind: "subject", subjectId },
    }),
  );
  return {
    accountId,
    workspaceId,
    subjectId,
    connectionId: connection!.id,
    sessionId: session.id,
    turnId: turn.id,
  };
}

/**
 * Run work with the refresh seam (the provider-named routines and their
 * provider-neutral equivalents from migration 0707) owned by a NOSUPERUSER,
 * NOBYPASSRLS role, as in production. The shared test database's objects are
 * owned by a superuser, which ignores FORCE RLS and would hide a missing
 * refresh policy.
 */
const REFRESH_SEAM_ROUTINES = [
  "opengeni_private.subscription_codex_refresh_write_allowed(uuid,uuid,uuid)",
  "opengeni_private.begin_subscription_codex_refresh(uuid,uuid,uuid,uuid,text,text,uuid,text,bigint)",
  "opengeni_private.persist_subscription_codex_refresh(uuid,uuid,uuid,uuid,uuid,bigint,text,timestamptz,timestamptz)",
  "opengeni_private.subscription_core_refresh_write_allowed(text,uuid,uuid,uuid)",
  "opengeni_private.begin_subscription_core_refresh(text,uuid,uuid,uuid,uuid,text,text,uuid,text,bigint)",
  "opengeni_private.persist_subscription_core_refresh(text,uuid,uuid,uuid,uuid,uuid,bigint,text,timestamptz,timestamptz)",
] as const;

async function withNonSuperuserRefreshOwners<T>(work: () => Promise<T>): Promise<T> {
  const probeRole = `subscription_refresh_owner_${crypto.randomUUID().replaceAll("-", "_")}`;
  const [originalOwners] = await shared!.admin<
    { connectionOwner: string; capabilityOwner: string; routineOwners: string[] }[]
  >`
    select pg_get_userbyid(connection.relowner) as "connectionOwner",
      pg_get_userbyid(capability.relowner) as "capabilityOwner",
      array(select pg_get_userbyid(routine.proowner)
        from unnest(${REFRESH_SEAM_ROUTINES as unknown as string[]}::text[])
          with ordinality as signature(name, position)
        join pg_proc routine on routine.oid = pg_catalog.to_regprocedure(signature.name)
        order by signature.position) as "routineOwners"
    from pg_class connection
    join pg_namespace connection_schema on connection_schema.oid = connection.relnamespace
      and connection_schema.nspname = current_schema()
    join pg_class capability on capability.oid =
      'opengeni_private.subscription_runtime_capabilities'::regclass
    where connection.relname = 'subscription_connections'`;
  if (originalOwners?.routineOwners.length !== REFRESH_SEAM_ROUTINES.length) {
    throw new Error("Refresh seam objects are missing");
  }
  try {
    await shared!.admin.unsafe(`
      create role ${probeRole} nosuperuser nobypassrls nologin;
      grant create, usage on schema public, opengeni_private to ${probeRole};
      grant all privileges on all tables in schema public, opengeni_private to ${probeRole};
      grant all privileges on all sequences in schema public, opengeni_private to ${probeRole};
      grant execute on all functions in schema public, opengeni_private to ${probeRole};
      alter table subscription_connections owner to ${probeRole};
      alter table opengeni_private.subscription_runtime_capabilities owner to ${probeRole};
      ${REFRESH_SEAM_ROUTINES.map((routine) => `alter function ${routine} owner to ${probeRole};`).join("\n")}
    `);
    const [owner] = await shared!.admin<{ superuser: boolean; bypassrls: boolean }[]>`
      select rolsuper as superuser, rolbypassrls as bypassrls from pg_roles
      where rolname = ${probeRole}`;
    expect(owner).toEqual({ superuser: false, bypassrls: false });
    return await work();
  } finally {
    await shared!.admin.unsafe(`
      ${REFRESH_SEAM_ROUTINES.map(
        (routine, index) =>
          `alter function ${routine} owner to ${originalOwners.routineOwners[index]};`,
      ).join("\n")}
      alter table opengeni_private.subscription_runtime_capabilities
        owner to ${originalOwners.capabilityOwner};
      alter table subscription_connections owner to ${originalOwners.connectionOwner};
      drop owned by ${probeRole};
      drop role if exists ${probeRole};
    `);
  }
}

async function ownerlessFixture(
  accountId: string,
  workspaceId: string,
  initiatingHumanSubjectId: string | null = null,
) {
  const sessionId = crypto.randomUUID();
  const session = await createSession(client!.db, {
    requestedSessionId: sessionId,
    accountId,
    workspaceId,
    initialMessage: "ownerless subscription authorization fixture",
    resources: [],
    metadata: {},
    model: "fixture-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const actor = {
    subjectId: "service:subscription-core",
    initiatingHumanSubjectId,
  };
  const turn = await withSessionRlsActorContext(actor, () =>
    enqueueSessionTurn(client!.db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `ownerless-subscription-${session.id}`,
      source: "user",
      prompt: "ownerless subscription authorization fixture",
      resources: [],
      tools: [],
      model: "fixture-model",
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator: initiatingHumanSubjectId
        ? { kind: "subject", subjectId: initiatingHumanSubjectId }
        : { kind: "service", subjectId: "service:subscription-core" },
    }),
  );
  return { sessionId: session.id, turnId: turn.id };
}

describe("provider-neutral subscription runtime persistence", () => {
  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "real PostgreSQL runtime tests use the non-superuser, non-bypass application role",
    async () => {
      const [role] = await rawRows<{
        currentUser: string;
        superuser: boolean;
        bypassRls: boolean;
      }>(
        client!.db,
        sql`select current_user as "currentUser", rolsuper as superuser,
            rolbypassrls as "bypassRls"
          from pg_catalog.pg_roles where rolname = current_user`,
      );
      expect(role).toEqual({
        currentUser: "opengeni_app",
        superuser: false,
        bypassRls: false,
      });
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "accepted v2 authority is immutable to the application role but writable by the table owner",
    async () => {
      const state = await fixture();
      const authority = {
        version: 2,
        personal: [],
      };

      // The table owner is the migration/backfill authority for the later
      // drained cutover and can populate the nullable precursor column.
      await shared!.admin`
        update session_turns
        set subscription_authority = ${shared!.admin.json(authority)}::jsonb
        where account_id = ${state.accountId}::uuid and id = ${state.turnId}::uuid`;

      const context = () =>
        withSessionRlsActorContext({ subjectId: state.subjectId }, () =>
          withRlsContext(
            client!.db,
            { accountId: state.accountId, workspaceId: state.workspaceId },
            async (db) => {
              const visible = await rawRows<{ id: string }>(
                db,
                sql`select id::text as id from session_turns
                  where account_id = ${state.accountId}::uuid and id = ${state.turnId}::uuid`,
              );
              expect(visible).toHaveLength(1);
              return db.execute(sql`
                update session_turns set subscription_authority = null
                where account_id = ${state.accountId}::uuid and id = ${state.turnId}::uuid
                returning id
              `);
            },
          ),
        );

      let mutationError: unknown;
      try {
        await context();
      } catch (error) {
        mutationError = error;
      }
      expect(mutationError).toBeDefined();
      const errorText =
        mutationError instanceof Error
          ? `${mutationError.message} ${String(mutationError.cause ?? "")}`
          : String(mutationError);
      expect(errorText).toContain("session turn subscription authority is immutable");

      const [persisted] = await shared!.admin<{ authority: unknown }[]>`
        select subscription_authority as authority from session_turns
        where account_id = ${state.accountId}::uuid and id = ${state.turnId}::uuid`;
      expect(persisted?.authority).toEqual(authority);
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "every private PostgreSQL function referenced by DB source exists after migrations",
    async () => {
      const references = sourcePrivateFunctionReferences();
      expect(references.length).toBeGreaterThan(0);
      const procedures = await shared!.admin<{ name: string }[]>`
        select distinct procedure.proname as name
        from pg_catalog.pg_proc procedure
        join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
        where namespace.nspname = 'opengeni_private'
          and procedure.proname = any(${references}::text[])`;
      const available = new Set(procedures.map((procedure) => procedure.name));
      expect(references.filter((name) => !available.has(name))).toEqual([]);
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "ownerless accepted turns authorize only shared organization/workspace connections",
    async () => {
      const state = await fixture();
      const actor = {
        subjectId: "service:subscription-core",
        initiatingHumanSubjectId: null,
      };
      const [workspaceConnection] = await shared!.admin<{ id: string }[]>`
        insert into subscription_connections (
          account_id, provider, credential_encrypted, ownership, scope_kind
        ) values (
          ${state.accountId}::uuid, 'codex', 'v1:ownerless-workspace', 'shared', 'workspaces'
        ) returning id::text as id`;
      await shared!.admin`
        insert into subscription_connection_workspaces (account_id, connection_id, workspace_id)
        values (
          ${state.accountId}::uuid, ${workspaceConnection!.id}::uuid, ${state.workspaceId}::uuid
        )`;
      const ownerless = await ownerlessFixture(state.accountId, state.workspaceId);
      const leaseResult = await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          async (db) => {
            const lease = await acquireSubscriptionTurnLease(db, {
              accountId: state.accountId,
              workspaceId: state.workspaceId,
              sessionId: ownerless.sessionId,
              turnId: ownerless.turnId,
              provider: "codex",
              connectionId: workspaceConnection!.id,
              holderId: `ownerless-${crypto.randomUUID()}`,
              generation: 1,
              ttlMs: 60_000,
            });
            const [context] = await db.execute(sql`
              select current_setting('opengeni.session_owner_subject_id', true) as owner_subject_id,
                current_setting('opengeni.turn_human_subject_id', true) as turn_human_subject_id`);
            return { lease, context };
          },
        ),
      );
      expect(leaseResult.lease).toMatchObject({ turnId: ownerless.turnId, generation: 1 });
      expect(leaseResult.context).toMatchObject({
        owner_subject_id: "",
        turn_human_subject_id: "",
      });
      const ownerlessAttempt = crypto.randomUUID();
      await liveTurnAttempt({
        accountId: state.accountId,
        workspaceId: state.workspaceId,
        sessionId: ownerless.sessionId,
        turnId: ownerless.turnId,
        connectionId: workspaceConnection!.id,
        attemptId: ownerlessAttempt,
        generation: 1,
      });
      const operationLease = await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          (db) =>
            acquireSubscriptionOperationLease(db, {
              accountId: state.accountId,
              workspaceId: state.workspaceId,
              operationId: crypto.randomUUID(),
              attemptId: ownerlessAttempt,
              operationKind: "image",
              sessionId: ownerless.sessionId,
              turnId: ownerless.turnId,
              provider: "codex",
              connectionId: workspaceConnection!.id,
              holderId: `ownerless-operation-${crypto.randomUUID()}`,
              generation: 1,
              ttlMs: 60_000,
            }),
        ),
      );
      expect(operationLease?.turnId).toBe(ownerless.turnId);
      await expect(
        withSessionRlsActorContext(actor, () =>
          withRlsContext(
            client!.db,
            { accountId: state.accountId, workspaceId: state.workspaceId },
            (db) =>
              writeSubscriptionSessionBinding(db, {
                accountId: state.accountId,
                workspaceId: state.workspaceId,
                sessionId: ownerless.sessionId,
                provider: "codex",
                connectionId: workspaceConnection!.id,
                modelId: "fixture-model",
                choice: "automatic",
                onlyThisModel: false,
                lastModelCallAt: null,
                lastSwitchReason: null,
              }),
          ),
        ),
      ).rejects.toThrow();

      const ownerlessHumanTurn = await ownerlessFixture(
        state.accountId,
        state.workspaceId,
        state.subjectId,
      );
      const authorizationChecks = await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          async (db) => {
            const authorize = async (
              accountId: string,
              workspaceId: string,
              sessionId: string,
              turnId: string,
            ) => {
              const [row] = await db.execute(sql`
                select opengeni_private.authorize_subscription_ownerless_session_access(
                  ${accountId}::uuid, ${workspaceId}::uuid, ${sessionId}::uuid, ${turnId}::uuid
                ) as authorized`);
              return row?.authorized === true;
            };
            return {
              wrongAccount: await authorize(
                crypto.randomUUID(),
                state.workspaceId,
                ownerless.sessionId,
                ownerless.turnId,
              ),
              wrongWorkspace: await authorize(
                state.accountId,
                crypto.randomUUID(),
                ownerless.sessionId,
                ownerless.turnId,
              ),
              wrongTurn: await authorize(
                state.accountId,
                state.workspaceId,
                ownerless.sessionId,
                crypto.randomUUID(),
              ),
              humanTurn: await authorize(
                state.accountId,
                state.workspaceId,
                ownerlessHumanTurn.sessionId,
                ownerlessHumanTurn.turnId,
              ),
              ownedSession: await authorize(
                state.accountId,
                state.workspaceId,
                state.sessionId,
                state.turnId,
              ),
            };
          },
        ),
      );
      expect(authorizationChecks).toEqual({
        wrongAccount: false,
        wrongWorkspace: false,
        wrongTurn: false,
        // An ownerless session stays shared-only when a person starts the
        // turn; the grant records no person and carries no personal access.
        humanTurn: true,
        ownedSession: false,
      });

      await expect(
        createSession(client!.db, {
          accountId: state.accountId,
          workspaceId: state.workspaceId,
          visibility: "user_private",
          initialMessage: "invalid ownerless private session",
          resources: [],
          metadata: {},
          model: "fixture-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
        }),
      ).rejects.toThrow();

      const [membership] = await shared!.admin<{ id: string }[]>`
        select id::text as id from organization_memberships
        where account_id = ${state.accountId}::uuid and subject_id = ${state.subjectId}
          and status = 'active' and revoked_at is null limit 1`;
      const [peopleConnection] = await shared!.admin<{ id: string }[]>`
        insert into subscription_connections (
          account_id, provider, credential_encrypted, ownership, scope_kind
        ) values (
          ${state.accountId}::uuid, 'codex', 'v1:ownerless-people', 'shared', 'people'
        ) returning id::text as id`;
      await shared!.admin`
        insert into subscription_connection_people (account_id, connection_id, organization_membership_id)
        values (${state.accountId}::uuid, ${peopleConnection!.id}::uuid, ${membership!.id}::uuid)`;
      const personalConnectionId = crypto.randomUUID();
      const authorityId = crypto.randomUUID();
      await shared!.admin`
        insert into organization_user_resource_authorities (
          id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
        ) values (
          ${authorityId}::uuid, ${state.accountId}::uuid, ${membership!.id}::uuid,
          'subscription_connection', ${personalConnectionId}::uuid, 1, 'active'
        )`;
      await shared!.admin`
        insert into subscription_connections (
          id, account_id, provider, credential_encrypted, ownership, scope_kind,
          owner_organization_membership_id, owner_subject_id, authority_id,
          authority_resource_kind, authority_generation
        ) values (
          ${personalConnectionId}::uuid, ${state.accountId}::uuid, 'codex', 'v1:ownerless-personal',
          'personal', 'people', ${membership!.id}::uuid, ${state.subjectId}, ${authorityId}::uuid,
          'subscription_connection', 1
        )`;

      for (const connectionId of [peopleConnection!.id, personalConnectionId]) {
        const deniedTurn = await ownerlessFixture(state.accountId, state.workspaceId);
        await expect(
          withSessionRlsActorContext(actor, () =>
            withRlsContext(
              client!.db,
              { accountId: state.accountId, workspaceId: state.workspaceId },
              (db) =>
                acquireSubscriptionTurnLease(db, {
                  accountId: state.accountId,
                  workspaceId: state.workspaceId,
                  sessionId: deniedTurn.sessionId,
                  turnId: deniedTurn.turnId,
                  provider: "codex",
                  connectionId,
                  holderId: `ownerless-deny-${crypto.randomUUID()}`,
                  generation: 1,
                  ttlMs: 60_000,
                }),
            ),
          ),
        ).rejects.toThrow();
        await expect(
          withSessionRlsActorContext(actor, () =>
            withRlsContext(
              client!.db,
              { accountId: state.accountId, workspaceId: state.workspaceId },
              (db) =>
                acquireSubscriptionOperationLease(db, {
                  accountId: state.accountId,
                  workspaceId: state.workspaceId,
                  operationId: crypto.randomUUID(),
                  attemptId: crypto.randomUUID(),
                  operationKind: "image",
                  sessionId: deniedTurn.sessionId,
                  turnId: deniedTurn.turnId,
                  provider: "codex",
                  connectionId,
                  holderId: `ownerless-operation-deny-${crypto.randomUUID()}`,
                  generation: 1,
                  ttlMs: 60_000,
                }),
            ),
          ),
        ).rejects.toThrow();
      }
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "placement world reads owner preferences without direct membership-table access",
    async () => {
      const state = await fixture();
      const [membership] = await shared!.admin<{ id: string }[]>`
        select id::text as id from organization_memberships
        where account_id = ${state.accountId}::uuid and subject_id = ${state.subjectId}
          and status = 'active' and revoked_at is null
        limit 1`;
      expect(membership?.id).toBeDefined();
      await shared!.admin`
        insert into subscription_settings (
          account_id, rotation, providers, cross_provider_failover, fallback_order,
          personal_connections_allowed, personal_fallback_allowed
        ) values (
          ${state.accountId}::uuid, ${shared!.admin.json({ codex: { mode: "spread" } })}::jsonb,
          '{}'::jsonb, false, ${shared!.admin.json({ "codex/a": ["codex/b"] })}::jsonb,
          true, true
        )`;
      await shared!.admin`
        insert into workspace_model_policies (account_id, workspace_id, allowed_providers, allowed_models)
        values (
          ${state.accountId}::uuid, ${state.workspaceId}::uuid,
          ARRAY['codex-subscription']::text[], ARRAY['codex/b']::text[]
        )`;
      await shared!.admin`
        insert into subscription_connection_assignment_policies (
          account_id, connection_id, workspace_id, inference_pool
        ) values (
          ${state.accountId}::uuid, ${state.connectionId}::uuid,
          ${state.workspaceId}::uuid, 'organization'
        )`;
      await shared!.admin`
        insert into subscription_person_preferences (
          account_id, organization_membership_id, personal_fallback_opt_in
        ) values (${state.accountId}::uuid, ${membership!.id}::uuid, true)`;

      const result = await withSubscriptionCorePlacementWorld(
        client!.db,
        {
          accountId: state.accountId,
          workspaceId: state.workspaceId,
          sessionId: state.sessionId,
          turnId: state.turnId,
          sessionOwnerSubjectId: state.subjectId,
          sessionOwnerMembershipId: membership!.id,
          initiatingHumanSubjectId: state.subjectId,
          acceptedAuthorityV2: { version: 2, personal: [] },
          preferredModelId: "codex/a",
          reasoningLevel: "medium",
          models: [
            { id: "codex/a", provider: "codex", reasoningLevels: ["medium"] },
            { id: "codex/b", provider: "codex", reasoningLevels: ["medium"] },
          ],
          reselectionPoints: [],
          now: new Date(),
        },
        async (_tx, input) => ({
          people: input.people,
          models: input.models,
          allowedModelIds: input.workspace.allowedModelIds,
          decision: decidePlacement(input),
        }),
      );

      expect(result.status).toBe("completed");
      if (result.status === "completed") {
        expect(result.value.people).toEqual([
          { membershipId: membership!.id, active: true, personalFallbackOptIn: true },
        ]);
        expect(result.value.models).toHaveLength(2);
        expect(result.value.allowedModelIds).toEqual(["codex/b"]);
        expect(result.value.decision).toMatchObject({ kind: "run", modelId: "codex/b" });
      }
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "personal placement authority is cutover-gated, exact-turn scoped, and generation-fenced",
    async () => {
      const state = await fixture();
      const [membership] = await shared!.admin<{ id: string; personal_workspace_id: string }[]>`
        select id::text as id, personal_workspace_id::text as personal_workspace_id
        from organization_memberships
        where account_id = ${state.accountId}::uuid and subject_id = ${state.subjectId}
          and status = 'active' and revoked_at is null limit 1`;
      expect(membership).toBeDefined();

      const personalSession = await withSessionRlsActorContext({ subjectId: state.subjectId }, () =>
        createSession(client!.db, {
          accountId: state.accountId,
          workspaceId: membership!.personal_workspace_id,
          initialMessage: "personal placement authority fixture",
          resources: [],
          metadata: {},
          model: "fixture-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          createdBy: { kind: "subject", subjectId: state.subjectId },
          createdByContext: {},
        }),
      );
      const personalTurn = await withSessionRlsActorContext({ subjectId: state.subjectId }, () =>
        enqueueSessionTurn(client!.db, {
          accountId: state.accountId,
          workspaceId: membership!.personal_workspace_id,
          sessionId: personalSession.id,
          triggerEventId: crypto.randomUUID(),
          temporalWorkflowId: `personal-subscription-${personalSession.id}`,
          source: "user",
          prompt: "personal placement authority fixture",
          resources: [],
          tools: [],
          model: "fixture-model",
          reasoningEffort: "medium",
          sandboxBackend: "none",
          metadata: {},
          initiator: { kind: "subject", subjectId: state.subjectId },
        }),
      );

      const connectionId = crypto.randomUUID();
      const authorityId = crypto.randomUUID();
      await shared!.admin`
        insert into organization_user_resource_authorities (
          id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
        ) values (
          ${authorityId}::uuid, ${state.accountId}::uuid, ${membership!.id}::uuid,
          'subscription_connection', ${connectionId}::uuid, 1, 'active'
        )`;
      await shared!.admin`
        insert into subscription_connections (
          id, account_id, provider, credential_encrypted, ownership, scope_kind,
          owner_organization_membership_id, owner_subject_id, authority_id,
          authority_resource_kind, authority_generation
        ) values (
          ${connectionId}::uuid, ${state.accountId}::uuid, 'codex', 'v1:personal-placement',
          'personal', 'people', ${membership!.id}::uuid, ${state.subjectId}, ${authorityId}::uuid,
          'subscription_connection', 1
        )`;
      // The owner's personal Claude connection shares the authority generation.
      // Codex placement must not rewrite or remove an earlier Claude capability.
      const claudeConnectionId = crypto.randomUUID();
      const claudeAuthorityId = crypto.randomUUID();
      await shared!.admin`
        insert into organization_user_resource_authorities (
          id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
        ) values (
          ${claudeAuthorityId}::uuid, ${state.accountId}::uuid, ${membership!.id}::uuid,
          'subscription_connection', ${claudeConnectionId}::uuid, 1, 'active'
        )`;
      await shared!.admin`
        insert into subscription_connections (
          id, account_id, provider, credential_encrypted, ownership, scope_kind,
          owner_organization_membership_id, owner_subject_id, authority_id,
          authority_resource_kind, authority_generation
        ) values (
          ${claudeConnectionId}::uuid, ${state.accountId}::uuid, 'claude', 'v1:personal-claude',
          'personal', 'people', ${membership!.id}::uuid, ${state.subjectId}, ${claudeAuthorityId}::uuid,
          'subscription_connection', 1
        )`;
      // Test-only probes that seed and read same-transaction capabilities the
      // app role cannot touch directly.
      const probeSuffix = crypto.randomUUID().replaceAll("-", "_");
      const seedProbe = `opengeni_private.test_seed_capabilities_${probeSuffix}`;
      const readProbe = `opengeni_private.test_read_capabilities_${probeSuffix}`;
      await shared!.admin.unsafe(`
        create function ${seedProbe}(
          p_account uuid, p_workspace uuid, p_session uuid, p_turn uuid,
          p_connection uuid, p_owner text, p_human text
        ) returns void language sql security definer
        set search_path = pg_catalog, opengeni_private, pg_temp as $probe$
          insert into opengeni_private.subscription_runtime_capabilities (
            backend_pid, transaction_id, capability_kind, account_id, workspace_id,
            session_id, turn_id, connection_id, provider,
            session_owner_subject_id, turn_human_subject_id
          ) values (
            pg_backend_pid(), pg_current_xact_id(), 'personal_access', p_account, p_workspace,
            p_session, p_turn, p_connection, 'claude', p_owner, p_human
          );
          insert into opengeni_private.subscription_runtime_capabilities (
            backend_pid, transaction_id, capability_kind, account_id
          ) values (pg_backend_pid(), pg_current_xact_id(), 'lifecycle', p_account);
        $probe$;
        create function ${readProbe}(p_account uuid, p_connection uuid)
        returns table (claude_provider text, lifecycle boolean) language sql security definer
        set search_path = pg_catalog, opengeni_private, pg_temp as $probe$
          select (
            select capability.provider from opengeni_private.subscription_runtime_capabilities capability
            where capability.backend_pid = pg_backend_pid()
              and capability.transaction_id = pg_current_xact_id_if_assigned()
              and capability.capability_kind = 'personal_access'
              and capability.account_id = p_account and capability.connection_id = p_connection
          ), exists (
            select 1 from opengeni_private.subscription_runtime_capabilities capability
            where capability.backend_pid = pg_backend_pid()
              and capability.transaction_id = pg_current_xact_id_if_assigned()
              and capability.capability_kind = 'lifecycle' and capability.account_id = p_account
          );
        $probe$;
        grant execute on function ${seedProbe}(uuid, uuid, uuid, uuid, uuid, text, text) to opengeni_app;
        grant execute on function ${readProbe}(uuid, uuid) to opengeni_app;
      `);
      await shared!.admin`
        insert into subscription_settings (
          account_id, rotation, providers, cross_provider_failover, fallback_order,
          personal_connections_allowed, personal_fallback_allowed
        ) values (
          ${state.accountId}::uuid, '{}'::jsonb, '{}'::jsonb, false, '{}'::jsonb, true, true
        ) on conflict (account_id, workspace_id) do update
          set personal_connections_allowed = true`;
      await shared!.admin`
        update session_turns
        set subscription_authority = ${shared!.admin.json({
          version: 2,
          personal: [
            {
              provider: "codex",
              ownerMembershipId: membership!.id,
              authorityGeneration: 1,
            },
          ],
        })}::jsonb
        where account_id = ${state.accountId}::uuid and id = ${personalTurn.id}::uuid`;

      const [sharedWorkspace] = await shared!.admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${state.accountId}::uuid, 'Subscription placement shared workspace')
        returning id::text as id`;
      await shared!.admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role)
        values (
          ${state.accountId}::uuid, ${sharedWorkspace!.id}::uuid, ${state.subjectId}, 'owner'
        )`;
      await shared!.admin`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${sharedWorkspace!.id}::uuid, ${state.accountId}::uuid)`;
      const sharedSession = await withSessionRlsActorContext({ subjectId: state.subjectId }, () =>
        createSession(client!.db, {
          accountId: state.accountId,
          workspaceId: sharedWorkspace!.id,
          initialMessage: "shared-workspace personal denial fixture",
          resources: [],
          metadata: {},
          model: "fixture-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          createdBy: { kind: "subject", subjectId: state.subjectId },
          createdByContext: {},
        }),
      );
      const sharedTurn = await withSessionRlsActorContext({ subjectId: state.subjectId }, () =>
        enqueueSessionTurn(client!.db, {
          accountId: state.accountId,
          workspaceId: sharedWorkspace!.id,
          sessionId: sharedSession.id,
          triggerEventId: crypto.randomUUID(),
          temporalWorkflowId: `shared-workspace-personal-denial-${sharedSession.id}`,
          source: "user",
          prompt: "shared-workspace personal denial fixture",
          resources: [],
          tools: [],
          model: "fixture-model",
          reasoningEffort: "medium",
          sandboxBackend: "none",
          metadata: {},
          initiator: { kind: "subject", subjectId: state.subjectId },
        }),
      );
      await shared!.admin`
        update session_turns
        set subscription_authority = ${shared!.admin.json({
          version: 2,
          personal: [
            {
              provider: "codex",
              ownerMembershipId: membership!.id,
              authorityGeneration: 1,
            },
          ],
        })}::jsonb
        where account_id = ${state.accountId}::uuid and id = ${sharedTurn.id}::uuid`;
      const coMemberSubjectId = `user:subscription-co-member-${crypto.randomUUID()}`;
      const [coMemberWorkspace] = await shared!.admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${state.accountId}::uuid, 'Subscription co-member Personal')
        returning id::text as id`;
      await shared!.admin`
        insert into organization_memberships (
          account_id, subject_id, role, status, personal_workspace_id
        ) values (
          ${state.accountId}::uuid, ${coMemberSubjectId}, 'member', 'active',
          ${coMemberWorkspace!.id}::uuid
        )`;

      const rollback = new Error("rollback cutover authorization fixture");
      const runAccessCase = async (input: {
        provider?: "codex" | "claude" | "xai";
        ownerMembershipId?: string;
        generation?: number;
        ownerSubjectId?: string;
        humanSubjectId?: string | null;
        cutover: "enabled" | "disabled" | "absent";
        cutoverProvider?: "codex" | "claude" | "xai";
        personalEnabled?: boolean;
        workspaceId?: string;
        sessionId?: string;
        turnId?: string;
        seedEarlierCapabilities?: boolean;
      }) => {
        let observed:
          | {
              authorized: boolean;
              visible: boolean;
              owner: string | null;
              human: string | null;
              earlierClaudeProvider: string | null;
              earlierLifecycle: boolean;
            }
          | undefined;
        try {
          await client!.db.transaction(async (transaction) => {
            await withSessionRlsActorContext({ subjectId: state.subjectId }, () =>
              withRlsContext(
                transaction as never,
                {
                  accountId: state.accountId,
                  workspaceId: membership!.personal_workspace_id,
                },
                async (ownerDb) => {
                  if (input.cutover !== "absent") {
                    await rawRows(
                      ownerDb,
                      sql`insert into subscription_provider_cutovers (account_id, provider, enabled)
                        values (${state.accountId}::uuid, ${input.cutoverProvider ?? "codex"}, ${input.cutover === "enabled"})
                        on conflict (account_id, provider) do update set enabled = excluded.enabled`,
                    );
                  }
                  if (input.personalEnabled === false) {
                    await rawRows(
                      ownerDb,
                      sql`update subscription_settings set personal_connections_allowed = false
                        where account_id = ${state.accountId}::uuid and workspace_id is null`,
                    );
                  }
                  await withSessionRlsActorContext(
                    {
                      subjectId: "service:subscription-core",
                      initiatingHumanSubjectId: input.humanSubjectId ?? state.subjectId,
                    },
                    () =>
                      withRlsContext(
                        ownerDb,
                        {
                          accountId: state.accountId,
                          workspaceId: input.workspaceId ?? membership!.personal_workspace_id,
                        },
                        async (db) => {
                          await rawRows(
                            db,
                            sql`select opengeni_private.authorize_subscription_session_access(
                              ${state.accountId}::uuid, ${input.workspaceId ?? membership!.personal_workspace_id}::uuid,
                              ${input.sessionId ?? personalSession.id}::uuid,
                              ${input.turnId ?? personalTurn.id}::uuid,
                              ${input.ownerSubjectId ?? state.subjectId},
                              ${input.humanSubjectId ?? state.subjectId}
                            ) as authorized`,
                          );
                          if (input.seedEarlierCapabilities) {
                            await rawRows(
                              db,
                              sql`select ${sql.raw(seedProbe)}(
                                ${state.accountId}::uuid,
                                ${input.workspaceId ?? membership!.personal_workspace_id}::uuid,
                                ${input.sessionId ?? personalSession.id}::uuid,
                                ${input.turnId ?? personalTurn.id}::uuid,
                                ${claudeConnectionId}::uuid, ${state.subjectId}, ${state.subjectId}
                              )`,
                            );
                          }
                          const [authorization] = await rawRows<{ authorized: boolean }>(
                            db,
                            sql`select opengeni_private.authorize_subscription_personal_placement_access(
                              ${state.accountId}::uuid, ${input.workspaceId ?? membership!.personal_workspace_id}::uuid,
                              ${input.sessionId ?? personalSession.id}::uuid,
                              ${input.turnId ?? personalTurn.id}::uuid,
                              ${input.provider ?? "codex"},
                              ${input.ownerMembershipId ?? membership!.id}::uuid,
                              ${input.generation ?? 1}::bigint,
                              ${input.ownerSubjectId ?? state.subjectId},
                              ${input.humanSubjectId ?? state.subjectId}
                            ) as authorized`,
                          );
                          const [visibility] = await rawRows<{ visible: boolean }>(
                            db,
                            sql`select opengeni_private.subscription_connection_visible(
                              ${state.accountId}::uuid, ${input.workspaceId ?? membership!.personal_workspace_id}::uuid,
                              ${connectionId}::uuid, 'personal', 'people', ${membership!.id}::uuid,
                              ${state.subjectId}, 'codex'
                            ) as visible`,
                          );
                          const [context] = await rawRows<{
                            owner: string | null;
                            human: string | null;
                          }>(
                            db,
                            sql`select nullif(current_setting('opengeni.session_owner_subject_id', true), '') as owner,
                              nullif(current_setting('opengeni.turn_human_subject_id', true), '') as human`,
                          );
                          const [earlier] = await rawRows<{
                            claude_provider: string | null;
                            lifecycle: boolean;
                          }>(
                            db,
                            sql`select * from ${sql.raw(readProbe)}(
                              ${state.accountId}::uuid, ${claudeConnectionId}::uuid
                            )`,
                          );
                          observed = {
                            authorized: authorization?.authorized === true,
                            visible: visibility?.visible === true,
                            owner: context?.owner ?? null,
                            human: context?.human ?? null,
                            earlierClaudeProvider: earlier?.claude_provider ?? null,
                            earlierLifecycle: earlier?.lifecycle === true,
                          };
                        },
                      ),
                  );
                },
              ),
            );
            throw rollback;
          });
        } catch (error) {
          if (error !== rollback) throw error;
        }
        return observed;
      };

      expect(await runAccessCase({ cutover: "absent" })).toMatchObject({
        authorized: false,
        visible: false,
      });
      expect(await runAccessCase({ cutover: "disabled" })).toMatchObject({
        authorized: false,
        visible: false,
      });
      expect(await runAccessCase({ cutover: "enabled" })).toMatchObject({
        authorized: true,
        visible: true,
        owner: state.subjectId,
        human: state.subjectId,
        earlierClaudeProvider: null,
        earlierLifecycle: false,
      });
      // Earlier same-transaction capabilities survive both an allowed and a
      // denied Codex placement unchanged.
      expect(
        await runAccessCase({ cutover: "enabled", seedEarlierCapabilities: true }),
      ).toMatchObject({
        authorized: true,
        visible: true,
        earlierClaudeProvider: "claude",
        earlierLifecycle: true,
      });
      expect(
        await runAccessCase({ cutover: "enabled", generation: 2, seedEarlierCapabilities: true }),
      ).toMatchObject({
        authorized: false,
        visible: false,
        earlierClaudeProvider: "claude",
        earlierLifecycle: true,
      });
      expect(
        await runAccessCase({
          cutover: "enabled",
          personalEnabled: false,
          seedEarlierCapabilities: true,
        }),
      ).toMatchObject({
        authorized: false,
        earlierClaudeProvider: "claude",
        earlierLifecycle: true,
      });
      // Accepted v2 snapshots store only canonical lowercase membership UUIDs.
      let uppercaseAuthorityError: unknown;
      try {
        await shared!.admin`
          update session_turns
          set subscription_authority = ${shared!.admin.json({
            version: 2,
            personal: [
              {
                provider: "codex",
                ownerMembershipId: membership!.id.toUpperCase(),
                authorityGeneration: 1,
              },
            ],
          })}::jsonb
          where account_id = ${state.accountId}::uuid and id = ${personalTurn.id}::uuid`;
      } catch (error) {
        uppercaseAuthorityError = error;
      }
      expect(String(uppercaseAuthorityError)).toContain(
        "session_turns_subscription_authority_v2_chk",
      );
      expect(
        await runAccessCase({
          cutover: "enabled",
          provider: "claude",
          cutoverProvider: "claude",
        }),
      ).toMatchObject({ authorized: false, visible: false });
      expect(await runAccessCase({ cutover: "enabled", generation: 2 })).toMatchObject({
        authorized: false,
        visible: false,
      });
      expect(
        await runAccessCase({ cutover: "enabled", ownerMembershipId: crypto.randomUUID() }),
      ).toMatchObject({ authorized: false, visible: false });
      expect(
        await runAccessCase({
          cutover: "enabled",
          humanSubjectId: coMemberSubjectId,
        }),
      ).toMatchObject({ authorized: false, visible: false });
      expect(await runAccessCase({ cutover: "enabled", personalEnabled: false })).toMatchObject({
        authorized: false,
        visible: false,
      });
      expect(
        await runAccessCase({
          cutover: "enabled",
          ownerSubjectId: "user:not-the-session-owner",
        }),
      ).toMatchObject({ authorized: false, visible: false });
      expect(
        await runAccessCase({
          cutover: "enabled",
          workspaceId: sharedWorkspace!.id,
          sessionId: sharedSession.id,
          turnId: sharedTurn.id,
        }),
      ).toMatchObject({ authorized: false, visible: false });

      const missingTurn = await withSessionRlsActorContext({ subjectId: state.subjectId }, () =>
        enqueueSessionTurn(client!.db, {
          accountId: state.accountId,
          workspaceId: membership!.personal_workspace_id,
          sessionId: personalSession.id,
          triggerEventId: crypto.randomUUID(),
          temporalWorkflowId: `personal-subscription-missing-v2-${personalSession.id}`,
          source: "user",
          prompt: "missing v2 authority fixture",
          resources: [],
          tools: [],
          model: "fixture-model",
          reasoningEffort: "medium",
          sandboxBackend: "none",
          metadata: {},
          initiator: { kind: "subject", subjectId: state.subjectId },
        }),
      );
      expect(await runAccessCase({ cutover: "enabled", turnId: missingTurn.id })).toMatchObject({
        authorized: false,
        visible: false,
      });

      const ownerless = await ownerlessFixture(state.accountId, state.workspaceId);
      expect(
        await runAccessCase({
          cutover: "enabled",
          workspaceId: state.workspaceId,
          sessionId: ownerless.sessionId,
          turnId: ownerless.turnId,
          ownerSubjectId: "",
          humanSubjectId: null,
        }),
      ).toMatchObject({ authorized: false, visible: false });

      const placementRequest = (input: {
        workspaceId: string;
        sessionId: string;
        turnId: string;
        ownerSubjectId: string | null;
        ownerMembershipId: string | null;
        humanSubjectId: string | null;
        acceptedAuthorityV2: {
          version: 2;
          personal: Array<{
            provider: "codex" | "claude" | "xai";
            ownerMembershipId: string;
            authorityGeneration: number;
          }>;
        };
      }) => ({
        accountId: state.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        sessionOwnerSubjectId: input.ownerSubjectId,
        sessionOwnerMembershipId: input.ownerMembershipId,
        initiatingHumanSubjectId: input.humanSubjectId,
        acceptedAuthorityV2: input.acceptedAuthorityV2,
        preferredModelId: "codex/model",
        reasoningLevel: "medium",
        models: [{ id: "codex/model", provider: "codex" as const, reasoningLevels: ["medium"] }],
        reselectionPoints: [],
        now: new Date(),
      });
      const rollbackWorld = new Error("rollback placement-world cutover row");
      const loadPlacementWorld = async (
        request: ReturnType<typeof placementRequest>,
        enableCutover: boolean,
      ) => {
        let result:
          | Awaited<
              ReturnType<
                typeof withSubscriptionCorePlacementWorld<{
                  connectionIds: string[];
                  personalAuthority: unknown[];
                }>
              >
            >
          | undefined;
        try {
          await client!.db.transaction(async (transaction) => {
            await withSessionRlsActorContext({ subjectId: state.subjectId }, () =>
              withRlsContext(
                transaction as never,
                { accountId: state.accountId, workspaceId: membership!.personal_workspace_id },
                async (ownerDb) => {
                  if (enableCutover) {
                    await rawRows(
                      ownerDb,
                      sql`insert into subscription_provider_cutovers (account_id, provider, enabled)
                        values (${state.accountId}::uuid, 'codex', true)
                        on conflict (account_id, provider) do update set enabled = true`,
                    );
                  }
                  result = await withSubscriptionCorePlacementWorld(
                    ownerDb,
                    request,
                    async (_tx, placement) => ({
                      connectionIds: placement.connections.map((connection) => connection.id),
                      personalAuthority: [...placement.session.personalAuthority],
                    }),
                  );
                },
              ),
            );
            throw rollbackWorld;
          });
        } catch (error) {
          if (error !== rollbackWorld) throw error;
        }
        return result;
      };
      const ownedWorld = await loadPlacementWorld(
        placementRequest({
          workspaceId: state.workspaceId,
          sessionId: state.sessionId,
          turnId: state.turnId,
          ownerSubjectId: state.subjectId,
          ownerMembershipId: membership!.id,
          humanSubjectId: state.subjectId,
          acceptedAuthorityV2: { version: 2, personal: [] },
        }),
        false,
      );
      expect(ownedWorld?.status).toBe("completed");

      const ownerlessPlacement = await ownerlessFixture(state.accountId, state.workspaceId);
      const ownerlessWorld = await loadPlacementWorld(
        placementRequest({
          workspaceId: state.workspaceId,
          sessionId: ownerlessPlacement.sessionId,
          turnId: ownerlessPlacement.turnId,
          ownerSubjectId: null,
          ownerMembershipId: null,
          humanSubjectId: null,
          acceptedAuthorityV2: { version: 2, personal: [] },
        }),
        false,
      );
      expect(ownerlessWorld?.status).toBe("completed");

      const personalWorld = await loadPlacementWorld(
        placementRequest({
          workspaceId: membership!.personal_workspace_id,
          sessionId: personalSession.id,
          turnId: personalTurn.id,
          ownerSubjectId: state.subjectId,
          ownerMembershipId: membership!.id,
          humanSubjectId: state.subjectId,
          acceptedAuthorityV2: {
            version: 2,
            personal: [
              { provider: "codex", ownerMembershipId: membership!.id, authorityGeneration: 1 },
            ],
          },
        }),
        true,
      );
      expect(personalWorld?.status).toBe("completed");
      if (personalWorld?.status === "completed") {
        expect(personalWorld.value.connectionIds).toContain(connectionId);
        expect(personalWorld.value.personalAuthority).toEqual([
          { provider: "codex", ownerMembershipId: membership!.id },
        ]);
      }
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "chat-turn leases are generation-fenced and provider cutovers fail closed by default",
    async () => {
      const state = await fixture();
      const actor = {
        subjectId: "service:subscription-test",
        initiatingHumanSubjectId: state.subjectId,
      };
      const first = {
        accountId: state.accountId,
        workspaceId: state.workspaceId,
        sessionId: state.sessionId,
        turnId: state.turnId,
        provider: "codex" as const,
        connectionId: state.connectionId,
        holderId: `worker-${crypto.randomUUID()}`,
        generation: 1,
      };
      expect(
        await withSessionRlsActorContext(actor, () =>
          withRlsContext(
            client!.db,
            { accountId: state.accountId, workspaceId: state.workspaceId },
            (db) =>
              isSubscriptionProviderCutoverEnabled(db, {
                accountId: state.accountId,
                provider: "codex",
              }),
          ),
        ),
      ).toBe(false);
      expect(
        await withSessionRlsActorContext(actor, () =>
          withRlsContext(
            client!.db,
            { accountId: state.accountId, workspaceId: state.workspaceId },
            (db) =>
              readSubscriptionProviderCutoverState(db, {
                accountId: state.accountId,
                provider: "codex",
              }),
          ),
        ),
      ).toBe("not_configured");
      await shared!.admin`
        insert into subscription_provider_cutovers (account_id, provider, enabled)
        values (${state.accountId}::uuid, 'codex', false)`;

      await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          async (db) => {
            expect(
              await readSubscriptionProviderCutoverState(db, {
                accountId: state.accountId,
                provider: "codex",
              }),
            ).toBe("disabled");
            expect(
              await isSubscriptionProviderCutoverEnabled(db, {
                accountId: state.accountId,
                provider: "codex",
              }),
            ).toBe(false);
            await shared!.admin`
              update subscription_provider_cutovers set enabled = true
              where account_id = ${state.accountId}::uuid and provider = 'codex'`;
            expect(
              await readSubscriptionProviderCutoverState(db, {
                accountId: state.accountId,
                provider: "codex",
              }),
            ).toBe("enabled");
            expect(
              await acquireSubscriptionTurnLease(db, { ...first, ttlMs: 60_000 }),
            ).toMatchObject({ generation: 1, turnId: state.turnId });
            expect(await assertSubscriptionTurnLeaseCurrent(db, first)).toBe(true);
            expect(
              await acquireSubscriptionTurnLease(db, {
                ...first,
                holderId: `replacement-${crypto.randomUUID()}`,
                generation: 2,
                ttlMs: 60_000,
              }),
            ).toBeNull();
            expect(
              await renewSubscriptionTurnLease(db, { ...first, ttlMs: 60_000 }),
            ).toBeInstanceOf(Date);
          },
        ),
      );

      await shared!.admin`
        update subscription_leases set leased_until = clock_timestamp() - interval '1 second'
        where account_id = ${state.accountId}::uuid and turn_id = ${state.turnId}::uuid`;
      const reclaimed = {
        ...first,
        holderId: `reclaimer-${crypto.randomUUID()}`,
        generation: 2,
      };
      await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          async (db) => {
            expect(
              await acquireSubscriptionTurnLease(db, { ...reclaimed, ttlMs: 60_000 }),
            ).toMatchObject({ generation: 2, turnId: state.turnId });
            expect(await assertSubscriptionTurnLeaseCurrent(db, first)).toBe(false);
            expect(await releaseSubscriptionTurnLease(db, first)).toBe(false);
            expect(await releaseSubscriptionTurnLease(db, reclaimed)).toBe(true);
          },
        ),
      );
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "operation leases are independent of chat leases and fenced by attempt and generation",
    async () => {
      const state = await fixture();
      const actor = {
        subjectId: "service:subscription-test",
        initiatingHumanSubjectId: state.subjectId,
      };
      const liveAttempt = crypto.randomUUID();
      await liveTurnAttempt({
        accountId: state.accountId,
        workspaceId: state.workspaceId,
        sessionId: state.sessionId,
        turnId: state.turnId,
        connectionId: state.connectionId,
        attemptId: liveAttempt,
        generation: 1,
      });
      const leaseInput = (operationId: string) => ({
        accountId: state.accountId,
        workspaceId: state.workspaceId,
        operationId,
        attemptId: liveAttempt,
        operationKind: "image" as const,
        sessionId: state.sessionId,
        turnId: state.turnId,
        provider: "codex" as const,
        connectionId: state.connectionId,
        holderId: `worker-${crypto.randomUUID()}`,
        generation: 1,
      });
      const first = leaseInput(crypto.randomUUID());
      const second = leaseInput(crypto.randomUUID());
      const [firstLease, secondLease] = await withSessionRlsActorContext(actor, () =>
        Promise.all([
          withRlsContext(
            client!.db,
            { accountId: state.accountId, workspaceId: state.workspaceId },
            (db) => acquireSubscriptionOperationLease(db, { ...first, ttlMs: 60_000 }),
          ),
          withRlsContext(
            client!.db,
            { accountId: state.accountId, workspaceId: state.workspaceId },
            (db) => acquireSubscriptionOperationLease(db, { ...second, ttlMs: 60_000 }),
          ),
        ]),
      );
      expect(firstLease?.generation).toBe(1);
      expect(secondLease?.generation).toBe(1);
      expect(firstLease?.operationId).not.toBe(secondLease?.operationId);

      await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          async (db) => {
            expect(await assertSubscriptionOperationLeaseCurrent(db, first)).toBe(true);
            expect(await releaseSubscriptionOperationLease(db, { ...first, generation: 2 })).toBe(
              false,
            );
            expect(
              await renewSubscriptionOperationLease(db, { ...first, ttlMs: 60_000 }),
            ).toBeInstanceOf(Date);
          },
        ),
      );
      await shared!.admin`
        update subscription_operation_leases
        set leased_until = clock_timestamp() - interval '1 second'
        where account_id = ${state.accountId}::uuid and operation_id = ${first.operationId}::uuid`;
      const reclaimer = {
        ...first,
        attemptId: crypto.randomUUID(),
        holderId: `reclaimer-${crypto.randomUUID()}`,
        generation: 2,
      };
      // The turn's next attempt and execution generation take over.
      await liveTurnAttempt({
        accountId: state.accountId,
        workspaceId: state.workspaceId,
        sessionId: state.sessionId,
        turnId: state.turnId,
        connectionId: state.connectionId,
        attemptId: reclaimer.attemptId,
        generation: 2,
      });
      const reclaimed = await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          (db) => acquireSubscriptionOperationLease(db, { ...reclaimer, ttlMs: 60_000 }),
        ),
      );
      expect(reclaimed?.generation).toBe(2);
      const fenced = await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          async (db) => {
            expect(await assertSubscriptionOperationLeaseCurrent(db, first)).toBe(false);
            expect(await releaseSubscriptionOperationLease(db, first)).toBe(false);
            return await releaseSubscriptionOperationLease(db, reclaimer);
          },
        ),
      );
      expect(fenced).toBe(true);
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "sessionless transcription requires shared authority and capacity wakes are durable and revision-fenced",
    async () => {
      const state = await fixture();
      const transcription = {
        accountId: state.accountId,
        workspaceId: state.workspaceId,
        operationId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        operationKind: "transcription" as const,
        provider: "codex" as const,
        connectionId: state.connectionId,
        holderId: "transcription-worker",
        generation: 1,
      };
      const lease = await withSessionRlsActorContext(
        { subjectId: state.subjectId, initiatingHumanSubjectId: state.subjectId },
        () =>
          withRlsContext(
            client!.db,
            { accountId: state.accountId, workspaceId: state.workspaceId },
            (db) => acquireSubscriptionOperationLease(db, { ...transcription, ttlMs: 60_000 }),
          ),
      );
      expect(lease?.operationId).toBe(transcription.operationId);

      const waiter = {
        accountId: state.accountId,
        workspaceId: state.workspaceId,
        sessionId: state.sessionId,
        turnId: state.turnId,
        waiterId: crypto.randomUUID(),
        provider: "codex" as const,
        waitReason: "quota_exhausted",
        generation: 2,
        wakeRevision: 1,
        observedWakeRevision: 0,
        nextCheckAt: new Date(Date.now() + 60_000),
        blockedTurnGeneration: 1,
      };
      const actor = {
        subjectId: "service:subscription-test",
        initiatingHumanSubjectId: state.subjectId,
      };
      await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          async (db) => {
            expect(await upsertSubscriptionCapacityWaiter(db, waiter)).toMatchObject({
              waiterId: waiter.waiterId,
            });
            expect(
              await upsertSubscriptionCapacityWaiter(db, {
                ...waiter,
                waiterId: crypto.randomUUID(),
                generation: 1,
              }),
            ).toBeNull();
            const revision = await withPoolWakeServiceScopeInTransaction(db, () =>
              wakeSubscriptionCapacityWaiter(db, {
                accountId: state.accountId,
                workspaceId: state.workspaceId,
                sessionId: state.sessionId,
                waiterId: waiter.waiterId,
                generation: waiter.generation,
              }),
            );
            expect(revision).toBe(2);
            expect(
              await upsertSubscriptionCapacityWaiter(db, {
                ...waiter,
                wakeRevision: 1,
                nextCheckAt: new Date(Date.now() + 120_000),
              }),
            ).toMatchObject({ waiterId: waiter.waiterId, wakeRevision: 2, nextCheckAt: null });
            expect(
              await observeSubscriptionCapacityWaiterWake(db, {
                accountId: state.accountId,
                workspaceId: state.workspaceId,
                sessionId: state.sessionId,
                waiterId: waiter.waiterId,
                generation: waiter.generation,
                wakeRevision: 1,
              }),
            ).toBe(false);
          },
        ),
      );

      const deliveries = await withRlsContext(
        client!.db,
        { accountId: state.accountId, workspaceId: state.workspaceId },
        (db) => claimSubscriptionCapacityWakeDeliveries(db, { limit: 10, claimTtlMs: 60_000 }),
      );
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        waiterId: waiter.waiterId,
        generation: 2,
        wakeRevision: 2,
      });
      const delivery = deliveries[0]!;
      expect(
        await withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          (db) =>
            markSubscriptionCapacityWakeDelivered(db, {
              id: delivery.id,
              claimGeneration: delivery.claimGeneration - 1,
            }),
        ),
      ).toBe(false);
      expect(
        await withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          (db) => markSubscriptionCapacityWakeDelivered(db, delivery),
        ),
      ).toBe(true);
      const takeoverRequest = {
        ...waiter,
        waiterId: crypto.randomUUID(),
        generation: 3,
        wakeRevision: 1,
        observedWakeRevision: 0,
      };
      const nextGeneration = await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          (db) => upsertSubscriptionCapacityWaiter(db, takeoverRequest),
        ),
      );
      expect(nextGeneration).toMatchObject({ waiterId: waiter.waiterId, generation: 3 });
      const takeoverReplay = await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          (db) => upsertSubscriptionCapacityWaiter(db, takeoverRequest),
        ),
      );
      expect(takeoverReplay).toMatchObject({ waiterId: waiter.waiterId, generation: 3 });
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "assignment pool policy remains independent and session binding writes are compare-and-swap fenced",
    async () => {
      const state = await fixture();
      await shared!.admin`
        insert into subscription_connection_assignment_policies (
          account_id, connection_id, workspace_id, inference_pool, allocator_enabled,
          allowed_model_ids, excluded_models
        ) values
          (${state.accountId}::uuid, ${state.connectionId}::uuid, ${state.workspaceId}::uuid,
           'workspace', true, array['codex/a'], array['codex/b']),
          (${state.accountId}::uuid, ${state.connectionId}::uuid, ${state.workspaceId}::uuid,
           'organization', false, array['codex/b'], array['codex/a'])`;
      const actor = { subjectId: state.subjectId, initiatingHumanSubjectId: state.subjectId };
      await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          async (db) => {
            const policies = await listSubscriptionConnectionAssignmentPolicies(db, {
              accountId: state.accountId,
              workspaceId: state.workspaceId,
              provider: "codex",
            });
            expect(policies).toHaveLength(2);
            expect(
              policies.map((policy) => [policy.inferencePool, policy.allocatorEnabled]),
            ).toEqual([
              ["organization", false],
              ["workspace", true],
            ]);
            const placementConnections = await listSubscriptionConnectionsForPlacement(db, {
              accountId: state.accountId,
              workspaceId: state.workspaceId,
              provider: "codex",
            });
            expect(placementConnections).toHaveLength(1);
            expect(placementConnections[0]).toMatchObject({
              id: state.connectionId,
              provider: "codex",
              ownership: { kind: "shared", scope: { kind: "organization" } },
              assignmentPolicies: [
                {
                  inferencePool: "organization",
                  allocatorEnabled: false,
                  allowedModelIds: ["codex/b"],
                  excludedModelIds: ["codex/a"],
                },
                {
                  inferencePool: "workspace",
                  allocatorEnabled: true,
                  allowedModelIds: ["codex/a"],
                  excludedModelIds: ["codex/b"],
                },
              ],
              quota: null,
            });

            const binding = {
              accountId: state.accountId,
              workspaceId: state.workspaceId,
              sessionId: state.sessionId,
              provider: "codex" as const,
              connectionId: state.connectionId,
              modelId: "codex/a",
              choice: "automatic" as const,
              onlyThisModel: false,
              lastModelCallAt: null,
              lastSwitchReason: "initial" as const,
            };
            expect(await writeSubscriptionSessionBinding(db, binding)).toBe(1);
            expect(
              await writeSubscriptionSessionBinding(db, { ...binding, modelId: "codex/b" }),
            ).toBe(null);
            expect(
              await writeSubscriptionSessionBinding(db, {
                ...binding,
                modelId: "codex/b",
                expectedVersion: 1,
              }),
            ).toBe(2);
            expect(
              await readSubscriptionSessionBinding(db, {
                workspaceId: state.workspaceId,
                sessionId: state.sessionId,
              }),
            ).toMatchObject({ modelId: "codex/b", version: 2 });
          },
        ),
      );
      await shared!.admin`
        delete from subscription_connection_assignment_policies
        where account_id = ${state.accountId}::uuid and connection_id = ${state.connectionId}::uuid`;
      const unassigned = await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          (db) =>
            listSubscriptionConnectionsForPlacement(db, {
              accountId: state.accountId,
              workspaceId: state.workspaceId,
              provider: "codex",
            }),
        ),
      );
      // No assignment row in this workspace: the management classification
      // applies (M3 PR 3b), exactly as the compatibility projection reads it.
      expect(unassigned[0]?.assignmentPolicies).toBeUndefined();
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "workspace administrators can manage only organization-delegated connection policies",
    async () => {
      const state = await fixture();
      const managerSubject = `user:subscription-policy-manager-${crypto.randomUUID()}`;
      const [personalWorkspace] = await shared!.admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${state.accountId}::uuid, 'Subscription policy manager Personal')
        returning id::text as id`;
      await shared!.admin`
        insert into organization_memberships (
          account_id, subject_id, role, status, personal_workspace_id
        ) values (
          ${state.accountId}::uuid, ${managerSubject}, 'member', 'active', ${personalWorkspace!.id}::uuid
        )`;
      await shared!.admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role)
        values (${state.accountId}::uuid, ${state.workspaceId}::uuid, ${managerSubject}, 'admin')`;

      const [delegated] = await shared!.admin<{ id: string }[]>`
        insert into subscription_connections (
          account_id, provider, credential_encrypted, ownership, scope_kind, managed_by_workspace_id
        ) values (
          ${state.accountId}::uuid, 'codex', 'v1:delegated-policy', 'shared', 'people',
          ${state.workspaceId}::uuid
        ) returning id::text as id`;
      await shared!.admin`
        insert into subscription_connection_people (account_id, connection_id, organization_membership_id)
        select ${state.accountId}::uuid, ${delegated!.id}::uuid, membership.id
        from organization_memberships membership
        where membership.account_id = ${state.accountId}::uuid
          and membership.subject_id = ${managerSubject}`;
      await shared!.admin`
        insert into subscription_connection_assignment_policies (
          account_id, connection_id, workspace_id, inference_pool, managed_by_workspace_id
        ) values (
          ${state.accountId}::uuid, ${delegated!.id}::uuid, ${state.workspaceId}::uuid,
          'organization', ${state.workspaceId}::uuid
        )`;

      await withSessionRlsActorContext({ subjectId: managerSubject }, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          async (db) => {
            const [changed] = await db.execute<{ allocator_enabled: boolean }>(sql`
              update subscription_connection_assignment_policies
              set allocator_enabled = false, allowed_model_ids = array['codex/a']::text[]
              where connection_id = ${delegated!.id}::uuid and inference_pool = 'organization'
              returning allocator_enabled
            `);
            expect(changed?.allocator_enabled).toBe(false);

            let markerMutationError: unknown;
            try {
              await db.transaction((nested) =>
                nested.execute(sql`
                  update subscription_connection_assignment_policies
                  set managed_by_workspace_id = null
                  where connection_id = ${delegated!.id}::uuid and inference_pool = 'organization'
                `),
              );
            } catch (error) {
              markerMutationError = error;
            }
            expect(markerMutationError).toBeDefined();

            let selfDelegationError: unknown;
            try {
              await db.transaction((nested) =>
                nested.execute(sql`
                  insert into subscription_connection_assignment_policies (
                    account_id, connection_id, workspace_id, inference_pool, managed_by_workspace_id
                  ) values (
                    ${state.accountId}::uuid, ${state.connectionId}::uuid, ${state.workspaceId}::uuid,
                    'organization', ${state.workspaceId}::uuid
                  )
                `),
              );
            } catch (error) {
              selfDelegationError = error;
            }
            expect(selfDelegationError).toBeDefined();
          },
        ),
      );
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "owned service turns refresh shared Codex credentials without minting personal authority",
    async () => {
      const state = await fixture();
      const actor = {
        subjectId: "service:subscription-core",
        initiatingHumanSubjectId: state.subjectId,
      };
      const [membership] = await shared!.admin<{ id: string }[]>`
        select id::text as id from organization_memberships
        where account_id = ${state.accountId}::uuid and subject_id = ${state.subjectId}
          and status = 'active' and revoked_at is null limit 1`;
      const serviceTurn = await withSessionRlsActorContext(actor, () =>
        enqueueSessionTurn(client!.db, {
          accountId: state.accountId,
          workspaceId: state.workspaceId,
          sessionId: state.sessionId,
          triggerEventId: crypto.randomUUID(),
          temporalWorkflowId: `subscription-refresh-service-${crypto.randomUUID()}`,
          source: "user",
          prompt: "service turn refresh fixture",
          resources: [],
          tools: [],
          model: "fixture-model",
          reasoningEffort: "medium",
          sandboxBackend: "none",
          metadata: {},
          initiator: { kind: "service", subjectId: "service:subscription-core" },
        }),
      );
      const request = {
        accountId: state.accountId,
        workspaceId: state.workspaceId,
        sessionId: state.sessionId,
        turnId: serviceTurn.id,
        sessionOwnerSubjectId: state.subjectId,
        sessionOwnerMembershipId: membership!.id,
        initiatingHumanSubjectId: null,
        provider: "codex" as const,
        connectionId: state.connectionId,
        holderId: `service-refresh-${crypto.randomUUID()}`,
        generation: 1,
      };
      const lease = await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          (db) => acquireSubscriptionTurnLease(db, { ...request, ttlMs: 60_000 }),
        ),
      );
      expect(lease).toMatchObject({ turnId: serviceTurn.id, generation: 1 });

      const result = await withSessionRlsActorContext(actor, () =>
        withSubscriptionCoreCodexRefreshLock(client!.db, request, async (db, credential) => {
          // The pre-call authorization is not a write capability.
          const authorizedOnlyScopeWrite = await db.execute(sql`
            update subscription_connections set scope_kind = 'workspaces'
            where account_id = ${state.accountId}::uuid and id = ${state.connectionId}::uuid
            returning id`);
          const persisted = await persistSubscriptionCodexRefresh(db, {
            ...request,
            expectedRefreshGeneration: credential.refreshGeneration,
            credentialEncrypted: "v1:c2VydmljZS10b2tlbg==:c2VjcmV0",
            expiresAt: new Date(Date.now() + 60 * 60_000),
            lastRefreshAt: new Date(),
          });
          const unauthorizedScopeWrite = await db.execute(sql`
            update subscription_connections set scope_kind = 'workspaces'
            where account_id = ${state.accountId}::uuid and id = ${state.connectionId}::uuid
            returning id`);
          return { credential, authorizedOnlyScopeWrite, persisted, unauthorizedScopeWrite };
        }),
      );
      expect(result).toMatchObject({
        status: "completed",
        value: {
          credential: { refreshGeneration: 1, credentialEncrypted: "v1:test" },
          authorizedOnlyScopeWrite: [],
          persisted: true,
          unauthorizedScopeWrite: [],
        },
      });
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "Codex refresh persistence refuses API-key connection credentials",
    async () => {
      const state = await fixture("api_key");
      const actor = {
        subjectId: "service:subscription-refresh-test",
        initiatingHumanSubjectId: state.subjectId,
      };
      const [membership] = await shared!.admin<{ id: string }[]>`
        select id::text as id from organization_memberships
        where account_id = ${state.accountId}::uuid and subject_id = ${state.subjectId}
          and status = 'active' and revoked_at is null limit 1`;
      const request = {
        accountId: state.accountId,
        workspaceId: state.workspaceId,
        sessionId: state.sessionId,
        turnId: state.turnId,
        sessionOwnerSubjectId: state.subjectId,
        sessionOwnerMembershipId: membership!.id,
        initiatingHumanSubjectId: state.subjectId,
        provider: "codex" as const,
        connectionId: state.connectionId,
        holderId: `refresh-api-key-${crypto.randomUUID()}`,
        generation: 1,
      };
      const lease = await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          (db) => acquireSubscriptionTurnLease(db, { ...request, ttlMs: 60_000 }),
        ),
      );
      expect(lease).toMatchObject({ generation: 1, turnId: state.turnId });

      const result = await withSessionRlsActorContext(actor, () =>
        withSubscriptionCoreCodexRefreshLock(client!.db, request, async (db) => {
          const persisted = await persistSubscriptionCodexRefresh(db, {
            ...request,
            expectedRefreshGeneration: 1,
            credentialEncrypted: "v1:dG9rZW4=:c2VjcmV0",
            expiresAt: new Date(Date.now() + 60 * 60_000),
            lastRefreshAt: new Date(),
          });
          return { persisted };
        }),
      );
      // Authorization refuses an API-key connection before any provider call.
      expect(result).toEqual({ status: "refused" });
      const standalonePersist = await withSessionRlsActorContext(
        { subjectId: "service:subscription-core", initiatingHumanSubjectId: state.subjectId },
        () =>
          withRlsContext(
            client!.db,
            { accountId: state.accountId, workspaceId: state.workspaceId },
            (db) =>
              persistSubscriptionCodexRefresh(db, {
                ...request,
                expectedRefreshGeneration: 1,
                credentialEncrypted: "v1:dG9rZW4=:c2VjcmV0",
                expiresAt: null,
                lastRefreshAt: new Date(),
              }),
          ),
      );
      expect(standalonePersist).toBe(false);
      const [connection] = await shared!.admin<{ kind: string; credential_encrypted: string }[]>`
        select kind, credential_encrypted from subscription_connections
        where account_id = ${state.accountId}::uuid and id = ${state.connectionId}::uuid`;
      expect(connection).toEqual({ kind: "api_key", credential_encrypted: "v1:test" });
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "Codex refresh authorization requires the exact live turn lease, and its write cannot authorize other column writes",
    async () => {
      const state = await fixture();
      const actor = {
        subjectId: "service:subscription-refresh-test",
        initiatingHumanSubjectId: state.subjectId,
      };
      const request = {
        accountId: state.accountId,
        workspaceId: state.workspaceId,
        sessionId: state.sessionId,
        turnId: state.turnId,
        sessionOwnerSubjectId: state.subjectId,
        sessionOwnerMembershipId: (
          await shared!.admin<{ id: string }[]>`
            select id::text as id from organization_memberships
            where account_id = ${state.accountId}::uuid and subject_id = ${state.subjectId}
              and status = 'active' and revoked_at is null limit 1`
        )[0]!.id,
        initiatingHumanSubjectId: state.subjectId,
        provider: "codex" as const,
        connectionId: state.connectionId,
        holderId: `refresh-${crypto.randomUUID()}`,
        generation: 1,
      };
      const refreshInput = {
        ...request,
        expectedRefreshGeneration: 1,
        credentialEncrypted: "v1:dG9rZW4=:c2VjcmV0",
        expiresAt: new Date(Date.now() + 60 * 60_000),
        lastRefreshAt: new Date(),
      };
      const lease = await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          (db) => acquireSubscriptionTurnLease(db, { ...request, ttlMs: 60_000 }),
        ),
      );
      expect(lease).toMatchObject({ generation: 1, turnId: state.turnId });

      await shared!.admin`
        update session_turns set subscription_authority = ${shared!.admin.json({
          version: 2,
          personal: [
            {
              provider: "codex",
              ownerMembershipId: request.sessionOwnerMembershipId,
              authorityGeneration: 1,
            },
          ],
        })}::jsonb
        where account_id = ${state.accountId}::uuid and id = ${state.turnId}::uuid`;
      let malformedAuthorityError: unknown;
      try {
        await shared!.admin`
          update session_turns set subscription_authority = ${shared!.admin.json({
            version: 2,
            personal: [
              {
                provider: "codex",
                ownerMembershipId: request.sessionOwnerMembershipId,
                authorityGeneration: 1,
              },
              {
                provider: "codex",
                ownerMembershipId: request.sessionOwnerMembershipId,
                authorityGeneration: 1,
              },
            ],
          })}::jsonb
          where account_id = ${state.accountId}::uuid and id = ${state.turnId}::uuid`;
      } catch (error) {
        malformedAuthorityError = error;
      }
      expect(malformedAuthorityError).toBeDefined();

      // Exercise UPDATE RLS as the production-style table/function owner.
      const refreshed = await withNonSuperuserRefreshOwners(() =>
        withSubscriptionCoreCodexRefreshLock(client!.db, request, async (db) => {
          const persisted = await persistSubscriptionCodexRefresh(db, refreshInput);
          // One begin authorizes exactly one write, even at the next generation.
          const persistedAgain = await persistSubscriptionCodexRefresh(db, {
            ...refreshInput,
            expectedRefreshGeneration: 2,
            credentialEncrypted: "v1:c2Vjb25k:c2VjcmV0",
          });
          const unauthorizedScopeWrite = await db.execute(sql`
              update subscription_connections set scope_kind = 'workspaces'
              where account_id = ${state.accountId}::uuid and id = ${state.connectionId}::uuid
              returning id
            `);
          return { persisted, persistedAgain, unauthorizedScopeWrite };
        }),
      );
      expect(refreshed).toMatchObject({
        status: "completed",
        value: { persisted: true, persistedAgain: false, unauthorizedScopeWrite: [] },
      });
      const refreshRoutinePosture = await shared!.admin<
        {
          name: string;
          owner: string;
          table_owner: string;
          security_definer: boolean;
          search_path: string;
          lock_timeout: string | null;
          app_execute: boolean;
          public_execute: boolean;
        }[]
      >`
        select proc.proname as name,
          pg_get_userbyid(proc.proowner) as owner,
          pg_get_userbyid(connection_table.relowner) as table_owner,
          proc.prosecdef as security_definer,
          (select setting from unnest(proc.proconfig) setting
            where setting like 'search_path=%') as search_path,
          (select setting from unnest(proc.proconfig) setting
            where setting like 'lock_timeout=%') as lock_timeout,
          has_function_privilege('opengeni_app', proc.oid, 'EXECUTE') as app_execute,
          coalesce((
            select bool_or(acl_entry.grantee = 0 and acl_entry.privilege_type = 'EXECUTE')
            from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl_entry
          ), false) as public_execute
        from pg_proc proc
        join pg_namespace namespace on namespace.oid = proc.pronamespace
        join pg_class connection_table on connection_table.oid = 'subscription_connections'::regclass
        where namespace.nspname = 'opengeni_private'
          and proc.proname in (
            'authorize_subscription_ownerless_session_access',
            'authorize_subscription_personal_placement_access',
            'subscription_codex_refresh_write_allowed',
            'begin_subscription_codex_refresh',
            'persist_subscription_codex_refresh',
            'subscription_core_refresh_write_allowed',
            'begin_subscription_core_refresh',
            'persist_subscription_core_refresh'
          )
        order by proc.proname`;
      expect(refreshRoutinePosture).toHaveLength(8);
      for (const routine of refreshRoutinePosture) {
        expect(routine.owner).toBe(routine.table_owner);
        expect(routine.security_definer).toBe(true);
        expect(routine.search_path.split("search_path=")[1]?.split(", ")).toEqual(
          routine.name === "subscription_codex_refresh_write_allowed" ||
            routine.name === "subscription_core_refresh_write_allowed"
            ? ["pg_catalog", "opengeni_private", "pg_temp"]
            : ["pg_catalog", "public", "opengeni_private", "pg_temp"],
        );
        expect(routine.app_execute).toBe(true);
        expect(routine.public_execute).toBe(false);
        expect(routine.lock_timeout).toBe(
          routine.name === "persist_subscription_codex_refresh" ||
            routine.name === "persist_subscription_core_refresh"
            ? "lock_timeout=0"
            : null,
        );
      }
      const [persisted] = await shared!.admin<
        { credential_encrypted: string; refresh_generation: string; scope_kind: string }[]
      >`
        select credential_encrypted, refresh_generation, scope_kind
        from subscription_connections where account_id = ${state.accountId}::uuid
          and id = ${state.connectionId}::uuid`;
      expect(persisted).toMatchObject({
        credential_encrypted: refreshInput.credentialEncrypted,
        refresh_generation: "2",
        scope_kind: "organization",
      });

      // A wrong turn, lease holder, expired lease, co-member, or another
      // organization's connection cannot obtain refresh authorization at the
      // SQL boundary, and persist without authorization in the same
      // transaction is refused.
      const anotherOrganization = await fixture();
      const coreActor = {
        subjectId: "service:subscription-core",
        initiatingHumanSubjectId: state.subjectId,
      };
      const beginDirect = (
        overrides: Partial<typeof request> = {},
        directActor: { subjectId: string; initiatingHumanSubjectId: string | null } = coreActor,
      ) =>
        withSessionRlsActorContext(directActor, () =>
          withRlsContext(
            client!.db,
            { accountId: state.accountId, workspaceId: state.workspaceId },
            async (db) => {
              const attempt = { ...request, ...overrides };
              const rows = await rawRows(
                db,
                sql`select * from opengeni_private.begin_subscription_core_refresh(
                  'codex', ${attempt.accountId}::uuid, ${attempt.workspaceId}::uuid,
                  ${attempt.sessionId}::uuid, ${attempt.turnId}::uuid,
                  ${attempt.sessionOwnerSubjectId}, ${attempt.initiatingHumanSubjectId},
                  ${attempt.connectionId}::uuid, ${attempt.holderId}, ${attempt.generation}::bigint
                )`,
              );
              const wrote = await persistSubscriptionCodexRefresh(db, {
                ...refreshInput,
                ...overrides,
                expectedRefreshGeneration: 2,
              });
              return { authorized: rows.length === 1, persisted: wrote };
            },
          ),
        );
      const refused = { authorized: false, persisted: false };
      expect(await beginDirect({ turnId: crypto.randomUUID() })).toEqual(refused);
      expect(await beginDirect({ holderId: `foreign-${crypto.randomUUID()}` })).toEqual(refused);
      expect(await beginDirect({ generation: 2 })).toEqual(refused);
      expect(await beginDirect({ connectionId: anotherOrganization.connectionId })).toEqual(
        refused,
      );
      const standalonePersist = await withSessionRlsActorContext(coreActor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          (db) =>
            persistSubscriptionCodexRefresh(db, { ...refreshInput, expectedRefreshGeneration: 2 }),
        ),
      );
      expect(standalonePersist).toBe(false);

      await shared!.admin`
        update subscription_leases set leased_until = clock_timestamp() - interval '1 second'
        where account_id = ${state.accountId}::uuid and turn_id = ${state.turnId}::uuid`;
      expect(await beginDirect()).toEqual(refused);
      await shared!.admin`
        update subscription_leases set leased_until = clock_timestamp() + interval '1 minute'
        where account_id = ${state.accountId}::uuid and turn_id = ${state.turnId}::uuid`;

      // A workspace co-member cannot use another member's accepted turn.
      const coMemberSubject = `user:subscription-refresh-comember-${crypto.randomUUID()}`;
      const [personalWorkspace] = await shared!.admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${state.accountId}::uuid, 'Subscription refresh co-member')
        returning id::text as id`;
      await shared!.admin`
        insert into organization_memberships (
          account_id, subject_id, role, status, personal_workspace_id
        ) values (
          ${state.accountId}::uuid, ${coMemberSubject}, 'member', 'active', ${personalWorkspace!.id}::uuid
        )`;
      await shared!.admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role)
        values (${state.accountId}::uuid, ${state.workspaceId}::uuid, ${coMemberSubject}, 'member')`;
      expect(
        await beginDirect(
          {},
          { subjectId: coMemberSubject, initiatingHumanSubjectId: coMemberSubject },
        ),
      ).toEqual(refused);
      expect(
        await beginDirect(
          { initiatingHumanSubjectId: coMemberSubject },
          { subjectId: "service:subscription-core", initiatingHumanSubjectId: coMemberSubject },
        ),
      ).toEqual(refused);
      // The same request with the real owner is still authorized, proving the
      // refusals above came from the identity checks rather than the fixture.
      expect(await beginDirect()).toEqual({ authorized: true, persisted: true });
      const [unchanged] = await shared!.admin<
        { credential_encrypted: string; scope_kind: string }[]
      >`
        select credential_encrypted, scope_kind from subscription_connections
        where account_id = ${state.accountId}::uuid and id = ${state.connectionId}::uuid`;
      expect(unchanged).toMatchObject({
        credential_encrypted: refreshInput.credentialEncrypted,
        scope_kind: "organization",
      });
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "ownerless Codex refresh rejects a people-scoped connection despite prior owned-session access",
    async () => {
      const state = await fixture();
      const ownerless = await ownerlessFixture(state.accountId, state.workspaceId);
      const [membership] = await shared!.admin<{ id: string }[]>`
        select id::text as id from organization_memberships
        where account_id = ${state.accountId}::uuid and subject_id = ${state.subjectId}
          and status = 'active' and revoked_at is null limit 1`;
      const request = {
        accountId: state.accountId,
        workspaceId: state.workspaceId,
        sessionId: ownerless.sessionId,
        turnId: ownerless.turnId,
        sessionOwnerSubjectId: null,
        sessionOwnerMembershipId: null,
        initiatingHumanSubjectId: null,
        provider: "codex" as const,
        connectionId: state.connectionId,
        holderId: `ownerless-refresh-${crypto.randomUUID()}`,
        generation: 1,
      };
      const actor = {
        subjectId: "service:subscription-core",
        initiatingHumanSubjectId: null,
      };
      const lease = await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          (db) => acquireSubscriptionTurnLease(db, { ...request, ttlMs: 60_000 }),
        ),
      );
      expect(lease).toMatchObject({ turnId: ownerless.turnId, generation: 1 });

      // Model an administrator tightening a previously shared organization
      // connection after placement has already leased it.
      const scopeManagerSubject = `user:subscription-refresh-scope-admin-${crypto.randomUUID()}`;
      const [managerPersonalWorkspace] = await shared!.admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${state.accountId}::uuid, 'Subscription refresh scope manager Personal')
        returning id::text as id`;
      await shared!.admin`
        insert into organization_memberships (
          account_id, subject_id, role, status, personal_workspace_id
        ) values (
          ${state.accountId}::uuid, ${scopeManagerSubject}, 'admin', 'active',
          ${managerPersonalWorkspace!.id}::uuid
        )`;
      const changedScope = await withSessionRlsActorContext(
        { subjectId: scopeManagerSubject },
        () =>
          withRlsContext(
            client!.db,
            { accountId: state.accountId, workspaceId: state.workspaceId },
            async (db) => {
              const [row] = await rawRows<{ scope_kind: string }>(
                db,
                sql`update subscription_connections set scope_kind = 'people'
                where account_id = ${state.accountId}::uuid and id = ${state.connectionId}::uuid
                returning scope_kind`,
              );
              return row?.scope_kind;
            },
          ),
      );
      expect(changedScope).toBe("people");
      await shared!.admin`
        insert into subscription_connection_people (account_id, connection_id, organization_membership_id)
        values (${state.accountId}::uuid, ${state.connectionId}::uuid, ${membership!.id}::uuid)`;

      const transactionResult = await client!.db.transaction(async (transaction) => {
        const ownedSessionAuthorized = await withSessionRlsActorContext(
          { subjectId: state.subjectId, initiatingHumanSubjectId: state.subjectId },
          () =>
            withRlsContext(
              transaction as never,
              { accountId: state.accountId, workspaceId: state.workspaceId },
              async (db) => {
                const [row] = await rawRows<{ authorized: boolean }>(
                  db,
                  sql`select opengeni_private.authorize_subscription_session_access(
                    ${state.accountId}::uuid, ${state.workspaceId}::uuid,
                    ${state.sessionId}::uuid, ${state.turnId}::uuid,
                    ${state.subjectId}, ${state.subjectId}
                  ) as authorized`,
                );
                return row?.authorized === true;
              },
            ),
        );

        const refresh = await withSubscriptionCoreCodexRefreshLock(
          transaction as never,
          request,
          async (db) => {
            const [visibility] = await rawRows<{ visible: boolean }>(
              db,
              sql`select opengeni_private.subscription_connection_visible(
                ${state.accountId}::uuid, ${state.workspaceId}::uuid,
                ${state.connectionId}::uuid, 'shared', 'people', null, null, 'codex'
              ) as visible`,
            );
            const persisted = await persistSubscriptionCodexRefresh(db, {
              ...request,
              expectedRefreshGeneration: 1,
              credentialEncrypted: "v1:b3duZXJsZXNzLXRva2Vu:c2VjcmV0",
              expiresAt: new Date(Date.now() + 60 * 60_000),
              lastRefreshAt: new Date(),
            });
            return { visible: visibility?.visible === true, persisted };
          },
        );
        const [context] = await rawRows<{
          owner: string;
          human: string;
          refreshCapability: boolean;
        }>(
          transaction as never,
          sql`select current_setting('opengeni.session_owner_subject_id', true) as owner,
              current_setting('opengeni.turn_human_subject_id', true) as human,
              opengeni_private.subscription_core_refresh_write_allowed(
                'codex', ${state.accountId}::uuid, ${state.workspaceId}::uuid, ${state.connectionId}::uuid
              ) as "refreshCapability"`,
        );
        return { ownedSessionAuthorized, refresh, context };
      });

      expect(transactionResult).toMatchObject({
        ownedSessionAuthorized: true,
        // Ownerless refresh is refused before the provider call even though an
        // earlier owned-session capability in this transaction makes the
        // people-scoped row visible.
        refresh: { status: "refused" },
        context: { owner: "", human: "", refreshCapability: false },
      });
      const [unchanged] = await shared!.admin<
        { credential_encrypted: string; scope_kind: string }[]
      >`
        select credential_encrypted, scope_kind from subscription_connections
        where account_id = ${state.accountId}::uuid and id = ${state.connectionId}::uuid`;
      expect(unchanged).toMatchObject({
        credential_encrypted: "v1:test",
        scope_kind: "people",
      });
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "stores a rotated token even when the lease is released and visibility is revoked during the provider call",
    async () => {
      const state = await fixture();
      const actor = {
        subjectId: "service:subscription-refresh-race-test",
        initiatingHumanSubjectId: state.subjectId,
      };
      const [membership] = await shared!.admin<{ id: string }[]>`
        select id::text as id from organization_memberships
        where account_id = ${state.accountId}::uuid and subject_id = ${state.subjectId}
          and status = 'active' and revoked_at is null limit 1`;
      const request = {
        accountId: state.accountId,
        workspaceId: state.workspaceId,
        sessionId: state.sessionId,
        turnId: state.turnId,
        sessionOwnerSubjectId: state.subjectId,
        sessionOwnerMembershipId: membership!.id,
        initiatingHumanSubjectId: state.subjectId,
        provider: "codex" as const,
        connectionId: state.connectionId,
        holderId: `refresh-race-${crypto.randomUUID()}`,
        generation: 1,
      };
      const lease = await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          (db) => acquireSubscriptionTurnLease(db, { ...request, ttlMs: 60_000 }),
        ),
      );
      expect(lease).toMatchObject({ turnId: state.turnId, generation: 1 });

      let signalAuthorized!: () => void;
      let finishProviderCall!: () => void;
      const authorizedSignal = new Promise<void>((resolveSignal) => {
        signalAuthorized = resolveSignal;
      });
      const providerCall = new Promise<void>((resolveCall) => {
        finishProviderCall = resolveCall;
      });
      const rotated = "v1:cm90YXRlZC10b2tlbg==:c2VjcmV0";
      const scopeManagerSubject = `user:subscription-refresh-rotation-admin-${crypto.randomUUID()}`;
      const [managerPersonalWorkspace] = await shared!.admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${state.accountId}::uuid, 'Subscription refresh rotation admin Personal')
        returning id::text as id`;
      await shared!.admin`
        insert into organization_memberships (
          account_id, subject_id, role, status, personal_workspace_id
        ) values (
          ${state.accountId}::uuid, ${scopeManagerSubject}, 'admin', 'active',
          ${managerPersonalWorkspace!.id}::uuid
        )`;
      const withinFiveSeconds = <T>(work: Promise<T>, label: string) =>
        Promise.race([
          work,
          Bun.sleep(5_000).then(() => {
            throw new Error(`${label} waited on the in-flight refresh`);
          }),
        ]);
      // Production-style non-superuser owners, so the write really depends on
      // the refresh-only SELECT and UPDATE policies once visibility is revoked.
      const refreshResult = await withNonSuperuserRefreshOwners(async () => {
        const refreshPromise = withSubscriptionCoreCodexRefreshLock(
          client!.db,
          request,
          async (db, credential) => {
            signalAuthorized();
            // The provider has accepted the old refresh token and rotated it.
            await providerCall;
            return await persistSubscriptionCodexRefresh(db, {
              ...request,
              expectedRefreshGeneration: credential.refreshGeneration,
              credentialEncrypted: rotated,
              expiresAt: new Date(Date.now() + 60 * 60_000),
              lastRefreshAt: new Date(),
            });
          },
        );
        try {
          await authorizedSignal;
          // No row lock is held across the provider call: lease release and an
          // administrator revoking this workspace's access both complete.
          const released = await withinFiveSeconds(
            withSessionRlsActorContext(actor, () =>
              withRlsContext(
                client!.db,
                { accountId: state.accountId, workspaceId: state.workspaceId },
                (db) => releaseSubscriptionTurnLease(db, request),
              ),
            ),
            "lease release",
          );
          expect(released).toBe(true);
          const rescoped = await withinFiveSeconds(
            withSessionRlsActorContext({ subjectId: scopeManagerSubject }, () =>
              withRlsContext(
                client!.db,
                { accountId: state.accountId, workspaceId: state.workspaceId },
                async (db) => {
                  const [row] = await rawRows<{ scope_kind: string }>(
                    db,
                    sql`update subscription_connections set scope_kind = 'people'
                    where account_id = ${state.accountId}::uuid
                      and id = ${state.connectionId}::uuid
                    returning scope_kind`,
                  );
                  return row?.scope_kind;
                },
              ),
            ),
            "connection rescope",
          );
          expect(rescoped).toBe("people");
        } finally {
          finishProviderCall();
        }
        return await refreshPromise;
      });
      expect(refreshResult).toEqual({ status: "completed", value: true });
      const [stored] = await shared!.admin<
        { credential_encrypted: string; refresh_generation: string; scope_kind: string }[]
      >`
        select credential_encrypted, refresh_generation, scope_kind
        from subscription_connections
        where account_id = ${state.accountId}::uuid and id = ${state.connectionId}::uuid`;
      expect(stored).toEqual({
        credential_encrypted: rotated,
        refresh_generation: "2",
        scope_kind: "people",
      });
      // With the lease gone and access revoked, a new refresh is not authorized.
      const reacquired = await withSubscriptionCoreCodexRefreshLock(client!.db, request, async () =>
        Promise.resolve("must not run"),
      );
      expect(reacquired.status).not.toBe("completed");
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "ownerless turns refresh a shared organization connection they lease",
    async () => {
      const state = await fixture();
      const ownerless = await ownerlessFixture(state.accountId, state.workspaceId);
      const request = {
        accountId: state.accountId,
        workspaceId: state.workspaceId,
        sessionId: ownerless.sessionId,
        turnId: ownerless.turnId,
        sessionOwnerSubjectId: null,
        sessionOwnerMembershipId: null,
        initiatingHumanSubjectId: null,
        provider: "codex" as const,
        connectionId: state.connectionId,
        holderId: `ownerless-refresh-ok-${crypto.randomUUID()}`,
        generation: 1,
      };
      expect(
        await withSessionRlsActorContext(
          { subjectId: "service:subscription-core", initiatingHumanSubjectId: null },
          () =>
            withRlsContext(
              client!.db,
              { accountId: state.accountId, workspaceId: state.workspaceId },
              (db) => acquireSubscriptionTurnLease(db, { ...request, ttlMs: 60_000 }),
            ),
        ),
      ).toMatchObject({ turnId: ownerless.turnId, generation: 1 });
      const rotated = "v1:b3duZXJsZXNzLW9r:c2VjcmV0";
      const refreshed = await withNonSuperuserRefreshOwners(() =>
        withSubscriptionCoreCodexRefreshLock(client!.db, request, async (db, credential) =>
          persistSubscriptionCodexRefresh(db, {
            ...request,
            expectedRefreshGeneration: credential.refreshGeneration,
            credentialEncrypted: rotated,
            expiresAt: null,
            lastRefreshAt: new Date(),
          }),
        ),
      );
      expect(refreshed).toEqual({ status: "completed", value: true });
      const [stored] = await shared!.admin<
        { credential_encrypted: string; refresh_generation: string; version: number }[]
      >`
        select credential_encrypted, refresh_generation::text, version from subscription_connections
        where account_id = ${state.accountId}::uuid and id = ${state.connectionId}::uuid`;
      // A refresh is not a metadata edit: the optimistic-concurrency version stays.
      expect(stored).toEqual({
        credential_encrypted: rotated,
        refresh_generation: "2",
        version: 1,
      });
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "credential writers always advance refresh_generation, so an in-flight refresh cannot overwrite them",
    async () => {
      const state = await fixture();
      const [membership] = await shared!.admin<{ id: string }[]>`
        select id::text as id from organization_memberships
        where account_id = ${state.accountId}::uuid and subject_id = ${state.subjectId}
          and status = 'active' and revoked_at is null limit 1`;
      const request = {
        accountId: state.accountId,
        workspaceId: state.workspaceId,
        sessionId: state.sessionId,
        turnId: state.turnId,
        sessionOwnerSubjectId: state.subjectId,
        sessionOwnerMembershipId: membership!.id,
        initiatingHumanSubjectId: state.subjectId,
        provider: "codex" as const,
        connectionId: state.connectionId,
        holderId: `refresh-writer-${crypto.randomUUID()}`,
        generation: 1,
      };
      const actor = {
        subjectId: "service:subscription-core",
        initiatingHumanSubjectId: state.subjectId,
      };
      expect(
        await withSessionRlsActorContext(actor, () =>
          withRlsContext(
            client!.db,
            { accountId: state.accountId, workspaceId: state.workspaceId },
            (db) => acquireSubscriptionTurnLease(db, { ...request, ttlMs: 60_000 }),
          ),
        ),
      ).toMatchObject({ generation: 1 });
      const adminSubject = `user:subscription-refresh-writer-admin-${crypto.randomUUID()}`;
      const [adminPersonal] = await shared!.admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${state.accountId}::uuid, 'Subscription refresh writer admin Personal')
        returning id::text as id`;
      await shared!.admin`
        insert into organization_memberships (
          account_id, subject_id, role, status, personal_workspace_id
        ) values (
          ${state.accountId}::uuid, ${adminSubject}, 'admin', 'active', ${adminPersonal!.id}::uuid
        )`;
      const asAdmin = <T>(work: (db: Parameters<typeof rawRows>[0]) => Promise<T>) =>
        withSessionRlsActorContext({ subjectId: adminSubject }, () =>
          withRlsContext(
            client!.db,
            { accountId: state.accountId, workspaceId: state.workspaceId },
            work,
          ),
        );
      const replaced = "v1:YWRtaW4tcmVwbGFjZWQ=:c2VjcmV0";

      // An administrator replaces the credential while a refresh is in flight.
      const refresh = await withSubscriptionCoreCodexRefreshLock(
        client!.db,
        request,
        async (db, credential) => {
          const [adminWrite] = await asAdmin((adminDb) =>
            rawRows<{ refresh_generation: string }>(
              adminDb,
              sql`update subscription_connections set credential_encrypted = ${replaced}
                where account_id = ${state.accountId}::uuid and id = ${state.connectionId}::uuid
                returning refresh_generation::text`,
            ),
          );
          const persisted = await persistSubscriptionCodexRefresh(db, {
            ...request,
            expectedRefreshGeneration: credential.refreshGeneration,
            credentialEncrypted: "v1:c3RhbGUtcm90YXRpb24=:c2VjcmV0",
            expiresAt: null,
            lastRefreshAt: new Date(),
          });
          return { adminGeneration: adminWrite?.refresh_generation, persisted };
        },
      );
      expect(refresh).toEqual({
        status: "completed",
        value: { adminGeneration: "2", persisted: false },
      });

      let rewindError: unknown;
      try {
        await asAdmin((adminDb) =>
          rawRows(
            adminDb,
            sql`update subscription_connections set refresh_generation = 1
              where account_id = ${state.accountId}::uuid and id = ${state.connectionId}::uuid`,
          ),
        );
      } catch (error) {
        rewindError = error;
      }
      expect(String((rewindError as { cause?: unknown } | undefined)?.cause)).toContain(
        "refresh generation cannot move backwards",
      );
      const adminWriteError = async (statement: ReturnType<typeof sql>) => {
        try {
          await asAdmin((adminDb) => rawRows(adminDb, statement));
          return null;
        } catch (error) {
          return String((error as { cause?: unknown }).cause ?? error);
        }
      };
      // No write may skip generations, so the generation stays a
      // JavaScript-safe integer and callers' compare-and-swap never rounds.
      expect(
        await adminWriteError(sql`update subscription_connections
          set credential_encrypted = 'v1:c2tpcA==:c2VjcmV0', refresh_generation = 4
          where account_id = ${state.accountId}::uuid and id = ${state.connectionId}::uuid`),
      ).toContain("refresh generation advances by at most one per write");
      expect(
        await adminWriteError(sql`update subscription_connections
          set refresh_generation = 9007199254740992
          where account_id = ${state.accountId}::uuid and id = ${state.connectionId}::uuid`),
      ).toContain("refresh generation advances by at most one per write");
      // The safe-integer CHECK still backs the trigger for any other writer.
      const [bound] = await shared!.admin<{ present: boolean }[]>`
        select exists (
          select 1 from pg_constraint
          where conname = 'subscription_connections_refresh_generation_safe_chk'
            and convalidated
        ) as present`;
      expect(bound?.present).toBe(true);
      const [stored] = await shared!.admin<
        { credential_encrypted: string; refresh_generation: string; version: number }[]
      >`
        select credential_encrypted, refresh_generation::text, version
        from subscription_connections
        where account_id = ${state.accountId}::uuid and id = ${state.connectionId}::uuid`;
      expect(stored).toEqual({
        credential_encrypted: replaced,
        refresh_generation: "2",
        version: 1,
      });
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "personal Codex refresh needs frozen owner authority and current settings, and leaves other capabilities untouched",
    async () => {
      const state = await fixture();
      const [membership] = await shared!.admin<{ id: string; personal_workspace_id: string }[]>`
        select id::text as id, personal_workspace_id::text as personal_workspace_id
        from organization_memberships
        where account_id = ${state.accountId}::uuid and subject_id = ${state.subjectId}
          and status = 'active' and revoked_at is null limit 1`;
      const personalWorkspaceId = membership!.personal_workspace_id;
      const personalSession = await withSessionRlsActorContext({ subjectId: state.subjectId }, () =>
        createSession(client!.db, {
          accountId: state.accountId,
          workspaceId: personalWorkspaceId,
          initialMessage: "personal refresh fixture",
          resources: [],
          metadata: {},
          model: "fixture-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          createdBy: { kind: "subject", subjectId: state.subjectId },
          createdByContext: {},
        }),
      );
      const personalTurn = await withSessionRlsActorContext({ subjectId: state.subjectId }, () =>
        enqueueSessionTurn(client!.db, {
          accountId: state.accountId,
          workspaceId: personalWorkspaceId,
          sessionId: personalSession.id,
          triggerEventId: crypto.randomUUID(),
          temporalWorkflowId: `personal-refresh-${personalSession.id}`,
          source: "user",
          prompt: "personal refresh fixture",
          resources: [],
          tools: [],
          model: "fixture-model",
          reasoningEffort: "medium",
          sandboxBackend: "none",
          metadata: {},
          initiator: { kind: "subject", subjectId: state.subjectId },
        }),
      );
      const connectionId = crypto.randomUUID();
      const authorityId = crypto.randomUUID();
      await shared!.admin`
        insert into organization_user_resource_authorities (
          id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
        ) values (
          ${authorityId}::uuid, ${state.accountId}::uuid, ${membership!.id}::uuid,
          'subscription_connection', ${connectionId}::uuid, 1, 'active'
        )`;
      await shared!.admin`
        insert into subscription_connections (
          id, account_id, provider, credential_encrypted, ownership, scope_kind,
          owner_organization_membership_id, owner_subject_id, authority_id,
          authority_resource_kind, authority_generation
        ) values (
          ${connectionId}::uuid, ${state.accountId}::uuid, 'codex', 'v1:personal-refresh',
          'personal', 'people', ${membership!.id}::uuid, ${state.subjectId}, ${authorityId}::uuid,
          'subscription_connection', 1
        )`;
      await shared!.admin`
        insert into subscription_settings (
          account_id, rotation, providers, cross_provider_failover, fallback_order,
          personal_connections_allowed, personal_fallback_allowed
        ) values (
          ${state.accountId}::uuid, '{}'::jsonb, '{}'::jsonb, false, '{}'::jsonb, true, true
        ) on conflict (account_id, workspace_id) do update
          set personal_connections_allowed = true`;
      // The accepted turn froze the owner's personal Codex authority (v1 stays
      // authoritative until the drained cutover replaces the helper's source).
      // The snapshot is immutable after acceptance, so this fixture writes it
      // as the table owner with the immutability trigger briefly disabled.
      await shared!.admin.begin(async (tx) => {
        await tx.unsafe(
          "alter table session_turns disable trigger session_turns_codex_authority_snapshot_immutable_trg",
        );
        await tx`
          update session_turns
          set codex_provider_account_authority_snapshot =
            '{"version":1,"scope":"user","authorityGeneration":1}'::jsonb
          where account_id = ${state.accountId}::uuid and id = ${personalTurn.id}::uuid`;
        await tx.unsafe(
          "alter table session_turns enable trigger session_turns_codex_authority_snapshot_immutable_trg",
        );
      });
      const request = {
        accountId: state.accountId,
        workspaceId: personalWorkspaceId,
        sessionId: personalSession.id,
        turnId: personalTurn.id,
        sessionOwnerSubjectId: state.subjectId,
        sessionOwnerMembershipId: membership!.id,
        initiatingHumanSubjectId: state.subjectId,
        provider: "codex" as const,
        connectionId,
        holderId: `personal-refresh-${crypto.randomUUID()}`,
        generation: 1,
      };
      const actor = {
        subjectId: "service:subscription-core",
        initiatingHumanSubjectId: state.subjectId,
      };
      expect(
        await withSessionRlsActorContext(actor, () =>
          withRlsContext(
            client!.db,
            { accountId: state.accountId, workspaceId: personalWorkspaceId },
            (db) => acquireSubscriptionTurnLease(db, { ...request, ttlMs: 60_000 }),
          ),
        ),
      ).toMatchObject({ generation: 1 });
      const refreshOnce = (credentialEncrypted: string) =>
        withSubscriptionCoreCodexRefreshLock(client!.db, request, async (db, credential) =>
          persistSubscriptionCodexRefresh(db, {
            ...request,
            expectedRefreshGeneration: credential.refreshGeneration,
            credentialEncrypted,
            expiresAt: null,
            lastRefreshAt: new Date(),
          }),
        );

      expect(await refreshOnce("v1:cGVyc29uYWwtb25l:c2VjcmV0")).toEqual({
        status: "completed",
        value: true,
      });

      // Disabling personal connections stops further personal refreshes, even
      // for a turn that still holds a live lease.
      await shared!.admin`
        update subscription_settings set personal_connections_allowed = false
        where account_id = ${state.accountId}::uuid and workspace_id is null`;
      expect(await refreshOnce("v1:cGVyc29uYWwtdHdv:c2VjcmV0")).toEqual({ status: "refused" });
      await shared!.admin`
        update subscription_settings set personal_connections_allowed = true
        where account_id = ${state.accountId}::uuid and workspace_id is null`;

      // A capability another turn holds for the same connection in this
      // transaction is neither rebound nor deleted; refresh fails closed.
      const probeSuffix = crypto.randomUUID().replaceAll("-", "_");
      const seedProbe = `opengeni_private.test_seed_personal_${probeSuffix}`;
      const readProbe = `opengeni_private.test_read_personal_${probeSuffix}`;
      await shared!.admin.unsafe(`
        create function ${seedProbe}(
          p_account uuid, p_workspace uuid, p_session uuid, p_turn uuid,
          p_connection uuid, p_owner text
        ) returns void language sql security definer
        set search_path = pg_catalog, opengeni_private, pg_temp as $probe$
          insert into opengeni_private.subscription_runtime_capabilities (
            backend_pid, transaction_id, capability_kind, account_id, workspace_id,
            session_id, turn_id, connection_id, provider,
            session_owner_subject_id, turn_human_subject_id
          ) values (
            pg_backend_pid(), pg_current_xact_id(), 'personal_access', p_account, p_workspace,
            p_session, p_turn, p_connection, 'codex', p_owner, p_owner
          );
        $probe$;
        create function ${readProbe}(p_account uuid, p_connection uuid)
        returns uuid language sql security definer
        set search_path = pg_catalog, opengeni_private, pg_temp as $probe$
          select capability.turn_id from opengeni_private.subscription_runtime_capabilities capability
          where capability.backend_pid = pg_backend_pid()
            and capability.transaction_id = pg_current_xact_id_if_assigned()
            and capability.capability_kind = 'personal_access'
            and capability.account_id = p_account and capability.connection_id = p_connection;
        $probe$;
        grant execute on function ${seedProbe}(uuid, uuid, uuid, uuid, uuid, text) to opengeni_app;
        grant execute on function ${readProbe}(uuid, uuid) to opengeni_app;
      `);
      const otherTurnId = crypto.randomUUID();
      try {
        const observed = await client!.db.transaction(async (transaction) => {
          await transaction.execute(sql`select ${sql.raw(seedProbe)}(
            ${state.accountId}::uuid, ${personalWorkspaceId}::uuid, ${personalSession.id}::uuid,
            ${otherTurnId}::uuid, ${connectionId}::uuid, ${state.subjectId}
          )`);
          const refreshed = await withSubscriptionCoreCodexRefreshLock(
            transaction as never,
            request,
            async () => "must not run",
          );
          const [held] = await rawRows<{ turn_id: string | null }>(
            transaction as never,
            sql`select ${sql.raw(readProbe)}(${state.accountId}::uuid, ${connectionId}::uuid)::text as turn_id`,
          );
          return { refreshed, heldTurnId: held?.turn_id ?? null };
        });
        expect(observed).toEqual({ refreshed: { status: "refused" }, heldTurnId: otherTurnId });
      } finally {
        await shared!.admin.unsafe(`
          drop function if exists ${seedProbe}(uuid, uuid, uuid, uuid, uuid, text);
          drop function if exists ${readProbe}(uuid, uuid);
        `);
      }
      const [stored] = await shared!.admin<{ credential_encrypted: string }[]>`
        select credential_encrypted from subscription_connections
        where account_id = ${state.accountId}::uuid and id = ${connectionId}::uuid`;
      expect(stored?.credential_encrypted).toBe("v1:cGVyc29uYWwtb25l:c2VjcmV0");
    },
    180_000,
  );
});
