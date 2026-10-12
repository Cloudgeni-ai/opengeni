import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import { fakeApiKeyProvider } from "./fixtures/subscription-core-fake-api-key";
import {
  admitTestSubscriptionCoreProvider,
  testSubscriptionCoreProviderModules,
} from "./helpers/subscription-core-test-provider";
import type { SubscriptionCoreProvider } from "../src/subscription-core/provider";

const home: SubscriptionCoreProvider = {
  ...fakeApiKeyProvider,
  sessionCompactionLock: sql`coalesce((session.metadata->>'failoverTestLock')::boolean, false)`,
  adapter: {
    ...fakeApiKeyProvider.adapter,
    provider: "failover_home",
    modelPolicyProviderId: "home-wire",
    modelTier: () => "standard",
  },
};
const target: SubscriptionCoreProvider = {
  ...fakeApiKeyProvider,
  adapter: {
    ...fakeApiKeyProvider.adapter,
    provider: "failover_target",
    modelPolicyProviderId: "target-wire",
    modelTier: () => "standard",
  },
};
const providerModules = [home, target].flatMap(testSubscriptionCoreProviderModules);
for (const [specifier, factory] of providerModules) mock.module(specifier, factory);
const { failoverFixture } = await import("./helpers/subscription-core-failover-fixture");
const {
  placeSubscriptionCoreTurnWithFailover: place,
  evaluateSubscriptionCorePlacementWithFailover: evaluate,
} = await import("../src/subscription-core/failover");
const { subscriptionCoreBindingsPermitCrossing, readSubscriptionCoreFailoverProvider } =
  await import("../src/subscription-core/failover-readiness");
const { withSubscriptionCoreAcceptedTurn } =
  await import("../src/subscription-core-placement-world");
const { rawRows } = await import("../src/database");
const { encryptEnvironmentValue } = await import("../src/environment-crypto");
const { recordSubscriptionCoreServingPolicyForTurnAttempt: recordServing } =
  await import("../src/subscription-core/serving-policy");
const { subscriptionCoreRequests } = await import("../src/subscription-core/requests");
const { subscriptionCoreTurns } = await import("../src/subscription-core/turns");
const { acquireSubscriptionTurnLease } = await import("../src/subscription-core-repository");
const models = [
  {
    id: "home/model",
    provider: home.adapter.provider,
    upstreamModelId: "home-upstream",
    reasoningLevels: ["low", "high"],
  },
  {
    id: "target/model",
    provider: target.adapter.provider,
    upstreamModelId: "target-upstream",
    reasoningLevels: ["low", "medium"],
  },
  {
    id: "home/second",
    provider: home.adapter.provider,
    upstreamModelId: "home-second",
    reasoningLevels: ["low", "high"],
  },
];
let shared: SharedTestDatabase;
let fixture: ReturnType<typeof failoverFixture>;
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
beforeAll(async () => {
  if (!realDb) return;
  const acquired = await acquireSharedTestDatabase("subscription-core-failover");
  if (!acquired) throw new Error("Real PostgreSQL required");
  shared = acquired;
  await admitTestSubscriptionCoreProvider(shared.admin, home);
  // The shared helper deliberately appends one provider to the original
  // terminal list member. B1 needs two; widen this disposable database only,
  // without editing the contended shared helper or production registry.
  await shared.admin.begin(async (tx) => {
    const anchor = `'${home.adapter.provider}'`;
    const checks = await tx<{ relation: string; name: string; definition: string }[]>`
      select conrelid::regclass::text as relation, conname as name, pg_get_constraintdef(oid) as definition
      from pg_constraint where contype = 'c' and pg_get_constraintdef(oid) like ${`%${anchor}::text]%`}`;
    for (const check of checks)
      await tx.unsafe(
        `alter table ${check.relation} drop constraint ${check.name}, add constraint ${check.name} ${check.definition.replaceAll(`${anchor}::text]`, `${anchor}::text, '${target.adapter.provider}'::text]`)}`,
      );
    const [routine] = await tx<
      { definition: string }[]
    >`select pg_get_functiondef('public.subscription_personal_authority_v2_valid(jsonb)'::regprocedure) as definition`;
    if (routine!.definition.split(`${anchor})`).length !== 2)
      throw new Error("Test authority validator drift");
    await tx.unsafe(
      routine!.definition.replace(`${anchor})`, `${anchor}, '${target.adapter.provider}')`),
    );
    await tx`insert into opengeni_private.subscription_core_providers(provider, extra_credits, primary_setting_column, connection_kind)
      values (${target.adapter.provider}, false, null, 'api_key')`;
    await tx`insert into opengeni_private.subscription_provider_cutover_receipts(provider, migration, committed_at, seed_rotation)
      values (${target.adapter.provider}, '9999_failover_fixture.sql', '-infinity', '{"mode":"spread"}')`;
  });
  fixture = failoverFixture(shared, [home, target], models);
  const database = new URL(shared.appUrl).pathname.slice(1);
  await shared.admin`alter database ${shared.admin(database)} set lock_timeout = '5s'`;
  await shared.admin`alter database ${shared.admin(database)} set statement_timeout = '20s'`;
}, 180_000);
afterAll(async () => {
  await fixture?.client.close();
  await shared?.release();
}, 180_000);

