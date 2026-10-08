import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
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
  markSubscriptionCapacityWakeDelivered,
  observeSubscriptionCapacityWaiterWake,
  readSubscriptionSessionBinding,
  writeSubscriptionSessionBinding,
  releaseSubscriptionOperationLease,
  releaseSubscriptionTurnLease,
  renewSubscriptionOperationLease,
  renewSubscriptionTurnLease,
  upsertSubscriptionCapacityWaiter,
  wakeSubscriptionCapacityWaiter,
  withRlsContext,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { withPoolWakeServiceScopeInTransaction } from "../src/subscription-session-access";

setDefaultTimeout(180_000);
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

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

describe("provider-neutral subscription runtime persistence", () => {
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
      await shared!.admin`
        insert into subscription_provider_cutovers (account_id, provider, enabled)
        values (${state.accountId}::uuid, 'codex', true)`;

      await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: state.accountId, workspaceId: state.workspaceId },
          async (db) => {
            expect(
              await isSubscriptionProviderCutoverEnabled(db, {
                accountId: state.accountId,
                provider: "codex",
              }),
            ).toBe(true);
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
});
