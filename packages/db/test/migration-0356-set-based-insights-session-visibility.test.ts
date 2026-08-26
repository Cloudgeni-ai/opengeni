import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

import {
  aggregateModelCallFacts,
  aggregateModelCallFactsByDay,
  aggregateModelCallFactsByHour,
  aggregateModelContextContributions,
  aggregateRootSessionDrivers,
  aggregateScheduleFacts,
  aggregateWarmSecondsByGroup,
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  listModelCallFacets,
  listRecentModelCalls,
  sumUsageQuantityInRange,
  sumUsageQuantityByDay,
  sumUsageQuantityByHour,
  sumUsageQuantitySinceForInsights,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";

const migrationUrl = new URL(
  "../drizzle/0356_set_based_insights_session_visibility.sql",
  import.meta.url,
);

setDefaultTimeout(60_000);

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0356-insights-visibility");
  if (!shared) return;
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

type Fixture = {
  accountId: string;
  workspaceId: string;
  ownerSubjectId: string;
  privateSessionId: string;
  sharedSessionId: string;
  since: Date;
  until: Date;
};

async function seedFixture(): Promise<Fixture> {
  if (!shared || !client) throw new Error("PostgreSQL test database unavailable");
  const suffix = crypto.randomUUID();
  const userId = `insights-visibility-owner-${suffix}`;
  const ownerSubjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Insights visibility owner",
  });
  const grant = access.workspaceGrants[0]!;

  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${grant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')
    on conflict (account_id) do nothing`;
  const privateSessionSettings = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: ownerSubjectId,
  });
  await updateOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: ownerSubjectId,
    enabled: true,
    expectedVersion: privateSessionSettings.version,
    operationId: crypto.randomUUID(),
  });

  const privateSession = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, () =>
    createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "private insights fact",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: ownerSubjectId },
      createdByContext: {},
    }),
  );
  await transitionSessionVisibility(client.db, {
    workspaceId: grant.workspaceId!,
    sessionId: privateSession.id,
    actorSubjectId: ownerSubjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: `insights-visibility-private-${suffix}`,
  });
  const sharedSession = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, () =>
    createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "shared insights fact",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: ownerSubjectId },
      createdByContext: {},
    }),
  );

  const since = new Date(Date.now() - 60_000);
  const until = new Date(Date.now() + 60_000);
  await shared.admin`
    insert into model_call_facts (
      account_id, workspace_id, session_id, turn_id, source_key, provider,
      provider_api, model, billing_path, input_tokens, total_tokens,
      priced_cost_micros, occurred_at
    ) values
      (${grant.accountId}, ${grant.workspaceId}, ${privateSession.id}, ${crypto.randomUUID()},
       ${`private-${suffix}`}, 'test', 'responses', 'test-model', 'external', 10, 10, 0, now()),
      (${grant.accountId}, ${grant.workspaceId}, ${sharedSession.id}, ${crypto.randomUUID()},
       ${`shared-${suffix}`}, 'test', 'responses', 'test-model', 'external', 20, 20, 0, now())`;
  await shared.admin`
    insert into usage_events (
      account_id, workspace_id, event_type, quantity, unit, session_id,
      idempotency_key, occurred_at
    ) values
      (${grant.accountId}, ${grant.workspaceId}, 'model.cost', 1, 'micros',
       ${privateSession.id}, ${`private-${suffix}`}, now()),
      (${grant.accountId}, ${grant.workspaceId}, 'model.cost', 2, 'micros',
       ${sharedSession.id}, ${`shared-${suffix}`}, now()),
      (${grant.accountId}, ${grant.workspaceId}, 'model.cost', 4, 'micros',
       null, ${`workspace-${suffix}`}, now())`;

  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    ownerSubjectId,
    privateSessionId: privateSession.id,
    sharedSessionId: sharedSession.id,
    since,
    until,
  };
}

async function visibleCounts(input: Fixture, subjectId: string | null) {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const app = postgres(shared.appUrl, {
    max: 1,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
  });
  try {
    return await app.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${input.accountId}, true)`;
      await tx`select set_config('opengeni.workspace_id', ${input.workspaceId}, true)`;
      await tx`select set_config('opengeni.subject_id', ${subjectId ?? ""}, true)`;
      const [facts] = await tx<Array<{ count: number }>>`
        select count(*)::int as count
        from opengeni_private.visible_workspace_insights_model_call_facts(
          ${input.workspaceId}, ${input.since}, ${input.until}
        )`;
      const [usage] = await tx<Array<{ count: number; quantity: number }>>`
        select count(*)::int as count, coalesce(sum(quantity), 0)::int as quantity
        from opengeni_private.visible_workspace_insights_usage_events(
          ${input.workspaceId}, ${input.since}, ${input.until}
        )
        where event_type = 'model.cost'`;
      return { facts: facts!, usage: usage! };
    });
  } finally {
    await app.end();
  }
}

