import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync, type Node } from "oxc-parser";
import type { Model } from "@openai/agents";
import {
  withCodexCatalogProvider,
  withXaiSubscriptionCatalogProvider,
  type Settings,
} from "@opengeni/config";
import * as db from "@opengeni/db";
import {
  XAI_SUBSCRIPTION_MODEL_ID_PREFIX,
  XAI_SUBSCRIPTION_MODEL_SLUGS,
} from "@opengeni/xai-subscription";
import { createObservability } from "@opengeni/observability";
import {
  buildModelInstance,
  buildOpenAIClientFromSettings,
  buildOpenGeniAgent,
  prepareAgentTools,
  resolveTurnModel,
  runAgentStream,
  normalizeSdkEvent,
} from "@opengeni/runtime";
import { requestBodyText } from "../../../packages/runtime/src/replayable-json-body";
import { ScriptedModel, testSettings } from "@opengeni/testing";
import { buildTurnAgent, type BuildTurnAgentDeps } from "../src/activities/agent-turn/agent-build";
import {
  reasoningSummaryForTurn,
  textVerbosityForTurn,
} from "../src/activities/agent-turn/tool-policy";
import { createTurnContext } from "../src/activities/agent-turn/turn-context";
import { createRuntimeBatcher } from "../src/activities/streaming";
import { TurnAttemptFencedError } from "../src/activities/turn-attempt-fenced";
import { streamSessionEvents, type SessionEvent } from "@opengeni/sdk";
import { buildTimeline } from "../../../packages/react/src/timeline/projection";

function builtinSettings(overrides: Parameters<typeof testSettings>[0] = {}): Settings {
  return testSettings({
    sandboxBackend: "none",
    openaiProvider: "openai",
    openaiModel: "gpt-5.6-sol",
    openaiAllowedModels: "gpt-5.6-sol,gpt-4.1",
    modelProvidersJson: JSON.stringify([
      {
        id: "fireworks",
        label: "Fireworks AI",
        api: "chat",
        baseUrl: "https://api.fireworks.ai/inference/v1",
        apiKey: "fw-test-key",
        models: [{ id: "accounts/fireworks/models/glm-5p2", label: "GLM 5.2" }],
      },
      {
        id: "azure-sol",
        label: "Azure OpenAI Sol",
        api: "responses",
        wireProfile: "azure-openai",
        baseUrl: "https://registry.openai.azure.com/openai/v1",
        apiKey: "azure-registry-test-key",
        models: [
          {
            id: "azure-sol/gpt-6-sol",
            upstreamModelId: "gpt-6-sol",
            label: "Sol",
            reasoningEffort: true,
          },
          { id: "azure-sol/gpt-4.1", upstreamModelId: "gpt-4.1", label: "GPT-4.1" },
        ],
      },
      {
        id: "compatible",
        label: "OpenAI-compatible Responses",
        api: "responses",
        baseUrl: "https://responses.example.test/v1",
        apiKey: "compatible-test-key",
        models: [{ id: "compatible/gpt-5.6-sol", upstreamModelId: "gpt-5.6-sol", label: "Sol" }],
      },
    ]),
    ...overrides,
  });
}

function resolved(settings: Settings, modelId: string) {
  const model = resolveTurnModel(settings, modelId);
  if (!model) throw new Error(`${modelId} did not resolve`);
  return model;
}

function verbosityFor(settings: Settings, modelId: string) {
  const model = resolved(settings, modelId);
  return textVerbosityForTurn(model, model.configured.upstreamModelId);
}

