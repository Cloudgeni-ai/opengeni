import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  configuredModels,
  getSettings,
  withClaudeConnectionCatalog,
  withCodexCatalogProvider,
} from "@opengeni/config";
import { failoverFixture } from "./helpers/subscription-core-failover-fixture";
import { SUBSCRIPTION_CORE_CODEX } from "../src/subscription-core-codex-adapter";
import { SUBSCRIPTION_CORE_CLAUDE } from "../src/subscription-core-claude-adapter";
import {
  armSubscriptionCoreCapacityWait,
  reconcileSubscriptionCoreCapacityWait,
  placeSubscriptionCoreTurnWithFailover,
  recordSubscriptionCoreServingSelectionForTurnAttempt,
} from "../src";
import { evaluateCoreCodexBlockedTurn } from "../../../apps/worker/src/activities/subscription-core-codex-waits";
import { servingCatalog } from "../../../apps/worker/src/activities/agent-turn/subscription-serving-catalog";
import {
  claimServingAttempt,
  servingPolicyForSelection,
} from "../../../apps/worker/src/activities/agent-turn/subscription-serving-claim";
import { acceptedPolicy } from "../../contracts/test/fixtures/turn-serving-policy";

const rawSettings = getSettings({
  OPENGENI_ENV: "test",
  OPENGENI_CODEX_SUBSCRIPTION_ENABLED: "true",
  OPENGENI_CLAUDE_SUBSCRIPTION_ENABLED: "true",
  OPENGENI_SUBSCRIPTION_CROSS_PROVIDER_FAILOVER_ENABLED: "true",
});
const settings = withClaudeConnectionCatalog(withCodexCatalogProvider(rawSettings), {
  claude_subscription: { models: [{ upstreamModelId: "claude-opus-5-5" }] },
});
const models = servingCatalog(settings, ["codex", "claude"]);
const home = models.find((model) => model.provider === "codex")!;
const target = models.find((model) => model.provider === "claude")!;
const policy = servingPolicyForSelection(settings, acceptedPolicy, home.id, "high");
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase;
let fixture: ReturnType<typeof failoverFixture>;
beforeAll(async () => {
  if (!realDb) return;
  shared = (await acquireSharedTestDatabase("failover-wait-recovery"))!;
  if (!shared) throw new Error("real PostgreSQL required");
  fixture = failoverFixture(
    shared,
    [SUBSCRIPTION_CORE_CODEX, SUBSCRIPTION_CORE_CLAUDE],
    [home, target],
  );
}, 180_000);
afterAll(async () => {
  await fixture?.client.close();
  await shared?.release();
}, 180_000);

async function setup(isPrivate: boolean) {
  const org = await fixture.organization();
  await shared.admin`insert into organization_model_provider_custom_models
    (account_id,provider_kind,upstream_model_id,create_operation_id,create_request_hash,created_by_subject_id)
    values (${org.accountId}::uuid,'claude_subscription',${target.upstreamModelId},${crypto.randomUUID()}::uuid,${"a".repeat(64)},${org.subjectId})`;
  const sourceId = await fixture.connection(org, SUBSCRIPTION_CORE_CODEX);
  const targetId = await fixture.connection(org, SUBSCRIPTION_CORE_CLAUDE);
  const work = await fixture.turn(org, {
    private: isPrivate,
    metadata: { turnExecutionPolicyV1: policy },
  });
  await shared.admin`update sessions set codex_compaction_mode='portable' where id=${work.identity.sessionId}::uuid`;
  await fixture.exhausted(org.accountId, sourceId, Date.now() + 86_400_000);
  await fixture.exhausted(org.accountId, targetId, Date.now() + 86_400_000);
  return { org, sourceId, targetId, work };
}

