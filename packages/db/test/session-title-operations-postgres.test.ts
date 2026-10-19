import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type { Settings } from "@opengeni/config";
import { failoverFixture } from "./helpers/subscription-core-failover-fixture";
import { subscriptionCoreCodexProvider } from "../src/subscription-core-codex-adapter";
import { subscriptionCoreXaiProvider } from "../src/subscription-core-xai-adapter";
import { subscriptionCoreClaudeProvider } from "../src/subscription-core-claude-adapter";
import { subscriptionCoreTurns } from "../src/subscription-core/turns";
import { subscriptionCoreOperations } from "../src/subscription-core/operations";
import { subscriptionCoreRequests } from "../src/subscription-core/requests";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import { updateSessionTitleWithEvent } from "../src/index";
import {
  admitSessionTitleOperation,
  claimSessionTitleOperation,
  getSessionTitleOperation,
  recordSessionTitleResponse,
  finishSessionTitleOperation,
  renewSessionTitleOperation,
  completeSessionTitleOperation,
  retrySessionTitleOperation,
  reserveSessionTitleDispatch,
} from "../src/session-title-operations";

setDefaultTimeout(180_000);
const enabled = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const providers = [
  subscriptionCoreCodexProvider(),
  subscriptionCoreXaiProvider(),
  subscriptionCoreClaudeProvider(),
];
const models = providers.map((provider) => ({
  id: `${provider.adapter.provider}/title-fixture`,
  provider: provider.adapter.provider,
  upstreamModelId: "title-fixture",
  reasoningLevels: ["high"],
}));
const key = Buffer.alloc(32, 51);
const settings = { environmentsEncryptionKey: key.toString("base64") } as Settings;
let shared: SharedTestDatabase;
let fixture: ReturnType<typeof failoverFixture>;
beforeAll(async () => {
  if (!enabled) return;
  const db = await acquireSharedTestDatabase("independent-session-title");
  if (!db) throw new Error("Real PostgreSQL required");
  shared = db;
  fixture = failoverFixture(shared, providers, models);
}, 180_000);
afterAll(async () => {
  await fixture?.client.close();
  await shared?.release();
}, 180_000);

