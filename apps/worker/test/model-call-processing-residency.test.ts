import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RunRawModelStreamEvent } from "@openai/agents-core";
import { resolveModelProvider } from "@opengeni/config";
import { modelCallProcessingResidency } from "@opengeni/contracts";
import * as opengeniDb from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing/settings";
import { useNoSessionUsageLimitForFakeDatabases } from "@opengeni/testing/session-usage-limits";
import {
  createCompactionModelUsageEventState,
  createModelResponseEventState,
  createSessionTitleModelUsageEventState,
  emitModelCallUsage,
  processCompactionModelUsageEvent,
  processModelResponseTerminalEvent,
  processSessionTitleModelUsageEvent,
  recordAuthoritativeModelCallFact,
  servedRouteProcessingResidency,
} from "../src/activities/agent-turn/model-usage";
useNoSessionUsageLimitForFakeDatabases();

// Every model call records where the route that served it processes data, on
// both its durable usage event and its fact, so EU-only inference can be
// audited per call. The record is the claim only, never evidence text.

const EVIDENCE = "Azure deployment gpt-eu on res-neu-internal, sku DataZoneStandard";
const euDataZone = {
  geography: "eu",
  deploymentType: "azure_data_zone",
  regions: ["swedencentral"],
  evidence: { source: "operator_declaration", reference: EVIDENCE, verifiedAt: "2026-10-26" },
} as const;
const EU_CLAIM = {
  geography: "eu",
  deploymentType: "azure_data_zone",
  regions: ["swedencentral"],
} as const;
const UNKNOWN_CLAIM = { geography: "unknown", deploymentType: "unknown", regions: [] } as const;

const settings = testSettings({
  modelProvidersJson: JSON.stringify([
    {
      id: "azure-eu",
      api: "responses",
      wireProfile: "azure-openai",
      baseUrl: "https://res.openai.azure.com/openai/v1",
      apiKey: "key",
      models: [
        { id: "azure-eu/gpt-eu", upstreamModelId: "gpt-eu", residency: euDataZone },
        // The name says EU; nothing else does.
        { id: "azure-eu/gpt-eu-named", upstreamModelId: "gpt-eu-named" },
      ],
    },
  ]),
});

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

function captureFacts() {
  const facts: Array<Record<string, unknown>> = [];
  const usageEvents = spyOn(opengeniDb, "recordUsageEvent").mockResolvedValue(undefined as never);
  const recorded = spyOn(opengeniDb, "recordModelCallFact").mockImplementation(
    async (_db, input) => {
      facts.push(input as unknown as Record<string, unknown>);
      return { promptCacheDiagnostics: null } as never;
    },
  );
  restores.push(
    () => usageEvents.mockRestore(),
    () => recorded.mockRestore(),
  );
  return facts;
}

function durableEvents() {
  const stored: Array<Record<string, unknown>> = [];
  const publish = async (batch: Array<{ type: string; payload?: unknown }>) => ({
    accepted: true,
    canonicalStartupMilestones: [],
    events: batch.map((event) => {
      stored.push(event.payload as Record<string, unknown>);
      return {
        id: crypto.randomUUID(),
        type: event.type,
        payload: event.payload,
        turnAssociation: "current",
      };
    }),
  });
  return { stored, publish: publish as any };
}

const usage = { inputTokens: 164, outputTokens: 12, totalTokens: 176 };

function callInput(publish: unknown) {
  return {
    dispatchId: "dispatch-A",
    settings,
    db: {} as any,
    observability: createObservability(testSettings(), { component: "worker" }) as any,
    publish: publish as any,
    accountId: "acct-1",
    workspaceId: "ws-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    turnAttemptId: "attempt-1",
    provider: "azure-eu",
    providerApi: "responses" as const,
    model: "azure-eu/gpt-eu",
    externallyBilled: true,
    servingCredentialId: null,
    priorSessionCredentialId: null,
    renewLease: async () => undefined,
    leaseLost: () => false,
    leaseLostMessage: "lease lost",
  };
}

test("the served route's record decides, never a name; the built-in fallback uses its own rule", () => {
  const route = (id: string) => ({ configured: resolveModelProvider(settings, id)!.model });
  const eu = route("azure-eu/gpt-eu");
  const named = route("azure-eu/gpt-eu-named");
  expect(servedRouteProcessingResidency(settings, eu, "ignored")).toEqual(EU_CLAIM);
  expect(servedRouteProcessingResidency(settings, named, "ignored")).toEqual(UNKNOWN_CLAIM);
  // A configured model without a readable record is unknown, not null.
  expect(servedRouteProcessingResidency(settings, { configured: {} }, "ignored")).toEqual(
    UNKNOWN_CLAIM,
  );
  expect(
    servedRouteProcessingResidency(
      settings,
      { configured: { residency: { ...euDataZone, deploymentType: "gateway" } as never } },
      "ignored",
    ),
  ).toEqual(UNKNOWN_CLAIM);

  // No resolved model: the legacy built-in provider served the call.
  expect(servedRouteProcessingResidency(testSettings(), null, "gpt-eu")).toEqual({
    geography: "us",
    deploymentType: "provider_default",
    regions: [],
  });
  expect(
    servedRouteProcessingResidency(testSettings({ openaiProvider: "azure" }), null, "gpt-eu"),
  ).toEqual(UNKNOWN_CLAIM);
  const declared = testSettings({
    openaiProvider: "azure",
    builtinModelResidencyJson: JSON.stringify({ "gpt-eu": euDataZone }),
  });
  expect(servedRouteProcessingResidency(declared, null, "gpt-eu")).toEqual(EU_CLAIM);
  expect(servedRouteProcessingResidency(declared, null, "gpt-other")).toEqual(UNKNOWN_CLAIM);
  // An unreadable declaration never fails the call's accounting.
  expect(
    servedRouteProcessingResidency(
      testSettings({ builtinModelResidencyJson: "{not json" }),
      null,
      "gpt-eu",
    ),
  ).toEqual(UNKNOWN_CLAIM);
});

