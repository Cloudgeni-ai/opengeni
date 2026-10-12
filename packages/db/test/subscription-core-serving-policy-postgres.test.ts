import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import { readTurnExecutionPolicyV1, readTurnPendingServingPolicyV1 } from "@opengeni/contracts";
import { acceptedPolicy, servingRevision } from "../../contracts/test/fixtures/turn-serving-policy";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  getSessionTurn,
  requestSessionTurnRecovery,
  withRlsContext,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { rawRows } from "../src/database";
import { sessionHistoryItems } from "../src/schema";
import {
  recordSubscriptionCoreServingPolicyForTurnAttempt as record,
  readSubscriptionCoreServingPolicyForTurn as read,
  countSubscriptionCoreTurnServingPolicyChanges as count,
  stageSubscriptionCorePendingServingPolicyTx,
} from "../src/subscription-core/serving-policy";
import { lockTurnAttemptWriteFenceTx } from "../src/session-attempt-fence";
import {
  acquireSubscriptionTurnLease,
  writeSubscriptionSessionBinding,
} from "../src/subscription-core-repository";
import { withSubscriptionCoreAcceptedTurn } from "../src/subscription-core-placement-world";
import { readSubscriptionCoreTurnIdentity } from "../src/subscription-core/turns";
import { subscriptionCoreRequests } from "../src/subscription-core/requests";
import { subscriptionCoreCodexProvider } from "../src/subscription-core-codex-adapter";

let shared: SharedTestDatabase;
let client: DbClient;
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
beforeAll(async () => {
  if (!realDb) return;
  const acquired = await acquireSharedTestDatabase("subscription-core-serving-policy");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  const databaseName = new URL(shared.appUrl).pathname.slice(1);
  await shared.admin`alter database ${shared.admin(databaseName)} set lock_timeout = '5s'`;
  await shared.admin`alter database ${shared.admin(databaseName)} set statement_timeout = '15s'`;
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function fixture(
  metadata: Record<string, unknown> = {
    turnExecutionPolicyV1: acceptedPolicy,
    unrelated: "preserve",
  },
  organization?: { accountId: string; subjectId: string },
) {
  const userId = `serving-${crypto.randomUUID()}`;
  const accountId =
    organization?.accountId ??
    (
      await ensureManagedAccessForUser(client.db, {
        userId,
        email: `${userId}@example.test`,
        name: "Serving fixture",
      })
    ).workspaceGrants[0]!.accountId;
  const subjectId = organization?.subjectId ?? `user:${userId}`;
  const [workspace] = await shared.admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${accountId}::uuid, 'Serving fixture') returning id::text`;
  const workspaceId = workspace!.id;
  await shared.admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role) values (${accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, 'owner')`;
  await shared.admin`insert into workspace_inference_controls (account_id, workspace_id) values (${accountId}::uuid, ${workspaceId}::uuid)`;
  const session = await withSessionRlsActorContext({ subjectId }, () =>
    createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: "Serving fixture",
      resources: [],
      metadata: {},
      model: acceptedPolicy.productModelId,
      reasoningEffort: "high",
      latencyMode: "standard",
      sandboxBackend: "none",
      subjectId,
      createdBy: { kind: "subject", subjectId },
      createdByContext: {},
    }),
  );
  const turn = await withSessionRlsActorContext({ subjectId }, () =>
    enqueueSessionTurn(client.db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${session.id}`,
      source: "user",
      prompt: "Serving fixture",
      resources: [],
      tools: [],
      model: acceptedPolicy.productModelId,
      reasoningEffort: "high",
      sandboxBackend: "none",
      metadata,
      initiator: { kind: "subject", subjectId },
    }),
  );
  const scope = { accountId, workspaceId, sessionId: session.id, turnId: turn.id };
  const attempt = await claim(scope);
  return { ...scope, ...attempt, subjectId, ...servingInput() };
}

function servingInput() {
  const revision = servingRevision();
  return {
    policy: revision.policy,
    connectionId: revision.connectionId,
    reason: revision.reason,
    crossProviderFailoverEnabled: true,
  };
}

async function claim(scope: { workspaceId: string; sessionId: string }) {
  const attemptId = crypto.randomUUID();
  const result = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
    sessionId: scope.sessionId,
    workflowId: `session-${scope.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (result.action !== "claimed") throw new Error(`Claim refused: ${result.reason}`);
  return { attemptId, executionGeneration: result.turn.executionGeneration };
}

async function recover(input: Awaited<ReturnType<typeof fixture>>) {
  expect(
    await requestSessionTurnRecovery(client.db, input.workspaceId, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      attemptId: input.attemptId,
      triggerEventId: crypto.randomUUID(),
      reason: "worker_shutdown",
    }),
  ).toMatchObject({ action: "recovering" });
  return { ...input, ...(await claim(input)) };
}

async function stage(input: Awaited<ReturnType<typeof fixture>>) {
  return withRlsContext(client.db, input, async (tx) => {
    const fence = await lockTurnAttemptWriteFenceTx(tx, input);
    if (!fence.allowed) throw new Error("Expected recovery write fence");
    return stageSubscriptionCorePendingServingPolicyTx(tx, input, fence);
  });
}

async function history(
  input: Awaited<ReturnType<typeof fixture>>,
  position: number,
  active = true,
) {
  await withRlsContext(client.db, input, async (tx) => {
    await tx.insert(sessionHistoryItems).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      position,
      active,
      item: { type: "message", role: "assistant", content: `history ${position}` },
    });
  });
}

