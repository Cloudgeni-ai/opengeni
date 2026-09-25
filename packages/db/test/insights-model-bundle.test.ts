import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  aggregateModelCallFacts,
  aggregateModelCallFactsByDay,
  aggregateModelCallFactsByHour,
  aggregateModelContextContributions,
  aggregateRootSessionDrivers,
  aggregateScheduleFacts,
  backfillModelCallFactsFromSessionEvents,
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  listModelCallFacets,
  listRecentModelCalls,
  INSIGHTS_RECENT_CALL_LIMIT,
  INSIGHTS_ROOT_DRIVER_LIMIT,
  readWorkspaceInsightsModelBundle,
  registerDbBinding,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  withSessionRlsActorContext,
  type Database,
  type DbClient,
  type WorkspaceInsightsModelBundle,
  type WorkspaceInsightsModelBundleInput,
} from "../src";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";
import * as schema from "../src/schema";

setDefaultTimeout(120_000);

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

async function acquireDatabase(): Promise<SharedTestDatabase | null> {
  const adminUrl = process.env.OPENGENI_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_TEST_POSTGRES_APP_URL;
  if (!adminUrl && !appUrl) return await acquireSharedTestDatabase("insights-model-bundle");
  if (!adminUrl || !appUrl) {
    throw new Error(
      "OPENGENI_TEST_POSTGRES_ADMIN_URL and OPENGENI_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  const admin = postgres(adminUrl, { max: 4 });
  return {
    admin,
    adminUrl,
    appUrl,
    release: async () => await admin.end().catch(() => undefined),
  };
}

beforeAll(async () => {
  shared = await acquireDatabase();
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
  sharedSessionId: string;
  privateSessionId: string;
  input: WorkspaceInsightsModelBundleInput;
};

async function fixture(): Promise<Fixture> {
  if (!shared || !client) throw new Error("PostgreSQL test database unavailable");
  const suffix = crypto.randomUUID();
  const userId = `insights-model-bundle-${suffix}`;
  const ownerSubjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Insights model bundle owner",
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;

  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${grant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')
    on conflict (account_id) do nothing`;
  const privateSettings = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: ownerSubjectId,
  });
  await updateOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: ownerSubjectId,
    enabled: true,
    expectedVersion: privateSettings.version,
    operationId: crypto.randomUUID(),
  });

  const privateSession = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, () =>
    createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "private model bundle",
      resources: [],
      metadata: {},
      model: "fixture-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: ownerSubjectId },
      createdByContext: {},
    }),
  );
  await transitionSessionVisibility(client.db, {
    workspaceId,
    sessionId: privateSession.id,
    actorSubjectId: ownerSubjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: `insights-model-bundle-private-${suffix}`,
  });
  const sharedSession = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, () =>
    createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "shared model bundle",
      resources: [],
      metadata: {},
      model: "fixture-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: ownerSubjectId },
      createdByContext: {},
    }),
  );
  await shared.admin`
    update sessions
    set title = case
      when id = ${privateSession.id} then 'Private model root'
      when id = ${sharedSession.id} then 'Shared model root'
      else title
    end
    where id in (${privateSession.id}, ${sharedSession.id})`;

  const privateTaskId = crypto.randomUUID();
  const sharedTaskId = crypto.randomUUID();
  const priorSince = new Date("2026-08-01T00:00:00.000Z");
  const priorUntil = new Date("2026-08-10T00:00:00.000Z");
  const since = new Date("2026-08-10T00:00:00.000Z");
  const until = new Date("2026-08-20T00:00:00.000Z");
  await shared.admin`
    insert into model_call_facts (
      account_id, workspace_id, session_id, turn_id, source_key, provider,
      provider_api, model, billing_path, scheduled_task_id,
      input_tokens, output_tokens, cached_tokens, cache_write_tokens,
      reasoning_tokens, total_tokens, priced_cost_micros,
      estimated_provider_cost_micros, equivalent_credit_cost_micros,
      pricing_source, context_contributions,
      occurred_at, recorded_at
    ) values
      (
        ${grant.accountId}, ${workspaceId}, ${sharedSession.id}, ${crypto.randomUUID()},
        ${`shared-openai-${suffix}`}, 'openai', 'responses', 'gpt-bundle', 'external',
        ${sharedTaskId}, 100, 50, 20, null, 5, 150, 0, 25, 27, 'gateway_reported',
        ${shared.admin.json([{ source: "company_profile", items: 1, utf8Bytes: 80, estimatedTokens: 20 }])},
        '2026-08-11T09:15:00.000Z', '2026-08-11T09:15:01.000Z'
      ),
      (
        ${grant.accountId}, ${workspaceId}, ${sharedSession.id}, ${crypto.randomUUID()},
        ${`shared-azure-${suffix}`}, 'azure', 'responses', 'azure-bundle', 'opengeni_credits',
        ${sharedTaskId}, null, 10, null, null, null, 10, 200, null, null, null, null,
        '2026-08-12T10:30:00.000Z', '2026-08-12T10:30:01.000Z'
      ),
      (
        ${grant.accountId}, ${workspaceId}, ${privateSession.id}, ${crypto.randomUUID()},
        ${`private-openai-a-${suffix}`}, 'openai', 'responses', 'gpt-bundle', 'opengeni_credits',
        ${privateTaskId}, 40, 20, 10, 3, 2, 60, 300, 50, 53, 'configured_list_price',
        ${shared.admin.json([{ source: "workspace_instruction_policy", items: 2, utf8Bytes: 120, estimatedTokens: 30 }])},
        '2026-08-13T11:45:00.000Z', '2026-08-13T11:45:01.000Z'
      ),
      (
        ${grant.accountId}, ${workspaceId}, ${privateSession.id}, ${crypto.randomUUID()},
        ${`private-openai-b-${suffix}`}, 'openai', 'responses', 'gpt-bundle', 'opengeni_credits',
        ${privateTaskId}, 10, 5, null, null, null, 15, 75, null, null, null, '[]'::jsonb,
        '2026-08-14T12:00:00.000Z', '2026-08-14T12:00:01.000Z'
      ),
      (
        ${grant.accountId}, ${workspaceId}, ${sharedSession.id}, ${crypto.randomUUID()},
        ${`prior-shared-${suffix}`}, 'openai', 'responses', 'gpt-bundle', 'opengeni_credits',
        ${sharedTaskId}, 70, 30, 10, null, null, 100, 100, 20, 21, 'configured_list_price', null,
        '2026-08-02T08:00:00.000Z', '2026-08-02T08:00:01.000Z'
      ),
      (
        ${grant.accountId}, ${workspaceId}, ${privateSession.id}, ${crypto.randomUUID()},
        ${`prior-private-${suffix}`}, 'openai', 'responses', 'gpt-bundle', 'opengeni_credits',
        ${privateTaskId}, 10, 10, 5, null, null, 20, 50, 10, 11, 'configured_list_price', null,
        '2026-08-03T08:00:00.000Z', '2026-08-03T08:00:01.000Z'
      )`;

  return {
    accountId: grant.accountId,
    workspaceId,
    ownerSubjectId,
    sharedSessionId: sharedSession.id,
    privateSessionId: privateSession.id,
    input: {
      workspaceId,
      since,
      until,
      priorSince,
      priorUntil,
      granularity: "day",
    },
  };
}

type LegacyComparableBundle = Omit<
  WorkspaceInsightsModelBundle,
  "dataThrough" | "driverGroups" | "driversTruncated" | "facetsTruncated" | "recentCallsTruncated"
>;

async function legacyModelBundle(
  db: Database,
  input: WorkspaceInsightsModelBundleInput,
): Promise<LegacyComparableBundle> {
  const filter = {
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
  };
  const window = {
    workspaceId: input.workspaceId,
    since: input.since,
    until: input.until,
    ...filter,
  };
  const priorWindow = {
    workspaceId: input.workspaceId,
    since: input.priorSince,
    until: input.priorUntil,
    ...filter,
  };
  const series =
    input.granularity === "hour" ? aggregateModelCallFactsByHour : aggregateModelCallFactsByDay;
  const [
    modelRows,
    priorModelRows,
    factBuckets,
    rootDrivers,
    scheduleFacts,
    facets,
    recentCalls,
    promptContributions,
  ] = await Promise.all([
    aggregateModelCallFacts(db, window),
    aggregateModelCallFacts(db, priorWindow),
    series(db, window),
    aggregateRootSessionDrivers(db, { ...window, limit: 8 }),
    aggregateScheduleFacts(db, window),
    listModelCallFacets(db, window),
    listRecentModelCalls(db, { ...window, limit: 50 }),
    aggregateModelContextContributions(db, window),
  ]);
  const priorRootDrivers = await aggregateRootSessionDrivers(db, {
    ...priorWindow,
    rootSessionIds: rootDrivers.map((row) => row.rootSessionId),
  });
  return {
    modelRows,
    priorModelRows,
    factBuckets,
    rootDrivers,
    priorRootDrivers,
    scheduleFacts,
    facets,
    recentCalls,
    promptContributions,
  };
}

function comparable(input: LegacyComparableBundle | WorkspaceInsightsModelBundle) {
  const {
    dataThrough: _dataThrough,
    driverGroups: _driverGroups,
    driversTruncated: _driversTruncated,
    facetsTruncated: _facetsTruncated,
    recentCallsTruncated: _recentCallsTruncated,
    ...bundle
  } = input as WorkspaceInsightsModelBundle;
  return {
    ...bundle,
    modelRows: [...bundle.modelRows].sort((a, b) =>
      `${a.provider}:${a.model}:${a.billingPath}`.localeCompare(
        `${b.provider}:${b.model}:${b.billingPath}`,
      ),
    ),
    priorModelRows: [...bundle.priorModelRows].sort((a, b) =>
      `${a.provider}:${a.model}:${a.billingPath}`.localeCompare(
        `${b.provider}:${b.model}:${b.billingPath}`,
      ),
    ),
    factBuckets: [...bundle.factBuckets.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
    priorRootDrivers: [...bundle.priorRootDrivers].sort((a, b) =>
      a.rootSessionId.localeCompare(b.rootSessionId),
    ),
    scheduleFacts: [...bundle.scheduleFacts].sort((a, b) =>
      a.scheduledTaskId.localeCompare(b.scheduledTaskId),
    ),
  };
}

type CapturedParameter = string | number | boolean | null;
type CapturedStatement = { query: string; parameters: CapturedParameter[] };

function capturedParameter(value: unknown): CapturedParameter {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw new Error("Unexpected captured Insights query parameter");
}

function instrumentedDb(statements: CapturedStatement[]): {
  db: Database;
  close: () => Promise<void>;
} {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const raw = postgres(shared.appUrl, {
    max: 8,
    prepare: false,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    debug: (_connection, query, parameters) =>
      statements.push({ query, parameters: parameters.map(capturedParameter) }),
  });
  const db = drizzle(raw, { schema }) as unknown as Database;
  registerDbBinding(db, { rlsStrategy: "force" });
  return { db, close: () => raw.end() };
}

function sessionRelationLoops(value: unknown, loops: number[] = []): number[] {
  if (Array.isArray(value)) {
    for (const item of value) sessionRelationLoops(item, loops);
    return loops;
  }
  if (value === null || typeof value !== "object") return loops;
  const row = value as Record<string, unknown>;
  if (row["Relation Name"] === "sessions" && typeof row["Actual Loops"] === "number") {
    loops.push(row["Actual Loops"]);
  }
  for (const child of Object.values(row)) sessionRelationLoops(child, loops);
  return loops;
}

describe("Workspace Insights model bundle", () => {
  test("reads each window once through the scoped projection and aggregates in grouping sets", async () => {
    const source = await Bun.file(
      new URL("../src/insights-model-bundle.ts", import.meta.url),
    ).text();
    expect(source).toContain("visible_workspace_insights_model_fact_rows");
    expect(source).not.toContain("visible_workspace_insights_model_call_facts");
    expect(source.match(/group by grouping sets/g)).toHaveLength(2);
    // Sessions are joined only for the bounded root and recent-call result rows,
    // never across the whole fact window.
    expect(source).not.toContain("selected_sessions");
    expect(source.match(/left join sessions root/g)).toHaveLength(2);
    expect(source.match(/left join sessions session/g)).toHaveLength(1);
    expect(source).not.toContain("count(distinct id)");
    expect(source).toContain("count(*) filter (where first_source)");
  });

  test("counts each fact once per source while preserving sums, including DB-accepted null sources", async () => {
    if (!shared) return;
    const entries = [
      { source: "company_profile", items: 1, utf8Bytes: 80, estimatedTokens: 20 },
      { source: null, items: 2, utf8Bytes: 40, estimatedTokens: 10 },
      { source: null, items: 3, utf8Bytes: 60, estimatedTokens: 15 },
    ];
    const [valid] = await shared.admin`
      select opengeni_private.model_context_contributions_valid(${shared.admin.json(entries)}) as accepted,
        opengeni_private.model_context_contributions_valid(${shared.admin.json([entries[0]!, entries[0]!])}) as duplicate_named`;
    expect(valid?.accepted).toBe(true);
    expect(valid?.duplicate_named).toBe(false);
    const [constraint] = await shared.admin`
      select convalidated from pg_constraint
      where conrelid = 'model_call_facts'::regclass
        and conname = 'model_call_facts_context_contributions_check'`;
    expect(constraint?.convalidated).toBe(true);

    // Include repeated sources across facts, empty coverage, and unknown coverage.
    const rows = await shared.admin`
      with facts(id, context_contributions) as (values
        (1, ${shared.admin.json(entries)}::jsonb),
        (2, ${shared.admin.json(entries)}::jsonb),
        (3, '[]'::jsonb), (4, null::jsonb)
      ), legacy as (
        select entry->>'source' as source,
          sum((entry->>'items')::bigint)::bigint as items,
          sum((entry->>'utf8Bytes')::bigint)::bigint as utf8_bytes,
          sum((entry->>'estimatedTokens')::bigint)::bigint as estimated_tokens,
          count(distinct id)::bigint as calls
        from facts cross join lateral jsonb_array_elements(context_contributions) entry
        group by entry->>'source'
      ), candidate as (
        select contribution.entry->>'source' as source,
          sum((contribution.entry->>'items')::bigint)::bigint as items,
          sum((contribution.entry->>'utf8Bytes')::bigint)::bigint as utf8_bytes,
          sum((contribution.entry->>'estimatedTokens')::bigint)::bigint as estimated_tokens,
          count(*) filter (where case
            when contribution.entry->>'source' is not null then true
            else not exists (
              select 1 from jsonb_array_elements(context_contributions)
                with ordinality earlier(entry, ordinal)
              where earlier.ordinal < contribution.ordinal
                and earlier.entry->>'source' is null
            ) end)::bigint as calls
        from facts cross join lateral jsonb_array_elements(context_contributions)
          with ordinality contribution(entry, ordinal)
        group by contribution.entry->>'source'
      )
      (select * from legacy except all select * from candidate)
      union all
      (select * from candidate except all select * from legacy)`;
    expect(rows).toHaveLength(0);
  });

  test("matches the legacy helpers for shared/private visibility, filters, and UTC buckets", async () => {
    if (!shared || !client) return;
    const seeded = await fixture();
    const cases: Array<{
      subjectId: string;
      input: WorkspaceInsightsModelBundleInput;
      expectedDataThrough: string;
    }> = [
      {
        subjectId: seeded.ownerSubjectId,
        input: seeded.input,
        expectedDataThrough: "2026-08-14T12:00:01.000Z",
      },
      {
        subjectId: seeded.ownerSubjectId,
        input: {
          ...seeded.input,
          granularity: "hour",
          provider: "openai",
          model: "gpt-bundle",
        },
        expectedDataThrough: "2026-08-14T12:00:01.000Z",
      },
      {
        subjectId: `user:${crypto.randomUUID()}`,
        input: seeded.input,
        expectedDataThrough: "2026-08-12T10:30:01.000Z",
      },
    ];
    for (const testCase of cases) {
      const [legacy, bundled] = await withSessionRlsActorContext(
        { subjectId: testCase.subjectId },
        async () =>
          await Promise.all([
            legacyModelBundle(client!.db, testCase.input),
            readWorkspaceInsightsModelBundle(client!.db, testCase.input),
          ]),
      );
      expect(comparable(bundled)).toEqual(comparable(legacy));
      expect(bundled.driverGroups).toBe(legacy.rootDrivers.length);
      expect(bundled.driversTruncated).toBe(false);
      expect(bundled.facetsTruncated).toBe(false);
      expect(bundled.recentCallsTruncated).toBe(false);
      expect(bundled.dataThrough?.toISOString()).toBe(testCase.expectedDataThrough);
      if (testCase.input.provider || testCase.input.model) {
        expect(bundled.facets).toEqual([
          { provider: "azure", model: "azure-bundle" },
          { provider: "openai", model: "gpt-bundle" },
        ]);
      }
    }
  });

  test("scopes a session drilldown while keeping facets and freshness workspace-wide", async () => {
    if (!shared || !client) return;
    const seeded = await fixture();
    const bundled = await withSessionRlsActorContext(
      { subjectId: seeded.ownerSubjectId },
      async () =>
        await readWorkspaceInsightsModelBundle(client!.db, {
          ...seeded.input,
          sessionId: seeded.sharedSessionId,
        }),
    );
    expect(bundled.recentCalls).toHaveLength(2);
    expect(bundled.recentCalls.every((call) => call.sessionId === seeded.sharedSessionId)).toBe(
      true,
    );
    expect(bundled.rootDrivers.length).toBeGreaterThan(0);
    expect(
      bundled.rootDrivers.every((driver) => driver.rootSessionId === seeded.sharedSessionId),
    ).toBe(true);
    expect(bundled.facets).toEqual([
      { provider: "azure", model: "azure-bundle" },
      { provider: "openai", model: "gpt-bundle" },
    ]);
    expect(bundled.dataThrough?.toISOString()).toBe("2026-08-14T12:00:01.000Z");
  });

  test("scopes a root drilldown through the same private-session visibility", async () => {
    if (!shared || !client) return;
    const seeded = await fixture();
    const scoped = (subjectId: string) =>
      withSessionRlsActorContext(
        { subjectId },
        async () =>
          await readWorkspaceInsightsModelBundle(client!.db, {
            ...seeded.input,
            rootSessionId: seeded.privateSessionId,
          }),
      );
    const owner = await scoped(seeded.ownerSubjectId);
    expect(owner.recentCalls.map((call) => call.sessionId)).toEqual([
      seeded.privateSessionId,
      seeded.privateSessionId,
    ]);
    expect(owner.rootDrivers.map((driver) => driver.rootSessionId)).toEqual([
      seeded.privateSessionId,
    ]);
    expect(owner.priorRootDrivers.map((driver) => driver.totalTokens)).toEqual([20]);

    const outsider = await scoped(`user:${crypto.randomUUID()}`);
    expect(outsider.recentCalls).toEqual([]);
    expect(outsider.rootDrivers).toEqual([]);
    expect(outsider.modelRows).toEqual([]);
    expect(outsider.priorModelRows).toEqual([]);
    // Facets stay workspace-wide but still exclude the outsider's invisible session.
    expect(outsider.facets).toEqual([
      { provider: "azure", model: "azure-bundle" },
      { provider: "openai", model: "gpt-bundle" },
    ]);
  });

  test("backfill preserves free external billing when the live fact write was lost", async () => {
    if (!shared || !client) return;
    const seeded = await fixture();
    const turnId = crypto.randomUUID();
    const secondTurnId = crypto.randomUUID();
    const sourceKey = `free-backfill-a-${crypto.randomUUID()}`;
    const secondSourceKey = `free-backfill-b-${crypto.randomUUID()}`;
    const occurredAt = new Date();
    const sourceResourceId = `${turnId}:${sourceKey}`;
    const secondSourceResourceId = `${secondTurnId}:${secondSourceKey}`;

    await shared.admin`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, position, prompt, model,
        reasoning_effort, latency_mode, sandbox_backend, resources, tools,
        metadata, started_at, finished_at
      ) values (
        ${turnId}, ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId},
        ${crypto.randomUUID()}, ${`session-${seeded.sharedSessionId}`}, 'completed', 1,
        'free external model backfill fixture', 'free-deployment-model',
        'medium', 'standard', 'none', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
        ${occurredAt}, ${occurredAt}
      ), (
        ${secondTurnId}, ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId},
        ${crypto.randomUUID()}, ${`session-${seeded.sharedSessionId}`}, 'completed', 2,
        'second free external model backfill fixture', 'free-deployment-model',
        'medium', 'standard', 'none', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
        ${occurredAt}, ${occurredAt}
      )`;

    // Absence of the model_call_facts row simulates the worker's intentionally
    // swallowed live fact-write failure. The billing ledger still has both a
    // token-cap row and the zero-cost marker for this deployment-funded call.
    await shared.admin`
      insert into usage_events (
        account_id, workspace_id, event_type, quantity, unit,
        source_resource_type, source_resource_id, session_id, turn_id,
        idempotency_key, occurred_at
      ) values
        (
          ${seeded.accountId}, ${seeded.workspaceId}, 'model.tokens', 1500, 'tokens',
          'model_response', ${sourceResourceId}, ${seeded.sharedSessionId}, ${turnId},
          ${`usage:model.tokens:${sourceResourceId}`}, ${occurredAt}
        ),
        (
          ${seeded.accountId}, ${seeded.workspaceId}, 'model.cost', 0, 'usd_micros',
          'model_response', ${sourceResourceId}, ${seeded.sharedSessionId}, ${turnId},
          ${`usage:model.cost:${sourceResourceId}`}, ${occurredAt}
        ),
        (
          ${seeded.accountId}, ${seeded.workspaceId}, 'model.tokens', 300, 'tokens',
          'model_response', ${secondSourceResourceId}, ${seeded.sharedSessionId}, ${secondTurnId},
          ${`usage:model.tokens:${secondSourceResourceId}`}, ${occurredAt}
        ),
        (
          ${seeded.accountId}, ${seeded.workspaceId}, 'model.cost', 0, 'usd_micros',
          'model_response', ${secondSourceResourceId}, ${seeded.sharedSessionId}, ${secondTurnId},
          ${`usage:model.cost:${secondSourceResourceId}`}, ${occurredAt}
        )`;
    await shared.admin`
      insert into session_events (
        account_id, workspace_id, session_id, turn_id, turn_association,
        sequence, type, payload, occurred_at
      ) values (
        ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId}, ${turnId},
        'current',
        (
          select coalesce(max(sequence), 0) + 1
          from session_events
          where workspace_id = ${seeded.workspaceId}
            and session_id = ${seeded.sharedSessionId}
        ),
        'agent.model.usage',
        ${shared.admin.json({
          sourceKey,
          provider: "workspace-gateway",
          upstreamProvider: "anthropic",
          providerApi: "responses",
          model: "free-deployment-model",
          billingPath: "external",
          inputTokens: 1000,
          outputTokens: 500,
        })},
        ${occurredAt}::timestamptz + interval '0.000123 seconds'
      )`;
    await shared.admin`
      insert into session_events (
        account_id, workspace_id, session_id, turn_id, turn_association,
        sequence, type, payload, occurred_at
      ) values (
        ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId}, ${secondTurnId},
        'current',
        (
          select coalesce(max(sequence), 0) + 1
          from session_events
          where workspace_id = ${seeded.workspaceId}
            and session_id = ${seeded.sharedSessionId}
        ),
        'agent.model.usage',
        ${shared.admin.json({
          sourceKey: secondSourceKey,
          provider: "openai",
          upstreamProvider: "../../not-a-provider",
          providerApi: "responses",
          model: "free-deployment-model",
          billingPath: "external",
          inputTokens: 200,
          outputTokens: 100,
        })},
        ${occurredAt}::timestamptz + interval '0.000456 seconds'
      )`;

    const result = await backfillModelCallFactsFromSessionEvents(client.db, {
      workspaceId: seeded.workspaceId,
      since: new Date(occurredAt.getTime() - 60_000),
      until: new Date(occurredAt.getTime() + 60_000),
      limit: 10,
      batchSize: 1,
    });
    expect(result).toEqual({ considered: 2, upserted: 2 });

    const rows = await shared.admin<
      Array<{
        sourceKey: string;
        provider: string;
        billingPath: string;
        pricedCostMicros: number;
        totalTokens: number | null;
      }>
    >`
      select
        source_key as "sourceKey",
        provider,
        billing_path as "billingPath",
        priced_cost_micros::int as "pricedCostMicros",
        total_tokens::int as "totalTokens"
      from model_call_facts
      where workspace_id = ${seeded.workspaceId}
        and turn_id in (${turnId}, ${secondTurnId})
      order by source_key`;
    expect(Array.from(rows)).toEqual([
      {
        sourceKey,
        provider: "anthropic",
        billingPath: "external",
        pricedCostMicros: 0,
        totalTokens: 1500,
      },
      {
        sourceKey: secondSourceKey,
        provider: "openai",
        billingPath: "external",
        pricedCostMicros: 0,
        totalTokens: 300,
      },
    ]);
  });

  test("reduces model sources from nine legacy reads to two by default and three with filtered facets", async () => {
    if (!shared) return;
    const seeded = await fixture();
    const legacyStatements: CapturedStatement[] = [];
    const legacyDb = instrumentedDb(legacyStatements);
    try {
      await withSessionRlsActorContext({ subjectId: seeded.ownerSubjectId }, () =>
        legacyModelBundle(legacyDb.db, seeded.input),
      );
    } finally {
      await legacyDb.close();
    }
    const bundledStatements: CapturedStatement[] = [];
    const bundledDb = instrumentedDb(bundledStatements);
    try {
      await withSessionRlsActorContext({ subjectId: seeded.ownerSubjectId }, () =>
        readWorkspaceInsightsModelBundle(bundledDb.db, seeded.input),
      );
    } finally {
      await bundledDb.close();
    }

    const legacySource = "visible_workspace_insights_model_call_facts";
    const source = "visible_workspace_insights_model_fact_rows";
    const legacyInvocations = legacyStatements.reduce(
      (total, statement) =>
        total + (statement.query.match(new RegExp(legacySource, "g"))?.length ?? 0),
      0,
    );
    const bundleQueries = bundledStatements.filter((statement) => statement.query.includes(source));
    const bundledInvocations = bundleQueries.reduce(
      (total, statement) => total + (statement.query.match(new RegExp(source, "g"))?.length ?? 0),
      0,
    );
    expect(legacyInvocations).toBe(9);
    expect(bundleQueries).toHaveLength(1);
    expect(bundledInvocations).toBe(2);

    const filteredStatements: CapturedStatement[] = [];
    const filteredDb = instrumentedDb(filteredStatements);
    try {
      await withSessionRlsActorContext({ subjectId: seeded.ownerSubjectId }, () =>
        readWorkspaceInsightsModelBundle(filteredDb.db, {
          ...seeded.input,
          provider: "openai",
          model: "gpt-bundle",
        }),
      );
    } finally {
      await filteredDb.close();
    }
    const filteredQueries = filteredStatements.filter((statement) =>
      statement.query.includes(source),
    );
    const filteredInvocations = filteredQueries.reduce(
      (total, statement) => total + (statement.query.match(new RegExp(source, "g"))?.length ?? 0),
      0,
    );
    expect(filteredQueries).toHaveLength(1);
    expect(filteredInvocations).toBe(3);
    expect(filteredQueries[0]?.query).toContain("::text");
  });

  test("bounds outer session-table lookup loops by result limits, not fact rows", async () => {
    if (!shared) return;
    const seeded = await fixture();
    const sourcePrefix = `insights-session-map-${crypto.randomUUID()}-`;
    const factsPerWindow = 512;
    await shared.admin`
      insert into model_call_facts (
        account_id, workspace_id, session_id, turn_id, source_key, provider,
        provider_api, model, billing_path, input_tokens, output_tokens,
        cached_tokens, total_tokens, priced_cost_micros, occurred_at
      )
      select
        ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId},
        gen_random_uuid(), ${sourcePrefix} || generated.window_name || '-' || generated.n::text,
        'openai', 'responses', 'gpt-bundle', 'opengeni_credits', 10, 5, 2, 15, 1,
        generated.occurred_at
      from (
        select 'current'::text as window_name, n,
          ${seeded.input.since}::timestamp with time zone + interval '1 minute' as occurred_at
        from generate_series(1, ${factsPerWindow}) generated(n)
        union all
        select 'prior'::text as window_name, n,
          ${seeded.input.priorSince}::timestamp with time zone + interval '1 minute' as occurred_at
        from generate_series(1, ${factsPerWindow}) generated(n)
      ) generated`;

    const statements: CapturedStatement[] = [];
    const capturedDb = instrumentedDb(statements);
    try {
      await withSessionRlsActorContext({ subjectId: seeded.ownerSubjectId }, () =>
        readWorkspaceInsightsModelBundle(capturedDb.db, seeded.input),
      );
    } finally {
      await capturedDb.close();
    }
    const statement = statements.find((candidate) =>
      candidate.query.includes("visible_workspace_insights_model_fact_rows"),
    );
    expect(statement).toBeDefined();
    if (!statement) return;

    const app = postgres(shared.appUrl, {
      max: 1,
      prepare: false,
      connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    });
    try {
      const plan = await app.begin(async (transaction) => {
        await transaction`select set_config('opengeni.account_id', ${seeded.accountId}, true)`;
        await transaction`select set_config('opengeni.workspace_id', ${seeded.workspaceId}, true)`;
        await transaction`select set_config('opengeni.subject_id', ${seeded.ownerSubjectId}, true)`;
        await transaction`select set_config('opengeni.initiating_human_subject_id', '', true)`;
        const rows = await transaction.unsafe<Array<{ "QUERY PLAN": unknown }>>(
          `explain (analyze, buffers, format json) ${statement.query}`,
          statement.parameters,
        );
        return rows[0]?.["QUERY PLAN"];
      });
      const loops = sessionRelationLoops(plan);
      expect(loops.length).toBeGreaterThan(0);
      const resultBound = INSIGHTS_RECENT_CALL_LIMIT + 1 + 2 * (INSIGHTS_ROOT_DRIVER_LIMIT + 1);
      expect(loops.reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(resultBound);
      expect(factsPerWindow * 2).toBeGreaterThan(resultBound * 10);
    } finally {
      await app.end();
    }
  });
});
