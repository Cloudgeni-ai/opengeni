import { describe, expect, test } from "bun:test";
import type { ResolvedModelProvider } from "@opengeni/config";
import type { ModelRequest } from "@openai/agents";
import { getOrCreateTrace, Usage } from "@openai/agents-core";
import { modelRequestPolicyForProvider } from "../src/model-provider-request-policy";
import { OpenGeniChatCompletionsModel } from "../src/model-provider-routing";
import { ReplayableJsonOpenAI, requestBodyText } from "../src/replayable-json-body";
import { modelResponseUsageFromResponse } from "../src/run-events";
import { normalizeModelCallUsage } from "../src/usage-telemetry";

const upstream = "anthropic/claude-sonnet-5.5";
const provider: ResolvedModelProvider = {
  id: "fixture",
  label: "Fixture",
  kind: "openrouter-workspace",
  api: "chat",
  wireProfile: "openai",
  builtin: false,
};
const baseRequest: Omit<ModelRequest, "input"> = {
  tools: [],
  handoffs: [],
  modelSettings: {},
  outputType: "text",
  tracing: false,
};

function project(body: Record<string, unknown>, selected = provider, path = "/chat/completions") {
  return modelRequestPolicyForProvider(selected)({ path, body })?.body ?? body;
}

describe("OpenRouter Anthropic automatic caching", () => {
  test("all three rails opt in without rewriting an earlier prefix or sharing a session key", () => {
    const messages = Object.freeze([
      Object.freeze({ role: "system", content: "Stable instructions" }),
      Object.freeze({ role: "user", content: "First question" }),
    ]);
    const tools = Object.freeze([
      Object.freeze({
        type: "function",
        function: { name: "lookup", parameters: { type: "object", properties: {} } },
      }),
    ]);
    const body = Object.freeze({ model: upstream, messages, tools, prompt_cache_key: "chat-a" });
    for (const kind of [
      "openrouter-managed",
      "openrouter-workspace",
      "openrouter-organization",
    ] as const) {
      const selected = { ...provider, kind };
      const first = project(body, selected, "/chat/completions?fixture=1");
      expect(first.cache_control).toEqual({ type: "ephemeral" });
      expect(first.messages).toBe(messages);
      expect(first.tools).toBe(tools);
      expect(first.prompt_cache_key).toBe("chat-a");
      expect(project(first, selected)).toBe(first);
      const nextMessages = [
        ...messages,
        { role: "assistant", content: "Result" },
        { role: "user", content: "Next turn" },
      ];
      const next = project({ ...body, messages: nextMessages }, selected);
      expect(next.messages).toBe(nextMessages);
      expect(JSON.stringify((next.messages as unknown[]).slice(0, 2))).toBe(
        JSON.stringify(first.messages),
      );
      expect(next.tools).toBe(first.tools);
      expect(next.cache_control).toEqual(first.cache_control);
      expect(project({ ...body, prompt_cache_key: "chat-b" }, selected).prompt_cache_key).toBe(
        "chat-b",
      );
    }
    expect(body).not.toHaveProperty("cache_control");
  });

  test("preserves caller-owned controls, including all four breakpoints and null", () => {
    for (const cache_control of [null, { type: "ephemeral" }, { type: "ephemeral", ttl: "1h" }]) {
      const body = { model: upstream, messages: [], cache_control };
      expect(project(body)).toBe(body);
    }
    for (const marker of ["cache_control", "prompt_cache_breakpoint"]) {
      const messages = Array.from({ length: 4 }, () => ({
        role: "user",
        content: [{ type: "text", text: "Reference", [marker]: { type: "ephemeral" } }],
      }));
      const body = { model: upstream, messages };
      expect(project(body)).toBe(body);
    }
    const tools = [
      { type: "function", function: { name: "lookup" }, cache_control: { type: "ephemeral" } },
    ];
    const body = { model: upstream, messages: [], tools };
    expect(project(body)).toBe(body);
    // A schema property is data, not a cache breakpoint.
    expect(
      project({
        ...body,
        tools: [
          {
            type: "function",
            function: { parameters: { properties: { cache_control: { type: "string" } } } },
          },
        ],
      }).cache_control,
    ).toEqual({ type: "ephemeral" });
  });

  test("does not change other provider/model/API routes", () => {
    const body = { model: upstream, messages: [{ role: "user", content: "Hello" }] };
    expect(project(body, { ...provider, kind: "api-key" })).not.toHaveProperty("cache_control");
    expect(project(body, provider, "/responses")).not.toHaveProperty("cache_control");
    for (const model of [
      "openai/gpt-5",
      "google/gemini-2.5-pro",
      "auto",
      "qwen/qwen3-coder-plus",
    ]) {
      expect(project({ ...body, model })).not.toHaveProperty("cache_control");
    }
  });
});

