import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  readTurnExecutionPolicyV1,
  readTurnPendingServingPolicyV1,
  readTurnServingPolicyV1,
} from "@opengeni/contracts";
import { failoverFixture } from "./helpers/subscription-core-failover-fixture";
import { SUBSCRIPTION_CORE_CODEX } from "../src/subscription-core-codex-adapter";
import {
  getSessionTurn,
  recordSubscriptionCoreServingPolicyForTurnAttempt as record,
  requestSessionTurnRecovery,
  readSubscriptionHistoryProvenance,
  withRlsContext,
} from "../src";
import { rawRows } from "../src/database";
import { sql } from "drizzle-orm";
import { getSettings, withCodexCatalogProvider, configuredModels } from "@opengeni/config";
import {
  claimServingAttempt,
  servingPolicyForSelection,
} from "../../../apps/worker/src/activities/agent-turn/subscription-serving-claim";
import { acceptedPolicy } from "../../contracts/test/fixtures/turn-serving-policy";

let shared: SharedTestDatabase;
let fixture: ReturnType<typeof failoverFixture>;
const enabled = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
beforeAll(async () => {
  if (!enabled) return;
  shared = (await acquireSharedTestDatabase("subscription-serving-runtime"))!;
  if (!shared) throw new Error("Real PostgreSQL required");
  fixture = failoverFixture(
    shared,
    [SUBSCRIPTION_CORE_CODEX],
    [
      {
        id: "codex/source",
        provider: "codex",
        upstreamModelId: "source",
        reasoningLevels: ["high"],
      },
      {
        id: "codex/target",
        provider: "codex",
        upstreamModelId: "target",
        reasoningLevels: ["high"],
      },
    ],
  );
}, 180_000);
afterAll(async () => {
  await fixture?.client.close();
  await shared?.release();
}, 180_000);

async function setup() {
  const org = await fixture.organization();
  const connectionId = await fixture.connection(org, SUBSCRIPTION_CORE_CODEX);
  const work = await fixture.turn(org);
  await shared.admin`update sessions set codex_compaction_mode = 'portable' where id = ${work.identity.sessionId}::uuid`;
  const stored = await getSessionTurn(fixture.client.db, org.workspaceId, work.identity.turnId);
  const accepted = readTurnExecutionPolicyV1(stored!.metadata);
  if (accepted.kind !== "valid") throw new Error("missing policy");
  const baseline = {
    ...work.identity,
    attemptId: work.attemptId,
    executionGeneration: work.executionGeneration,
    crossProviderFailoverEnabled: true as const,
    connectionId,
    policy: accepted.policy,
    reason: "initial" as const,
  };
  expect(await record(fixture.client.db, baseline)).toMatchObject({ accepted: true });
  const target = {
    crossProviderFailoverEnabled: true as const,
    executionGeneration: work.executionGeneration,
    connectionId,
    reason: "failover_same_provider" as const,
    policy: { ...accepted.policy, productModelId: "codex/target", upstreamModelId: "target" },
  };
  const recovery = {
    sessionId: work.identity.sessionId,
    turnId: work.identity.turnId,
    attemptId: work.attemptId,
    triggerEventId: crypto.randomUUID(),
    reason: "subscription_serving_model_changed",
    subscriptionServingTarget: target,
  };
  return { org, work, baseline, target, recovery, connectionId };
}