describe("textVerbosityForTurn", () => {
  test("asks for low verbosity only on routes that accept it", () => {
    const codex = withCodexCatalogProvider(builtinSettings());
    expect(verbosityFor(codex, "codex/gpt-6-sol")).toBe("low");
    expect(verbosityFor(builtinSettings(), "gpt-5.6-sol")).toBe("low");

    // Older models accept only the default verbosity.
    expect(verbosityFor(builtinSettings(), "gpt-4.1")).toBeUndefined();
    const codexModel = resolved(codex, "codex/gpt-6-sol");
    expect(textVerbosityForTurn(codexModel, "gpt-5.1-codex-max")).toBeUndefined();
    expect(textVerbosityForTurn(codexModel, "gpt-5-chat-latest")).toBeUndefined();

    // Azure OpenAI Responses, built in or registered, with the same model check.
    const azure = builtinSettings({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
    });
    expect(resolved(azure, "gpt-5.6-sol").provider.wireProfile).toBe("azure-openai");
    expect(verbosityFor(azure, "gpt-5.6-sol")).toBe("low");
    expect(verbosityFor(azure, "gpt-4.1")).toBeUndefined();
    const azureRegistry = resolved(builtinSettings(), "azure-sol/gpt-6-sol").provider;
    expect(azureRegistry.builtin).toBe(false);
    expect(azureRegistry.wireProfile).toBe("azure-openai");
    expect(verbosityFor(builtinSettings(), "azure-sol/gpt-6-sol")).toBe("low");
    expect(verbosityFor(builtinSettings(), "azure-sol/gpt-4.1")).toBeUndefined();

    // Unverified wires keep the provider default.
    const proxied = builtinSettings({ openaiBaseUrl: "https://proxy.example.test/v1" });
    expect(verbosityFor(proxied, "gpt-5.6-sol")).toBeUndefined();
    expect(verbosityFor(builtinSettings(), "compatible/gpt-5.6-sol")).toBeUndefined();
    expect(verbosityFor(builtinSettings(), "accounts/fireworks/models/glm-5p2")).toBeUndefined();
    const xai = withXaiSubscriptionCatalogProvider(builtinSettings());
    const xaiModelId = `${XAI_SUBSCRIPTION_MODEL_ID_PREFIX}${XAI_SUBSCRIPTION_MODEL_SLUGS[0]}`;
    expect(resolved(xai, xaiModelId).provider.kind).toBe("xai-subscription");
    expect(verbosityFor(xai, xaiModelId)).toBeUndefined();
    // The legacy global-client path stays byte-identical.
    expect(textVerbosityForTurn(null, "gpt-5.6-sol")).toBeUndefined();
  });
});

test("auto summaries require a supported Responses route and accepted reasoning capability", () => {
  const settings = builtinSettings();
  expect(reasoningSummaryForTurn(resolved(settings, "gpt-5.6-sol"))).toBe("auto");
  expect(reasoningSummaryForTurn(resolved(settings, "azure-sol/gpt-6-sol"))).toBe("auto");
  for (const modelId of [
    "gpt-4.1",
    "azure-sol/gpt-4.1",
    "compatible/gpt-5.6-sol",
    "accounts/fireworks/models/glm-5p2",
  ]) {
    expect(reasoningSummaryForTurn(resolved(settings, modelId))).toBeUndefined();
  }
  const supported = resolved(settings, "gpt-5.6-sol");
  for (const modelId of ["gpt-5-chat-latest", "gpt-5.1-codex-max", "o3"]) {
    expect(
      reasoningSummaryForTurn({
        ...supported,
        configured: { ...supported.configured, upstreamModelId: modelId },
      }),
    ).toBeUndefined();
  }
  expect(
    reasoningSummaryForTurn({
      ...supported,
      configured: {
        ...supported.configured,
        capabilities: {
          ...supported.configured.capabilities,
          reasoning: { ...supported.configured.capabilities.reasoning, runnable: false },
        },
      },
    }),
  ).toBeUndefined();
  expect(
    reasoningSummaryForTurn(resolved(withCodexCatalogProvider(settings), "codex/gpt-6-sol")),
  ).toBeUndefined();
  expect(
    reasoningSummaryForTurn(
      resolved(builtinSettings({ openaiBaseUrl: "https://proxy.example.test/v1" }), "gpt-5.6-sol"),
    ),
  ).toBeUndefined();
  const xai = withXaiSubscriptionCatalogProvider(settings);
  expect(
    reasoningSummaryForTurn(
      resolved(xai, `${XAI_SUBSCRIPTION_MODEL_ID_PREFIX}${XAI_SUBSCRIPTION_MODEL_SLUGS[0]}`),
    ),
  ).toBeUndefined();
  expect(reasoningSummaryForTurn(null)).toBeUndefined();
});

