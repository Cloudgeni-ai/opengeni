import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";

import { sql } from "drizzle-orm";
import {
  createDb,
  ensureManagedAccessForUser,
  createOrganizationSharedWorkspace,
  readSubscriptionUsagePool,
  withRlsContext,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { setSubjectRlsContext, rawRows } from "../src/database";
import {
  recordSubscriptionUsageReading,
  withSubscriptionUsageReading,
} from "../src/subscription-core/usage-reading";
import { subscriptionPlanWeight } from "../src/subscription-usage-pool";
import {
  buildSubscriptionUsagePool,
  storedQuotaDocument,
  type SubscriptionQuota,
  type SubscriptionUsagePoolInput,
} from "@opengeni/subscriptions";

const real = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  if (!real) return;
  shared = await acquireSharedTestDatabase("pooled-usage-faaa0257");
  if (!shared) throw new Error("Real PostgreSQL required");
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

test.skipIf(!real)(
  "persists raw readings atomically, scopes pools and histories, and prunes only expired telemetry",
  async () => {
    const userId = crypto.randomUUID();
    const subjectId = `user:${userId}`;
    const access = await ensureManagedAccessForUser(client!.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Pool test",
    });
    const accountId = access.workspaceGrants[0]!.accountId;
    const workspace = await createOrganizationSharedWorkspace(client!.db, {
      organizationId: accountId,
      actorSubjectId: subjectId,
      name: "Pool test workspace",
      operationId: crypto.randomUUID(),
    });
    const otherWorkspace = await createOrganizationSharedWorkspace(client!.db, {
      organizationId: accountId,
      actorSubjectId: subjectId,
      name: "Other pool workspace",
      operationId: crypto.randomUUID(),
    });
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [i, id] of ids.entries()) {
      await shared!
        .admin`insert into subscription_connections(id,account_id,provider,kind,credential_encrypted,credential_format,
      provider_account_id,plan_type,ownership,scope_kind,status,allocator_enabled,allow_personal_workspaces)
      values(${id},${accountId},'codex','subscription','fixture','v1',${crypto.randomUUID()},${i ? "plus" : "pro"},'shared','workspaces','active',true,false)`;
    }
    await shared!
      .admin`insert into subscription_connection_workspaces(account_id,connection_id,workspace_id)
    values(${accountId},${ids[0]!},${workspace.id})`;
    const now = Date.now();
    const observation: SubscriptionQuota = {
      windows: [{ id: "primary", usedPercent: 25, resetsAt: now + 3_600_000, status: "ok" }],
      modelCooldowns: {},
      exhaustedUntil: null,
      exhaustedKind: null,
      observedAt: now,
      observedRefreshGeneration: 1,
      revision: 1,
      source: "usage_endpoint",
    };
    for (const id of ids) {
      const document = withSubscriptionUsageReading(storedQuotaDocument(observation), observation);
      await shared!
        .admin`insert into subscription_connection_quota(account_id,connection_id,quota,observed_refresh_generation,revision,updated_at)
      values(${accountId},${id},${shared!.admin.json(document)},1,1,${new Date(now).toISOString()})`;
    }
    const history = await shared!
      .admin`select * from opengeni_private.subscription_usage_readings where account_id=${accountId}`;
    expect(history.length).toBe(2);
    expect(Number(history[0]!.used_percent)).toBe(25);
    // Repeated snapshot writes never duplicate an observation.
    await shared!
      .admin`update subscription_connection_quota set revision=revision+1,updated_at=updated_at where connection_id=${ids[0]!}`;
    expect(
      (
        await shared!
          .admin`select * from opengeni_private.subscription_usage_readings where account_id=${accountId}`
      ).length,
    ).toBe(2);
    const read = (workspaceId: string | null) =>
      withSessionRlsActorContext({ subjectId }, () =>
        readSubscriptionUsagePool(client!.db, {
          accountId,
          workspaceId,
          subjectId,
          provider: "codex",
          now,
        }),
      );
    const organization = await read(null);
    expect(organization.windows[0]!.accounts.map((a) => a.id).sort()).toEqual([...ids].sort());
    // The assigned organization account reaches this workspace; the other does not.
    expect((await read(workspace.id)).windows[0]!.accounts.map((a) => a.id)).toEqual([ids[0]!]);
    expect(
      (await read(otherWorkspace.id)).windows.every((window) => window.accounts.length === 0),
    ).toBe(true);
    await shared!.admin.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${accountId}, true), set_config('opengeni.subject_id', ${subjectId}, true)`;
      await tx`update subscription_connections set managed_by_workspace_id=${workspace.id}::uuid where id=${ids[0]!}::uuid`;
      await tx`update subscription_connections set scope_kind='organization' where id=${ids[1]!}::uuid`;
    });
    const scoped = await read(workspace.id);
    // Workspace-owned and organization-wide accounts combine in one pool.
    expect(scoped.windows[0]!.accounts.map((a) => a.id).sort()).toEqual([...ids].sort());
    expect((await read(otherWorkspace.id)).windows[0]!.accounts.map((a) => a.id)).toEqual([
      ids[1]!,
    ]);
    // The limits overview includes all available sources even when inference selects one.
    await shared!.admin.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${accountId}, true), set_config('opengeni.subject_id', ${subjectId}, true)`;
      await tx`insert into subscription_settings(account_id,workspace_id,providers)
        values(${accountId},${workspace.id},'{"codex":{"inferenceSource":"workspace"}}'::jsonb)
        on conflict (account_id,workspace_id) do update set providers=excluded.providers`;
    });
    expect((await read(workspace.id)).windows[0]!.accounts.map((a) => a.id).sort()).toEqual(
      [...ids].sort(),
    );
    await expect(
      withRlsContext(client!.db, { accountId, workspaceId: workspace.id }, async (tx) => {
        await setSubjectRlsContext(tx, subjectId);
        return tx.execute(sql`select opengeni_private.read_subscription_usage_history(${crypto.randomUUID()}::uuid,
      ${workspace.id}::uuid, ${subjectId}, 'codex', ARRAY[${ids[0]}::uuid])`);
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(
      Promise.resolve(
        client!.db.execute(sql`select * from opengeni_private.subscription_usage_readings`),
      ),
    ).rejects.toThrow();
    await shared!
      .admin`insert into opengeni_private.subscription_usage_readings(account_id,connection_id,window_id,observed_at,used_percent)
    values(${accountId},${ids[0]!},'primary',now()-interval '31 days',1)`;
    await rawRows(client!.db, sql`select opengeni_private.prune_subscription_usage_history()`);
    expect(
      (
        await shared!
          .admin`select * from opengeni_private.subscription_usage_readings where account_id=${accountId}`
      ).length,
    ).toBe(2);

    // Original endpoint observations survive independently of allocator quota.
    const append = (id: string, usedPercent: number | null, at: number) =>
      withSessionRlsActorContext({ subjectId }, () =>
        withRlsContext(client!.db, { accountId, workspaceId: workspace.id }, async (tx) => {
          await setSubjectRlsContext(tx, subjectId);
          return recordSubscriptionUsageReading(tx, accountId, id, "codex", {
            observedAt: at,
            windows: [{ id: "primary", usedPercent, resetsAt: now + 3_600_000, status: "ok" }],
          });
        }),
      );
    await append(ids[0]!, 40, now + 1);
    await append(ids[0]!, 40, now + 1);
    expect(
      (
        await shared!
          .admin`select * from opengeni_private.subscription_usage_readings where account_id=${accountId}`
      ).length,
    ).toBe(3);
    await expect(append(crypto.randomUUID(), 40, now + 1)).rejects.toMatchObject({
      cause: { code: "42501" },
    });
    await append(ids[0]!, null, now + 2);
    const unknown = await withSessionRlsActorContext({ subjectId }, () =>
      readSubscriptionUsagePool(client!.db, {
        accountId,
        workspaceId: workspace.id,
        subjectId,
        provider: "codex",
        now: now + 3,
      }),
    );
    // The newest (unknown) reading blanks only its own account; the pool total
    // covers the accounts that reported.
    const pooled = unknown.windows[0]!.accounts;
    expect(pooled.find((account) => account.id === ids[0])!.remainingPercent).toBeNull();
    expect(pooled.find((account) => account.id !== ids[0])!.remainingPercent).toBe(75);
    expect(unknown.windows[0]!.remainingPercent).toBe(75);
    expect(
      (
        await shared!
          .admin`select quota from subscription_connection_quota where connection_id=${ids[0]!}`
      )[0]!.quota.windows[0].usedPercent,
    ).toBe(25);

    // The telemetry mirror preserves call/account identity and at least seven days.
    const factId = crypto.randomUUID();
    await shared!
      .admin`insert into model_call_facts(id,account_id,workspace_id,connection_id,session_id,turn_id,source_key,
    provider,provider_api,model,billing_path,estimated_provider_cost_micros,pricing_source,occurred_at)
    values(${factId},${accountId},${workspace.id},${ids[0]!},${crypto.randomUUID()},${crypto.randomUUID()},'pool-test',
      'codex','responses','fixture','external',123,'configured_list_price',now()-interval '8 days')`;
    const mirrored = await shared!
      .admin`select connection_id,units from opengeni_private.subscription_usage_calls where fact_id=${factId}`;
    expect(mirrored[0]!.connection_id).toBe(ids[0]);
    expect(Number(mirrored[0]!.units)).toBe(123);
    await rawRows(client!.db, sql`select opengeni_private.prune_subscription_usage_history()`);
    expect(
      (
        await shared!
          .admin`select * from opengeni_private.subscription_usage_calls where fact_id=${factId}`
      ).length,
    ).toBe(1);
    await shared!.admin`update model_call_facts set connection_id=null where id=${factId}`;
    expect(
      (
        await shared!
          .admin`select * from opengeni_private.subscription_usage_calls where fact_id=${factId}`
      ).length,
    ).toBe(0);

    // Shared-account history includes calls from every workspace, not just the filtered one.
    const sharedFactId = crypto.randomUUID();
    await shared!
      .admin`insert into model_call_facts(id,account_id,workspace_id,connection_id,session_id,turn_id,source_key,
      provider,provider_api,model,billing_path,estimated_provider_cost_micros,pricing_source,occurred_at)
      values(${sharedFactId},${accountId},${otherWorkspace.id},${ids[1]!},${crypto.randomUUID()},${crypto.randomUUID()},'cross-workspace-pool-test',
        'codex','responses','fixture','external',456,'configured_list_price',now()-interval '1 hour')`;
    const accountHistory = (workspaceId: string) =>
      withSessionRlsActorContext({ subjectId }, () =>
        withRlsContext(client!.db, { accountId, workspaceId }, async (tx) => {
          await setSubjectRlsContext(tx, subjectId);
          const [row] = await rawRows<{
            history: { calls: { connectionId: string; units: number }[]; readings: unknown[] };
          }>(
            tx,
            sql`select opengeni_private.read_subscription_usage_history(${accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, 'codex', ARRAY[${ids[1]}::uuid]) as history`,
          );
          return row!.history;
        }),
      );
    const fromTarget = await accountHistory(workspace.id);
    expect(fromTarget.calls).toHaveLength(1);
    expect(fromTarget.calls[0]!.units).toBe(456);
    expect(fromTarget).toEqual(await accountHistory(otherWorkspace.id));
  },
  180_000,
);

type HistoryReading = {
  connectionId: string;
  window: string;
  usedPercent: number | null;
  resetsAt: number | null;
  observedAt: number;
};
type HistoryCall = { connectionId: string; at: number; units: number; count?: number };

test.skipIf(!real)(
  "a dense history reads back bounded, keeps every change and call total, and forecasts the same",
  async () => {
    const userId = crypto.randomUUID();
    const subjectId = `user:${userId}`;
    const access = await ensureManagedAccessForUser(client!.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Dense history test",
    });
    const accountId = access.workspaceGrants[0]!.accountId;
    const workspace = await createOrganizationSharedWorkspace(client!.db, {
      organizationId: accountId,
      actorSubjectId: subjectId,
      name: "Dense history workspace",
      operationId: crypto.randomUUID(),
    });
    const connectionId = crypto.randomUUID();
    await shared!
      .admin`insert into subscription_connections(id,account_id,provider,kind,credential_encrypted,credential_format,
      provider_account_id,plan_type,ownership,scope_kind,status,allocator_enabled,allow_personal_workspaces)
      values(${connectionId},${accountId},'codex','subscription','fixture','v1',${crypto.randomUUID()},'pro','shared','workspaces','active',true,false)`;
    // Six hours read every ten seconds, as a busy account reports after every
    // call: the five-hour window resets four hours ago and then rises a point
    // every five minutes, the weekly window a point every half hour.
    await shared!.admin`
      with clock as (select date_trunc('second', now()) as now)
      insert into opengeni_private.subscription_usage_readings
        (account_id, connection_id, window_id, observed_at, used_percent, resets_at)
      select ${accountId}::uuid, ${connectionId}::uuid, w.id, clock.now - s * interval '10 seconds',
        case when w.id = 'secondary' then 30 + floor((2160 - s) / 180.0)
          when s > 1440 then 50 + floor((2160 - s) / 72.0)
          else floor((1440 - s) / 30.0) end,
        case when w.id = 'secondary' then clock.now + interval '3 days'
          when s > 1440 then clock.now - interval '4 hours'
          else clock.now + interval '1 hour' end
      from clock, generate_series(0, 2159) s, (values ('primary'), ('secondary')) w(id)`;
    // A call every 13 seconds, of varying size.
    await shared!.admin`
      insert into model_call_facts(account_id,workspace_id,connection_id,session_id,turn_id,source_key,
        provider,provider_api,model,billing_path,estimated_provider_cost_micros,pricing_source,occurred_at)
      select ${accountId}::uuid, ${workspace.id}::uuid, ${connectionId}::uuid, gen_random_uuid(), gen_random_uuid(),
        'dense-history-' || n, 'codex', 'responses', 'fixture', 'external', 500 + (n * 37) % 1000,
        'configured_list_price', now() - n * interval '13 seconds'
      from generate_series(1, 1660) n`;
    const [raw] = await shared!.admin<
      Array<{ readings: HistoryReading[]; calls: HistoryCall[] }>
    >`select
      (select jsonb_agg(jsonb_build_object('connectionId', connection_id, 'window', window_id,
        'usedPercent', used_percent, 'resetsAt', extract(epoch from resets_at) * 1000,
        'observedAt', extract(epoch from observed_at) * 1000) order by observed_at)
        from opengeni_private.subscription_usage_readings where account_id = ${accountId}) as readings,
      (select jsonb_agg(jsonb_build_object('connectionId', connection_id,
        'at', extract(epoch from occurred_at) * 1000, 'units', units) order by occurred_at)
        from opengeni_private.subscription_usage_calls where account_id = ${accountId}) as calls`;
    const bounded = await withSessionRlsActorContext({ subjectId }, () =>
      withRlsContext(client!.db, { accountId, workspaceId: workspace.id }, async (tx) => {
        await setSubjectRlsContext(tx, subjectId);
        const [row] = await rawRows<{
          history: { readings: HistoryReading[]; calls: HistoryCall[]; start: number | null };
        }>(
          tx,
          sql`select opengeni_private.read_subscription_usage_history(${accountId}::uuid,
            ${workspace.id}::uuid, ${subjectId}, 'codex', ARRAY[${connectionId}::uuid]) as history`,
        );
        return row!.history;
      }),
    );
    expect(raw!.readings).toHaveLength(4320);
    expect(raw!.calls).toHaveLength(1660);
    // Bounded by changes and five-minute slots, not by how often usage was read.
    expect(bounded.readings.length).toBeLessThan(raw!.readings.length / 4);
    const key = (reading: HistoryReading) =>
      `${reading.window}:${reading.usedPercent}:${reading.resetsAt}`;
    expect(new Set(bounded.readings.map(key))).toEqual(new Set(raw!.readings.map(key)));
    for (const window of ["primary", "secondary"]) {
      const rows = (history: { readings: HistoryReading[] }) =>
        history.readings.filter((row) => row.window === window);
      const all = rows(raw!);
      // The first and last readings, every change and each five-minute slot's
      // first reading stay; nothing else does.
      const slot = (at: number) => Math.floor(at / 300_000);
      const expected = all.filter(
        (row, index) =>
          index === 0 ||
          index === all.length - 1 ||
          key(row) !== key(all[index - 1]!) ||
          slot(row.observedAt) !== slot(all[index - 1]!.observedAt),
      );
      expect(rows(bounded)).toEqual(expected);
    }
    // Call totals keep every call's units and count.
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
    expect(bounded.calls.length).toBeLessThan(raw!.calls.length / 2);
    expect(sum(bounded.calls.map((call) => call.count ?? 1))).toBe(1660);
    expect(sum(bounded.calls.map((call) => call.units))).toBe(
      sum(raw!.calls.map((call) => call.units)),
    );
    expect(bounded.start).toBe(
      Math.min(raw!.readings[0]!.observedAt, ...raw!.calls.map((call) => call.at)),
    );
    // Every total sits between the same two readings and in the same hour as its calls.
    const boundaries = [...new Set(bounded.readings.map((row) => row.observedAt))].sort(
      (a, b) => a - b,
    );
    const place = (at: number) =>
      `${boundaries.filter((boundary) => boundary < at).length}:${Math.floor(at / 3_600_000)}`;
    const expected = new Map<string, { units: number; count: number; at: number }>();
    for (const call of raw!.calls) {
      const total = expected.get(place(call.at)) ?? { units: 0, count: 0, at: -Infinity };
      expected.set(place(call.at), {
        units: total.units + call.units,
        count: total.count + 1,
        at: Math.max(total.at, call.at),
      });
    }
    expect(
      new Map(
        bounded.calls.map((call) => [
          place(call.at),
          { units: call.units, count: call.count ?? 1, at: call.at },
        ]),
      ),
    ).toEqual(expected);

    // The pool forecast from the bounded history is the one from every row.
    const now = Math.max(...raw!.readings.map((row) => row.observedAt));
    const pool = (history: { readings: HistoryReading[]; calls: HistoryCall[] }) => {
      const window = (id: string) => (id === "primary" ? "five_hour" : "weekly");
      const input: SubscriptionUsagePoolInput = {
        provider: "codex",
        now,
        accounts: [
          {
            id: connectionId,
            label: "Dense",
            plan: "pro",
            planWeight: 10,
            windows: history.readings.map((row) => ({
              id: window(row.window),
              usedPercent: row.usedPercent,
              resetsAt: row.resetsAt,
              observedAt: row.observedAt,
            })),
          },
        ],
        readings: history.readings.map((row) => ({
          connectionId: row.connectionId,
          window: window(row.window),
          usedPercent: row.usedPercent!,
          resetsAt: row.resetsAt,
          observedAt: row.observedAt,
        })),
        calls: history.calls,
        historyStart: null,
      };
      return buildSubscriptionUsagePool(input);
    };
    const all = pool(raw!);
    expect(all.windows.map((window) => window.accounts[0]!.weightBasis)).toEqual([
      "observed",
      "observed",
    ]);
    expect(all.windows.map((window) => window.forecast.kind)).toEqual(["unused", "runs_out"]);
    expect(pool(bounded)).toEqual(all);
  },
  180_000,
);

test("relative plan defaults remain provider-boundary estimates", () => {
  expect(subscriptionPlanWeight("codex", "pro")).toBe(10);
  expect(subscriptionPlanWeight("codex", "plus")).toBe(1);
  expect(subscriptionPlanWeight("claude", "max_5x")).toBe(5);
  expect(subscriptionPlanWeight("claude", "max_20x")).toBe(20);
  expect(subscriptionPlanWeight("claude", "claude_max")).toBe(5);
  expect(subscriptionPlanWeight("claude", null)).toBe(1);
});