describe.skipIf(!enabled)("C2 serving recovery on restricted PostgreSQL app role", () => {
  test("SUB-FAIL-01 real claim hook records a baseline before runtime configuration without provider calls", async () => {
    const settings = withCodexCatalogProvider(
      getSettings({
        OPENGENI_ENV: "test",
        OPENGENI_CODEX_SUBSCRIPTION_ENABLED: "true",
        OPENGENI_SUBSCRIPTION_CROSS_PROVIDER_FAILOVER_ENABLED: "true",
      }),
    );
    const model = configuredModels(settings).find(
      (candidate) => candidate.credentialSource.kind === "connected_subscription",
    )!;
    const policy = servingPolicyForSelection(settings, acceptedPolicy, model.id, "high");
    const org = await fixture.organization();
    await fixture.connection(org, SUBSCRIPTION_CORE_CODEX);
    const work = await fixture.turn(org, {
      model: {
        id: model.id,
        provider: "codex",
        upstreamModelId: model.upstreamModelId,
        reasoningLevels: ["high"],
      },
      metadata: { turnExecutionPolicyV1: policy },
    });
    await shared.admin`update sessions set codex_compaction_mode = 'portable' where id = ${work.identity.sessionId}::uuid`;
    const input = {
      ...work.identity,
      db: fixture.client.db,
      settings,
      attemptId: work.attemptId,
      executionGeneration: work.executionGeneration,
      compactionMode: "portable",
      source: "user",
      acceptedPolicy: policy,
      providerIds: ["codex"],
    };
    const first = await claimServingAttempt(input);
    expect(first?.revision?.policy).toEqual(policy);
    expect((await claimServingAttempt(input))?.revision).toEqual(first?.revision);
    const [leases] =
      await shared.admin`select count(*)::int as n from subscription_leases where turn_id = ${work.identity.turnId}::uuid`;
    expect(leases!.n).toBe(0);
  });
  test("SUB-FAIL-03 atomic recovery/claim consumes pending target once and preserves accepted policy", async () => {
    const { org, work, baseline, target, recovery } = await setup();
    await withRlsContext(fixture.client.db, work.identity, async (tx) => {
      const [role] = await rawRows<{ elevated: boolean }>(
        tx,
        sql`select rolsuper or rolbypassrls as elevated from pg_roles where rolname = current_user`,
      );
      expect(role!.elevated).toBe(false);
    });
    expect(
      await requestSessionTurnRecovery(fixture.client.db, org.workspaceId, recovery),
    ).toMatchObject({ action: "recovering" });
    expect(
      await requestSessionTurnRecovery(fixture.client.db, org.workspaceId, recovery),
    ).toMatchObject({ action: "stale" });
    const staged = await getSessionTurn(fixture.client.db, org.workspaceId, work.identity.turnId);
    expect(readTurnPendingServingPolicyV1(staged!.metadata)?.policy).toEqual(target.policy);
    expect(readTurnExecutionPolicyV1(staged!.metadata)).toEqual({
      kind: "valid",
      policy: baseline.policy,
    });
    const next = await fixture.claim(org.workspaceId, work.identity.sessionId);
    const input = { ...baseline, ...target, ...next };
    expect(await record(fixture.client.db, input)).toMatchObject({
      accepted: true,
      installed: true,
      modelChangeCount: 1,
    });
    expect(await record(fixture.client.db, input)).toMatchObject({
      accepted: true,
      installed: false,
      modelChangeCount: 1,
    });
    const consumed = await getSessionTurn(fixture.client.db, org.workspaceId, work.identity.turnId);
    expect(readTurnPendingServingPolicyV1(consumed!.metadata)).toBeNull();
    const revisions = readTurnServingPolicyV1(consumed!.metadata);
    expect(revisions.kind === "valid" && revisions.revisions.length).toBe(2);
    expect(readTurnExecutionPolicyV1(consumed!.metadata)).toEqual({
      kind: "valid",
      policy: baseline.policy,
    });
  });

  test("SUB-FAIL-08 unknown model outcomes and remote history roll back recovery without proposals", async () => {
    const { org, work, recovery, connectionId } = await setup();
    // Fixture injects a historical unknown; the worker does not contact a provider.
    const operationId = crypto.randomUUID();
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into subscription_operation_leases(account_id, workspace_id, operation_id, attempt_id,
        operation_kind, session_id, turn_id, provider, connection_id, holder_id, generation, leased_until,
        request_id, transport_attempt, request_reserved_at, request_outcome)
        values (${org.accountId}::uuid, ${org.workspaceId}::uuid, ${operationId}::uuid, ${work.attemptId}::uuid,
          'model', ${work.identity.sessionId}::uuid, ${work.identity.turnId}::uuid, 'codex', ${connectionId}::uuid,
          'fixture', 1, clock_timestamp(), 'unknown-request', 1, clock_timestamp(), 'unknown')`;
    });
    await expect(
      requestSessionTurnRecovery(fixture.client.db, org.workspaceId, recovery),
    ).rejects.toThrow("unresolved model");
    expect(
      readTurnPendingServingPolicyV1(
        (await getSessionTurn(fixture.client.db, org.workspaceId, work.identity.turnId))!.metadata,
      ),
    ).toBeNull();
    await shared.admin`update subscription_operation_leases set request_outcome = 'response_received' where operation_id = ${operationId}::uuid`;
    await shared.admin`update sessions set codex_compaction_mode = 'remote_v2' where id = ${work.identity.sessionId}::uuid`;
    await expect(
      requestSessionTurnRecovery(fixture.client.db, org.workspaceId, recovery),
    ).rejects.toThrow("portable history");
    const stored = await getSessionTurn(fixture.client.db, org.workspaceId, work.identity.turnId);
    expect(stored!.status).toBe("running");
    expect(readTurnPendingServingPolicyV1(stored!.metadata)).toBeNull();
  });

  test("SUB-FAIL-08 history provenance is tenant/session scoped without altering canonical bytes", async () => {
    const { org, work } = await setup();
    const id = crypto.randomUUID();
    await shared.admin`insert into session_history_items(id, account_id, workspace_id, session_id, turn_id, position, item)
      values (${id}::uuid, ${org.accountId}::uuid, ${org.workspaceId}::uuid, ${work.identity.sessionId}::uuid,
        ${work.identity.turnId}::uuid, 1, '{"type":"message","role":"user","content":"original"}')`;
    const provenance = await readSubscriptionHistoryProvenance(
      fixture.client.db,
      org.workspaceId,
      work.identity.sessionId,
      [id],
    );
    expect(provenance.turnByHistoryId.get(id)).toBe(work.identity.turnId);
    const other = await fixture.organization();
    expect(
      (
        await readSubscriptionHistoryProvenance(
          fixture.client.db,
          other.workspaceId,
          work.identity.sessionId,
          [id],
        )
      ).turnMetadata.size,
    ).toBe(0);
    expect(
      (
        await readSubscriptionHistoryProvenance(
          fixture.client.db,
          org.workspaceId,
          crypto.randomUUID(),
          [id],
        )
      ).turnMetadata.size,
    ).toBe(0);
    const [row] = await shared.admin`select item from session_history_items where id = ${id}::uuid`;
    expect(row!.item).toEqual({ type: "message", role: "user", content: "original" });
  });
});
