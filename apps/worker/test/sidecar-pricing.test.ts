import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { createObservability } from "@opengeni/observability";
import { calculateModelUsageCostBreakdown, configuredProviders } from "@opengeni/config";
import { generateSessionTitle, summarizeForCompaction } from "@opengeni/runtime";
import { ReplayableJsonOpenAI } from "../../../packages/runtime/src/replayable-json-body";
import {
  createSessionTitleModelUsageEventState,
  createCompactionModelUsageEventState,
  processCompactionModelUsageEvent,
  processSessionTitleModelUsageEvent,
} from "../src/activities/agent-turn/model-usage";

test("Fast title settlement preserves request pricing while releasing its hold", async () => {
  const settings = testSettings({
    billingMode: "stripe",
    usageLimitsMode: "managed",
    modelPricingJson: JSON.stringify({
      "gpt-5.6-sol": {
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
        marginBps: 0,
      },
    }),
  });
  const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
  const standard = calculateModelUsageCostBreakdown(settings, "gpt-5.6-sol", usage, {
    latencyMode: "standard",
  }).creditCostMicros;
  const fast = calculateModelUsageCostBreakdown(settings, "gpt-5.6-sol", usage, {
    latencyMode: "fast",
  }).creditCostMicros;
  expect(fast).toBeGreaterThan(standard);
  let batch: Parameters<typeof db.recordUsageEventsAndApplyCreditDebit>[1] | undefined;
  const write = spyOn(db, "recordUsageEventsAndApplyCreditDebit").mockImplementation(
    async (_db, input) => {
      batch = input;
      return { events: [], debit: null };
    },
  );
  const fact = spyOn(db, "recordModelCallFact").mockResolvedValue(undefined);
  const release = {
    eventType: "model.cost.reserved",
    quantity: -1000,
    unit: "usd_micros",
    idempotencyKey: "fast-title-release",
  };
  try {
    let actualWireTier: unknown;
    let result: Awaited<ReturnType<typeof processSessionTitleModelUsageEvent>> | undefined;
    const client = new ReplayableJsonOpenAI({
      apiKey: "test",
      baseURL: "http://proof.invalid/v1",
      maxRetries: 0,
      fetch: async (_url, init) => {
        actualWireTier = (await new Response(init?.body).json()).service_tier;
        return Response.json({
          id: "title-fast",
          status: "completed",
          service_tier: "fast",
          output: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Audit finance paths" }],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        });
      },
    });
    const generated = await generateSessionTitle(settings, "Audit financial roots", {
      client,
      provider: configuredProviders(settings)[0]!,
      modelName: "gpt-5.6-sol",
      serviceTier: "fast",
      onModelCallAdmission: async () => ({ maxOutputTokens: 512 }),
      onUsage: async (reportedUsage) => {
        result = await processSessionTitleModelUsageEvent({
          usage: reportedUsage,
          state: createSessionTitleModelUsageEventState(),
          dispatchId: "dispatch",
          settings,
          db: {} as never,
          observability: createObservability(settings, { component: "spec-proof" }),
          publish: null,
          accountId: "account",
          workspaceId: "workspace",
          sessionId: "session",
          turnId: "turn",
          turnAttemptId: "attempt",
          provider: "openai",
          providerApi: "responses",
          model: "gpt-5.6-sol",
          latencyMode: "fast",
          externallyBilled: false,
          servingCredentialId: null,
          priorSessionCredentialId: null,
          emittedSourceKeys: new Set(),
          renewLease: async () => {},
          leaseLost: () => false,
          leaseLostMessage: "lost",
          reservationReleases: [release],
        });
      },
    });
    expect(generated.title).toBe("Audit finance paths");
    expect(actualWireTier).toBe("fast");
    expect(result?.usageReported).toBe(true);
    expect(batch?.creditDebit?.requestedAmountMicros).toBe(fast);
    expect(batch?.creditDebit?.requestedAmountMicros).not.toBe(standard);
    expect(batch?.usageEvents).toContainEqual(release);
  } finally {
    write.mockRestore();
    fact.mockRestore();
  }
});

test("Fast prepared Responses compaction preserves request pricing while releasing its hold", async () => {
  const settings = testSettings({
    billingMode: "stripe",
    usageLimitsMode: "managed",
    modelPricingJson: JSON.stringify({
      "gpt-5.6-sol": {
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
        marginBps: 0,
      },
    }),
  });
  const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
  const standard = calculateModelUsageCostBreakdown(settings, "gpt-5.6-sol", usage, {
    latencyMode: "standard",
  }).creditCostMicros;
  const fast = calculateModelUsageCostBreakdown(settings, "gpt-5.6-sol", usage, {
    latencyMode: "fast",
  }).creditCostMicros;
  expect(fast).toBeGreaterThan(standard);
  let batch: Parameters<typeof db.recordUsageEventsAndApplyCreditDebit>[1] | undefined;
  const write = spyOn(db, "recordUsageEventsAndApplyCreditDebit").mockImplementation(
    async (_db, input) => {
      batch = input;
      return { events: [], debit: null };
    },
  );
  const fact = spyOn(db, "recordModelCallFact").mockResolvedValue(undefined);
  const release = {
    eventType: "model.cost.reserved",
    quantity: -1000,
    unit: "usd_micros",
    idempotencyKey: "fast-compaction-release",
  };
  try {
    let actualWireTier: unknown;
    let result: Awaited<ReturnType<typeof processCompactionModelUsageEvent>> | undefined;
    const client = new ReplayableJsonOpenAI({
      apiKey: "test",
      baseURL: "http://proof.invalid/v1",
      maxRetries: 0,
      fetch: async (_url, init) => {
        actualWireTier = (await new Response(init?.body).json()).service_tier;
        return Response.json({
          id: "title-fast",
          status: "completed",
          service_tier: "fast",
          output: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Audit finance paths" }],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        });
      },
    });
    const generated = await summarizeForCompaction(
      settings,
      [{ type: "message", role: "user", content: "Audit financial roots" }],
      {
        client,
        provider: configuredProviders(settings)[0]!,
        model: "gpt-5.6-sol",
        preparedRequest: {
          systemInstructions: "Summarize the active task",
          tools: [],
          handoffs: [],
          outputType: "text",
          modelSettings: { providerData: { service_tier: "fast" } },
          tracing: false,
        },
        onModelCallAdmission: async () => ({ maxOutputTokens: 512 }),
        onUsage: async (reportedUsage) => {
          result = await processCompactionModelUsageEvent({
            usage: reportedUsage,
            state: createCompactionModelUsageEventState(),
            dispatchId: "dispatch",
            settings,
            db: {} as never,
            observability: createObservability(settings, { component: "spec-proof" }),
            publish: null,
            accountId: "account",
            workspaceId: "workspace",
            sessionId: "session",
            turnId: "turn",
            turnAttemptId: "attempt",
            provider: "openai",
            providerApi: "responses",
            model: "gpt-5.6-sol",
            latencyMode: "fast",
            externallyBilled: false,
            servingCredentialId: null,
            priorSessionCredentialId: null,
            emittedSourceKeys: new Set(),
            renewLease: async () => {},
            leaseLost: () => false,
            leaseLostMessage: "lost",
            reservationReleases: [release],
          });
        },
      },
    );
    expect(generated).toBe("Audit finance paths");
    expect(actualWireTier).toBe("fast");
    expect(result?.usageReported).toBe(true);
    expect(batch?.creditDebit?.requestedAmountMicros).toBe(fast);
    expect(batch?.creditDebit?.requestedAmountMicros).not.toBe(standard);
    expect(batch?.usageEvents).toContainEqual(release);
  } finally {
    write.mockRestore();
    fact.mockRestore();
  }
});

test.each(["title", "compaction"])(
  "direct Chat %s local client policy failure refunds its own grant",
  async (kind) => {
    const settings = testSettings();
    const provider = { ...configuredProviders(settings)[0]!, api: "chat" as const };
    let fetches = 0;
    let refunds = 0;
    const client = new ReplayableJsonOpenAI(
      {
        apiKey: "fixture",
        fetch: async () => {
          fetches++;
          throw new Error("unexpected fetch");
        },
      },
      {
        modelRequestPolicy: () => {
          throw new Error("owned local policy refusal");
        },
      },
    );
    const onModelCallAdmission = async () => ({
      maxOutputTokens: 10,
      onRequestNotDispatched: async () => {
        refunds++;
      },
    });
    await expect(
      kind === "title"
        ? generateSessionTitle(settings, "test opener", { client, provider, onModelCallAdmission })
        : summarizeForCompaction(settings, [{ role: "user", content: "test history" }], {
            client,
            provider,
            api: "chat",
            onModelCallAdmission,
          }),
    ).rejects.toThrow(
      kind === "title" ? "owned local policy refusal" : "Compaction provider request failed",
    );
    expect(fetches).toBe(0);
    expect(refunds).toBe(1);
  },
);
