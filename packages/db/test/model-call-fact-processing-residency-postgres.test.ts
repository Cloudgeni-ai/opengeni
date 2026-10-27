import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { InsightsCallsQuery, InsightsCallsResponse } from "@opengeni/contracts/insights-usage";
import type { ModelCallProcessingResidencyV1 } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import {
  backfillModelCallFactsFromSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  readInsightsCalls,
  recordModelCallFact,
  withRlsContext,
} from "../src/index";

setDefaultTimeout(120_000);

// Every model call fact records where the route that served it processed the
// call: the residency claim only, never evidence. Null means only "recorded
// before calls carried one"; new calls without a known route are unknown.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("model-call-fact-processing-residency");
  if (!db) throw new Error("test postgres unavailable");
  shared = db;
  client = createDb(db.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const EU: ModelCallProcessingResidencyV1 = {
  geography: "eu",
  deploymentType: "azure_data_zone",
  regions: ["swedencentral"],
};
const UNKNOWN: ModelCallProcessingResidencyV1 = {
  geography: "unknown",
  deploymentType: "unknown",
  regions: [],
};
const US: ModelCallProcessingResidencyV1 = {
  geography: "us",
  deploymentType: "provider_default",
  regions: [],
};
const EVIDENCE = {
  source: "operator_declaration",
  reference: "Deployment gpt-eu on res-neu-internal, sku DataZoneStandard",
  verifiedAt: "2026-10-26",
};

async function scope() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "residency",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "residency",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return { accountId: grant.accountId, workspaceId: grant.workspaceId!, sessionId: session.id };
}

const fact = (
  base: Awaited<ReturnType<typeof scope>>,
  sourceKey: string,
  extra: Partial<Parameters<typeof recordModelCallFact>[1]> = {},
) =>
  recordModelCallFact(client.db, {
    ...base,
    turnId: crypto.randomUUID(),
    sourceKey,
    provider: "azure-eu",
    providerApi: "responses",
    model: "azure-eu/gpt-eu",
    billingPath: "external",
    pricedCostMicros: 0,
    inputTokens: 10,
    outputTokens: 2,
    ...extra,
  });

async function storedResidency(workspaceId: string, sourceKey: string) {
  const [row] = await shared.admin<{ residency: unknown }[]>`
    select processing_residency as residency from model_call_facts
    where workspace_id = ${workspaceId} and source_key = ${sourceKey}`;
  return row?.residency;
}

test("the live fact writer records the claim, never evidence, and unknown when none is given", async () => {
  const base = await scope();
  const eu = await fact(base, "eu", { processingResidency: EU as never });
  expect(eu.processingResidency).toEqual(EU);
  expect(await storedResidency(base.workspaceId, "eu")).toEqual(EU);

  // A caller handing over the full record still stores only the claim.
  await fact(base, "with-evidence", {
    processingResidency: { ...EU, evidence: EVIDENCE } as never,
  });
  const stored = await storedResidency(base.workspaceId, "with-evidence");
  expect(stored).toEqual(EU);
  expect(JSON.stringify(stored)).not.toContain("res-neu-internal");

  // A new call whose route is not known is unknown, never null.
  const missing = await fact(base, "missing");
  expect(missing.processingResidency).toEqual(UNKNOWN);
  expect(await storedResidency(base.workspaceId, "missing")).toEqual(UNKNOWN);
  const malformed = await fact(base, "malformed", {
    processingResidency: { geography: "mars" } as never,
  });
  expect(malformed.processingResidency).toEqual(UNKNOWN);

  // An idempotent retry never rewrites the recorded residency.
  const turnId = crypto.randomUUID();
  await fact(base, "retry", { turnId, processingResidency: US as never });
  const retried = await fact(base, "retry", { turnId, processingResidency: EU as never });
  expect(retried.processingResidency).toEqual(US);
});