describe.skipIf(!realDb)(
  "integrated portable waiter recovery using the restricted app role",
  () => {
    test.each([false, true])(
      "raw control settings resolve a real fallback for private=%s and preserve accepted model",
      async (isPrivate) => {
        const { org, targetId, work } = await setup(isPrivate);
        // Unlike claim, control services have no injected subscription providers.
        expect(configuredModels(rawSettings).some((model) => model.id === target.id)).toBe(false);
        const services = { db: fixture.client.db, settings: rawSettings };
        const evaluation = await evaluateCoreCodexBlockedTurn(services, work.identity);
        expect(evaluation.kind).toBe("wait");
        if (evaluation.kind !== "wait") throw new Error("expected exhausted pool");
        expect(evaluation.candidateProviders).toContain("claude");
        const armed = await armSubscriptionCoreCapacityWait(fixture.client.db, "codex", {
          ...work.identity,
          attemptId: work.attemptId,
          waitReason: evaluation.waitReason,
          earliestResetAt: evaluation.earliestResetAt,
          healthRetryAt: evaluation.healthRetryAt,
          candidateProviders: evaluation.candidateProviders ?? [],
          failurePayload: {},
        });
        if (armed.action !== "waiting") throw new Error(`arm: ${armed.action}`);
        await shared.admin`delete from subscription_connection_quota where connection_id=${targetId}::uuid`;
        const ready = await evaluateCoreCodexBlockedTurn(services, work.identity);
        expect(ready.kind).toBe("run");
        if (ready.kind !== "run") throw new Error("expected fallback capacity");
        expect(ready.candidateProviders).toContain("claude");
        const resumed = await reconcileSubscriptionCoreCapacityWait(fixture.client.db, {
          ...work.identity,
          provider: "codex",
          waiterId: armed.waiter.waiterId,
          generation: armed.waiter.generation,
          evaluatedWakeRevision: armed.waiter.wakeRevision,
          evaluation: ready,
        });
        expect(resumed.action).toBe("resumed");
        const attempt = await fixture.claim(org.workspaceId, work.identity.sessionId);
        const serving = await claimServingAttempt({
          ...work.identity,
          db: fixture.client.db,
          settings,
          attemptId: attempt.attemptId,
          executionGeneration: attempt.executionGeneration,
          compactionMode: "portable",
          source: "user",
          acceptedPolicy: policy,
          providerIds: ["codex", "claude"],
        });
        expect(serving?.revision?.policy.productModelId).toBe(target.id);
        expect(serving?.acceptedPolicy.productModelId).toBe(home.id);
        expect(serving?.revision?.connectionId).toBe(targetId);
        const selection = {
          ...work.identity,
          attemptId: attempt.attemptId,
          executionGeneration: attempt.executionGeneration,
          provider: "claude",
          connectionId: targetId,
          modelId: target.id,
          reason: "failover_cross_provider" as const,
        };
        await expect(
          recordSubscriptionCoreServingSelectionForTurnAttempt(fixture.client.db, selection),
        ).rejects.toThrow("live placed lease");
        const placement = await placeSubscriptionCoreTurnWithFailover(
          fixture.client.db,
          SUBSCRIPTION_CORE_CODEX,
          {
            ...work,
            ...attempt,
            models,
          },
        );
        expect(placement.kind).toBe("run");
        const selected = await recordSubscriptionCoreServingSelectionForTurnAttempt(
          fixture.client.db,
          selection,
        );
        expect(selected.events.map((event) => event.type)).toEqual([
          "subscription.account.switched",
          "subscription.account.selected",
        ]);
        expect(selected.events[0]!.payload).toMatchObject({
          fromModelId: home.id,
          toModelId: target.id,
          toAccountId: targetId,
        });
        const retried = await recordSubscriptionCoreServingSelectionForTurnAttempt(
          fixture.client.db,
          selection,
        );
        expect(retried.events.map((event) => event.id)).toEqual(
          selected.events.map((event) => event.id),
        );
        await expect(
          recordSubscriptionCoreServingSelectionForTurnAttempt(fixture.client.db, {
            ...selection,
            connectionId: crypto.randomUUID(),
          }),
        ).rejects.toThrow("conflicting subscription selections");
        await expect(
          recordSubscriptionCoreServingSelectionForTurnAttempt(fixture.client.db, {
            ...selection,
            attemptId: work.attemptId,
            executionGeneration: work.executionGeneration,
          }),
        ).rejects.toThrow("fenced");
      },
      180_000,
    );

    test("a fresh pin or organization fallback disable removes the alternative on recheck", async () => {
      const { org, sourceId, targetId, work } = await setup(true);
      await shared.admin`delete from subscription_connection_quota where connection_id=${targetId}::uuid`;
      const services = { db: fixture.client.db, settings: rawSettings };
      expect(await evaluateCoreCodexBlockedTurn(services, work.identity)).toMatchObject({
        kind: "run",
      });
      await shared.admin`update subscription_settings set cross_provider_failover=false where account_id=${org.accountId}::uuid and workspace_id is null`;
      expect(await evaluateCoreCodexBlockedTurn(services, work.identity)).toMatchObject({
        kind: "wait",
        candidateProviders: [],
      });
      await shared.admin`update subscription_settings set cross_provider_failover=true where account_id=${org.accountId}::uuid and workspace_id is null`;
      await fixture.pin(org, work, "codex", sourceId, home.id);
      expect(await evaluateCoreCodexBlockedTurn(services, work.identity)).toMatchObject({
        kind: "wait",
        waitReason: "pinned_account_unavailable",
        candidateProviders: [],
      });
    }, 180_000);
  },
);