describe.skipIf(!realDb)("serving revisions on real PostgreSQL as the non-owner app role", () => {
  test("D-37 stale generation and attempt cannot record", async () => {
    const input = await fixture();
    expect(
      await record(client.db, { ...input, executionGeneration: input.executionGeneration + 1 }),
    ).toEqual({ accepted: false, reason: "generation_changed" });
    expect(await record(client.db, { ...input, attemptId: crypto.randomUUID() })).toMatchObject({
      accepted: false,
    });
    expect(await read(client.db, input)).toEqual({ kind: "absent" });
    const next = await recover(input);
    expect(await record(client.db, input)).toEqual({
      accepted: false,
      reason: "generation_changed",
    });
    expect(await record(client.db, next)).toMatchObject({ accepted: true, installed: true });
  }, 180_000);

  test("D-37 idempotent retry retains the original history boundary and immutable accepted policy", async () => {
    const input = await fixture();
    await history(input, 101.5, false);
    const first = await record(client.db, input);
    expect(first).toMatchObject({
      accepted: true,
      installed: true,
      revision: { historyPosition: 101.5 },
    });
    if (!first.accepted) throw new Error("Expected serving receipt");
    await history(input, 102);
    expect(await record(client.db, input)).toEqual({ ...first, installed: false });
    await expect(
      record(client.db, { ...input, connectionId: crypto.randomUUID() }),
    ).rejects.toThrow("Conflicting");
    const result = await read(client.db, input);
    expect(result?.kind).toBe("valid");
    if (result?.kind === "valid") expect(result.revisions).toHaveLength(1);
    const turn = await getSessionTurn(client.db, input.workspaceId, input.turnId);
    expect(readTurnExecutionPolicyV1(turn!.metadata)).toEqual({
      kind: "valid",
      policy: acceptedPolicy,
    });
    expect(turn!.metadata?.unrelated).toBe("preserve");
  }, 180_000);

  test("SUB-FAIL-11 retried recording and account-only reclaims do not spend the bound of four", async () => {
    let input = await fixture();
    expect(await count(client.db, input)).toBe(0);
    await record(client.db, input);
    await record(client.db, input);
    expect(await count(client.db, input)).toBe(0);
    input = { ...(await recover(input)), connectionId: crypto.randomUUID() };
    await record(client.db, input);
    expect(await count(client.db, input)).toBe(0);
    for (let index = 1; index <= 4; index++) {
      const policy = { ...input.policy, productModelId: `target/model-${index}` };
      await stage({ ...input, policy });
      input = {
        ...(await recover(input)),
        policy,
      };
      expect(await record(client.db, input)).toMatchObject({
        accepted: true,
        modelChangeCount: index,
      });
      await record(client.db, input);
      expect(await count(client.db, input)).toBe(index);
    }
    await expect(
      stage({ ...input, policy: { ...input.policy, productModelId: "target/over-budget" } }),
    ).rejects.toThrow("bound exceeded");
  }, 180_000);

  test("D-37 pending target is fenced, idempotent, rollback-safe and consumed only by a newer claim", async () => {
    let input = await fixture();
    await record(client.db, input);
    const target = { ...input, policy: { ...input.policy, productModelId: "target/next" } };
    await expect(
      withRlsContext(client.db, input, async (tx) => {
        const fence = await lockTurnAttemptWriteFenceTx(tx, input);
        if (!fence.allowed) throw new Error("Expected fence");
        await expect(
          stageSubscriptionCorePendingServingPolicyTx(client.db, target, fence),
        ).rejects.toThrow("transaction fence");
        await expect(
          stageSubscriptionCorePendingServingPolicyTx(
            tx,
            { ...target, turnId: crypto.randomUUID() },
            fence,
          ),
        ).rejects.toThrow("transaction fence");
        await stageSubscriptionCorePendingServingPolicyTx(tx, target, fence);
        expect(await stageSubscriptionCorePendingServingPolicyTx(tx, target, fence)).toMatchObject({
          sourceExecutionGeneration: input.executionGeneration,
        });
        throw new Error("rollback recovery");
      }),
    ).rejects.toThrow("rollback recovery");
    expect(
      readTurnPendingServingPolicyV1(
        (await getSessionTurn(client.db, input.workspaceId, input.turnId))!.metadata,
      ),
    ).toBeNull();
    const pending = await stage(target);
    expect(await stage(target)).toEqual(pending);
    await expect(stage({ ...target, connectionId: crypto.randomUUID() })).rejects.toThrow(
      "Conflicting pending",
    );
    expect(await count(client.db, input)).toBe(0);
    expect(await record(client.db, input)).toMatchObject({ installed: false });
    await expect(record(client.db, target)).rejects.toThrow("Conflicting serving revision");
    input = { ...(await recover(input)), policy: target.policy };
    await history(input, 123);
    await expect(
      record(client.db, { ...input, connectionId: crypto.randomUUID() }),
    ).rejects.toThrow("Pending serving target");
    expect(await record(client.db, input)).toMatchObject({
      accepted: true,
      installed: true,
      modelChangeCount: 1,
      revision: { historyPosition: 123 },
    });
    expect(
      readTurnPendingServingPolicyV1(
        (await getSessionTurn(client.db, input.workspaceId, input.turnId))!.metadata,
      ),
    ).toBeNull();
    expect(await record(client.db, input)).toMatchObject({ installed: false, modelChangeCount: 1 });
    input = await recover(input);
    await expect(
      record(client.db, {
        ...input,
        policy: { ...input.policy, productModelId: "target/unproposed" },
      }),
    ).rejects.toThrow("requires a pending");
    expect(await record(client.db, input)).toMatchObject({ accepted: true, modelChangeCount: 1 });
  }, 180_000);

  test("D-39 prospective budget includes refusals of a held provider and refuses an over-budget commit", async () => {
    let input = await fixture();
    await record(client.db, input);
    const policy = { ...input.policy, productModelId: "target/next" };
    await stage({ ...input, policy });
    const connectionId = crypto.randomUUID();
    await shared.admin`insert into subscription_connections (id, account_id, provider, credential_encrypted, ownership, scope_kind, provider_account_id)
      values (${connectionId}::uuid, ${input.accountId}::uuid, 'codex', 'synthetic-not-used', 'shared', 'organization', ${connectionId})`;
    await shared.admin`insert into subscription_turn_failures (account_id, workspace_id, session_id, turn_id, connection_id, provider, failure_kind, recovery_evidence)
      values (${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.sessionId}::uuid, ${input.turnId}::uuid, ${connectionId}::uuid, 'codex', 'capacity', '{"refusals":4}'::jsonb)`;
    await shared.admin`update subscription_provider_cutovers set enabled = false where account_id = ${input.accountId}::uuid and provider = 'codex'`;
    input = { ...(await recover(input)), policy };
    expect(await record(client.db, input)).toEqual({
      accepted: false,
      reason: "failover_bound_exceeded",
    });
    expect(await count(client.db, input)).toBe(0);
    expect(
      readTurnPendingServingPolicyV1(
        (await getSessionTurn(client.db, input.workspaceId, input.turnId))!.metadata,
      ),
    ).not.toBeNull();
    // Exactly four is allowed, but no fifth transition. The refusal ledger is
    // test setup only; production never erases a refusal to make room.
    await shared.admin`update subscription_turn_failures set recovery_evidence = '{"refusals":3}'::jsonb where turn_id = ${input.turnId}::uuid`;
    expect(await record(client.db, input)).toMatchObject({ accepted: true, modelChangeCount: 1 });
    await expect(
      stage({ ...input, policy: { ...policy, productModelId: "target/again" } }),
    ).rejects.toThrow("bound exceeded");
  }, 180_000);

  test("D-37 RLS isolates workspaces even for unqualified reads under a non-owner non-bypass role", async () => {
    const first = await fixture();
    const second = await fixture(undefined, first);
    const otherAccount = await fixture();
    await record(client.db, first);
    const [posture] = await rawRows<{
      superuser: boolean;
      bypass: boolean;
      owner: boolean;
      rls: boolean;
      force: boolean;
    }>(
      client.db,
      sql`
      select role.rolsuper as superuser, role.rolbypassrls as bypass, relation.relowner = role.oid as owner,
        relation.relrowsecurity as rls, relation.relforcerowsecurity as force
      from pg_roles role join pg_class relation on relation.oid = 'session_turns'::regclass where role.rolname = current_user`,
    );
    expect(posture).toEqual({
      superuser: false,
      bypass: false,
      owner: false,
      rls: true,
      force: true,
    });
    for (const foreign of [second, otherAccount]) {
      const hidden = await withRlsContext(client.db, foreign, (tx) =>
        rawRows(tx, sql`select metadata from session_turns where id = ${first.turnId}::uuid`),
      );
      expect(hidden).toEqual([]);
      const crossed = { ...first, accountId: foreign.accountId, workspaceId: foreign.workspaceId };
      expect(await read(client.db, crossed)).toBeNull();
      expect(await count(client.db, crossed)).toBeNull();
      expect(await record(client.db, crossed)).toMatchObject({ accepted: false });
    }
    expect(await read(client.db, first)).toMatchObject({ kind: "valid" });
  }, 180_000);

  test("D-39 concurrent writers on one turn commit exactly one receipt", async () => {
    const input = await fixture();
    const outcomes = await Promise.all([record(client.db, input), record(client.db, input)]);
    expect(outcomes.filter((outcome) => outcome.accepted && outcome.installed)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.accepted && !outcome.installed)).toHaveLength(1);
    expect(await read(client.db, input)).toMatchObject({
      kind: "valid",
      revisions: [expect.objectContaining({ executionGeneration: input.executionGeneration })],
    });
    expect(await count(client.db, input)).toBe(0);
  }, 180_000);

  test("D-37 restriction and missing accepted policy fail closed", async () => {
    const restricted = await fixture({
      turnExecutionPolicyV1: { ...acceptedPolicy, credentialRestriction: "developer_setup" },
    });
    expect(await record(client.db, restricted)).toEqual({
      accepted: false,
      reason: "credential_restricted",
    });
    expect(await read(client.db, restricted)).toEqual({ kind: "absent" });
    const absent = await fixture({});
    expect(await record(client.db, absent)).toEqual({
      accepted: false,
      reason: "accepted_policy_absent",
    });
  }, 180_000);

  test("D-43 disabled writer does no database work", async () => {
    const input = await fixture();
    // No usable handle: even a read or opening a transaction would throw.
    for (const enabled of [false, undefined])
      expect(
        await record({} as typeof client.db, { ...input, crossProviderFailoverEnabled: enabled }),
      ).toEqual({ accepted: false, reason: "disabled" });
    expect(await read(client.db, input)).toEqual({ kind: "absent" });
  }, 180_000);

  test("D-37 lock order: real reservation and revision serialize without a placement/turn deadlock", async () => {
    const input = await fixture();
    const identity = await readSubscriptionCoreTurnIdentity(client.db, input);
    if (!identity?.sessionOwnerSubjectId)
      throw new Error("An owned session is required to lock the reservation binding");
    const connectionId = crypto.randomUUID();
    await shared.admin`insert into subscription_connections (id, account_id, provider, credential_encrypted, ownership, scope_kind, provider_account_id, plan_type, expires_at)
      values (${connectionId}::uuid, ${input.accountId}::uuid, 'codex', 'synthetic-not-used', 'shared', 'organization', ${connectionId}, 'pro', now() + interval '1 day')`;
    const ref = {
      connectionId,
      holderId: `holder:${input.attemptId}`,
      generation: input.executionGeneration,
    };
    expect(
      await withSubscriptionCoreAcceptedTurn(client.db, identity, async (tx) => {
        expect(
          await acquireSubscriptionTurnLease(tx, {
            ...identity,
            ...ref,
            provider: "codex",
            ttlMs: 120_000,
          }),
        ).not.toBeNull();
        expect(
          await writeSubscriptionSessionBinding(tx, {
            ...identity,
            provider: "codex",
            connectionId,
            modelId: acceptedPolicy.productModelId,
            choice: "automatic",
            onlyThisModel: false,
            lastModelCallAt: new Date(),
            lastSwitchReason: "initial",
          }),
        ).toBe(1);
      }),
    ).toMatchObject({ status: "completed" });
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const placement = withSubscriptionCoreAcceptedTurn(client.db, identity, async (tx) => {
      await tx.execute(
        sql`select session_id from subscription_session_bindings where session_id = ${input.sessionId}::uuid for update`,
      );
      await expect(record(tx, input)).rejects.toThrow("outside the placement transaction");
      locked.resolve();
      await release.promise;
    });
    let reservation: Promise<unknown> | undefined;
    let revision: Promise<unknown> | undefined;
    try {
      await Promise.race([locked.promise, placement]);
      reservation = subscriptionCoreRequests(
        subscriptionCoreCodexProvider(),
      ).reserveSubscriptionCoreRequest(client.db, identity, ref, {
        attemptId: input.attemptId,
        executionGeneration: input.executionGeneration,
        requestId: crypto.randomUUID(),
        transportAttempt: 1,
      });
      // Prevent unhandled rejection if a broken candidate deadlocks/times out.
      void reservation.catch(() => {});
      await waitForBlockedQuery("subscription_session_bindings");
      revision = record(client.db, input);
      void revision.catch(() => {});
      await waitForBlockedQuery("session_turns");
    } finally {
      release.resolve();
      await placement;
    }
    await expect(reservation).resolves.toMatchObject({ operationId: expect.any(String) });
    await expect(revision).resolves.toMatchObject({ accepted: true, installed: true });
    expect(await count(client.db, input)).toBe(0);
  }, 180_000);
});

async function waitForBlockedQuery(relation: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const rows = await shared.admin<{ blocked: boolean }[]>`select exists (
      select 1 from pg_stat_activity where datname = current_database() and usename = 'opengeni_app'
        and wait_event_type = 'Lock' and query like ${`%${relation}%`}
    ) as blocked`;
    if (rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`No blocked query on ${relation}`);
}
