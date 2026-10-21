import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
} from "../src/runtime-posture";
import { sql } from "drizzle-orm";
import {
  createDb,
  ensureManagedAccessForUser,
  createOrganizationSharedWorkspace,
  connectSubscriptionCoreCodexConnection,
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
import { storedQuotaDocument, type SubscriptionQuota } from "@opengeni/subscriptions";

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

test("relative plan defaults remain provider-boundary estimates", () => {
  expect(subscriptionPlanWeight("codex", "pro")).toBe(10);
  expect(subscriptionPlanWeight("codex", "plus")).toBe(1);
  expect(subscriptionPlanWeight("claude", "max_5x")).toBe(5);
  expect(subscriptionPlanWeight("claude", "max_20x")).toBe(20);
  expect(subscriptionPlanWeight("claude", "claude_max")).toBe(5);
  expect(subscriptionPlanWeight("claude", null)).toBe(1);
});

test.skipIf(!real)(
  "owner migration preserves runtime posture and backfills attributed facts across FORCE RLS",
  async () => {
    const owned = await acquireOwnerMigratedTestDatabase("pooled-usage-owner");
    if (!owned) throw new Error("Real PostgreSQL required");
    let runtime: DbClient | undefined;
    let owner: DbClient | undefined;
    try {
      await migrate(owned.ownerUrl);
      await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
      const url = new URL(owned.ownerUrl);
      url.username = "opengeni_app";
      url.password = owned.appPassword;
      runtime = createDb(url.toString(), { max: 2 });
      owner = createDb(owned.ownerUrl, { max: 1 });
      const options = {
        rlsStrategy: "force" as const,
        expectedRole: "opengeni_app",
        targetSchema: "public",
      };
      expect(
        evaluateRuntimeDatabasePosture(
          await inspectRuntimeDatabasePosture(runtime.db, options),
          options,
        ),
      ).toEqual([]);
      const userId = crypto.randomUUID();
      const subjectId = `user:${userId}`;
      const access = await ensureManagedAccessForUser(runtime.db, {
        userId,
        email: `${userId}@example.test`,
        name: "Owner migration",
      });
      const { accountId, workspaceId } = access.workspaceGrants[0]!;
      const id = crypto.randomUUID();
      const fact = crypto.randomUUID();
      await owned.admin`insert into subscription_connections(id,account_id,provider,kind,credential_encrypted,credential_format,
      provider_account_id,ownership,scope_kind,status) values(${id},${accountId},'codex','subscription','fixture','v1',${crypto.randomUUID()},'shared','organization','active')`;
      await owned.admin.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`insert into model_call_facts(id,account_id,workspace_id,connection_id,session_id,turn_id,source_key,
        provider,provider_api,model,billing_path,estimated_provider_cost_micros,pricing_source,occurred_at)
        values(${fact},${accountId},${workspaceId},${id},${crypto.randomUUID()},${crypto.randomUUID()},'seed-test',
          'codex','responses','fixture','external',25,'configured_list_price',now()-interval '8 days')`;
      });
      const seed = await Bun.file(
        new URL("../drizzle/0872_subscription_usage_call_history_seed.sql", import.meta.url),
      ).text();
      await owner.db.transaction(async (tx) => {
        await tx.execute(sql.raw(seed));
      });
      expect(
        (
          await owned.admin`select * from opengeni_private.subscription_usage_calls where fact_id=${fact}`
        ).length,
      ).toBe(1);
      await withSessionRlsActorContext({ subjectId }, () =>
        withRlsContext(runtime!.db, { accountId, workspaceId: null }, (tx) =>
          recordSubscriptionUsageReading(tx, accountId, id, "codex", {
            observedAt: Date.now(),
            windows: [
              { id: "primary", usedPercent: 20, resetsAt: Date.now() + 3_600_000, status: "ok" },
            ],
          }),
        ),
      );
      expect(
        (
          await owned.admin`select * from opengeni_private.subscription_usage_readings where connection_id=${id}`
        ).length,
      ).toBe(1);
      const [membership] =
        await owned.admin`select personal_workspace_id from organization_memberships
        where account_id=${accountId} and subject_id=${subjectId}`;
      const personalId = membership!.personal_workspace_id as string;
      const personal = await withSessionRlsActorContext({ subjectId }, () =>
        connectSubscriptionCoreCodexConnection(runtime!.db, {
          accountId,
          workspaceId: personalId,
          subjectId,
          credentialEncrypted: "fixture",
          providerAccountId: crypto.randomUUID(),
          providerSubjectId: crypto.randomUUID(),
          planType: "pro",
          isFedramp: false,
          expiresAt: new Date(Date.now() + 86_400_000),
          lastRefreshAt: new Date(),
          accountEmail: "personal@example.test",
          label: "Personal",
        }),
      );
      expect(personal.kind).toBe("connected");
      if (personal.kind !== "connected") throw new Error("Personal fixture connection refused");
      const personalConnection = personal.id;
      const observation = {
        observedAt: Date.now(),
        windows: [
          {
            id: "primary",
            usedPercent: 35,
            resetsAt: Date.now() + 3_600_000,
            status: "ok" as const,
          },
        ],
      };
      await withSessionRlsActorContext({ subjectId }, () =>
        withRlsContext(runtime!.db, { accountId, workspaceId: personalId }, (tx) =>
          recordSubscriptionUsageReading(tx, accountId, personalConnection, "codex", observation),
        ),
      );
      const personalPool = await withSessionRlsActorContext({ subjectId }, () =>
        readSubscriptionUsagePool(runtime!.db, {
          accountId,
          workspaceId: personalId,
          subjectId,
          provider: "codex",
        }),
      );
      // Personal accounts join only through the existing owner-only Personal-workspace reader.
      expect(personalPool.windows[0]!.accounts.some((a) => a.id === personalConnection)).toBe(true);
      const orgPool = await withSessionRlsActorContext({ subjectId }, () =>
        readSubscriptionUsagePool(runtime!.db, {
          accountId,
          workspaceId: null,
          subjectId,
          provider: "codex",
        }),
      );
      expect(orgPool.windows[0]!.accounts.some((a) => a.id === personalConnection)).toBe(false);
    } finally {
      await runtime?.close();
      await owner?.close();
      await owned.release();
    }
  },
  180_000,
);