test("main, compaction, title and aggregate calls record the residency on the event and fact", async () => {
  const facts = captureFacts();
  const { stored, publish } = durableEvents();
  const base = callInput(publish);
  const claimed = new Set<string>();
  const emitted = new Set<string>();
  const eu = modelCallProcessingResidency(
    resolveModelProvider(settings, base.model)!.model.residency,
  );
  const builtin = servedRouteProcessingResidency(testSettings(), null, "gpt-builtin");

  await processModelResponseTerminalEvent({
    ...base,
    event: new RunRawModelStreamEvent({
      type: "response_done",
      response: { id: "msg_main", output: [], usage },
    } as any) as any,
    state: createModelResponseEventState(claimed),
    metricProvider: "azure-eu",
    emittedSourceKeys: emitted,
    setLastInputTokens: async () => undefined,
    processingResidency: eu,
  });
  await processCompactionModelUsageEvent({
    ...base,
    usage: { usage } as any,
    state: createCompactionModelUsageEventState(claimed),
    emittedSourceKeys: emitted,
    processingResidency: modelCallProcessingResidency(null),
  });
  await processSessionTitleModelUsageEvent({
    ...base,
    usage: { usage } as any,
    state: createSessionTitleModelUsageEventState(claimed),
    emittedSourceKeys: emitted,
    processingResidency: builtin,
  });
  expect(
    await emitModelCallUsage({
      observability: base.observability,
      publish,
      accountId: "acct-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      provider: "azure-eu",
      providerApi: "responses",
      model: base.model,
      purpose: "main",
      sourceKey: "dispatch-A:aggregate",
      usage: { usage },
      emittedSourceKeys: emitted,
      // A caller handing over the full record still records only the claim.
      processingResidency: { ...euDataZone } as never,
    }),
  ).toBe(true);

  expect(stored.map((payload) => [payload.purpose, payload.processingResidency])).toEqual([
    ["main", EU_CLAIM],
    ["compaction", UNKNOWN_CLAIM],
    ["session-title", { geography: "us", deploymentType: "provider_default", regions: [] }],
    ["main", EU_CLAIM],
  ]);
  expect(facts.map((fact) => [fact.sourceKey, fact.processingResidency])).toEqual([
    ["msg_main", EU_CLAIM],
    ["dispatch-A:compaction-1", UNKNOWN_CLAIM],
    [
      "dispatch-A:session-title-1",
      { geography: "us", deploymentType: "provider_default", regions: [] },
    ],
  ]);
  // Evidence text may name internal resources and is never recorded.
  expect(JSON.stringify([stored, facts])).not.toContain("res-neu-internal");
  expect(JSON.stringify([stored, facts])).not.toContain("evidence");
});

test("the authoritative fact writer forwards the served route's residency", async () => {
  const facts = captureFacts();
  const billing = {
    billingPath: "external",
    pricedCostMicros: 0,
    estimatedProviderCostMicros: null,
    equivalentCreditCostMicros: null,
    pricingSource: null,
    normalizedUsage: {
      telemetry: {
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      totalTokens: 2,
    },
  } as any;
  const base = {
    db: {} as any,
    observability: createObservability(testSettings(), { component: "worker" }) as any,
    accountId: "acct-1",
    workspaceId: "ws-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    turnAttemptId: "attempt-1",
    provider: "azure-eu",
    providerApi: "responses" as const,
    model: "azure-eu/gpt-eu",
    billing,
  };
  await recordAuthoritativeModelCallFact({
    ...base,
    sourceKey: "eu",
    processingResidency: EU_CLAIM as never,
  });
  expect(facts.map((fact) => fact.processingResidency)).toEqual([EU_CLAIM]);
});

test("every worker call site passes the served route's residency", () => {
  const source = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s+/g, " ");
  const stream = source("../src/activities/agent-turn/stream-attempt.ts");
  const compaction = source("../src/activities/agent-turn/compaction-prep.ts");
  const title = source("../src/activities/independent-session-title.ts");
  // The turn's route, resolved once; the title records its own route.
  expect(stream).toContain(
    "const turnProcessingResidency = servedRouteProcessingResidency( settings, resolvedModel, turnExecutionPolicy.productModelId, );",
  );
  expect(stream.split("processingResidency: turnProcessingResidency,").length - 1).toBe(3);
  expect(stream).toContain(
    "processingResidency: titleProcessingResidency ?? turnProcessingResidency,",
  );
  expect(stream).toContain(
    "titleProcessingResidency = servedRouteProcessingResidency( settings, titleRoute.resolvedModel,",
  );
  expect(compaction).toContain("processingResidency: compactionProcessingResidency,");
  // The independent title freezes its accepted route's residency in the request.
  expect(title).toContain(
    "processingResidency: servedRouteProcessingResidency( input.settings, input.route.resolvedModel, route.modelId, ),",
  );
  expect(title.split("processingResidency,").length - 1).toBeGreaterThanOrEqual(2);
});
