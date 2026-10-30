import { describe, expect, test } from "bun:test";
import { Runner, tool as defineTool } from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";
import { testSettings } from "@opengeni/testing/settings";
import { z } from "zod";
import {
  buildOpenAIClientFromSettings,
  buildOpenGeniAgent,
  modelRequestPolicyForProvider,
  OpenGeniResponsesModel,
} from "../src/index";
import { callModelInputFilterForSettings } from "../src/model-input";
import { storelessResponsesBody } from "../src/model-provider-request-policy";
import { ReplayableJsonOpenAI, requestBodyText } from "../src/replayable-json-body";

/**
 * Opengeni rebuilds every request from its own history, so the provider never
 * needs to keep response objects. Responses `store` defaults to true (30 days
 * of stored responses), so main agent turns must say `store: false` on Azure
 * OpenAI and the OpenAI platform. Azure accepted it live on 30 October 2026,
 * including encrypted reasoning round trips without provider item ids.
 */

function provider(overrides: Partial<ResolvedModelProvider>): ResolvedModelProvider {
  return {
    id: "fixture",
    label: "Fixture",
    kind: "api-key",
    api: "responses",
    wireProfile: "openai",
    builtin: false,
    baseUrl: "https://fixture.example/v1",
    apiKey: "fixture",
    ...overrides,
  } as ResolvedModelProvider;
}

const AZURE = provider({
  id: "azure-sol",
  wireProfile: "azure-openai",
  baseUrl: "https://example.openai.azure.com/openai/v1",
});

/** Runs a real two-step agent turn (tool call, then answer) and returns each request body. */
async function agentTurnBodies(selected: ResolvedModelProvider): Promise<Record<string, any>[]> {
  const bodies: Record<string, any>[] = [];
  const client = new ReplayableJsonOpenAI(
    {
      apiKey: "fixture",
      baseURL: selected.baseUrl ?? "https://fixture.example/v1",
      maxRetries: 0,
      fetch: (async (_url, init) => {
        bodies.push(JSON.parse(await requestBodyText(init?.body)));
        const output =
          bodies.length === 1
            ? [
                {
                  id: "rs_1",
                  type: "reasoning",
                  summary: [],
                  encrypted_content: "opaque-reasoning",
                },
                {
                  id: "fc_1",
                  type: "function_call",
                  status: "completed",
                  call_id: "call_1",
                  name: "get_time",
                  arguments: "{}",
                },
              ]
            : [
                {
                  id: "msg_1",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "Noon.", annotations: [] }],
                },
              ];
        return Response.json({
          id: `resp_${bodies.length}`,
          object: "response",
          status: "completed",
          output,
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        });
      }) as typeof fetch,
    },
    { modelRequestPolicy: modelRequestPolicyForProvider(selected) },
  );
  const settings = testSettings({ sandboxBackend: "none" });
  const getTime = defineTool({
    name: "get_time",
    description: "Current time",
    parameters: z.object({}),
    execute: async () => "12:00 UTC",
  });
  const agent = buildOpenGeniAgent(settings, [], {
    model: new OpenGeniResponsesModel(client, "fixture-model", selected),
    reasoningEffort: "medium",
    encryptedReasoning: true,
  });
  agent.tools.push(getTime);
  await new Runner({ tracingDisabled: true }).run(agent, "What time is it?", {
    maxTurns: 3,
    callModelInputFilter: callModelInputFilterForSettings(settings),
  });
  return bodies;
}

describe("storeless Responses requests", () => {
  test("a main Azure OpenAI agent turn sends store:false on every request", async () => {
    const bodies = await agentTurnBodies(AZURE);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body.store).toBe(false);
    // Nothing points at a stored response: no chaining and no provider item ids,
    // while the encrypted reasoning travels inline.
    const second = bodies[1]!;
    expect(second.previous_response_id).toBeUndefined();
    expect(second.input.some((item: any) => typeof item.id === "string")).toBe(false);
    expect(JSON.stringify(second.input)).toContain("opaque-reasoning");
    expect(second.include).toContain("reasoning.encrypted_content");
  });

  test.each([
    ["a workspace OpenAI key", provider({ kind: "direct-openai-workspace" }), false],
    ["an organization OpenAI key", provider({ kind: "direct-openai-organization" }), false],
    ["the built-in OpenAI provider", provider({ builtin: true, baseUrl: undefined }), false],
    [
      "the built-in provider on an OpenAI-compatible server",
      provider({ builtin: true, baseUrl: "http://vllm.internal:8000/v1" }),
      undefined,
    ],
    ["an operator's compatible Responses server", provider({}), undefined],
    [
      "a workspace's own compatible server",
      provider({ kind: "direct-compatible-workspace" }),
      undefined,
    ],
  ] as const)("a main turn on %s", async (_name, selected, store) => {
    const bodies = await agentTurnBodies(selected);
    for (const body of bodies) expect(body.store).toBe(store);
  });

  test("leaves requests that use or chose provider storage alone", () => {
    const input = [{ type: "message", role: "user", content: "Hi" }];
    expect(storelessResponsesBody("/responses", { model: "m", input })).toEqual({
      model: "m",
      input,
      store: false,
    });
    expect(storelessResponsesBody("/responses?api-version=x", { input })?.store).toBe(false);
    // The Agents SDK spells an unset modelSettings.store as an undefined key.
    expect(storelessResponsesBody("/responses", { input, store: undefined })?.store).toBe(false);
    // The caller decided.
    expect(storelessResponsesBody("/responses", { input, store: true })).toBeNull();
    // Chained or conversation state lives at the provider.
    expect(
      storelessResponsesBody("/responses", { input, previous_response_id: "resp_1" }),
    ).toBeNull();
    expect(storelessResponsesBody("/responses", { input, conversation: "conv_1" })).toBeNull();
    // Preserved provider item ids may reference stored items.
    expect(
      storelessResponsesBody("/responses", {
        input: [{ id: "msg_1", type: "message", role: "assistant", content: [] }],
      }),
    ).toBeNull();
    // Not a Responses create request.
    expect(storelessResponsesBody("/chat/completions", { messages: [] })).toBeNull();
    expect(storelessResponsesBody("/responses/resp_1", {})).toBeNull();
  });

  test("the built-in Azure and OpenAI clients are storeless on Responses", async () => {
    for (const settings of [
      testSettings({
        openaiProvider: "azure",
        azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
        azureOpenaiApiKey: "fixture",
      }),
      testSettings({ openaiProvider: "openai", openaiApiKey: "fixture" }),
    ]) {
      const bodies: Record<string, any>[] = [];
      const original = globalThis.fetch;
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(await requestBodyText(init?.body)));
        return Response.json({
          id: "resp_1",
          object: "response",
          status: "completed",
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }) as typeof fetch;
      try {
        const client = buildOpenAIClientFromSettings(settings);
        await client.responses.create({ model: "m", input: "Hi" });
      } finally {
        globalThis.fetch = original;
      }
      expect(bodies).toHaveLength(1);
      expect(bodies[0]!.store).toBe(false);
    }
  });
});