function executionTimeMs(plan: unknown): number {
  if (!Array.isArray(plan)) return Number.POSITIVE_INFINITY;
  const first = plan[0];
  if (!first || typeof first !== "object") return Number.POSITIVE_INFINITY;
  const value = (first as Record<string, unknown>)["Execution Time"];
  return typeof value === "number" ? value : Number.POSITIVE_INFINITY;
}

describe("migration 0356 set-based Insights session visibility", () => {
  test("installs bounded read-only functions without weakening ordinary fact-table RLS", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain("visible_workspace_insights_model_call_facts");
    expect(source).toContain("visible_workspace_insights_usage_events");
    expect(source).toContain("SECURITY DEFINER");
    expect(source).toContain("context_workspace_id <> p_workspace_id");
    expect(source).toContain("p_until - p_since > interval '370 days'");
    expect(source).toContain("session_private_actor_visible(");
    expect(source).toContain("session_variable_set_attachments_protocol_v1_active()");
    expect(source).toContain("current_setting('opengeni.migration_application_roles')");
    expect(source).toContain("INNER JOIN pg_catalog.pg_roles role_row");
    expect(source).not.toContain("WHERE pg_catalog.has_schema_privilege");
    expect(source).not.toContain("BYPASSRLS");
    expect(source).not.toMatch(/ALTER TABLE .* (?:NO )?FORCE ROW LEVEL SECURITY/iu);
  });

  test("keeps the definer seam private, bounded, and fail-closed", async () => {
    if (!shared) return;
    const appRole = decodeURIComponent(new URL(shared.appUrl).username);
    const functions = await shared.admin<
      Array<{
        name: string;
        securityDefiner: boolean;
        volatility: string;
        settings: string[] | null;
        appCanExecute: boolean;
        publicCanExecute: boolean;
      }>
    >`
      select
        procedure.proname as name,
        procedure.prosecdef as "securityDefiner",
        procedure.provolatile as volatility,
        procedure.proconfig as settings,
        has_function_privilege(${appRole}, procedure.oid, 'EXECUTE') as "appCanExecute",
        exists (
          select 1
          from aclexplode(
            coalesce(procedure.proacl, acldefault('f', procedure.proowner))
          ) privilege
          where privilege.grantee = 0
            and privilege.privilege_type = 'EXECUTE'
        ) as "publicCanExecute"
      from pg_proc procedure
      inner join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'opengeni_private'
        and procedure.proname in (
          'visible_workspace_insights_model_call_facts',
          'visible_workspace_insights_usage_events'
        )
      order by procedure.proname`;
    expect(functions).toHaveLength(2);
    for (const fn of functions) {
      expect(fn.securityDefiner).toBe(true);
      expect(fn.volatility).toBe("s");
      expect(fn.settings).toContain("search_path=pg_catalog, public, opengeni_private, pg_temp");
      expect(fn.appCanExecute).toBe(true);
      expect(fn.publicCanExecute).toBe(false);
    }

    const input = await seedFixture();
    const currentApp = postgres(shared.appUrl, {
      max: 1,
      connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    });
    try {
      await expect(
        currentApp.begin(async (tx) => {
          await tx`
            select count(*)
            from opengeni_private.visible_workspace_insights_model_call_facts(
              ${input.workspaceId}, ${input.since}, ${input.until}
            )`;
        }),
      ).rejects.toThrow("does not match the requested workspace");
      await expect(
        currentApp.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${input.accountId}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${input.workspaceId}, true)`;
          await tx`
            select count(*)
            from opengeni_private.visible_workspace_insights_model_call_facts(
              ${crypto.randomUUID()}, ${input.since}, ${input.until}
            )`;
        }),
      ).rejects.toThrow("does not match the requested workspace");
      await expect(
        currentApp.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${input.accountId}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${input.workspaceId}, true)`;
          await tx`
            select count(*)
            from opengeni_private.visible_workspace_insights_model_call_facts(
              ${input.workspaceId},
              ${new Date(input.until.getTime() - 371 * 24 * 60 * 60 * 1_000)},
              ${input.until}
            )`;
        }),
      ).rejects.toThrow("at most 370 days");
    } finally {
      await currentApp.end();
    }

    const oldApp = postgres(shared.appUrl, {
      max: 1,
      connection: { application_name: "opengeni-lossless-v1" },
    });
    try {
      await expect(
        oldApp.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${input.accountId}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${input.workspaceId}, true)`;
          await tx`
            select count(*)
            from opengeni_private.visible_workspace_insights_model_call_facts(
              ${input.workspaceId}, ${input.since}, ${input.until}
            )`;
        }),
      ).rejects.toThrow("0352-or-newer runtime");
    } finally {
      await oldApp.end();
    }
  });

  test("preserves shared, private-owner, and workspace-level fact visibility", async () => {
    if (!shared) return;
    const input = await seedFixture();
    const policies = await shared.admin<
      Array<{ tableName: string; usingExpression: string; checkExpression: string }>
    >`
      select tablename as "tableName", qual as "usingExpression", with_check as "checkExpression"
      from pg_policies
      where schemaname = current_schema()
        and policyname = 'session_visibility_isolation'
        and tablename in ('model_call_facts', 'usage_events')
      order by tablename`;
    expect(policies).toHaveLength(2);
    for (const policy of policies) {
      expect(policy.usingExpression).toContain("session_reference_visible");
      expect(policy.checkExpression).toBe(policy.usingExpression);
    }

    expect(await visibleCounts(input, input.ownerSubjectId)).toEqual({
      facts: { count: 2 },
      usage: { count: 3, quantity: 7 },
    });
    expect(await visibleCounts(input, `user:${crypto.randomUUID()}`)).toEqual({
      facts: { count: 1 },
      usage: { count: 2, quantity: 6 },
    });
    expect(await visibleCounts(input, null)).toEqual({
      facts: { count: 2 },
      usage: { count: 3, quantity: 7 },
    });
  });

  test("runs every Insights fact helper against the bounded visible sources", async () => {
    if (!shared || !client) return;
    const input = await seedFixture();
    const read = async (subjectId: string) =>
      await withSessionRlsActorContext({ subjectId }, async () => {
        const window = {
          workspaceId: input.workspaceId,
          since: input.since,
          until: input.until,
        };
        const [
          models,
          modelDays,
          modelHours,
          usage,
          usageDays,
          usageHours,
          usageSince,
          roots,
          schedules,
          warmGroups,
          facets,
          recent,
          context,
        ] = await Promise.all([
          aggregateModelCallFacts(client!.db, window),
          aggregateModelCallFactsByDay(client!.db, window),
          aggregateModelCallFactsByHour(client!.db, window),
          sumUsageQuantityInRange(client!.db, { ...window, eventType: "model.cost" }),
          sumUsageQuantityByDay(client!.db, { ...window, eventType: "model.cost" }),
          sumUsageQuantityByHour(client!.db, { ...window, eventType: "model.cost" }),
          sumUsageQuantitySinceForInsights(client!.db, {
            workspaceId: input.workspaceId,
            eventType: "model.cost",
            since: input.since,
          }),
          aggregateRootSessionDrivers(client!.db, { ...window, limit: 8 }),
          aggregateScheduleFacts(client!.db, window),
          aggregateWarmSecondsByGroup(client!.db, window),
          listModelCallFacets(client!.db, window),
          listRecentModelCalls(client!.db, { ...window, limit: 50 }),
          aggregateModelContextContributions(client!.db, window),
        ]);
        return {
          models,
          modelDays,
          modelHours,
          usage,
          usageDays,
          usageHours,
          usageSince,
          roots,
          schedules,
          warmGroups,
          facets,
          recent,
          context,
        };
      });

    const owner = await read(input.ownerSubjectId);
    expect(owner.models.reduce((total, row) => total + row.calls, 0)).toBe(2);
    expect([...owner.modelDays.values()].reduce((total, row) => total + row.calls, 0)).toBe(2);
    expect([...owner.modelHours.values()].reduce((total, row) => total + row.calls, 0)).toBe(2);
    expect(owner.usage).toBe(7);
    expect([...owner.usageDays.values()].reduce((total, quantity) => total + quantity, 0)).toBe(7);
    expect([...owner.usageHours.values()].reduce((total, quantity) => total + quantity, 0)).toBe(7);
    expect(owner.usageSince).toBe(7);
    expect(owner.roots).toHaveLength(2);
    expect(owner.schedules).toEqual([]);
    expect(owner.warmGroups).toEqual([]);
    expect(owner.facets).toEqual([{ provider: "test", model: "test-model" }]);
    expect(owner.recent).toHaveLength(2);
    expect(owner.context.totalCalls).toBe(2);

    const unrelated = await read(`user:${crypto.randomUUID()}`);
    expect(unrelated.models.reduce((total, row) => total + row.calls, 0)).toBe(1);
    expect([...unrelated.modelDays.values()].reduce((total, row) => total + row.calls, 0)).toBe(1);
    expect([...unrelated.modelHours.values()].reduce((total, row) => total + row.calls, 0)).toBe(1);
    expect(unrelated.usage).toBe(6);
    expect([...unrelated.usageDays.values()].reduce((total, quantity) => total + quantity, 0)).toBe(
      6,
    );
    expect(
      [...unrelated.usageHours.values()].reduce((total, quantity) => total + quantity, 0),
    ).toBe(6);
    expect(unrelated.usageSince).toBe(6);
    expect(unrelated.roots).toHaveLength(1);
    expect(unrelated.recent).toHaveLength(1);
    expect(unrelated.context.totalCalls).toBe(1);
  });

  test("does not execute one sessions lookup per model-call fact", async () => {
    if (!shared) return;
    const input = await seedFixture();
    const bulkSessions = 512;
    const factsPerSession = 8;
    const bulkSessionIds: string[] = [];
    for (let offset = 0; offset < bulkSessions; offset += 16) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(16, bulkSessions - offset) }, (_, index) =>
          createSession(client!.db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            initialMessage: `Insights performance fixture ${offset + index}`,
            resources: [],
            metadata: {},
            model: "test-model",
            reasoningEffort: "medium",
            latencyMode: "standard",
            sandboxBackend: "none",
          }),
        ),
      );
      bulkSessionIds.push(...batch.map((session) => session.id));
    }
    await shared.admin`
      insert into model_call_facts (
        account_id, workspace_id, session_id, turn_id, source_key, provider,
        provider_api, model, billing_path, input_tokens, total_tokens,
        priced_cost_micros, occurred_at
      )
      select
        ${input.accountId}, ${input.workspaceId}, bulk_sessions.id,
        gen_random_uuid(), ${`bulk-${crypto.randomUUID()}-`} || row_number() over ()::text,
        'test', 'responses', 'test-model', 'external', 1, 1, 0, now()
      from unnest(${bulkSessionIds}::uuid[]) bulk_sessions(id)
      cross join generate_series(1, ${factsPerSession}) facts(n)`;

    const app = postgres(shared.appUrl, {
      max: 1,
      connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    });
    try {
      const plans = await app.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${input.accountId}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${input.workspaceId}, true)`;
        await tx`select set_config('opengeni.subject_id', ${input.ownerSubjectId}, true)`;
        const direct = await tx.unsafe<Array<Record<string, unknown>>>(
          `explain (analyze, format json)
           select count(*)
           from model_call_facts
           where workspace_id = '${input.workspaceId}'::uuid
             and occurred_at >= '${input.since.toISOString()}'::timestamptz
             and occurred_at < '${input.until.toISOString()}'::timestamptz`,
        );
        const setBased = await tx.unsafe<Array<Record<string, unknown>>>(
          `explain (analyze, format json)
           select count(*)
           from opengeni_private.visible_workspace_insights_model_call_facts(
             '${input.workspaceId}'::uuid,
             '${input.since.toISOString()}'::timestamptz,
             '${input.until.toISOString()}'::timestamptz
           )`,
        );
        return {
          direct: direct[0]?.["QUERY PLAN"],
          setBased: setBased[0]?.["QUERY PLAN"],
        };
      });
      expect(executionTimeMs(plans.setBased)).toBeLessThan(executionTimeMs(plans.direct) / 3);
    } finally {
      await app.end();
    }
  });
});