function fixtureClient(
  stream: boolean,
  details: Record<string, unknown> | undefined,
  seen: unknown[],
) {
  const usage = {
    prompt_tokens: 5200,
    completion_tokens: 4,
    total_tokens: 5204,
    ...(details ? { prompt_tokens_details: details } : {}),
    completion_tokens_details: { reasoning_tokens: 2 },
  };
  const common = { id: "chatcmpl-cache", model: upstream, created: 1 };
  return new ReplayableJsonOpenAI(
    {
      apiKey: "fixture",
      baseURL: "https://openrouter.invalid/api/v1",
      maxRetries: 0,
      fetch: async (_input, init) => {
        seen.push(JSON.parse((await requestBodyText(init?.body))!));
        if (!stream)
          return Response.json({
            ...common,
            object: "chat.completion",
            usage,
            choices: [
              { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
            ],
          });
        const chunks = [
          {
            ...common,
            choices: [
              { index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null },
            ],
          },
          { ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { ...common, choices: [], usage },
          // Cumulative usage snapshots are replacements, never additive. A later
          // no-usage chunk must not erase the last provider snapshot.
          { ...common, choices: [], usage },
          { ...common, choices: [], usage: null },
        ];
        return new Response(
          chunks
            .map(
              (chunk) =>
                `data: ${JSON.stringify({ ...chunk, object: "chat.completion.chunk" })}\n\n`,
            )
            .join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    },
    { modelRequestPolicy: modelRequestPolicyForProvider(provider) },
  );
}

describe("Chat cache usage survives SDK conversion", () => {
  for (const stream of [false, true]) {
    test(`${stream ? "streamed" : "non-streamed"} reads and writes reach model usage and run aggregation`, async () => {
      const seen: any[] = [];
      const model = new OpenGeniChatCompletionsModel(
        fixtureClient(
          stream,
          {
            cached_tokens: 5175,
            cache_write_tokens: 17,
            audio_tokens: 0,
          },
          seen,
        ),
        upstream,
      );
      const request = { ...baseRequest, input: "Hello" };
      let response: any;
      if (stream) {
        for await (const event of model.getStreamedResponse(request)) {
          if (event.type === "response_done") response = event.response;
        }
      } else response = await getOrCreateTrace(() => model.getResponse(request));
      expect(seen[0].cache_control).toEqual({ type: "ephemeral" });
      expect(seen[0].messages).toEqual([{ role: "user", content: "Hello" }]);
      const usage = modelResponseUsageFromResponse(response)!.usage;
      expect(normalizeModelCallUsage(usage).telemetry).toEqual({
        inputTokens: 5200,
        outputTokens: 4,
        cachedTokens: 5175,
        cacheWriteTokens: 17,
        reasoningTokens: 2,
      });
      const aggregate = new Usage();
      aggregate.add(new Usage(usage));
      aggregate.add(new Usage(usage));
      const normalized = normalizeModelCallUsage(aggregate);
      expect(normalized.telemetry.cachedTokens).toBe(10350);
      expect(normalized.telemetry.cacheWriteTokens).toBe(34);
      expect(
        normalized.requestUsageEntries?.map(
          (entry) => entry.inputTokensDetails?.cache_write_tokens,
        ),
      ).toEqual([17, 17]);
    });

    test(`${stream ? "streamed" : "non-streamed"} missing writes stay unknown and invalid counts reach validation`, async () => {
      for (const details of [
        undefined,
        { cached_tokens: 0 },
        { cached_tokens: 0, cache_write_tokens: -1 },
      ]) {
        const model = new OpenGeniChatCompletionsModel(
          fixtureClient(stream, details, []),
          upstream,
        );
        let response: any;
        if (stream) {
          for await (const event of model.getStreamedResponse({ ...baseRequest, input: "Hello" })) {
            if (event.type === "response_done") response = event.response;
          }
        } else
          response = await getOrCreateTrace(() =>
            model.getResponse({ ...baseRequest, input: "Hello" }),
          );
        const normalized = normalizeModelCallUsage(modelResponseUsageFromResponse(response)!.usage);
        expect(normalized.telemetry.cacheWriteTokens).toBeNull();
        if (details?.cache_write_tokens === -1)
          expect(normalized.rejectedFields.length).toBeGreaterThan(0);
      }
    });
  }
});