test("facts rebuilt from durable usage events keep the residency; older events stay null", async () => {
  const base = await scope();
  const turnId = crypto.randomUUID();
  const occurredAt = new Date();
  await shared.admin`
    insert into session_turns (
      id, account_id, workspace_id, session_id, trigger_event_id,
      temporal_workflow_id, status, position, prompt, model,
      reasoning_effort, latency_mode, sandbox_backend, resources, tools,
      metadata, started_at, finished_at
    ) values (
      ${turnId}, ${base.accountId}, ${base.workspaceId}, ${base.sessionId},
      ${crypto.randomUUID()}, ${`session-${base.sessionId}`}, 'completed', 1,
      'residency backfill fixture', 'azure-eu/gpt-eu',
      'medium', 'standard', 'none', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
      ${occurredAt}, ${occurredAt}
    )`;
  const events: Array<[string, Record<string, unknown>]> = [
    ["eu-event", { processingResidency: EU }],
    ["builtin-event", { processingResidency: US }],
    ["unknown-event", { processingResidency: UNKNOWN }],
    // Recorded before usage events carried a residency.
    ["legacy-event", {}],
    // Present but malformed: a newer event, so unknown rather than null.
    ["malformed-event", { processingResidency: { geography: "eu", regions: "x" } }],
    ["evidence-event", { processingResidency: { ...EU, evidence: EVIDENCE } }],
  ];
  for (const [sourceKey, extra] of events) {
    await shared.admin`
      insert into session_events (
        account_id, workspace_id, session_id, turn_id, turn_association,
        sequence, type, payload, occurred_at
      ) values (
        ${base.accountId}, ${base.workspaceId}, ${base.sessionId}, ${turnId}, 'current',
        (select coalesce(max(sequence), 0) + 1 from session_events
          where workspace_id = ${base.workspaceId} and session_id = ${base.sessionId}),
        'agent.model.usage',
        ${shared.admin.json({
          sourceKey,
          provider: "azure-eu",
          providerApi: "responses",
          model: "azure-eu/gpt-eu",
          billingPath: "external",
          inputTokens: 10,
          outputTokens: 2,
          ...extra,
        } as never)},
        ${occurredAt}
      )`;
  }
  const result = await backfillModelCallFactsFromSessionEvents(client.db, {
    workspaceId: base.workspaceId,
    since: new Date(occurredAt.getTime() - 60_000),
    until: new Date(occurredAt.getTime() + 60_000),
    limit: 20,
  });
  expect(result).toEqual({ considered: events.length, upserted: events.length });
  const rows = await shared.admin<{ sourceKey: string; residency: unknown }[]>`
    select source_key as "sourceKey", processing_residency as residency from model_call_facts
    where workspace_id = ${base.workspaceId} and turn_id = ${turnId} order by source_key`;
  expect(Object.fromEntries(rows.map((row) => [row.sourceKey, row.residency]))).toEqual({
    "builtin-event": US,
    "eu-event": EU,
    "evidence-event": EU,
    "legacy-event": null,
    "malformed-event": UNKNOWN,
    "unknown-event": UNKNOWN,
  });
});

test("Insights calls expose each call's processing geography", async () => {
  const base = await scope();
  const now = new Date();
  // The read window ends at `now`, exclusive.
  const at = new Date(now.getTime() - 60_000);
  await fact(base, "eu", { processingResidency: EU as never, occurredAt: at });
  await fact(base, "unknown", { occurredAt: at });
  await fact(base, "us", { processingResidency: US as never, occurredAt: at });
  // A fact written before 1001, and one whose stored geography is not a known value.
  for (const [sourceKey, residency] of [
    ["legacy", null],
    ["corrupt", { geography: "mars", deploymentType: "unknown", regions: [] }],
  ] as const) {
    await shared.admin`
      insert into model_call_facts (account_id, workspace_id, session_id, turn_id, source_key,
        provider, provider_api, model, billing_path, priced_cost_micros, processing_residency, occurred_at)
      values (${base.accountId}, ${base.workspaceId}, ${base.sessionId}, ${crypto.randomUUID()},
        ${sourceKey}, 'azure-eu', 'responses', 'azure-eu/gpt-eu', 'external', 0,
        ${residency === null ? null : shared.admin.json(residency as never)}, ${at})`;
  }
  const page = InsightsCallsResponse.parse(
    await readInsightsCalls(client.db, {
      accountId: base.accountId,
      workspaceId: base.workspaceId,
      detailsWorkspaceIds: [base.workspaceId],
      now,
      query: InsightsCallsQuery.parse({ range: "30d" }),
    }),
  );
  const ids = await shared.admin<{ id: string; sourceKey: string }[]>`
    select id, source_key as "sourceKey" from model_call_facts where workspace_id = ${base.workspaceId}`;
  const byId = new Map(ids.map((row) => [row.id, row.sourceKey]));
  expect(
    Object.fromEntries(page.calls.map((call) => [byId.get(call.id), call.processingGeography])),
  ).toEqual({ eu: "eu", unknown: "unknown", us: "us", legacy: null, corrupt: "unknown" });

  // The previous release never asks for the geography and keeps its exact
  // response shape, which its strict parser requires.
  const keys = await withRlsContext(
    client.db,
    { accountId: base.accountId, workspaceId: base.workspaceId },
    async (scoped) =>
      await scoped.execute(sql`select distinct key
        from opengeni_private.insights_scoped_calls_rows(
          ${base.accountId}::uuid, ${base.workspaceId}::uuid,
          ${new Date(now.getTime() - 3_600_000).toISOString()}::timestamptz, ${now.toISOString()}::timestamptz,
          ${JSON.stringify({ range: "30d", limit: 50 })}::jsonb, null::timestamptz, null::uuid, 50,
          array[${base.workspaceId}::uuid]::uuid[], false
        ) calls cross join lateral jsonb_object_keys(calls.payload) key`),
  );
  const legacyKeys = Array.from(keys as unknown as Array<{ key: string }>).map((row) => row.key);
  expect(legacyKeys).toContain("listByClassMicros");
  expect(legacyKeys).not.toContain("processingGeography");
});