// Execute the exact production publisher, including its attempt fence. Only
// the durable storage/publish port is scripted; this is not a PostgreSQL test.
function fencedPublisher(accept: boolean, stored: SessionEvent[]) {
  const source = readFileSync(
    new URL("../src/activities/agent-turn/claim.ts", import.meta.url),
    "utf8",
  );
  const parsed = parseSync("claim.ts", source);
  expect(parsed.errors).toEqual([]);
  let expression: Node | undefined;
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = value as Node;
    if (
      node.type === "AssignmentExpression" &&
      node.left.type === "MemberExpression" &&
      node.left.object.type === "Identifier" &&
      node.left.object.name === "eventing" &&
      node.left.property.type === "Identifier" &&
      node.left.property.name === "publish"
    )
      expression = node.right;
    for (const child of Object.values(value)) visit(child);
  };
  visit(parsed.program);
  if (!expression) throw new Error("Missing production fenced event publisher");
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(
    `const publish = ${source.slice(expression.start, expression.end)};`,
  );
  const noop = () => undefined;
  const ports = {
    db: {},
    bus: {},
    input: { workspaceId: "workspace", sessionId: "session", attemptId: "attempt" },
    attempt: { turnId: "turn", executionGeneration: 1 },
    producerId: "producer",
    observability: {},
    activityContext: null,
    heartbeatDetails: {},
    TurnAttemptFencedError,
    recordSessionEventAppendLatency: noop,
    recordSessionEventAppendPhase: noop,
    recordSessionEventPublishLatency: noop,
    recordCanonicalStartupMilestones: noop,
    turnLifecycleMetricsFor: () => ({ progress: noop }),
    appendAndPublishTurnEventsFenced: async (
      _db: unknown,
      _bus: unknown,
      workspaceId: string,
      sessionId: string,
      turnId: string,
      generation: number,
      attemptId: string,
      events: any[],
    ) => {
      expect({ workspaceId, sessionId, turnId, generation, attemptId }).toEqual({
        workspaceId: "workspace",
        sessionId: "session",
        turnId: "turn",
        generation: 1,
        attemptId: "attempt",
      });
      if (accept)
        for (const event of events) {
          const sequence = stored.length + 1;
          expect(event.producerSeq).toBe(sequence);
          expect(event.producerId).toBe("producer");
          stored.push({
            ...event,
            id: `event-${sequence}`,
            workspaceId,
            sessionId,
            sequence,
            turnAttemptId: attemptId,
            occurredAt: new Date(sequence).toISOString(),
          });
        }
      return { accepted: accept, canonicalStartupMilestones: [] };
    },
  };
  return new Function(
    "ports",
    `const { ${Object.keys(ports).join(", ")} } = ports; let producerSeq = 0; ${compiled} return publish;`,
  )(ports) as (events: { type: string; payload: unknown }[]) => Promise<void>;
}

