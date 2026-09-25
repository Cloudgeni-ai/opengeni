import { afterEach, describe, expect, test } from "bun:test";
import type { ResolvedModelProvider } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";

import {
  generateSessionTitle,
  SESSION_TITLE_GENERATION_INSTRUCTIONS,
  SESSION_TITLE_GENERATION_MAX_OUTPUT_TOKENS,
} from "../src/index";
import { buildProviderClient } from "../src/model-provider-client";
import { buildModelInstance } from "../src/model-provider-routing";

type CapturedRequest = { path: string; body: Record<string, unknown> };

const servers: Array<{ stop: (force?: boolean) => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function providerServer(respond: (request: CapturedRequest) => Response) {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const captured = {
        path: new URL(request.url).pathname,
        body: (await request.json()) as Record<string, unknown>,
      };
      requests.push(captured);
      return respond(captured);
    },
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, requests };
}

function provider(
  baseUrl: string,
  overrides: Partial<ResolvedModelProvider> & Pick<ResolvedModelProvider, "api">,
): ResolvedModelProvider {
  return {
    id: overrides.api === "chat" ? "openrouter" : "title-responses",
    label: "Title test provider",
    kind: overrides.api === "chat" ? "openrouter-managed" : "openai",
    wireProfile: "openai",
    builtin: false,
    baseUrl,
    apiKey: "test-provider-key",
    credentialSource: { kind: "deployment_env" },
    billing: { kind: "credits" },
    ...overrides,
  } as ResolvedModelProvider;
}

function chatCompletion(content: string | null, finishReason: string) {
  return Response.json({
    id: "gen-title-1",
    object: "chat.completion",
    model: "nvidia/nemotron-3-super-120b-a12b:free",
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        message: { role: "assistant", content, reasoning: "Brief planning." },
      },
    ],
    usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
  });
}

async function generateThroughResolvedChatModel(
  respond: (request: CapturedRequest) => Response,
  options: { reasoningEffort?: "low" } = {},
) {
  const upstream = providerServer(respond);
  const settings = testSettings({ sandboxBackend: "none" });
  const resolved = provider(upstream.baseUrl, { api: "chat" });
  const modelName = "nvidia/nemotron-3-super-120b-a12b:free";
  const client = buildProviderClient(resolved, settings);
  const result = await generateSessionTitle(
    settings,
    "My pod keeps crashing in Kubernetes, can you help me debug it?",
    {
      client,
      provider: resolved,
      model: buildModelInstance(resolved, client, modelName),
      modelName,
      ...options,
    },
  );
  return { result, requests: upstream.requests };
}

describe("session title generation", () => {
  test("a chat-completions provider generates a title outside an agent trace", async () => {
    const { result, requests } = await generateThroughResolvedChatModel(
      () => chatCompletion("Kubernetes Pod Crash Debugging", "stop"),
      { reasoningEffort: "low" },
    );

    expect(result.title).toBe("Kubernetes Pod Crash Debugging");
    expect(result.usage?.usage.inputTokens).toBe(40);
    expect(result.usage?.usage.outputTokens).toBe(12);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toBe("/v1/chat/completions");
    expect(requests[0]!.body).toMatchObject({
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      max_tokens: SESSION_TITLE_GENERATION_MAX_OUTPUT_TOKENS,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: SESSION_TITLE_GENERATION_INSTRUCTIONS },
        {
          role: "user",
          content: "My pod keeps crashing in Kubernetes, can you help me debug it?",
        },
      ],
    });
    expect(requests[0]!.body.tools).toBeUndefined();
    expect(requests[0]!.body.stream).not.toBe(true);
  });

  test("a chat title request omits reasoning effort when none is supplied", async () => {
    const { requests } = await generateThroughResolvedChatModel(() =>
      chatCompletion("Kubernetes Pod Crash Debugging", "stop"),
    );

    expect(requests[0]!.body.reasoning_effort).toBeUndefined();
  });

  test("a title cut off by the output cap keeps only whole words", async () => {
    const { result } = await generateThroughResolvedChatModel(() =>
      chatCompletion("Kubernetes Pod Crash Debugg", "length"),
    );

    expect(result.title).toBe("Kubernetes Pod Crash");
  });

  test("a capped response with only reasoning yields no title", async () => {
    const { result } = await generateThroughResolvedChatModel(() => chatCompletion(null, "length"));

    expect(result.title).toBeNull();
    expect(result.usage?.usage.outputTokens).toBe(12);
  });

  test("a completed chat title keeps its final word", async () => {
    const { result } = await generateThroughResolvedChatModel(() =>
      chatCompletion("Kubernetes Pod Crash Debugging", "stop"),
    );

    expect(result.title).toBe("Kubernetes Pod Crash Debugging");
  });

  test("a Responses title request sends the reasoning effort and trims an incomplete title", async () => {
    const upstream = providerServer(() =>
      Response.json({
        id: "resp-title-incomplete",
        object: "response",
        created_at: 1,
        model: "title-reasoning-model",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            id: "msg-title",
            type: "message",
            role: "assistant",
            status: "incomplete",
            content: [
              { type: "output_text", text: "Kubernetes Pod Crash Debugg", annotations: [] },
            ],
          },
        ],
        usage: {
          input_tokens: 40,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: SESSION_TITLE_GENERATION_MAX_OUTPUT_TOKENS,
          output_tokens_details: { reasoning_tokens: 500 },
          total_tokens: 40 + SESSION_TITLE_GENERATION_MAX_OUTPUT_TOKENS,
        },
      }),
    );
    const settings = testSettings({ sandboxBackend: "none" });
    const resolved = provider(upstream.baseUrl, { api: "responses" });
    const client = buildProviderClient(resolved, settings);

    const result = await generateSessionTitle(settings, "Debug my crashing Kubernetes pod", {
      client,
      provider: resolved,
      model: buildModelInstance(resolved, client, "title-reasoning-model"),
      modelName: "title-reasoning-model",
      reasoningEffort: "low",
    });

    expect(result.title).toBe("Kubernetes Pod Crash");
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]!.path).toBe("/v1/responses");
    expect(upstream.requests[0]!.body).toMatchObject({
      max_output_tokens: SESSION_TITLE_GENERATION_MAX_OUTPUT_TOKENS,
      reasoning: { effort: "low" },
    });
  });
});
