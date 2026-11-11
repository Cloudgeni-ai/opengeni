import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  listSessionEvents,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { ScriptedModel, assistantMessage } from "@opengeni/testing/scripted-model";
import { createProductionAgentRuntime, type OpenGeniRuntime } from "@opengeni/runtime";
import { createActivityTestHarness } from "../src/activities";

setDefaultTimeout(120_000);

// A real agent turn records the residency of the route that served each call
// on its durable agent.model.usage event and its model_call_facts row: the
// resolved configured model's record, or unknown when that route has none.

const EVIDENCE = "Azure deployment gpt-eu on res-neu-internal, sku DataZoneStandard";
const euDataZone = {
  geography: "eu",
  deploymentType: "azure_data_zone",
  regions: ["swedencentral"],
  evidence: { source: "operator_declaration", reference: EVIDENCE, verifiedAt: "2026-10-26" },
} as const;
const EU_CLAIM = { geography: "eu", deploymentType: "azure_data_zone", regions: ["swedencentral"] };
const UNKNOWN_CLAIM = { geography: "unknown", deploymentType: "unknown", regions: [] };

let shared: SharedTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("model-call-processing-residency-worker");
  if (!acquired) throw new Error("Native PostgreSQL required for processing residency");
  shared = acquired;
  app = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

async function runTurn(residency: typeof euDataZone | undefined) {
  const subjectId = `user:residency:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "processing-residency",
    accountExternalId: crypto.randomUUID(),
    accountName: "Processing residency",
    workspaceExternalSource: "processing-residency",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Processing residency",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const ctx = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  const session = await createSession(app.db, {
    ...ctx,
    createdBy: { kind: "subject", subjectId },
    initialMessage: "Say hello",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(app.db, {
    ...ctx,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  const scripted = new ScriptedModel([
    { id: `reply-${session.id}`, inputTokens: 100, output: [assistantMessage("Hello")] },
  ]);
  const production = createProductionAgentRuntime({ model: scripted });
  const runtime: OpenGeniRuntime = {
    ...production,
    configure: () => {},
    resolveTurnModel: () => ({
      provider: { id: "test-chat", label: "Offline", kind: "api-key", api: "chat", builtin: false },
      client: {} as NonNullable<ReturnType<OpenGeniRuntime["resolveTurnModel"]>>["client"],
      model: scripted,
      configured: {
        id: "scripted-model",
        label: "Offline",
        providerId: "test-chat",
        providerLabel: "Offline",
        api: "chat",
        contextWindowTokens: 250_000,
        effectiveContextWindowTokens: 250_000,
        autoCompactTokenLimit: 225_000,
        reasoningEffort: false,
        hostedWebSearch: false,
        ...(residency ? { residency } : {}),
      },
    }),
  };
  const activities = createActivityTestHarness({
    settings: testSettings({
      databaseUrl: shared.appUrl,
      openaiModel: "scripted-model",
      sandboxBackend: "none",
      modelPricingJson: JSON.stringify({
        "scripted-model": {
          inputMicrosPerMillionTokens: 1_000_000,
          outputMicrosPerMillionTokens: 0,
        },
      }),
    }),
    db: app.db,
    bus: new MemoryEventBus(),
    runtime,
  });
  const result = await activities.runAgentTurn({
    ...ctx,
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  expect(result.status).toBe("idle");
  const events = await listSessionEvents(app.db, ctx.workspaceId, session.id, {
    after: 0,
    limit: 200,
  });
  const usage = events
    .filter((event) => event.type === "agent.model.usage")
    .map((event) => event.payload as Record<string, unknown>);
  const facts = await shared.admin<{ sourceKey: string; residency: unknown }[]>`
    select source_key as "sourceKey", processing_residency as residency from model_call_facts
    where session_id = ${session.id} order by source_key`;
  return { usage, facts };
}

test("a turn on an EU route records the route's claim, never its evidence", async () => {
  const { usage, facts } = await runTurn(euDataZone);
  const main = usage.filter((payload) => payload.purpose === "main");
  expect(main.length).toBeGreaterThan(0);
  for (const payload of main) expect(payload.processingResidency).toEqual(EU_CLAIM);
  const mainKeys = new Set(main.map((payload) => payload.sourceKey));
  const mainFacts = facts.filter((fact) => mainKeys.has(fact.sourceKey));
  expect(mainFacts.length).toBe(main.length);
  for (const fact of mainFacts) expect(fact.residency).toEqual(EU_CLAIM);
  expect(JSON.stringify([usage, facts])).not.toContain("res-neu-internal");
});

test("a turn on a route without a residency record records unknown, never null", async () => {
  const { usage, facts } = await runTurn(undefined);
  const main = usage.filter((payload) => payload.purpose === "main");
  expect(main.length).toBeGreaterThan(0);
  for (const payload of main) expect(payload.processingResidency).toEqual(UNKNOWN_CLAIM);
  expect(facts.length).toBeGreaterThan(0);
  for (const fact of facts) expect(fact.residency).toEqual(UNKNOWN_CLAIM);
});
