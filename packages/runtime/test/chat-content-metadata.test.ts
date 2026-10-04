import { describe, expect, test } from "bun:test";
import { OpenAIChatCompletionsModel } from "@openai/agents";
import { getOrCreateTrace } from "@openai/agents-core";
import type { ResolvedModelProvider } from "@opengeni/config";
import {
  chatModelRequestPolicy,
  modelRequestPolicyForProvider,
} from "../src/model-provider-request-policy";
import { ReplayableJsonOpenAI, requestBodyText } from "../src/replayable-json-body";

const provider: ResolvedModelProvider = {
  id: "fixture",
  label: "Fixture",
  kind: "api-key",
  api: "chat",
  builtin: false,
};

describe("Chat assistant content projection", () => {
  test("keeps refusal text while removing misplaced response message metadata", () => {
    const result = chatModelRequestPolicy({
      path: "/chat/completions",
      body: {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "refusal",
                refusal: "Cannot assist",
                role: "assistant",
                content: null,
                annotations: [],
              },
            ],
          },
        ],
      },
    });
    expect(result?.body?.messages).toEqual([
      { role: "assistant", content: [{ type: "refusal", refusal: "Cannot assist" }] },
    ]);
  });
  test("keeps canonical history, input images, tools and cache extensions intact", () => {
    const body = {
      model: "fixture-model",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Earlier answer",
              annotations: [],
              logprobs: [],
              cache_control: { type: "ephemeral" },
            },
          ],
          tool_calls: [
            { id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: "Found" },
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect this" },
            { type: "image_url", image_url: { url: "https://example.com/image.png" } },
          ],
        },
      ],
    };
    const before = structuredClone(body);
    const result = chatModelRequestPolicy({ path: "/chat/completions?version=test", body })!;
    const messages = result.body!.messages as typeof body.messages;
    expect(messages[0]!.content).toEqual([
      { type: "text", text: "Earlier answer", cache_control: { type: "ephemeral" } },
    ]);
    expect(messages[0]!.tool_calls).toBe(body.messages[0]!.tool_calls);
    expect(messages[1]).toBe(body.messages[1]);
    expect(messages[2]).toBe(body.messages[2]);
    expect(body).toEqual(before);
    expect(chatModelRequestPolicy({ path: "/responses", body })).toBeUndefined();
    expect(
      chatModelRequestPolicy({ path: "/chat/completions", body: result.body! }),
    ).toBeUndefined();
  });

  test("composes the projection with Gateway routing", () => {
    const policy = modelRequestPolicyForProvider(
      { ...provider, kind: "vercel-gateway-managed" },
      new Map([["fixture-model", undefined]]),
    );
    const result = policy({
      path: "/chat/completions",
      body: {
        model: "fixture-model",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Earlier answer", annotations: [] }],
          },
        ],
      },
    })!;
    expect(result.body!.messages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Earlier answer" }] },
    ]);
    expect(result.headers).toHaveProperty("x-opengeni-gateway-request-body-normalized", "1");
  });

  test("replays streamed and nonstreamed SDK replies before an image follow-up", async () => {
    const requests: Record<string, any>[] = [];
    const client = new ReplayableJsonOpenAI(
      {
        apiKey: "fixture-key",
        baseURL: "https://example.com/v1",
        maxRetries: 0,
        fetch: async (_input, init) => {
          const body = JSON.parse(await requestBodyText(init?.body));
          requests.push(body);
          for (const message of body.messages) {
            if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
            for (const part of message.content) {
              expect(Object.keys(part).sort()).toEqual(["text", "type"]);
            }
          }
          if (body.stream) {
            return new Response(
              [
                {
                  id: "reply-stream",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "fixture-model",
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant", content: "Synthetic answer" },
                      finish_reason: null,
                    },
                  ],
                },
                {
                  id: "reply-stream",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "fixture-model",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                },
              ]
                .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
                .join("") + "data: [DONE]\n\n",
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          return Response.json({
            id: "reply-sync",
            object: "chat.completion",
            created: 1,
            model: "fixture-model",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "Second answer",
                  refusal: null,
                  reasoning: "Synthetic summary",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          });
        },
      },
      { modelRequestPolicy: modelRequestPolicyForProvider(provider) },
    );
    const model = new OpenAIChatCompletionsModel(client, "fixture-model");
    const base = {
      modelSettings: {},
      tools: [],
      handoffs: [],
      outputType: "text",
      tracing: false,
    } as const;
    let output: unknown[] = [];
    for await (const event of model.getStreamedResponse({ ...base, input: "Hello" } as never)) {
      if (event.type === "response_done") output = event.response.output;
    }
    expect(output).toHaveLength(1);
    const retained = structuredClone(output);
    const input = [
      { role: "user", content: "Hello" },
      ...output,
      {
        role: "user",
        content: [
          { type: "input_text", text: "Inspect this" },
          { type: "input_image", image: "https://example.com/image.png", detail: "auto" },
        ],
      },
    ];
    const second = await getOrCreateTrace(() => model.getResponse({ ...base, input } as never));
    for await (const _event of model.getStreamedResponse({
      ...base,
      input: [...input, ...second.output, { role: "user", content: "Continue" }],
    } as never)) {
    }
    expect(output).toEqual(retained);
    expect(requests).toHaveLength(3);
    expect(
      requests[2]!.messages.some((message: any) => message.reasoning === "Synthetic summary"),
    ).toBe(true);
    expect(requests[1]!.messages.at(-1).content).toContainEqual({
      type: "image_url",
      image_url: { url: "https://example.com/image.png", detail: "auto" },
    });
  });
});