describe.skipIf(!realDb)("B1 failover on real PostgreSQL as non-owner app role", () => {
  test("D-34 narrow readiness proves receipt and kind without private table SELECT", async () => {
    const org = await fixture.organization();
    const work = await fixture.turn(org);
    const result = await withSubscriptionCoreAcceptedTurn(
      fixture.client.db,
      work.identity,
      async (tx) => {
        const [role] = await rawRows<{ rolsuper: boolean; rolbypassrls: boolean; owner: boolean }>(
          tx,
          sql`
        select role.rolsuper, role.rolbypassrls, role.oid = relation.relowner as owner
        from pg_roles role cross join pg_class relation where role.rolname = current_user and relation.oid = 'session_turns'::regclass`,
        );
        expect(role).toEqual({ rolsuper: false, rolbypassrls: false, owner: false });
        expect(
          await readSubscriptionCoreFailoverProvider(tx, org.accountId, target.adapter.provider),
        ).toBe(target);
        expect(
          await readSubscriptionCoreFailoverProvider(tx, org.accountId, "unregistered"),
        ).toBeNull();
        await expect(
          tx.transaction((inner) =>
            inner.execute(sql`select * from opengeni_private.subscription_core_providers`),
          ),
        ).rejects.toThrow();
        await expect(
          tx.transaction((inner) =>
            inner.execute(
              sql`select opengeni_private.subscription_core_connection_kind(${target.adapter.provider})`,
            ),
          ),
        ).rejects.toThrow();
        return true;
      },
    );
    expect(result).toEqual({ status: "completed", value: true });
  });
  test("D-46 rolling uniqueness blocks crossing but preserves same-provider fallback", async () => {
    // The drained provider cutover removes this rolling compatibility index.
    // Recreate that historical posture explicitly, rather than depending on
    // which migration happened to be the latest when this suite was written.
    await fixture.admin`create unique index if not exists subscription_session_bindings_rolling_session_idx
      on subscription_session_bindings (workspace_id, session_id)`;
    try {
      const org = await fixture.organization();
      await fixture.connection(org, home, { allowedModelIds: ["home/second"] });
      await fixture.connection(org, target);
      const work = await fixture.turn(org);
      expect(
        await withSubscriptionCoreAcceptedTurn(fixture.client.db, work.identity, (tx) =>
          subscriptionCoreBindingsPermitCrossing(tx),
        ),
      ).toEqual({ status: "completed", value: false });
      const result = await place(fixture.client.db, home, work);
      expect(result).toMatchObject({
        kind: "run",
        provider: home.adapter.provider,
        modelId: "home/second",
      });
      expect(await fixture.binding(work, target.adapter.provider)).toBeNull();
    } finally {
      await fixture.admin`drop index subscription_session_bindings_rolling_session_idx`;
    }
  });
  test("D-33/D-36 cross-provider placement writes only target after rolling window closes", async () => {
    const org = await fixture.organization();
    const homeId = await fixture.connection(org, home);
    const targetId = await fixture.connection(org, target);
    await fixture.exhausted(org.accountId, homeId);
    const work = await fixture.turn(org);
    const result = await place(fixture.client.db, home, work);
    expect(result).toMatchObject({
      kind: "run",
      provider: target.adapter.provider,
      modelId: "target/model",
      connectionId: targetId,
      switch: "failover_cross_provider",
      reasoningLevel: "medium",
    });
    expect(await fixture.binding(work, home.adapter.provider)).toBeNull();
    expect(await fixture.binding(work, target.adapter.provider)).toMatchObject({
      connection_id: targetId,
      choice: "automatic",
    });
  });
  test("D-43 default off delegates without a target lease", async () => {
    const org = await fixture.organization();
    const homeId = await fixture.connection(org, home);
    await fixture.connection(org, target);
    await fixture.exhausted(org.accountId, homeId);
    const { crossProviderFailoverEnabled: _gate, ...work } = await fixture.turn(org);
    expect(await place(fixture.client.db, home, work)).toMatchObject({
      kind: "wait",
      reason: "no_eligible_capacity",
    });
    expect(await evaluate(fixture.client.db, home, work)).toMatchObject({ kind: "wait" });
    expect(
      await fixture.binding(
        { ...work, crossProviderFailoverEnabled: true },
        target.adapter.provider,
      ),
    ).toBeNull();
  });

  test("D-46 key-definition proof rejects renamed/reversed/INCLUDE/partial/invalid indexes", async () => {
    const org = await fixture.organization();
    const work = await fixture.turn(org);
    const proof = () =>
      withSubscriptionCoreAcceptedTurn(fixture.client.db, work.identity, (tx) =>
        subscriptionCoreBindingsPermitCrossing(tx),
      );
    for (const definition of [
      "(workspace_id, session_id)",
      "(session_id, workspace_id)",
      "(workspace_id, session_id) include (provider)",
      "(workspace_id, session_id) where provider = 'not-a-provider'",
    ]) {
      await fixture.admin.unsafe(
        `create unique index b1_test_renamed on subscription_session_bindings ${definition}`,
      );
      try {
        expect(await proof()).toEqual({ status: "completed", value: false });
      } finally {
        await fixture.admin`drop index b1_test_renamed`;
      }
    }
    await fixture.admin`create unique index b1_test_invalid on subscription_session_bindings(session_id, workspace_id)`;
    try {
      await fixture.admin`update pg_index set indisvalid = false where indexrelid = 'b1_test_invalid'::regclass`;
      expect(await proof()).toEqual({ status: "completed", value: false });
    } finally {
      await fixture.admin`drop index b1_test_invalid`;
    }
    expect(await proof()).toEqual({ status: "completed", value: true });
    // INCLUDE attributes cannot turn a one-key unique index into a two-key blocker.
    await fixture.admin`create unique index b1_test_include_only on subscription_session_bindings(session_id) include(workspace_id)`;
    try {
      expect(await proof()).toEqual({ status: "completed", value: true });
    } finally {
      await fixture.admin`drop index b1_test_include_only`;
    }
    await fixture.admin`alter table subscription_session_bindings drop constraint subscription_session_bindings_pkey`;
    try {
      expect(await proof()).toEqual({ status: "completed", value: false });
    } finally {
      await fixture.admin`alter table subscription_session_bindings add primary key(workspace_id, session_id, provider)`;
    }
  });

  test("D-34 no receipt, uncommitted receipt and maintenance never lease target; commit enables it", async () => {
    const org = await fixture.organization();
    const source = await fixture.connection(org, home);
    const destination = await fixture.connection(org, target);
    await fixture.exhausted(org.accountId, source);
    const work = await fixture.turn(org);
    // Reproduce the historical pre-receipt switch/connection state only in
    // this disposable clone; runtime roles cannot delete append-only receipts.
    await fixture.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from opengeni_private.subscription_provider_cutover_receipts where provider = ${target.adapter.provider}`;
    });
    const noTargetLease = async () => {
      expect(await place(fixture.client.db, home, work)).toMatchObject({ kind: "wait" });
      const [row] = await fixture.admin<
        { count: number }[]
      >`select count(*)::int as count from subscription_leases where connection_id = ${destination}::uuid`;
      expect(row!.count).toBe(0);
    };
    await noTargetLease();
    let inserted!: () => void;
    let commit!: () => void;
    const ready = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const writer = fixture.admin.begin(async (tx) => {
      await tx`insert into opengeni_private.subscription_provider_cutover_receipts(provider, migration, committed_at, seed_rotation)
        values (${target.adapter.provider}, '9999_failover_fixture.sql', '-infinity', '{"mode":"spread"}')`;
      inserted();
      await proceed;
    });
    await ready;
    try {
      await noTargetLease();
    } finally {
      commit();
      await writer;
    }
    await fixture.admin`update subscription_provider_cutovers set enabled = false where account_id = ${org.accountId}::uuid and provider = ${target.adapter.provider}`;
    await noTargetLease();
    await fixture.admin`delete from subscription_provider_cutovers where account_id = ${org.accountId}::uuid and provider = ${target.adapter.provider}`;
    await noTargetLease();
    await fixture.admin`insert into subscription_provider_cutovers(account_id, provider, enabled) values (${org.accountId}::uuid, ${target.adapter.provider}, true)`;
    expect(await place(fixture.client.db, home, work)).toMatchObject({
      kind: "run",
      connectionId: destination,
    });
  });

  test("D-35 effective empty order wins, missing order derives adapter tier; restrictions and switches apply", async () => {
    const org = await fixture.organization();
    const source = await fixture.connection(org, home);
    await fixture.connection(org, target);
    await fixture.exhausted(org.accountId, source);
    const work = await fixture.turn(org);
    await fixture.admin`update subscription_settings set fallback_order = ${fixture.admin.json({ "home/model": [] })}::jsonb where account_id = ${org.accountId}::uuid`;
    expect(await evaluate(fixture.client.db, home, work)).toMatchObject({ kind: "wait" });
    await fixture.admin`update subscription_settings set fallback_order = '{}'::jsonb where account_id = ${org.accountId}::uuid`;
    expect(await evaluate(fixture.client.db, home, work)).toMatchObject({
      kind: "run",
      modelId: "target/model",
    });
    await fixture.admin`update subscription_settings set cross_provider_failover = false where account_id = ${org.accountId}::uuid`;
    expect(await evaluate(fixture.client.db, home, work)).toMatchObject({ kind: "wait" });
    await fixture.admin`update subscription_settings set cross_provider_failover = true, providers = ${fixture.admin.json({ [target.adapter.provider]: false })}::jsonb where account_id = ${org.accountId}::uuid`;
    expect(await evaluate(fixture.client.db, home, work)).toMatchObject({ kind: "wait" });
    await fixture.admin`update subscription_settings set providers = '{}'::jsonb where account_id = ${org.accountId}::uuid`;
    await fixture.admin`insert into workspace_model_policies(account_id, workspace_id, allowed_models)
      values (${org.accountId}::uuid, ${org.workspaceId}::uuid, array['home/model'])`;
    expect(await evaluate(fixture.client.db, home, work)).toMatchObject({ kind: "wait" });
    await fixture.admin`update workspace_model_policies set allowed_models = array['target/model'] where workspace_id = ${org.workspaceId}::uuid`;
    expect(await evaluate(fixture.client.db, home, work)).toMatchObject({
      kind: "run",
      modelId: "target/model",
    });
  });

  test("B1 no-mapping diagnostic preserves home success and explicit untiered targets", async () => {
    const original = target.adapter.modelTier;
    Object.defineProperty(target.adapter, "modelTier", { configurable: true, value: () => null });
    try {
      const org = await fixture.organization();
      const source = await fixture.connection(org, home);
      const destination = await fixture.connection(org, target);
      const work = await fixture.turn(org);
      await fixture.admin`update subscription_settings set fallback_order = '{}'::jsonb where account_id = ${org.accountId}::uuid`;
      expect(await evaluate(fixture.client.db, home, work)).toMatchObject({
        kind: "run",
        connectionId: source,
      });
      expect(await place(fixture.client.db, home, work)).toMatchObject({
        kind: "run",
        connectionId: source,
      });
      await fixture.release(work);
      await fixture.exhausted(org.accountId, source);
      const diagnostic = { kind: "wait", reason: "failover_no_model_mapping" };
      expect(await evaluate(fixture.client.db, home, work)).toMatchObject(diagnostic);
      expect(await place(fixture.client.db, home, work)).toMatchObject(diagnostic);
      expect(await fixture.binding(work, target.adapter.provider)).toBeNull();
      expect(
        await place(fixture.client.db, home, {
          ...work,
          executionGeneration: work.executionGeneration + 1,
        }),
      ).toMatchObject({ kind: "attempt_fenced" });
      // Caller-supplied tiers cannot manufacture an approved mapping.
      expect(
        await evaluate(fixture.client.db, home, {
          ...work,
          models: work.models.map((model) => ({ ...model, tier: "standard" as const })),
        }),
      ).toMatchObject(diagnostic);
      await fixture.admin`update subscription_settings set fallback_order = ${fixture.admin.json({ "home/model": ["target/missing"] })}::jsonb where account_id = ${org.accountId}::uuid`;
      expect(await evaluate(fixture.client.db, home, work)).toMatchObject(diagnostic);
      // Exact configured catalog IDs work even when the adapter declares no tier.
      await fixture.admin`update subscription_settings set fallback_order = ${fixture.admin.json({ "home/model": ["target/model"] })}::jsonb where account_id = ${org.accountId}::uuid`;
      expect(await evaluate(fixture.client.db, home, work)).toMatchObject({
        kind: "run",
        connectionId: destination,
      });
      expect(await place(fixture.client.db, home, work)).toMatchObject({
        kind: "run",
        connectionId: destination,
      });
    } finally {
      Object.defineProperty(target.adapter, "modelTier", { configurable: true, value: original });
    }
  });

  test("B1 no-mapping diagnostic distinguishes empty order, disabled gates, pins and unavailable mapped targets", async () => {
    const org = await fixture.organization();
    const source = await fixture.connection(org, home);
    const destination = await fixture.connection(org, target);
    const work = await fixture.turn(org);
    await fixture.exhausted(org.accountId, source);
    const ordinaryWait = { kind: "wait", reason: "no_eligible_capacity" };
    const checkWait = async () => {
      expect(await evaluate(fixture.client.db, home, work)).toMatchObject(ordinaryWait);
      expect(await place(fixture.client.db, home, work)).toMatchObject(ordinaryWait);
    };
    await fixture.admin`update subscription_settings set fallback_order = ${fixture.admin.json({ "home/model": [] })}::jsonb where account_id = ${org.accountId}::uuid`;
    await checkWait();
    await fixture.admin`update subscription_settings set fallback_order = ${fixture.admin.json({ "home/model": ["target/missing"] })}::jsonb, cross_provider_failover = false where account_id = ${org.accountId}::uuid`;
    await checkWait();
    await fixture.admin`update subscription_settings set cross_provider_failover = true where account_id = ${org.accountId}::uuid`;
    expect(
      await place(fixture.client.db, home, { ...work, crossProviderFailoverEnabled: false }),
    ).toMatchObject(ordinaryWait);
    await fixture.pin(org, work, home.adapter.provider, source, "home/model");
    expect(await place(fixture.client.db, home, work)).toMatchObject({
      kind: "wait",
      reason: "pinned_account_unavailable",
    });
    await fixture.pin(org, work, home.adapter.provider, source, "home/model", false, "automatic");
    await fixture.admin`update subscription_settings set fallback_order = ${fixture.admin.json({ "home/model": ["target/model"] })}::jsonb where account_id = ${org.accountId}::uuid`;
    // Readiness is not mapping: committed registry/receipt with disabled live switch.
    await fixture.admin`update subscription_provider_cutovers set enabled = false where account_id = ${org.accountId}::uuid and provider = ${target.adapter.provider}`;
    await checkWait();
    await fixture.admin`update subscription_provider_cutovers set enabled = true where account_id = ${org.accountId}::uuid and provider = ${target.adapter.provider}`;
    await fixture.admin.begin(async (tx) => {
      // Reproduce pre-receipt state only in this disposable fixture clone.
      await tx`set local session_replication_role = replica`;
      await tx`delete from opengeni_private.subscription_provider_cutover_receipts where provider = ${target.adapter.provider}`;
      // Uncommitted deletion must not affect the app's mapped target.
      expect(await evaluate(fixture.client.db, home, work)).toMatchObject({
        kind: "run",
        connectionId: destination,
      });
    });
    try {
      await checkWait();
    } finally {
      await fixture.admin`insert into opengeni_private.subscription_provider_cutover_receipts(provider, migration, committed_at, seed_rotation)
        values (${target.adapter.provider}, '9999_failover_fixture.sql', '-infinity', '{"mode":"spread"}')`;
    }
    await fixture.exhausted(org.accountId, destination);
    await checkWait();
    // A mapped but policy-denied target is not an absent mapping.
    await fixture.admin`insert into workspace_model_policies(account_id, workspace_id, allowed_models)
      values (${org.accountId}::uuid, ${org.workspaceId}::uuid, array['home/model'])`;
    await checkWait();
    const privateOrg = await fixture.organization();
    const privateSource = await fixture.connection(privateOrg, home);
    await fixture.connection(privateOrg, target, { personal: true });
    await fixture.exhausted(privateOrg.accountId, privateSource);
    const privateWork = await fixture.turn(privateOrg);
    expect(await place(fixture.client.db, home, privateWork)).toMatchObject(ordinaryWait);
    expect(await evaluate(fixture.client.db, home, privateWork)).toMatchObject(ordinaryWait);
  });

  test("B1 no-mapping diagnostic preserves same-provider fallback and home maintenance", async () => {
    const org = await fixture.organization();
    const source = await fixture.connection(org, home, { allowedModelIds: ["home/second"] });
    const work = await fixture.turn(org);
    await fixture.admin`update subscription_settings set fallback_order = ${fixture.admin.json({ "home/model": ["home/second", "target/missing"] })}::jsonb where account_id = ${org.accountId}::uuid`;
    expect(await place(fixture.client.db, home, work)).toMatchObject({
      kind: "run",
      modelId: "home/second",
    });
    await fixture.release(work);
    await fixture.exhausted(org.accountId, source);
    expect(await place(fixture.client.db, home, work)).toMatchObject({
      kind: "wait",
      reason: "failover_no_model_mapping",
    });
    await fixture.admin`update subscription_provider_cutovers set enabled = false where account_id = ${org.accountId}::uuid and provider = ${home.adapter.provider}`;
    expect(await place(fixture.client.db, home, work)).toMatchObject({
      kind: "cutover_not_enabled",
    });
    expect(await evaluate(fixture.client.db, home, work)).toMatchObject({
      kind: "cutover_not_enabled",
    });
  });

  test("D-46 home pin, deleted pin and only-model never cross", async () => {
    for (const mode of ["pin", "deleted", "only"] as const) {
      const org = await fixture.organization();
      const source = await fixture.connection(org, home);
      await fixture.connection(org, target);
      await fixture.exhausted(org.accountId, source);
      const work = await fixture.turn(org);
      await fixture.pin(
        org,
        work,
        home.adapter.provider,
        mode === "deleted" ? null : source,
        "home/model",
        mode === "only",
        mode === "only" ? "automatic" : "explicit",
      );
      const before = await fixture.binding(work, home.adapter.provider);
      expect(await place(fixture.client.db, home, work)).toMatchObject({
        kind: "wait",
        reason:
          mode === "pin"
            ? "pinned_account_unavailable"
            : mode === "deleted"
              ? "pinned_account_ineligible"
              : "no_eligible_capacity",
      });
      expect(await fixture.binding(work, home.adapter.provider)).toEqual(before);
      expect(await fixture.binding(work, target.adapter.provider)).toBeNull();
    }
  });

  test("D-46 target pin filters account/model, deleted pin removes provider and every choice is preserved", async () => {
    const org = await fixture.organization();
    const source = await fixture.connection(org, home);
    const pinned = await fixture.connection(org, target);
    await fixture.connection(org, target);
    await fixture.exhausted(org.accountId, source);
    const work = await fixture.turn(org);
    await fixture.pin(org, work, target.adapter.provider, pinned, "target/not-in-order", true);
    expect(await evaluate(fixture.client.db, home, work)).toMatchObject({ kind: "wait" });
    await fixture.pin(org, work, target.adapter.provider, pinned, "target/model", true);
    const result = await place(fixture.client.db, home, work);
    expect(result).toMatchObject({ kind: "run", connectionId: pinned, explicit: true });
    expect(await fixture.binding(work, target.adapter.provider)).toMatchObject({
      connection_id: pinned,
      choice: "explicit",
      only_this_model: true,
    });
    await fixture.release(work);
    await fixture.exhausted(org.accountId, pinned);
    expect(await place(fixture.client.db, home, work)).toMatchObject({ kind: "wait" });
    await fixture.pin(org, work, target.adapter.provider, null, "target/model");
    expect(await evaluate(fixture.client.db, home, work)).toMatchObject({ kind: "wait" });
    expect(await fixture.binding(work, target.adapter.provider)).toMatchObject({
      connection_id: null,
      choice: "explicit",
    });
  });

  test("D-36 continuity keeps warm fallback, returns cold, preserves source row and per-provider clocks", async () => {
    const org = await fixture.organization();
    const source = await fixture.connection(org, home);
    const destination = await fixture.connection(org, target);
    const work = await fixture.turn(org);
    await fixture.pin(org, work, home.adapter.provider, source, "home/model", false, "automatic");
    const initialHome = await fixture.binding(work, home.adapter.provider);
    await fixture.exhausted(org.accountId, source);
    expect(await place(fixture.client.db, home, work)).toMatchObject({
      kind: "run",
      connectionId: destination,
    });
    expect(await fixture.binding(work, home.adapter.provider)).toEqual(initialHome);
    const policy = {
      schemaVersion: 1 as const,
      productModelId: "target/model",
      requestedModelId: null,
      modelSource: "session" as const,
      reasoningEffort: "medium" as const,
      reasoningSource: "session" as const,
      latencyMode: "standard" as const,
      latencyModeSource: "deployment" as const,
      providerId: target.adapter.modelPolicyProviderId,
      upstreamModelId: "target-upstream",
      wireApi: "chat" as const,
      credentialSource: { kind: "organization_connection" as const, mechanism: "api_key" as const },
      billing: { upstreamPayer: "organization" as const, metering: "external" as const },
      definitionVersion: `sha256:${"a".repeat(64)}`,
    };
    expect(
      await recordServing(fixture.client.db, {
        ...work.identity,
        ...work,
        policy,
        connectionId: destination,
        reason: "failover_cross_provider",
      }),
    ).toMatchObject({ accepted: true });
    await fixture.finish(work);
    await fixture.admin`delete from subscription_connection_quota where connection_id = ${source}::uuid`;
    const next = await fixture.turn(org, { sessionId: work.identity.sessionId });
    expect(await place(fixture.client.db, home, next)).toMatchObject({
      kind: "run",
      connectionId: destination,
      switch: "sticky",
    });
    expect(await fixture.binding(next, home.adapter.provider)).toEqual(initialHome);
    await fixture.release(next);
    const targetBeforeReturn = await fixture.binding(next, target.adapter.provider);
    const cold = new Date(Date.now() + 25 * 60_000);
    expect(await place(fixture.client.db, home, { ...next, now: cold })).toMatchObject({
      kind: "run",
      connectionId: source,
      switch: "return_to_preferred",
    });
    expect(await fixture.binding(next, target.adapter.provider)).toEqual(targetBeforeReturn);
    expect(await fixture.binding(next, home.adapter.provider)).toMatchObject({
      connection_id: source,
      last_model_call_at: cold,
    });
    await fixture.finish(next);
    const changed = await fixture.turn(org, {
      sessionId: next.identity.sessionId,
      model: models[2]!,
    });
    expect(await place(fixture.client.db, home, changed)).toMatchObject({
      kind: "run",
      connectionId: source,
    });
    expect(await fixture.binding(changed, home.adapter.provider)).toMatchObject({
      model_id: "home/second",
    });
  });

  test("D-33 same-turn target lease reuse, stale attempt fence and ownerless no-binding behavior", async () => {
    const org = await fixture.organization();
    const source = await fixture.connection(org, home);
    const destination = await fixture.connection(org, target);
    await fixture.exhausted(org.accountId, source);
    const work = await fixture.turn(org);
    expect(await place(fixture.client.db, home, work)).toMatchObject({
      kind: "run",
      connectionId: destination,
    });
    expect(await place(fixture.client.db, home, work)).toMatchObject({
      kind: "run",
      connectionId: destination,
      reusedLease: true,
    });
    expect(
      await place(fixture.client.db, home, { ...work, attemptId: crypto.randomUUID() }),
    ).toMatchObject({ kind: "attempt_fenced" });
    const ownerless = await fixture.turn(org, { ownerless: true });
    expect(await place(fixture.client.db, home, ownerless)).toMatchObject({
      kind: "run",
      connectionId: destination,
    });
    expect(await fixture.binding(ownerless, target.adapter.provider)).toBeNull();
  });

  test("D-38 unresolved source requests fence typed and direct admission across real recovery/reclaim", async () => {
    for (const outcome of ["unknown", "reserved"] as const) {
      for (const closure of [
        "interrupted_recoverable",
        "failed",
        "lease_lost_recoverable",
      ] as const) {
        const org = await fixture.organization();
        const source = await fixture.connection(org, home);
        const destination = await fixture.connection(org, target);
        const work = await fixture.turn(org);
        expect(await place(fixture.client.db, home, work)).toMatchObject({
          kind: "run",
          connectionId: source,
        });
        const ref = {
          connectionId: source,
          holderId: work.holderId,
          generation: work.executionGeneration,
        };
        const reserved = await subscriptionCoreRequests(home).reserveSubscriptionCoreRequest(
          fixture.client.db,
          work.identity,
          ref,
          {
            requestId: crypto.randomUUID(),
            transportAttempt: 1,
            attemptId: work.attemptId,
            executionGeneration: work.executionGeneration,
          },
        );
        if (outcome === "unknown")
          await subscriptionCoreRequests(home).settleSubscriptionCoreRequest(
            fixture.client.db,
            work.identity,
            ref,
            {
              ...reserved,
              attemptId: work.attemptId,
              executionGeneration: work.executionGeneration,
              outcome,
            },
          );
        await fixture.exhausted(org.accountId, source);
        const next = await fixture.recover(work);
        expect(next.executionGeneration).toBe(work.executionGeneration + 1);
        const [attempt] = await fixture.admin<
          { outcome: string; state: string }[]
        >`select outcome, state from session_turn_attempts where id = ${work.attemptId}::uuid`;
        expect(attempt).toEqual({ outcome: "interrupted_recoverable", state: "closed" });
        // Real recovery/reclaim above supplies the generation fence; vary only
        // the already-closed source's terminal reason to cover both other
        // historical exemptions, without fabricating a successor generation.
        if (closure !== "interrupted_recoverable")
          await fixture.admin`update session_turn_attempts set outcome = ${closure} where id = ${work.attemptId}::uuid`;
        expect(await place(fixture.client.db, home, next)).toMatchObject({
          kind: "run",
          connectionId: destination,
        });
        const request = {
          requestId: crypto.randomUUID(),
          transportAttempt: 1,
          attemptId: next.attemptId,
          executionGeneration: next.executionGeneration,
        };
        const targetRef = {
          connectionId: destination,
          holderId: next.holderId,
          generation: next.executionGeneration,
        };
        await expect(
          subscriptionCoreRequests(target).reserveSubscriptionCoreRequest(
            fixture.client.db,
            next.identity,
            targetRef,
            request,
          ),
        ).rejects.toMatchObject({ code: "subscription_core_request_outcome_unknown" });
        const direct = withSubscriptionCoreAcceptedTurn(fixture.client.db, next.identity, (tx) =>
          tx.execute(sql`
          insert into subscription_operation_leases(account_id, workspace_id, operation_id, attempt_id, operation_kind,
            session_id, turn_id, provider, connection_id, holder_id, generation, leased_until,
            request_id, transport_attempt, request_reserved_at, request_outcome)
          values (${org.accountId}::uuid, ${org.workspaceId}::uuid, ${crypto.randomUUID()}::uuid, ${next.attemptId}::uuid, 'model',
            ${next.identity.sessionId}::uuid, ${next.identity.turnId}::uuid, ${target.adapter.provider}, ${destination}::uuid,
            ${next.holderId}, ${next.executionGeneration}, clock_timestamp() + interval '1 minute',
            ${crypto.randomUUID()}, 1, clock_timestamp(), 'reserved')`),
        );
        let error: unknown;
        try {
          await direct;
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeDefined();
        const messages: string[] = [];
        for (let cause = error; cause instanceof Error; cause = cause.cause)
          messages.push(cause.message);
        expect(messages.join(" ")).toContain("prior request outcome is unresolved");
        // Credential/media custody is not model custody and is not fenced.
        await expect(
          subscriptionCoreRequests(target).reserveSubscriptionCoreTurnCredentialRequest(
            fixture.client.db,
            next.identity,
            targetRef,
            { ...request, requestId: crypto.randomUUID() },
          ),
        ).resolves.toHaveProperty("operationId");
        // SAME-provider closed-generation recovery is deliberately preserved.
        await fixture.release(next);
        await fixture.admin`delete from subscription_connection_quota where connection_id = ${source}::uuid`;
        expect(await place(fixture.client.db, home, next)).toMatchObject({
          kind: "run",
          connectionId: source,
        });
        await expect(
          subscriptionCoreRequests(home).reserveSubscriptionCoreRequest(
            fixture.client.db,
            next.identity,
            { ...targetRef, connectionId: source },
            { ...request, requestId: crypto.randomUUID() },
          ),
        ).resolves.toHaveProperty("operationId");
      }
    }
  }, 180_000);

  test("D-38 open unknown and removed-source registry still block", async () => {
    const org = await fixture.organization();
    const source = await fixture.connection(org, home);
    const destination = await fixture.connection(org, target);
    const work = await fixture.turn(org);
    await place(fixture.client.db, home, work);
    const ref = {
      connectionId: source,
      holderId: work.holderId,
      generation: work.executionGeneration,
    };
    const request = {
      requestId: crypto.randomUUID(),
      transportAttempt: 1,
      attemptId: work.attemptId,
      executionGeneration: work.executionGeneration,
    };
    const reservation = await subscriptionCoreRequests(home).reserveSubscriptionCoreRequest(
      fixture.client.db,
      work.identity,
      ref,
      request,
    );
    await subscriptionCoreRequests(home).settleSubscriptionCoreRequest(
      fixture.client.db,
      work.identity,
      ref,
      { ...reservation, ...request, outcome: "unknown" },
    );
    await fixture.release(work);
    await fixture.exhausted(org.accountId, source);
    expect(await place(fixture.client.db, home, work)).toMatchObject({
      kind: "run",
      connectionId: destination,
    });
    const targetRef = { ...ref, connectionId: destination };
    await expect(
      subscriptionCoreRequests(target).reserveSubscriptionCoreRequest(
        fixture.client.db,
        work.identity,
        targetRef,
        { ...request, requestId: crypto.randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "subscription_core_request_outcome_unknown" });
    await fixture.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from opengeni_private.subscription_core_providers where provider = ${home.adapter.provider}`;
    });
    try {
      await expect(
        subscriptionCoreRequests(target).reserveSubscriptionCoreRequest(
          fixture.client.db,
          work.identity,
          targetRef,
          { ...request, requestId: crypto.randomUUID() },
        ),
      ).rejects.toMatchObject({ code: "subscription_core_request_outcome_unknown" });
      await expect(
        withSubscriptionCoreAcceptedTurn(fixture.client.db, work.identity, (tx) =>
          tx.execute(sql`
        insert into subscription_operation_leases(account_id, workspace_id, operation_id, attempt_id, operation_kind,
          session_id, turn_id, provider, connection_id, holder_id, generation, leased_until,
          request_id, transport_attempt, request_reserved_at, request_outcome)
        values (${org.accountId}::uuid, ${org.workspaceId}::uuid, ${crypto.randomUUID()}::uuid, ${work.attemptId}::uuid, 'model',
          ${work.identity.sessionId}::uuid, ${work.identity.turnId}::uuid, ${target.adapter.provider}, ${destination}::uuid,
          ${work.holderId}, ${work.executionGeneration}, clock_timestamp() + interval '1 minute',
          ${crypto.randomUUID()}, 1, clock_timestamp(), 'reserved')`),
        ),
      ).rejects.toThrow();
    } finally {
      await fixture.admin`insert into opengeni_private.subscription_core_providers(provider, extra_credits, primary_setting_column, connection_kind)
        values (${home.adapter.provider}, false, null, 'api_key')`;
    }
  });

  test("D-39 refusal count includes held providers without registry filtering", async () => {
    const { countSubscriptionCoreTurnRefusalsAcrossProviders: count } =
      await import("../src/subscription-core/failover");
    const org = await fixture.organization();
    const source = await fixture.connection(org, home);
    const destination = await fixture.connection(org, target);
    const work = await fixture.turn(org);
    for (const [provider, connectionId, refusals] of [
      [home.adapter.provider, source, 2],
      [target.adapter.provider, destination, 1],
    ] as const)
      await fixture.admin`insert into subscription_turn_failures(account_id, workspace_id, session_id, turn_id, connection_id, provider, failure_kind, recovery_evidence)
        values (${org.accountId}::uuid, ${org.workspaceId}::uuid, ${work.identity.sessionId}::uuid, ${work.identity.turnId}::uuid,
          ${connectionId}::uuid, ${provider}, 'exhausted', ${fixture.admin.json({ refusals })}::jsonb)`;
    await fixture.admin`update subscription_provider_cutovers set enabled = false where account_id = ${org.accountId}::uuid`;
    expect(await count(fixture.client.db, work.identity)).toBe(3);
    expect(
      await count(fixture.client.db, { ...work.identity, workspaceId: crypto.randomUUID() }),
    ).toBeNull();
  });

  test("D-12/D-28 personal home precedes provider fallback; target personal requires its own frozen authority", async () => {
    const org = await fixture.organization();
    const source = await fixture.connection(org, home);
    const ownHome = await fixture.connection(org, home, { personal: true });
    const ownTarget = await fixture.connection(org, target, { personal: true });
    const sharedTarget = await fixture.connection(org, target);
    await fixture.exhausted(org.accountId, source);
    await fixture.admin`insert into subscription_person_preferences(account_id, organization_membership_id, personal_fallback_opt_in)
      values (${org.accountId}::uuid, ${org.membershipId}::uuid, true) on conflict do nothing`;
    const work = await fixture.turn(org, { private: true });
    expect(
      work.identity.acceptedAuthorityV2.personal.map((value) => String(value.provider)),
    ).toContain(home.adapter.provider);
    expect(
      work.identity.acceptedAuthorityV2.personal.map((value) => String(value.provider)),
    ).toContain(target.adapter.provider);
    expect(await place(fixture.client.db, home, work)).toMatchObject({
      kind: "run",
      connectionId: ownHome,
      personal: true,
    });
    await fixture.release(work);
    await fixture.exhausted(org.accountId, ownHome);
    await fixture.pin(org, work, target.adapter.provider, ownTarget, "target/model");
    expect(await place(fixture.client.db, home, work)).toMatchObject({
      kind: "run",
      connectionId: ownTarget,
      personal: true,
    });
    const { TurnExecutionPolicyV1 } = await import("@opengeni/contracts");
    const [row] = await fixture.admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from session_turns where id = ${work.identity.turnId}::uuid`;
    const policy = TurnExecutionPolicyV1.parse({
      ...(row!.metadata.turnExecutionPolicyV1 as object),
      productModelId: "target/model",
      providerId: target.adapter.modelPolicyProviderId,
      upstreamModelId: "target-upstream",
      reasoningEffort: "medium",
    });
    expect(
      await recordServing(fixture.client.db, {
        ...work.identity,
        ...work,
        policy,
        connectionId: ownTarget,
        reason: "failover_cross_provider",
      }),
    ).toMatchObject({ accepted: true });
    await fixture.release(work);
    await fixture.admin`update subscription_person_preferences set personal_fallback_opt_in = false where account_id = ${org.accountId}::uuid`;
    expect(await place(fixture.client.db, home, work)).toMatchObject({ kind: "wait" });
    // Personal workspace participation does not require fallback opt-in (D-28).
    const personal = await fixture.turn(org, { workspaceId: org.personalWorkspaceId });
    await fixture.exhausted(org.accountId, sharedTarget);
    expect(await place(fixture.client.db, home, personal)).toMatchObject({
      kind: "run",
      connectionId: ownTarget,
    });
    const sharedWork = await fixture.turn(org);
    expect(await evaluate(fixture.client.db, home, sharedWork)).toMatchObject({ kind: "wait" });
  });

  test("D-42 revoked or absent frozen personal entry never borrows another provider authority", async () => {
    const org = await fixture.organization();
    const source = await fixture.connection(org, home);
    await fixture.exhausted(org.accountId, source);
    // Accept before the target personal account exists: it cannot be captured.
    const work = await fixture.turn(org, { private: true });
    await fixture.connection(org, target, { personal: true });
    await fixture.admin`insert into subscription_person_preferences(account_id, organization_membership_id, personal_fallback_opt_in)
      values (${org.accountId}::uuid, ${org.membershipId}::uuid, true) on conflict do nothing`;
    expect(
      work.identity.acceptedAuthorityV2.personal.some(
        (value) => value.provider === target.adapter.provider,
      ),
    ).toBe(false);
    expect(await evaluate(fixture.client.db, home, work)).toMatchObject({ kind: "wait" });
    const next = await fixture.turn(org, { private: true });
    const [authority] = await fixture.admin<
      { authority_id: string }[]
    >`select authority_id::text from subscription_connections
      where account_id = ${org.accountId}::uuid and provider = ${target.adapter.provider} and ownership = 'personal'`;
    await fixture.admin`update organization_user_resource_authorities set status = 'revoked', revoked_at = clock_timestamp(), generation = generation + 1 where id = ${authority!.authority_id}::uuid`;
    expect(await evaluate(fixture.client.db, home, next)).toMatchObject({ kind: "wait" });
    await expect(
      evaluate(fixture.client.db, home, {
        ...next,
        identity: { ...next.identity, initiatingHumanSubjectId: "user:foreign" },
      }),
    ).resolves.toMatchObject({ kind: "not_visible" });
  });

  test("D-41 reports earliest reset and health deadline across permitted core candidates", async () => {
    const org = await fixture.organization();
    const source = await fixture.connection(org, home);
    const destination = await fixture.connection(org, target);
    const quarantined = await fixture.connection(org, target);
    const soon = Date.now() + 45_000;
    const later = soon + 60_000;
    const retry = new Date(soon - 10_000);
    await fixture.exhausted(org.accountId, source, later);
    await fixture.exhausted(org.accountId, destination, soon);
    await fixture.admin`update subscription_connections set status = 'error', health_retry_at = ${retry} where id = ${quarantined}::uuid`;
    const work = await fixture.turn(org);
    expect(await evaluate(fixture.client.db, home, work)).toMatchObject({
      kind: "wait",
      earliestResetAt: new Date(soon),
      healthRetryAt: retry,
    });
    await fixture.admin`update subscription_provider_cutovers set enabled = false where account_id = ${org.accountId}::uuid and provider = ${target.adapter.provider}`;
    expect(await evaluate(fixture.client.db, home, work)).toMatchObject({
      kind: "wait",
      earliestResetAt: new Date(later),
      healthRetryAt: null,
    });
  });

  test("D-33 raced first inserts and same-turn reservations agree on one target account", async () => {
    const org = await fixture.organization();
    const source = await fixture.connection(org, home);
    await fixture.connection(org, target);
    await fixture.connection(org, target);
    await fixture.exhausted(org.accountId, source);
    const work = await fixture.turn(org);
    const placements = await Promise.all(
      Array.from({ length: 5 }, () => place(fixture.client.db, home, work)),
    );
    for (const result of placements) expect(result.kind).toBe("run");
    const account = placements[0]!.kind === "run" ? placements[0]!.connectionId : "";
    expect(
      new Set(placements.map((result) => (result.kind === "run" ? result.connectionId : null)))
        .size,
    ).toBe(1);
    expect(await fixture.binding(work, target.adapter.provider)).toMatchObject({
      connection_id: account,
    });
    const results = await Promise.all([
      place(fixture.client.db, home, work),
      subscriptionCoreRequests(target).reserveSubscriptionCoreRequest(
        fixture.client.db,
        work.identity,
        { connectionId: account, holderId: work.holderId, generation: work.executionGeneration },
        {
          requestId: crypto.randomUUID(),
          transportAttempt: 1,
          attemptId: work.attemptId,
          executionGeneration: work.executionGeneration,
        },
      ),
    ]);
    expect(results[0]).toMatchObject({ kind: "run", connectionId: account });
    expect(results[1]).toHaveProperty("operationId");
    // Expiry alone is not a lease-generation dead end for this exact attempt.
    await fixture.admin`update subscription_leases set leased_until = clock_timestamp() - interval '1 second'
      where workspace_id = ${org.workspaceId}::uuid and turn_id = ${work.identity.turnId}::uuid`;
    expect(await place(fixture.client.db, home, work)).toMatchObject({
      kind: "run",
      connectionId: account,
      reusedLease: false,
    });
  });

  test("D-34 home maintenance and D-42 compaction lock preserve waits", async () => {
    const org = await fixture.organization();
    const source = await fixture.connection(org, home);
    await fixture.connection(org, target);
    await fixture.exhausted(org.accountId, source);
    const work = await fixture.turn(org);
    await fixture.admin`update sessions set metadata = metadata || '{"failoverTestLock":true}'::jsonb where id = ${work.identity.sessionId}::uuid`;
    expect(await evaluate(fixture.client.db, home, work)).toMatchObject({
      kind: "wait",
      reason: "compaction_provider_locked",
    });
    expect(await place(fixture.client.db, home, work)).toMatchObject({
      kind: "wait",
      reason: "compaction_provider_locked",
    });
    await fixture.admin`update subscription_provider_cutovers set enabled = false where account_id = ${org.accountId}::uuid and provider = ${home.adapter.provider}`;
    expect(await place(fixture.client.db, home, work)).toEqual({ kind: "cutover_not_enabled" });
    expect(await fixture.binding(work, target.adapter.provider)).toBeNull();
  });

  test("D-35 per-model upstream entitlement and absent/mismatched tiers fail closed", async () => {
    const org = await fixture.organization();
    const source = await fixture.connection(org, home);
    const destination = await fixture.connection(org, target);
    await fixture.exhausted(org.accountId, source);
    const work = await fixture.turn(org);
    await fixture.admin`insert into subscription_connection_quota(account_id, connection_id, model_catalog_slugs,
      model_catalog_refresh_generation, model_catalog_observed_at, model_catalog_expires_at)
      values (${org.accountId}::uuid, ${destination}::uuid, array['not-the-model'], 1, clock_timestamp(), clock_timestamp() + interval '1 minute')`;
    expect(await evaluate(fixture.client.db, home, work)).toMatchObject({ kind: "wait" });
    await fixture.admin`update subscription_connection_quota set model_catalog_slugs = array['target-upstream'] where connection_id = ${destination}::uuid`;
    expect(await evaluate(fixture.client.db, home, work)).toMatchObject({
      kind: "run",
      connectionId: destination,
    });
    await fixture.admin`update subscription_settings set fallback_order = '{}'::jsonb where account_id = ${org.accountId}::uuid`;
    const original = target.adapter.modelTier;
    try {
      for (const tier of [null, "fast", "frontier"]) {
        Object.defineProperty(target.adapter, "modelTier", {
          configurable: true,
          value: () => tier,
        });
        expect(await evaluate(fixture.client.db, home, work)).toMatchObject({ kind: "wait" });
      }
    } finally {
      Object.defineProperty(target.adapter, "modelTier", { configurable: true, value: original });
    }
    expect(await evaluate(fixture.client.db, home, work)).toMatchObject({ kind: "run" });
  });

  test("D-38 unknown media request does not fence a model request on another provider", async () => {
    const org = await fixture.organization();
    const source = await fixture.connection(org, home);
    const destination = await fixture.connection(org, target);
    const work = await fixture.turn(org);
    await place(fixture.client.db, home, work);
    const operationId = crypto.randomUUID();
    await withSubscriptionCoreAcceptedTurn(fixture.client.db, work.identity, (tx) =>
      tx.execute(sql`
      insert into subscription_operation_leases(account_id, workspace_id, operation_id, attempt_id, operation_kind,
        session_id, turn_id, provider, connection_id, holder_id, generation, leased_until,
        request_id, transport_attempt, request_reserved_at, request_outcome)
      values (${org.accountId}::uuid, ${org.workspaceId}::uuid, ${operationId}::uuid, ${work.attemptId}::uuid, 'image',
        ${work.identity.sessionId}::uuid, ${work.identity.turnId}::uuid, ${home.adapter.provider}, ${source}::uuid,
        ${work.holderId}, ${work.executionGeneration}, clock_timestamp() + interval '1 minute',
        ${crypto.randomUUID()}, 1, clock_timestamp(), 'reserved')`),
    );
    await subscriptionCoreRequests(home).settleSubscriptionCoreRequest(
      fixture.client.db,
      work.identity,
      { connectionId: source, holderId: work.holderId, generation: work.executionGeneration },
      {
        operationId,
        attemptId: work.attemptId,
        executionGeneration: work.executionGeneration,
        outcome: "unknown",
      },
    );
    await fixture.release(work);
    await fixture.exhausted(org.accountId, source);
    expect(await place(fixture.client.db, home, work)).toMatchObject({
      kind: "run",
      connectionId: destination,
    });
    await expect(
      subscriptionCoreRequests(target).reserveSubscriptionCoreRequest(
        fixture.client.db,
        work.identity,
        {
          connectionId: destination,
          holderId: work.holderId,
          generation: work.executionGeneration,
        },
        {
          attemptId: work.attemptId,
          executionGeneration: work.executionGeneration,
          requestId: crypto.randomUUID(),
          transportAttempt: 1,
        },
      ),
    ).resolves.toHaveProperty("operationId");
  });

  test("D-42 frozen target shared pools never widen with live organization settings", async () => {
    for (const pool of ["none", "workspace", "organization"] as const) {
      const org = await fixture.organization();
      const source = await fixture.connection(org, home);
      const destination = await fixture.connection(org, target);
      await fixture.exhausted(org.accountId, source);
      const work = await fixture.turn(org);
      // This is the immutable carrier copied by background/scheduled work;
      // no current personal authority or live source may replace its pool.
      await fixture.admin.begin(async (tx) => {
        // Simulate the durable copied carrier after a real-time cutover. The
        // test registration's historical -infinity receipt cannot own records.
        await tx`set local session_replication_role = replica`;
        await tx`insert into opengeni_private.subscription_authority_compat
        (account_id, workspace_id, provider, carrier_kind, turn_id, personal, shared_pool, legacy_scope)
        values (${org.accountId}::uuid, ${org.workspaceId}::uuid, ${target.adapter.provider}, 'session_turn',
          ${work.identity.turnId}::uuid, '[]'::jsonb, ${pool}, ${pool === "none" ? "missing" : pool})`;
      });
      if (pool === "organization")
        expect(await place(fixture.client.db, home, work)).toMatchObject({
          kind: "run",
          connectionId: destination,
        });
      else {
        expect(await place(fixture.client.db, home, work)).toMatchObject({ kind: "wait" });
        expect(await fixture.binding(work, target.adapter.provider)).toBeNull();
      }
    }
  });

  test("D-34 unreadable readiness and mismatched kind fail closed without aborting the world", async () => {
    const org = await fixture.organization();
    const work = await fixture.turn(org);
    const [role] = await fixture.admin<
      { rolname: string }[]
    >`select rolname from pg_roles where rolname = ${new URL(shared.appUrl).username}`;
    await fixture.admin`revoke execute on function opengeni_private.subscription_core_failover_readiness(text) from ${fixture.admin(role!.rolname)}`;
    try {
      expect(
        await withSubscriptionCoreAcceptedTurn(fixture.client.db, work.identity, (tx) =>
          readSubscriptionCoreFailoverProvider(tx, org.accountId, target.adapter.provider),
        ),
      ).toEqual({ status: "completed", value: null });
    } finally {
      await fixture.admin`grant execute on function opengeni_private.subscription_core_failover_readiness(text) to ${fixture.admin(role!.rolname)}`;
    }
    await fixture.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update opengeni_private.subscription_core_providers set connection_kind = 'subscription' where provider = ${target.adapter.provider}`;
    });
    try {
      expect(
        await withSubscriptionCoreAcceptedTurn(fixture.client.db, work.identity, (tx) =>
          readSubscriptionCoreFailoverProvider(tx, org.accountId, target.adapter.provider),
        ),
      ).toEqual({ status: "completed", value: null });
    } finally {
      await fixture.admin.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update opengeni_private.subscription_core_providers set connection_kind = 'api_key' where provider = ${target.adapter.provider}`;
      });
    }
  });

  test("D-33 older foreign lease stays busy; disabled or pinned routing releases only its own lease", async () => {
    const org = await fixture.organization();
    const source = await fixture.connection(org, home);
    const destination = await fixture.connection(org, target);
    await fixture.exhausted(org.accountId, source);
    const work = await fixture.turn(org);
    expect(await place(fixture.client.db, home, work)).toMatchObject({
      kind: "run",
      connectionId: destination,
    });
    const next = await fixture.recover(work);
    await withSubscriptionCoreAcceptedTurn(fixture.client.db, next.identity, (tx) =>
      acquireSubscriptionTurnLease(tx, {
        ...next.identity,
        provider: target.adapter.provider,
        connectionId: destination,
        holderId: work.holderId,
        generation: work.executionGeneration,
        ttlMs: 60_000,
      }),
    );
    expect(await place(fixture.client.db, home, next)).toMatchObject({ kind: "lease_busy" });
    expect(
      await place(fixture.client.db, home, { ...next, crossProviderFailoverEnabled: false }),
    ).toMatchObject({ kind: "lease_busy" });
    await fixture.release(next);
    expect(await place(fixture.client.db, home, next)).toMatchObject({
      kind: "run",
      connectionId: destination,
    });
    await fixture.admin`delete from subscription_connection_quota where connection_id = ${source}::uuid`;
    expect(
      await place(fixture.client.db, home, { ...next, crossProviderFailoverEnabled: false }),
    ).toMatchObject({ kind: "run", connectionId: source });
    await fixture.release(next);
    await fixture.exhausted(org.accountId, source);
    expect(await place(fixture.client.db, home, next)).toMatchObject({
      kind: "run",
      connectionId: destination,
    });
    await fixture.pin(org, next, home.adapter.provider, source, "home/model");
    expect(await place(fixture.client.db, home, next)).toMatchObject({ kind: "wait" });
    const [leases] = await fixture.admin<
      { count: number }[]
    >`select count(*)::int as count from subscription_leases where turn_id = ${next.identity.turnId}::uuid`;
    expect(leases!.count).toBe(0);
  });

  test("D-36 current-turn serving revision survives a cold cache and reclaimed attempt", async () => {
    const org = await fixture.organization();
    const source = await fixture.connection(org, home);
    const destination = await fixture.connection(org, target);
    await fixture.exhausted(org.accountId, source);
    const work = await fixture.turn(org);
    expect(await place(fixture.client.db, home, work)).toMatchObject({
      kind: "run",
      connectionId: destination,
    });
    const { TurnExecutionPolicyV1 } = await import("@opengeni/contracts");
    const [row] = await fixture.admin<
      { metadata: Record<string, unknown> }[]
    >`select metadata from session_turns where id = ${work.identity.turnId}::uuid`;
    const policy = TurnExecutionPolicyV1.parse({
      ...(row!.metadata.turnExecutionPolicyV1 as object),
      productModelId: "target/model",
      providerId: target.adapter.modelPolicyProviderId,
      upstreamModelId: "target-upstream",
      reasoningEffort: "medium",
    });
    expect(
      await recordServing(fixture.client.db, {
        ...work.identity,
        ...work,
        policy,
        connectionId: destination,
        reason: "failover_cross_provider",
      }),
    ).toMatchObject({ accepted: true });
    const next = await fixture.recover(work);
    await fixture.admin`delete from subscription_connection_quota where connection_id = ${source}::uuid`;
    expect(
      await place(fixture.client.db, home, { ...next, now: new Date(Date.now() + 25 * 60_000) }),
    ).toMatchObject({ kind: "run", connectionId: destination, switch: "sticky" });
  });

  test("D-33 distinct turns in one session cannot split accounts across the active-turn fence", async () => {
    const org = await fixture.organization();
    const source = await fixture.connection(org, home);
    await fixture.connection(org, target);
    await fixture.connection(org, target);
    await fixture.exhausted(org.accountId, source);
    const prior = await fixture.turn(org);
    await fixture.finish(prior);
    const current = await fixture.turn(org, { sessionId: prior.identity.sessionId });
    const results = await Promise.all([
      place(fixture.client.db, home, prior),
      place(fixture.client.db, home, current),
    ]);
    expect(results[0]).toEqual({ kind: "attempt_fenced" });
    expect(results[1].kind).toBe("run");
    const leases = await fixture.admin<
      { turn_id: string; connection_id: string }[]
    >`select turn_id::text, connection_id::text from subscription_leases where session_id = ${current.identity.sessionId}::uuid`;
    expect(leases).toHaveLength(1);
    expect(leases[0]!.turn_id).toBe(current.identity.turnId);
    expect(await fixture.binding(current, target.adapter.provider)).toMatchObject({
      connection_id: leases[0]!.connection_id,
    });
  });

  test("D-33 first-insert serialization is held before any connection lease", async () => {
    const { withSubscriptionCoreFailoverPlacementWorld } =
      await import("../src/subscription-core/failover-world");
    const org = await fixture.organization();
    const work = await fixture.turn(org);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = withSubscriptionCoreFailoverPlacementWorld(
      fixture.client.db,
      home,
      work,
      true,
      async () => {
        entered();
        await held;
        return true;
      },
    );
    await ready;
    try {
      // Missing binding rows cannot be row-locked. Observe the B1 session
      // lock before its callback can acquire any connection lock/lease.
      const [lock] = await fixture.admin<{ held: boolean }[]>`select exists (
        select 1 from pg_locks where locktype = 'advisory' and granted and mode = 'ExclusiveLock'
          and classid = ((hashtextextended(${`subscription-failover:${org.workspaceId}:${work.identity.sessionId}`}, 0) >> 32) & 4294967295)::oid
          and objid = (hashtextextended(${`subscription-failover:${org.workspaceId}:${work.identity.sessionId}`}, 0) & 4294967295)::oid
      ) as held`;
      expect(lock!.held).toBe(true);
      const [leases] = await fixture.admin<
        { count: number }[]
      >`select count(*)::int as count from subscription_leases where turn_id = ${work.identity.turnId}::uuid`;
      expect(leases!.count).toBe(0);
    } finally {
      release();
      await first;
    }
  });

  test("D-33 home-only placement holds the same session fence as provider switching", async () => {
    const org = await fixture.organization();
    await fixture.connection(org, home);
    const work = await fixture.turn(org);
    const key = `subscription-failover:${org.workspaceId}:${work.identity.sessionId}`;
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const blocker = withSubscriptionCoreAcceptedTurn(fixture.client.db, work.identity, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      entered();
      await held;
    });
    await ready;
    const placing = place(fixture.client.db, home, {
      ...work,
      crossProviderFailoverEnabled: false,
    });
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const [row] = await fixture.admin<{ waiting: boolean }[]>`select exists (
          select 1 from pg_locks where locktype = 'advisory' and not granted
            and classid = ((hashtextextended(${key}, 0) >> 32) & 4294967295)::oid
            and objid = (hashtextextended(${key}, 0) & 4294967295)::oid
        ) as waiting`;
        waiting = row!.waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waiting).toBe(true);
      const [leases] = await fixture.admin<{ count: number }[]>`select count(*)::int as count
        from subscription_leases where turn_id = ${work.identity.turnId}::uuid`;
      expect(leases!.count).toBe(0);
    } finally {
      release();
      await blocker;
      await placing;
    }
    expect(await placing).toMatchObject({ kind: "run" });
  });

  test("D-46 transactional rolling-index drop preserves provider key and rolls back on failure", async () => {
    // B1 does not implement or activate the downstream drained cutover. This
    // tests the schema boundary it consumes after that cutover's preflight.
    await fixture.admin`create unique index subscription_session_bindings_rolling_session_idx
      on subscription_session_bindings(workspace_id, session_id) where false`;
    const org = await fixture.organization();
    const work = await fixture.turn(org);
    const crossing = () =>
      withSubscriptionCoreAcceptedTurn(fixture.client.db, work.identity, (tx) =>
        subscriptionCoreBindingsPermitCrossing(tx),
      );
    expect(await crossing()).toEqual({ status: "completed", value: false });
    await expect(
      fixture.admin.begin(async (tx) => {
        await tx`drop index subscription_session_bindings_rolling_session_idx`;
        const [invariant] = await tx<{ provider_fixed: boolean; provider_key: boolean }[]>`select
        exists(select 1 from pg_trigger where tgrelid = 'subscription_session_bindings'::regclass
          and tgname = 'subscription_session_bindings_provider_fixed' and tgenabled = 'O') as provider_fixed,
        exists(select 1 from pg_index where indrelid = 'subscription_session_bindings'::regclass
          and indisprimary and indisvalid and indnkeyatts = 3) as provider_key`;
        expect(invariant).toEqual({ provider_fixed: true, provider_key: true });
        throw new Error("simulated cutover verification failure");
      }),
    ).rejects.toThrow("simulated cutover verification failure");
    expect(await crossing()).toEqual({ status: "completed", value: false });
    await fixture.admin`drop index subscription_session_bindings_rolling_session_idx`;
    expect(await crossing()).toEqual({ status: "completed", value: true });
  });

  test("D-33 parity copies preserve compacted/cleared context, commit clocks and stale decisions", async () => {
    const { commitBinding, readAttemptFence } = await import("../src/subscription-core/failover");
    const { policyBinding, readLastContextReplacedAt } =
      await import("../src/subscription-core/failover-world");
    const { readSubscriptionSessionBinding } = await import("../src/subscription-core-repository");
    for (const copied of [false, true]) {
      const org = await fixture.organization();
      const connectionId = await fixture.connection(org, home);
      const work = await fixture.turn(org);
      const now = new Date();
      if (copied)
        await withSubscriptionCoreAcceptedTurn(fixture.client.db, work.identity, (tx) =>
          commitBinding(tx, work.identity, home.adapter.provider, {
            decidedFrom: null,
            clockDecided: false,
            connectionId,
            modelId: "home/model",
            placementSwitch: "initial",
            now,
            restartClock: true,
          }),
        );
      else
        expect(
          await subscriptionCoreTurns(home).placeSubscriptionCoreTurn(fixture.client.db, {
            ...work,
            now,
          }),
        ).toMatchObject({ kind: "run", connectionId });
      expect(await fixture.binding(work, home.adapter.provider)).toMatchObject({
        connection_id: connectionId,
        model_id: "home/model",
        choice: "automatic",
        last_model_call_at: now,
        version: "1",
      });
      await fixture.release(work);
      for (const [index, type] of [
        "session.context.compacted",
        "session.context.cleared",
      ].entries()) {
        const occurredAt = new Date(now.getTime() + 1000 * (index + 1));
        await fixture.admin`insert into session_events(account_id, workspace_id, session_id, sequence, type, payload, occurred_at)
          select ${org.accountId}::uuid, ${org.workspaceId}::uuid, ${work.identity.sessionId}::uuid, coalesce(max(sequence), 0) + 1,
            ${type!}, '{}'::jsonb, ${occurredAt} from session_events where session_id = ${work.identity.sessionId}::uuid`;
        expect(
          await withSubscriptionCoreAcceptedTurn(fixture.client.db, work.identity, (tx) =>
            readLastContextReplacedAt(tx, work.identity),
          ),
        ).toEqual({ status: "completed", value: occurredAt.getTime() });
      }
      const future = new Date(now.getTime() + 3000);
      expect(
        await subscriptionCoreTurns(home).placeSubscriptionCoreTurn(fixture.client.db, {
          ...work,
          now: future,
        }),
      ).toMatchObject({
        kind: "run",
        reselection: { reason: "reselection_point", points: ["compaction_completed"] },
      });
      expect(
        await withSubscriptionCoreAcceptedTurn(fixture.client.db, work.identity, (tx) =>
          readAttemptFence(tx, { ...work, executionGeneration: work.executionGeneration + 1 }),
        ),
      ).toEqual({ status: "completed", value: false });
      expect(
        await subscriptionCoreTurns(home).placeSubscriptionCoreTurn(fixture.client.db, {
          ...work,
          executionGeneration: work.executionGeneration + 1,
        }),
      ).toEqual({ kind: "attempt_fenced" });
      await withSubscriptionCoreAcceptedTurn(fixture.client.db, work.identity, async (tx) => {
        const binding = policyBinding(
          await readSubscriptionSessionBinding(tx, {
            ...work.identity,
            provider: home.adapter.provider,
            forUpdate: true,
          }),
        );
        const next = {
          decidedFrom: binding,
          clockDecided: true,
          connectionId,
          modelId: "home/model",
          placementSwitch: "sticky" as const,
          now: future,
          restartClock: false,
        };
        await commitBinding(tx, work.identity, home.adapter.provider, next);
        await expect(
          commitBinding(tx, work.identity, home.adapter.provider, {
            ...next,
            decidedFrom: { ...binding!, lastModelCallAt: now.getTime() },
          }),
        ).rejects.toThrow();
      });
      expect(await fixture.binding(work, home.adapter.provider)).toMatchObject({
        last_model_call_at: future,
        version: "1",
      });
    }
  });

  test("D-33 opposite-direction placements serialize with pin, refresh, disconnect and request reservation", async () => {
    const { withSubscriptionCoreRefreshLock } =
      await import("../src/subscription-core-placement-world");
    const { persistSubscriptionCoreRefresh } = await import("../src/subscription-core-repository");
    const { disconnectSubscriptionCoreConnection } =
      await import("../src/subscription-core/connections");
    const org = await fixture.organization();
    const source = await fixture.connection(org, home);
    const destination = await fixture.connection(org, target);
    const disconnect = await fixture.connection(org, target, { allowedModelIds: [] });
    const reverseModel = {
      id: "target/second",
      provider: target.adapter.provider,
      upstreamModelId: "target-second",
      reasoningLevels: ["low", "high"],
    };
    const catalog = [...models, reverseModel];
    await fixture.admin`update subscription_settings set fallback_order = ${fixture.admin.json({ "home/model": ["target/model"], "target/second": ["home/second"] })}::jsonb where account_id = ${org.accountId}::uuid`;
    const left = { ...(await fixture.turn(org)), models: catalog };
    const right = { ...(await fixture.turn(org, { model: reverseModel })), models: catalog };
    // Existing own home leases let a physical reservation and a real refresh
    // race the switch. No provider I/O: the refresh callback persists a local fixture.
    await withSubscriptionCoreAcceptedTurn(fixture.client.db, left.identity, (tx) =>
      acquireSubscriptionTurnLease(tx, {
        ...left.identity,
        provider: home.adapter.provider,
        connectionId: source,
        holderId: left.holderId,
        generation: left.executionGeneration,
        ttlMs: 60_000,
      }),
    );
    const refreshing = await fixture.turn(org, { model: models[1]! });
    await withSubscriptionCoreAcceptedTurn(fixture.client.db, refreshing.identity, (tx) =>
      acquireSubscriptionTurnLease(tx, {
        ...refreshing.identity,
        provider: target.adapter.provider,
        connectionId: destination,
        holderId: refreshing.holderId,
        generation: refreshing.executionGeneration,
        ttlMs: 60_000,
      }),
    );
    for (const [connectionId, modelId] of [
      [source, "home/model"],
      [destination, "target/second"],
    ])
      await fixture.admin`insert into subscription_connection_quota(account_id, connection_id, quota, observed_refresh_generation, revision, updated_at)
        values (${org.accountId}::uuid, ${connectionId!}::uuid,
          ${fixture.admin.json({ windows: [], modelCooldowns: { [modelId!]: Date.now() + 60_000 }, exhaustedUntil: null, source: "refusal" })}::jsonb,
          1, 1, clock_timestamp())`;
    const raced = await Promise.allSettled([
      place(fixture.client.db, home, left),
      place(fixture.client.db, target, right),
      fixture.pin(org, left, target.adapter.provider, destination, "target/model"),
      withSubscriptionCoreRefreshLock(
        fixture.client.db,
        target,
        {
          ...refreshing.identity,
          connectionId: destination,
          holderId: refreshing.holderId,
          generation: refreshing.executionGeneration,
        },
        (tx, credential) =>
          persistSubscriptionCoreRefresh(tx, {
            ...refreshing.identity,
            provider: target.adapter.provider,
            connectionId: destination,
            expectedRefreshGeneration: credential.refreshGeneration,
            credentialEncrypted: encryptEnvironmentValue(Buffer.alloc(32, 73), "fixture-rotated"),
            expiresAt: null,
            lastRefreshAt: new Date(),
          }),
      ),
      disconnectSubscriptionCoreConnection(fixture.client.db, target, {
        accountId: org.accountId,
        workspaceId: null,
        subjectId: org.subjectId,
        connectionId: disconnect,
      }),
      subscriptionCoreRequests(home).reserveSubscriptionCoreRequest(
        fixture.client.db,
        left.identity,
        { connectionId: source, holderId: left.holderId, generation: left.executionGeneration },
        {
          attemptId: left.attemptId,
          executionGeneration: left.executionGeneration,
          requestId: crypto.randomUUID(),
          transportAttempt: 1,
        },
      ),
    ]);
    for (const [index, result] of raced.entries()) {
      if (index === 5 && result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "subscription_core_lease_lost" });
      } else expect(result.status).toBe("fulfilled");
    }
    expect(raced[0]).toMatchObject({
      status: "fulfilled",
      value: { kind: "run", connectionId: destination },
    });
    expect(raced[1]).toMatchObject({
      status: "fulfilled",
      value: { kind: "run", connectionId: source },
    });
    expect(raced[3]).toMatchObject({
      status: "fulfilled",
      value: { status: "completed", value: true },
    });
    expect(raced[4]).toMatchObject({ status: "fulfilled", value: { outcome: "removed" } });
    expect(await fixture.binding(left, target.adapter.provider)).toMatchObject({
      connection_id: destination,
      choice: "explicit",
    });
    expect(await fixture.binding(right, home.adapter.provider)).toMatchObject({
      connection_id: source,
    });
    const [mismatch] = await fixture.admin<
      { count: number }[]
    >`select count(*)::int as count from subscription_leases lease
      join subscription_session_bindings binding on binding.workspace_id = lease.workspace_id and binding.session_id = lease.session_id and binding.provider = lease.provider
      where lease.turn_id in (${left.identity.turnId}::uuid, ${right.identity.turnId}::uuid) and binding.connection_id <> lease.connection_id`;
    expect(mismatch!.count).toBe(0);
    // Placement has returned, so every binding lock is gone before C1 takes
    // turn FOR UPDATE. Race that separate fence against turn SHARE -> binding
    // reservation to exercise the required post-commit ordering.
    const { TurnExecutionPolicyV1 } = await import("@opengeni/contracts");
    const [turnRow] = await fixture.admin<
      { metadata: Record<string, unknown> }[]
    >`select metadata from session_turns where id = ${left.identity.turnId}::uuid`;
    const policy = TurnExecutionPolicyV1.parse({
      ...(turnRow!.metadata.turnExecutionPolicyV1 as object),
      productModelId: "target/model",
      providerId: target.adapter.modelPolicyProviderId,
      upstreamModelId: "target-upstream",
      reasoningEffort: "medium",
    });
    const postCommit = await Promise.all([
      recordServing(fixture.client.db, {
        ...left.identity,
        ...left,
        policy,
        connectionId: destination,
        reason: "failover_cross_provider",
      }),
      subscriptionCoreRequests(target).reserveSubscriptionCoreRequest(
        fixture.client.db,
        left.identity,
        {
          connectionId: destination,
          holderId: left.holderId,
          generation: left.executionGeneration,
        },
        {
          attemptId: left.attemptId,
          executionGeneration: left.executionGeneration,
          requestId: crypto.randomUUID(),
          transportAttempt: 1,
        },
      ),
    ]);
    expect(postCommit[0]).toMatchObject({ accepted: true });
    expect(postCommit[1]).toHaveProperty("operationId");
  }, 180_000);
});