async function sseTimeline(events: SessionEvent[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events)
        controller.enqueue(
          encoder.encode(
            `id: ${event.sequence}\nevent: session.event\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
      controller.close();
    },
  });
  const delivered: SessionEvent[] = [];
  for await (const event of streamSessionEvents(
    {
      openStream: async () => body,
      listEvents: async () => {
        throw new Error("Unexpected sequence gap");
      },
    },
    { reconnect: false },
  ))
    delivered.push(event);
  return buildTimeline(delivered);
}

test("only provider summary text maps to visible reasoning, not private or encrypted reasoning", () => {
  const raw = (type: string) => ({
    type: "raw_model_stream_event",
    source: "openai-responses",
    data: { type: "model", event: { type, delta: "Provider text" } },
  });
  expect(normalizeSdkEvent(raw("response.reasoning_summary_text.delta") as any)).toEqual([
    { type: "agent.reasoning.delta", payload: { text: "Provider text" } },
  ]);
  for (const type of [
    "response.reasoning_text.delta",
    "response.reasoning.delta",
    "response.reasoning.encrypted_content.delta",
  ]) {
    expect(normalizeSdkEvent(raw(type) as any)).toEqual([]);
  }
});

test("a fenced summary cannot reach the event stream or timeline", async () => {
  const stored: SessionEvent[] = [];
  const batcher = createRuntimeBatcher(fencedPublisher(false, stored));
  await batcher.push({ type: "agent.reasoning.delta", payload: { text: "Provider summary" } });
  await expect(batcher.flush()).rejects.toBeInstanceOf(TurnAttemptFencedError);
  expect(stored).toEqual([]);
});

// Execute the production builder. Only unrelated persistence is stubbed.
async function buildWorkerAgent(settings: Settings, modelId: string, modelOverride?: Model) {
  const resolvedModel = resolved(settings, modelId);
  const context = createTurnContext({ settings, cancellationRequestedAt: null });
  context.eventing.preparedTools = await prepareAgentTools(settings, []);
  const persistence = [
    spyOn(db, "getSandboxRecoveryDiscontinuity").mockResolvedValue(null),
    spyOn(db, "getWorkspaceVideoGenerationPolicy").mockResolvedValue({
      schemaVersion: 1,
      revision: 0,
      fundingSource: "workspace_gateway",
      enabledModelIds: [],
      defaultModelId: null,
    }),
    spyOn(db, "ensureSessionSkillCatalog").mockImplementation(async (_db, input) => input.catalog),
    spyOn(db, "getExternalLinkTurnAuthorization").mockResolvedValue(null),
  ];
  try {
    const deps: Partial<BuildTurnAgentDeps> = {
      ...context,
      input: {
        accountId: "account",
        workspaceId: "workspace",
        sessionId: "session",
        attemptId: "attempt",
        workflowId: "workflow",
        workflowRunId: "workflow-run",
        trigger: { kind: "next" },
      },
      db: {} as BuildTurnAgentDeps["db"],
      runtime: {
        buildAgent: (runSettings: Settings, resources, options) =>
          buildOpenGeniAgent(runSettings, resources, {
            ...options,
            model: modelOverride ?? new ScriptedModel("ok"),
          }),
      } as BuildTurnAgentDeps["runtime"],
      observability: createObservability(settings, { component: "worker" }),
      objectStorage: null,
      media: {} as BuildTurnAgentDeps["media"],
      turn: {
        id: "turn",
        executionGeneration: 1,
        reasoningEffort: "medium",
      } as BuildTurnAgentDeps["turn"],
      session: { id: "session" } as BuildTurnAgentDeps["session"],
      runSettings: settings,
      mcpServers: [],
      skillCatalog: [],
      resolvedModel,
      turnExecutionPolicy: {
        providerId: resolvedModel.provider.id,
        latencyMode: "standard",
        upstreamModelId: resolvedModel.configured.upstreamModelId,
      } as BuildTurnAgentDeps["turnExecutionPolicy"],
      runtimeResources: [],
      sandboxEnvironment: {},
      sandboxArtifactRuntime: { available: false, environment: {} },
      fileResourceDownloads: [],
      attemptConnectorActionBindings: [],
      modelInputPolicy: { inputFileMediaTypes: [], supportsImageInput: true },
      preparationIndependentToolNames: [],
      groupBoxBackend: "none",
      postToolPreparationStartedAt: performance.now(),
      trigger: { type: "user.message", payload: {} } as BuildTurnAgentDeps["trigger"],
    };
    return (await buildTurnAgent(deps as BuildTurnAgentDeps)).agent;
  } finally {
    for (const spy of persistence) spy.mockRestore();
    await context.eventing.preparedTools?.close();
  }
}

test("the worker builds Codex and Azure turns with low verbosity and leaves other wires unchanged", async () => {
  const codex = await buildWorkerAgent(
    withCodexCatalogProvider(builtinSettings()),
    "codex/gpt-6-sol",
  );
  expect(codex.modelSettings.text).toEqual({ verbosity: "low" });
  expect(codex.modelSettings.reasoning).toEqual({ effort: "medium", summary: "detailed" });

  const azure = await buildWorkerAgent(
    builtinSettings({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
    }),
    "gpt-5.6-sol",
  );
  expect(azure.modelSettings.text).toEqual({ verbosity: "low" });
  expect(azure.modelSettings.reasoning).toEqual({ effort: "medium", summary: "auto" });

  const compatible = await buildWorkerAgent(builtinSettings(), "compatible/gpt-5.6-sol");
  expect(compatible.modelSettings.text).toBeUndefined();
  expect(compatible.modelSettings.reasoning).toEqual({ effort: "medium", summary: "detailed" });
});

function summaryStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let released = false;
  const summary = "Checking the requested reply.";
  const reasoning = {
    id: "reasoning-1",
    type: "reasoning",
    summary: [{ type: "summary_text", text: summary }],
  };
  const message = {
    id: "message-1",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "OK", annotations: [] }],
  };
  let sequence = 0;
  const emit = (event: object) =>
    controller.enqueue(
      encoder.encode(`data: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`),
    );
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      emit({
        type: "response.created",
        response: { id: "response-1", status: "in_progress", output: [], usage: null },
      });
      emit({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...reasoning, summary: [] },
      });
      emit({
        type: "response.reasoning_summary_part.added",
        item_id: reasoning.id,
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
      emit({
        type: "response.reasoning_summary_text.delta",
        item_id: reasoning.id,
        output_index: 0,
        summary_index: 0,
        delta: summary,
      });
    },
  });
  return {
    summary,
    body,
    released: () => released,
    releaseFinal() {
      if (released) return;
      released = true;
      emit({
        type: "response.reasoning_summary_text.done",
        item_id: reasoning.id,
        output_index: 0,
        summary_index: 0,
        text: summary,
      });
      emit({
        type: "response.reasoning_summary_part.done",
        item_id: reasoning.id,
        output_index: 0,
        summary_index: 0,
        part: reasoning.summary[0],
      });
      emit({ type: "response.output_item.done", output_index: 0, item: reasoning });
      emit({
        type: "response.output_item.added",
        output_index: 1,
        item: { ...message, status: "in_progress", content: [] },
      });
      emit({
        type: "response.content_part.added",
        item_id: message.id,
        output_index: 1,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      emit({
        type: "response.output_text.delta",
        item_id: message.id,
        output_index: 1,
        content_index: 0,
        delta: "OK",
        logprobs: [],
      });
      emit({
        type: "response.output_text.done",
        item_id: message.id,
        output_index: 1,
        content_index: 0,
        text: "OK",
        logprobs: [],
      });
      emit({
        type: "response.content_part.done",
        item_id: message.id,
        output_index: 1,
        content_index: 0,
        part: message.content[0],
      });
      emit({ type: "response.output_item.done", output_index: 1, item: message });
      emit({
        type: "response.completed",
        response: {
          id: "response-1",
          status: "completed",
          output: [reasoning, message],
          usage: {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 20,
            output_tokens_details: { reasoning_tokens: 18 },
            total_tokens: 30,
          },
        },
      });
      controller.close();
    },
  };
}

for (const provider of ["azure", "openai"] as const) {
  test(`the production worker requests auto summaries on the actual ${provider} Responses wire, before final text`, async () => {
    const feed = summaryStream();
    const settings = builtinSettings({
      openaiProvider: provider,
      openaiModel: "gpt-6-luna",
      openaiAllowedModels: "gpt-6-luna,gpt-4.1",
      openaiApiKey: "summary-fixture-key",
      azureOpenaiBaseUrl: "https://summary-fixture.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "summary-fixture-key",
      openaiMaxRetries: 0,
      webSearchEnabled: false,
      modelProvidersJson: "[]",
    });
    const selected = resolved(settings, "gpt-6-luna");
    const bodies: any[] = [];
    const urls: string[] = [];
    const priorFetch = globalThis.fetch;
    let client: ReturnType<typeof buildOpenAIClientFromSettings>;
    // The production client captures this local transport synchronously. No
    // model request is sent to a live provider and no global override survives.
    globalThis.fetch = (async (url, init) => {
      urls.push(String(url));
      bodies.push(JSON.parse(await requestBodyText(init?.body)));
      return new Response(feed.body, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      client = buildOpenAIClientFromSettings(settings);
    } finally {
      globalThis.fetch = priorFetch;
    }
    const model = buildModelInstance(
      selected.provider,
      client!,
      selected.configured.upstreamModelId,
    );
    const agent = await buildWorkerAgent(settings, "gpt-6-luna", model);
    const stream = await runAgentStream(agent, "Reply OK", settings);
    const visible: { type: string; payload: any }[] = [];
    const stored: SessionEvent[] = [];
    const batcher = createRuntimeBatcher(fencedPublisher(true, stored));
    try {
      let sawSummary = false;
      for await (const event of stream.toStream()) {
        for (const normalized of normalizeSdkEvent(event)) {
          visible.push(normalized);
          await batcher.push(normalized);
          if (normalized.type === "agent.reasoning.delta") {
            expect(feed.released()).toBe(false);
            expect(normalized.payload).toEqual({ text: feed.summary });
            expect(visible.some((entry) => entry.type === "agent.message.delta")).toBe(false);
            sawSummary = true;
            await batcher.flush();
            expect(await sseTimeline(stored)).toContainEqual(
              expect.objectContaining({ kind: "reasoning", text: feed.summary, streaming: true }),
            );
            expect(stored.some((entry) => entry.type === "agent.message.delta")).toBe(false);
            feed.releaseFinal();
          }
        }
      }
      await stream.completed;
      await batcher.flush();
      expect(sawSummary).toBe(true);
      expect(visible.find((event) => event.type === "agent.message.delta")?.payload.text).toBe(
        "OK",
      );
      expect(bodies).toHaveLength(1);
      expect(urls[0]).toContain("/responses");
      expect(bodies[0].model).toBe("gpt-6-luna");
      expect(bodies[0].reasoning).toEqual({ effort: "medium", summary: "auto" });
      expect(bodies[0].text).toEqual({ verbosity: "low" });
      expect(bodies[0].providerOptions).toBeUndefined();
    } finally {
      feed.releaseFinal();
      await stream.completed.catch(() => undefined);
      await batcher.flush().catch(() => undefined);
    }
  });
}
