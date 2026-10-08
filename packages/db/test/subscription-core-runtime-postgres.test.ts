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

async function fixture() {
  const userId = `subscription-runtime-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Subscription runtime fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const workspaceId = access.workspaceGrants[0]!.workspaceId!;
  const subjectId = `user:${userId}`;
  const [connection] = await shared!.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, credential_encrypted, ownership, scope_kind
    ) values (${accountId}::uuid, 'codex', 'v1:test', 'shared', 'organization')
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
      const operationLease = await withSessionRlsActorContext(actor, () =>
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
        humanTurn: false,
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
      }) => {
        let observed:
          | { authorized: boolean; visible: boolean; owner: string | null; human: string | null }
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
                          observed = {
                            authorized: authorization?.authorized === true,
                            visible: visibility?.visible === true,
                            owner: context?.owner ?? null,
                            human: context?.human ?? null,
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
      });
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
      const leaseInput = (operationId: string) => ({
        accountId: state.accountId,
        workspaceId: state.workspaceId,
        operationId,
        attemptId: crypto.randomUUID(),
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
      expect(unassigned[0]?.assignmentPolicies).toEqual([]);
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
        withSubscriptionCoreCodexRefreshLock(client!.db, request, async (db) => {
          const persisted = await persistSubscriptionCodexRefresh(db, {
            ...request,
            initiatingHumanSubjectId: null,
            expectedRefreshGeneration: 1,
            credentialEncrypted: "v1:c2VydmljZS10b2tlbg==:c2VjcmV0",
            expiresAt: new Date(Date.now() + 60 * 60_000),
            lastRefreshAt: new Date(),
          });
          const unauthorizedScopeWrite = await db.execute(sql`
            update subscription_connections set scope_kind = 'workspaces'
            where account_id = ${state.accountId}::uuid and id = ${state.connectionId}::uuid
            returning id`);
          return { persisted, unauthorizedScopeWrite };
        }),
      );
      expect(result).toMatchObject({
        status: "completed",
        value: { persisted: true, unauthorizedScopeWrite: [] },
      });
    },
    180_000,
  );

  test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
    "Codex token refresh writes require the exact live turn lease and cannot authorize other column writes",
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

      // Exercise UPDATE RLS as the production-style table/function owner. A
      // superuser-owned fixture bypasses FORCE RLS and would miss a missing
      // refresh capability before SELECT ... FOR UPDATE.
      const probeRole = `subscription_refresh_owner_${crypto.randomUUID().replaceAll("-", "_")}`;
      const [originalOwners] = await shared!.admin<
        {
          connectionOwner: string;
          capabilityOwner: string;
          refreshPolicyOwner: string;
          persistOwner: string;
        }[]
      >`
        select pg_get_userbyid(connection.relowner) as "connectionOwner",
          pg_get_userbyid(capability.relowner) as "capabilityOwner",
          pg_get_userbyid(refresh_policy.proowner) as "refreshPolicyOwner",
          pg_get_userbyid(persist.proowner) as "persistOwner"
        from pg_class connection
        join pg_namespace connection_schema on connection_schema.oid = connection.relnamespace
          and connection_schema.nspname = current_schema()
        join pg_class capability on capability.oid =
          'opengeni_private.subscription_runtime_capabilities'::regclass
        join pg_proc persist on persist.oid = pg_catalog.to_regprocedure(
          'opengeni_private.persist_subscription_codex_refresh(uuid,uuid,uuid,uuid,text,text,uuid,text,bigint,bigint,text,timestamptz,timestamptz)'
        )
        join pg_proc refresh_policy on refresh_policy.oid = pg_catalog.to_regprocedure(
          'opengeni_private.subscription_codex_refresh_write_allowed(uuid,uuid,uuid)'
        )
        where connection.relname = 'subscription_connections'`;
      expect(originalOwners).toBeDefined();
      let refreshed: Awaited<ReturnType<typeof withSubscriptionCoreCodexRefreshLock>>;
      try {
        await shared!.admin.unsafe(`
          create role ${probeRole} nosuperuser nobypassrls nologin;
          grant create, usage on schema public, opengeni_private to ${probeRole};
          grant all privileges on all tables in schema public, opengeni_private to ${probeRole};
          grant all privileges on all sequences in schema public, opengeni_private to ${probeRole};
          grant execute on all functions in schema public, opengeni_private to ${probeRole};
          alter table subscription_connections owner to ${probeRole};
          alter table opengeni_private.subscription_runtime_capabilities owner to ${probeRole};
          alter function opengeni_private.subscription_codex_refresh_write_allowed(uuid,uuid,uuid)
            owner to ${probeRole};
          alter function opengeni_private.persist_subscription_codex_refresh(
            uuid,uuid,uuid,uuid,text,text,uuid,text,bigint,bigint,text,timestamptz,timestamptz
          ) owner to ${probeRole};
        `);

        refreshed = await withSubscriptionCoreCodexRefreshLock(client!.db, request, async (db) => {
          const persisted = await persistSubscriptionCodexRefresh(db, refreshInput);
          const unauthorizedScopeWrite = await db.execute(sql`
              update subscription_connections set scope_kind = 'workspaces'
              where account_id = ${state.accountId}::uuid and id = ${state.connectionId}::uuid
              returning id
            `);
          return { persisted, unauthorizedScopeWrite };
        });
      } finally {
        if (originalOwners) {
          await shared!.admin.unsafe(`
            alter function opengeni_private.persist_subscription_codex_refresh(
              uuid,uuid,uuid,uuid,text,text,uuid,text,bigint,bigint,text,timestamptz,timestamptz
            ) owner to ${originalOwners.persistOwner};
            alter function opengeni_private.subscription_codex_refresh_write_allowed(uuid,uuid,uuid)
              owner to ${originalOwners.refreshPolicyOwner};
            alter table opengeni_private.subscription_runtime_capabilities
              owner to ${originalOwners.capabilityOwner};
            alter table subscription_connections owner to ${originalOwners.connectionOwner};
            drop owned by ${probeRole};
            drop role if exists ${probeRole};
          `);
        }
      }
      expect(refreshed).toMatchObject({
        status: "completed",
        value: { persisted: true, unauthorizedScopeWrite: [] },
      });
      const refreshRoutinePosture = await shared!.admin<
        {
          name: string;
          owner: string;
          table_owner: string;
          security_definer: boolean;
          search_path: string;
          app_execute: boolean;
          public_execute: boolean;
        }[]
      >`
        select proc.proname as name,
          pg_get_userbyid(proc.proowner) as owner,
          pg_get_userbyid(connection_table.relowner) as table_owner,
          proc.prosecdef as security_definer,
          array_to_string(proc.proconfig, ',') as search_path,
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
            'persist_subscription_codex_refresh'
          )
        order by proc.proname`;
      expect(refreshRoutinePosture).toHaveLength(4);
      for (const routine of refreshRoutinePosture) {
        expect(routine.owner).toBe(routine.table_owner);
        expect(routine.security_definer).toBe(true);
        expect(routine.search_path.split("search_path=")[1]?.split(", ")).toEqual(
          routine.name === "subscription_codex_refresh_write_allowed"
            ? ["pg_catalog", "opengeni_private", "pg_temp"]
            : ["pg_catalog", "public", "opengeni_private", "pg_temp"],
        );
        expect(routine.app_execute).toBe(true);
        expect(routine.public_execute).toBe(false);
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

      // A wrong turn, lease holder, or another organization's connection
      // cannot reuse the refresh API, even while the caller has session access.
      const anotherOrganization = await fixture();
      const wrongTurn = await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          (db) =>
            persistSubscriptionCodexRefresh(db, {
              ...refreshInput,
              expectedRefreshGeneration: 2,
              turnId: crypto.randomUUID(),
            }),
        ),
      );
      expect(wrongTurn).toBe(false);
      const foreignLease = await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          (db) =>
            persistSubscriptionCodexRefresh(db, {
              ...refreshInput,
              expectedRefreshGeneration: 2,
              holderId: `foreign-${crypto.randomUUID()}`,
            }),
        ),
      );
      expect(foreignLease).toBe(false);
      const otherOrganizationConnection = await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          (db) =>
            persistSubscriptionCodexRefresh(db, {
              ...refreshInput,
              expectedRefreshGeneration: 2,
              connectionId: anotherOrganization.connectionId,
            }),
        ),
      );
      expect(otherOrganizationConnection).toBe(false);

      await shared!.admin`
        update subscription_leases set leased_until = clock_timestamp() - interval '1 second'
        where account_id = ${state.accountId}::uuid and turn_id = ${state.turnId}::uuid`;
      const expiredLease = await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          (db) =>
            persistSubscriptionCodexRefresh(db, {
              ...refreshInput,
              expectedRefreshGeneration: 2,
            }),
        ),
      );
      expect(expiredLease).toBe(false);

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
      const coMemberRefresh = await withSessionRlsActorContext(
        { subjectId: coMemberSubject, initiatingHumanSubjectId: coMemberSubject },
        () =>
          withRlsContext(
            client!.db,
            { accountId: state.accountId, workspaceId: state.workspaceId },
            (db) =>
              persistSubscriptionCodexRefresh(db, {
                ...refreshInput,
                expectedRefreshGeneration: 2,
              }),
          ),
      );
      expect(coMemberRefresh).toBe(false);
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
    "holds the accepted lease row through refresh so concurrent release cannot race the write",
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

      let signalPersisted!: () => void;
      let releaseRefresh!: () => void;
      const persistedSignal = new Promise<void>((resolveSignal) => {
        signalPersisted = resolveSignal;
      });
      const holdRefresh = new Promise<void>((resolveHold) => {
        releaseRefresh = resolveHold;
      });
      const refreshPromise = withSubscriptionCoreCodexRefreshLock(
        client!.db,
        request,
        async (db) => {
          const persisted = await persistSubscriptionCodexRefresh(db, {
            ...request,
            expectedRefreshGeneration: 1,
            credentialEncrypted: "v1:cmFjZS10b2tlbg==:c2VjcmV0",
            expiresAt: new Date(Date.now() + 60 * 60_000),
            lastRefreshAt: new Date(),
          });
          signalPersisted();
          await holdRefresh;
          return persisted;
        },
      );
      await persistedSignal;
      const releasePromise = withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          (db) => releaseSubscriptionTurnLease(db, request),
        ),
      );
      let releaseIsBlocked = false;
      try {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const [waiter] = await shared!.admin<{ blocked: boolean }[]>`
            select exists (
              select 1 from pg_stat_activity
              where datname = current_database() and state = 'active'
                and wait_event_type = 'Lock'
                and query ilike 'delete from subscription_leases%'
            ) as blocked`;
          if (waiter?.blocked) {
            releaseIsBlocked = true;
            break;
          }
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        }
        expect(releaseIsBlocked).toBe(true);
      } finally {
        releaseRefresh();
      }
      const [refresh, released] = await Promise.all([refreshPromise, releasePromise]);
      expect(refresh).toMatchObject({ status: "completed", value: true });
      expect(released).toBe(true);
    },
    180_000,
  );
});