describe.skipIf(!enabled)("independent session title custody", () => {
  for (const [index, provider] of providers.entries()) {
    test(`${provider.adapter.provider}: exact title survives source settlement, reserves once, and fences a reclaimed holder`, async () => {
      const org = await fixture.organization();
      const connectionId = await fixture.connection(org, provider);
      const credential =
        provider.adapter.provider === "codex"
          ? {
              access_token: "fixture-access",
              refresh_token: "fixture-refresh",
              id_token: "fixture-id",
            }
          : provider.adapter.provider === "claude"
            ? {
                version: 1,
                token: "sk-ant-oat01-fixture",
                identity: { accountUuid: "", deviceId: "a".repeat(64) },
              }
            : { version: 1, accessToken: "fixture-access", refreshToken: "fixture-refresh" };
      await shared.admin`update subscription_connections set credential_encrypted = ${encryptEnvironmentValue(key, JSON.stringify(credential))}
        where id = ${connectionId}::uuid`;
      const work = await fixture.turn(org, { model: models[index]! });
      // The title generation must not accidentally equal the source attempt's.
      await shared.admin`update session_turns set execution_generation = 3 where id = ${work.identity.turnId}::uuid`;
      await shared.admin`update session_turn_attempts set execution_generation = 3 where id = ${work.attemptId}::uuid`;
      work.executionGeneration = 3;
      const placed = await subscriptionCoreTurns(provider).placeSubscriptionCoreTurn(
        fixture.client.db,
        work,
      );
      expect(placed).toMatchObject({ kind: "run", connectionId });
      const job = await admitSessionTitleOperation(fixture.client.db, {
        ...work,
        provider: provider.adapter.provider,
        connectionId,
        requestEncrypted: encryptEnvironmentValue(key, "title request"),
      });
      expect(job?.state).toBe("pending");
      const tenant = {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        operationId: job!.id,
      };
      const first = await claimSessionTitleOperation(fixture.client.db, {
        ...tenant,
        holderId: "first",
        ttlMs: 300_000,
      });
      expect(first?.generation).toBe(1);
      const scope = { kind: "turn" as const, identity: work.identity };
      const ref = {
        operationId: job!.id,
        operationKind: "session_title" as const,
        attemptId: work.attemptId,
        holderId: "first",
        generation: 1,
        connectionId,
      };
      const operations = subscriptionCoreOperations(provider);
      expect(
        await operations.acquireSubscriptionCoreOperationLease(fixture.client.db, scope, ref),
      ).toMatchObject({ kind: "acquired" });
      await fixture.finish(work);
      expect(
        await operations.loadSubscriptionCoreConnectionCredential(
          fixture.client.db,
          settings,
          scope,
          connectionId,
          ref,
        ),
      ).toMatchObject({ kind: "loaded" });
      expect(
        await operations.renewSubscriptionCoreOperationLease(fixture.client.db, scope, ref),
      ).not.toBeNull();
      await shared.admin`update session_title_operations set leased_until = clock_timestamp() - interval '1 second' where id = ${job!.id}::uuid`;
      // The provider lease intentionally remains live longer than its expired
      // metadata grant: reclaim must clean up that exact stale owner.
      const next = await claimSessionTitleOperation(fixture.client.db, {
        ...tenant,
        holderId: "second",
        ttlMs: 300_000,
      });
      expect(next?.generation).toBe(2);
      const second = { ...ref, holderId: "second", generation: 2 };
      expect(
        await operations.acquireSubscriptionCoreOperationLease(fixture.client.db, scope, second),
      ).toMatchObject({ kind: "acquired" });
      expect(
        await operations.loadSubscriptionCoreConnectionCredential(
          fixture.client.db,
          settings,
          scope,
          connectionId,
          ref,
        ),
      ).toMatchObject({ kind: "not_visible" });
      const consent = { ...work, connectionId, operationRef: second };
      expect(
        await subscriptionCoreTurns(provider).canSpendSubscriptionCoreExtraCredits(
          fixture.client.db,
          consent,
        ),
      ).toBe(false);
      await shared.admin`update subscription_connections set extra_credits_enabled = true where id = ${connectionId}::uuid`;
      expect(
        await subscriptionCoreTurns(provider).canSpendSubscriptionCoreExtraCredits(
          fixture.client.db,
          consent,
        ),
      ).toBe(provider.adapter.provider === "codex");
      expect(
        await subscriptionCoreTurns(provider).canSpendSubscriptionCoreExtraCredits(
          fixture.client.db,
          { ...consent, operationRef: ref },
        ),
      ).toBe(false);
      await shared.admin`update subscription_connections set extra_credits_enabled = false where id = ${connectionId}::uuid`;
      expect(
        await subscriptionCoreTurns(provider).canSpendSubscriptionCoreExtraCredits(
          fixture.client.db,
          consent,
        ),
      ).toBe(false);
      const [credentialRow] = await shared.admin<
        { refresh_generation: number }[]
      >`select refresh_generation from subscription_connections where id = ${connectionId}::uuid`;
      const generation = Number(credentialRow!.refresh_generation);
      const observation = {
        windows: [
          { id: "primary", status: "ok" as const, usedPercent: 10, resetsAt: Date.now() + 60_000 },
        ],
        modelCooldowns: {},
        exhaustedUntil: null,
        exhaustedKind: null,
        revision: 0,
        observedAt: Date.now(),
        observedRefreshGeneration: generation,
        source: "response_headers" as const,
      };
      expect(
        await operations.recordSubscriptionCoreUsageObservation(
          fixture.client.db,
          scope,
          connectionId,
          observation,
          {},
          second,
        ),
      ).toMatchObject({ applied: true });
      await shared.admin`update subscription_connections set refresh_generation = refresh_generation + 1 where id = ${connectionId}::uuid`;
      expect(
        await operations.recordSubscriptionCoreUsageObservation(
          fixture.client.db,
          scope,
          connectionId,
          { ...observation, observedAt: Date.now() + 1 },
          {},
          second,
        ),
      ).toEqual({ applied: false, recovered: false });
      const requests = subscriptionCoreRequests(provider);
      const request = await requests.reserveSubscriptionCoreOperationRequest(
        fixture.client.db,
        scope,
        second,
        connectionId,
        { requestId: `title:${job!.id}`, transportAttempt: 1 },
      );
      await expect(
        requests.reserveSubscriptionCoreOperationRequest(
          fixture.client.db,
          scope,
          second,
          connectionId,
          { requestId: `title:${job!.id}:replay`, transportAttempt: 1 },
        ),
      ).rejects.toThrow();
      await requests.settleSubscriptionCoreOperationRequest(fixture.client.db, scope, {
        operationId: request.operationId,
        outcome: "refused",
      });
      const retried = await requests.reserveSubscriptionCoreOperationRequest(
        fixture.client.db,
        scope,
        second,
        connectionId,
        { requestId: `title:${job!.id}`, transportAttempt: 2 },
      );
      expect(retried.operationId).not.toBe(request.operationId);
      expect((await getSessionTitleOperation(fixture.client.db, tenant))?.requestOperationId).toBe(
        retried.operationId,
      );
      const claim = { ...tenant, holderId: "second", generation: 2 };
      expect(
        await renewSessionTitleOperation(fixture.client.db, { ...claim, ttlMs: 300_000 }),
      ).toBe(true);
      expect(
        await renewSessionTitleOperation(fixture.client.db, {
          ...claim,
          holderId: "first",
          generation: 1,
          ttlMs: 300_000,
        }),
      ).toBe(false);
      expect(
        await recordSessionTitleResponse(fixture.client.db, {
          ...claim,
          responseEncrypted: encryptEnvironmentValue(key, "response"),
        }),
      ).toBe(true);
      // Revoking future use after a finite response must not prevent settlement
      // of that exact request or strand the metadata job.
      await shared.admin`update subscription_connections set disconnected_at = now(), status = 'disabled', credential_encrypted = '',
        provider_account_id = null, allocator_enabled = false
        where id = ${connectionId}::uuid`;
      const complete = () =>
        completeSessionTitleOperation(
          fixture.client.db,
          { ...claim, sessionId: work.identity.sessionId },
          async (tx) => {
            return updateSessionTitleWithEvent(tx, {
              workspaceId: org.workspaceId,
              sessionId: work.identity.sessionId,
              title: "Independent title operation",
              source: "agent",
            });
          },
        );
      await expect(
        completeSessionTitleOperation(
          fixture.client.db,
          { ...claim, sessionId: work.identity.sessionId },
          async (tx) => {
            await updateSessionTitleWithEvent(tx, {
              workspaceId: org.workspaceId,
              sessionId: work.identity.sessionId,
              title: "Must roll back",
              source: "agent",
            });
            throw new Error("settlement failed");
          },
        ),
      ).rejects.toThrow("settlement failed");
      expect((await getSessionTitleOperation(fixture.client.db, tenant))?.state).toBe("responded");
      expect(await complete()).toMatchObject({ completed: true, value: { updated: true } });
      const [settled] = await shared.admin`select request_outcome from subscription_operation_leases
        where operation_id = ${retried.operationId}::uuid`;
      expect(settled!.request_outcome).toBe("response_received");
      expect(await complete()).toEqual({ completed: false });
      expect(
        (await getSessionTitleOperation(fixture.client.db, tenant))?.requestEncrypted,
      ).toBeNull();
      expect(
        await operations.loadSubscriptionCoreConnectionCredential(
          fixture.client.db,
          settings,
          scope,
          connectionId,
          second,
        ),
      ).toMatchObject({ kind: "not_visible" });
      expect(
        await operations.releaseSubscriptionCoreOperationLease(fixture.client.db, scope, second),
      ).toBe(false);
      expect(
        await getSessionTitleOperation(fixture.client.db, {
          accountId: org.accountId,
          workspaceId: org.workspaceId,
          sessionId: work.identity.sessionId,
        }),
      ).toBeNull();
    });

    test(`${provider.adapter.provider}: personal title authority is live after its source closes`, async () => {
      const org = await fixture.organization();
      await shared.admin`insert into subscription_person_preferences(account_id, organization_membership_id, personal_fallback_opt_in)
        values (${org.accountId}::uuid, ${org.membershipId}::uuid, true) on conflict do nothing`;
      const connectionId = await fixture.connection(org, provider, { personal: true });
      const work = await fixture.turn(org, { model: models[index]!, private: true });
      expect(
        await subscriptionCoreTurns(provider).placeSubscriptionCoreTurn(fixture.client.db, work),
      ).toMatchObject({ kind: "run", connectionId });
      const job = await admitSessionTitleOperation(fixture.client.db, {
        ...work,
        provider: provider.adapter.provider,
        connectionId,
        requestEncrypted: "encrypted fixture",
      });
      const tenant = {
        accountId: work.identity.accountId,
        workspaceId: work.identity.workspaceId,
        operationId: job!.id,
      };
      await claimSessionTitleOperation(fixture.client.db, {
        ...tenant,
        holderId: "owner",
        ttlMs: 300_000,
      });
      const scope = { kind: "turn" as const, identity: work.identity };
      const ref = {
        operationId: job!.id,
        operationKind: "session_title" as const,
        attemptId: work.attemptId,
        holderId: "owner",
        generation: 1,
        connectionId,
      };
      const operations = subscriptionCoreOperations(provider);
      expect(
        await operations.acquireSubscriptionCoreOperationLease(fixture.client.db, scope, ref),
      ).toMatchObject({ kind: "acquired" });
      await fixture.finish(work);
      expect(
        await operations.readSubscriptionCoreOperationQuota(fixture.client.db, scope, ref),
      ).not.toBeNull();
      expect(
        await operations.readSubscriptionCoreOperationQuota(fixture.client.db, scope, {
          ...ref,
          operationId: crypto.randomUUID(),
        }),
      ).toBeNull();
      const request = await subscriptionCoreRequests(
        provider,
      ).reserveSubscriptionCoreOperationRequest(fixture.client.db, scope, ref, connectionId, {
        requestId: `personal-title:${job!.id}`,
        transportAttempt: 1,
      });
      await recordSessionTitleResponse(fixture.client.db, {
        ...tenant,
        holderId: "owner",
        generation: 1,
        responseEncrypted: "finite response",
      });
      await shared.admin`update organization_user_resource_authorities set status = 'revoked', revoked_at = now() where resource_id = ${connectionId}::uuid`;
      expect(
        await operations.readSubscriptionCoreOperationQuota(fixture.client.db, scope, ref),
      ).toBeNull();
      expect(
        await operations.renewSubscriptionCoreOperationLease(fixture.client.db, scope, ref),
      ).toBeNull();
      await expect(
        subscriptionCoreRequests(provider).reserveSubscriptionCoreOperationRequest(
          fixture.client.db,
          scope,
          ref,
          connectionId,
          { requestId: `revoked-title:${job!.id}`, transportAttempt: 1 },
        ),
      ).rejects.toThrow();
      expect(
        await completeSessionTitleOperation(
          fixture.client.db,
          {
            ...tenant,
            holderId: "owner",
            generation: 1,
            sessionId: work.identity.sessionId,
          },
          async () => "settled",
        ),
      ).toEqual({ completed: true, value: "settled" });
      const [settled] = await shared.admin`select request_outcome from subscription_operation_leases
        where operation_id = ${request.operationId}::uuid`;
      expect(settled!.request_outcome).toBe("response_received");
      expect(
        await operations.releaseSubscriptionCoreOperationLease(fixture.client.db, scope, ref),
      ).toBe(false);
    });
  }

  test("a terminal failed job does not suppress a later accepted turn's title", async () => {
    const org = await fixture.organization();
    const work = await fixture.turn(org, { model: models[0]! });
    const input = {
      ...work,
      provider: "fixture-api",
      connectionId: null,
      requestEncrypted: "encrypted fixture",
    };
    const first = await admitSessionTitleOperation(fixture.client.db, input);
    const tenant = {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      operationId: first!.id,
    };
    await claimSessionTitleOperation(fixture.client.db, {
      ...tenant,
      holderId: "failed",
      ttlMs: 300_000,
    });
    expect(
      await finishSessionTitleOperation(fixture.client.db, {
        ...tenant,
        holderId: "failed",
        generation: 1,
        state: "failed",
      }),
    ).toBe(true);
    expect((await admitSessionTitleOperation(fixture.client.db, input))!.id).toBe(first!.id);
    await fixture.finish(work);
    const next = await fixture.turn(org, { model: models[0]!, sessionId: work.identity.sessionId });
    const nextInput = { ...input, ...next };
    const second = await admitSessionTitleOperation(fixture.client.db, nextInput);
    expect(second!.id).not.toBe(first!.id);
    expect((await admitSessionTitleOperation(fixture.client.db, nextInput))!.id).toBe(second!.id);
    await fixture.finish(next);
  });

  test("an unsent claim retries with a new holder but a dispatched claim never resets", async () => {
    const org = await fixture.organization();
    const work = await fixture.turn(org, { model: models[0]! });
    const job = await admitSessionTitleOperation(fixture.client.db, {
      ...work,
      provider: "fixture-api",
      connectionId: null,
      requestEncrypted: "encrypted fixture",
    });
    const tenant = { accountId: org.accountId, workspaceId: org.workspaceId, operationId: job!.id };
    await claimSessionTitleOperation(fixture.client.db, {
      ...tenant,
      holderId: "first",
      ttlMs: 300_000,
    });
    const first = { ...tenant, holderId: "first", generation: 1 };
    expect(await retrySessionTitleOperation(fixture.client.db, first)).toBe(true);
    expect(
      (
        await claimSessionTitleOperation(fixture.client.db, {
          ...tenant,
          holderId: "second",
          ttlMs: 300_000,
        })
      )?.generation,
    ).toBe(2);
    expect(await retrySessionTitleOperation(fixture.client.db, first)).toBe(false);
    const second = { ...tenant, holderId: "second", generation: 2 };
    expect(await reserveSessionTitleDispatch(fixture.client.db, second)).toBe(true);
    expect(await retrySessionTitleOperation(fixture.client.db, second)).toBe(false);
    expect((await getSessionTitleOperation(fixture.client.db, tenant))?.state).toBe("dispatching");
    await finishSessionTitleOperation(fixture.client.db, { ...second, state: "unknown" });
    await fixture.finish(work);
  });
});
