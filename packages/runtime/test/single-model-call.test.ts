import { describe, expect, test } from "bun:test";
import type { Model, ModelRequest, ModelResponse } from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";
import type OpenAI from "openai";
import { buildAnthropicRequest } from "../src/anthropic-messages";
import {
  runSingleModelCall,
  SingleModelCallProviderError,
  SingleModelCallUnsupportedError,
  type SingleModelCallRequest,
} from "../src/single-model-call";

function provider(
  api: ResolvedModelProvider["api"],
  kind = "api-key",
  wireProfile: ResolvedModelProvider["wireProfile"] = "openai",
): ResolvedModelProvider {
  return {
    id: `test-${api}`,
    label: "Test",
    kind,
    api,
    wireProfile,
    builtin: false,
    baseUrl: "https://example.test/v1",
    apiKey: "key",
    credentialSource: { kind: "deployment", mechanism: "api_key" },
    billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
  } as ResolvedModelProvider;
}

async function* iterate<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

function fakeClient(handlers: {
  chat?: (body: Record<string, unknown>) => unknown;
  responses?: (body: Record<string, unknown>) => unknown;
}) {
  const bodies: Record<string, unknown>[] = [];
  const client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          bodies.push(body);
          return handlers.chat!(body);
        },
      },
    },
    responses: {
      create: async (body: Record<string, unknown>) => {
        bodies.push(body);
        return handlers.responses!(body);
      },
    },
  } as unknown as OpenAI;
  return { client, bodies };
}

const REQUEST: SingleModelCallRequest = {
  messages: [
    { role: "system", content: "Translate to Norwegian." },
    {
      role: "user",
      content: [
        { type: "text", text: "Hello" },
        { type: "image", url: "https://example.test/a.png", detail: "low" },
      ],
    },
    { role: "assistant", content: "Hei" },
    { role: "system", content: "Be brief." },
    { role: "user", content: "World" },
  ],
  maxOutputTokens: 64,
  temperature: 0.3,
  topP: 0.8,
  reasoningEffort: "low",
  outputFormat: {
    type: "json_schema",
    name: "translation",
    schema: { type: "object", properties: { text: { type: "string" } } },
    strict: true,
  },
};

describe("runSingleModelCall on Chat Completions", () => {
  test("sends one request with every supported parameter", async () => {
    const { client, bodies } = fakeClient({
      chat: () => ({
        choices: [{ finish_reason: "length", message: { content: '{"text":"Verden"}' } }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      }),
    });
    const result = await runSingleModelCall(
      { client, provider: provider("chat"), modelId: "upstream-model" },
      { ...REQUEST, stop: ["END"] },
    );
    expect(bodies[0]).toEqual({
      model: "upstream-model",
      messages: [
        { role: "system", content: "Translate to Norwegian." },
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            { type: "image_url", image_url: { url: "https://example.test/a.png", detail: "low" } },
          ],
        },
        { role: "assistant", content: "Hei" },
        { role: "system", content: "Be brief." },
        { role: "user", content: "World" },
      ],
      max_tokens: 64,
      temperature: 0.3,
      top_p: 0.8,
      stop: ["END"],
      reasoning_effort: "low",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "translation",
          schema: { type: "object", properties: { text: { type: "string" } } },
          strict: true,
        },
      },
    });
    expect(result.text).toBe('{"text":"Verden"}');
    expect(result.finishReason).toBe("length");
    expect(result.usage?.usage).toMatchObject({ inputTokens: 20, outputTokens: 5 });
  });

  test("streams deltas and reads usage from the final chunk", async () => {
    const { client, bodies } = fakeClient({
      chat: () =>
        iterate([
          { choices: [{ delta: { content: "Hei" } }] },
          { choices: [{ delta: { content: " verden" }, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
        ]),
    });
    const deltas: string[] = [];
    const result = await runSingleModelCall(
      { client, provider: provider("chat"), modelId: "m" },
      { messages: [{ role: "user", content: "Hello world" }] },
      { onTextDelta: (delta) => void deltas.push(delta) },
    );
    expect(bodies[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(deltas).toEqual(["Hei", " verden"]);
    expect(result).toMatchObject({ text: "Hei verden", finishReason: "stop" });
    expect(result.usage?.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
  });
});

describe("runSingleModelCall on Responses", () => {
  test("leading system messages become instructions; later ones stay in place", async () => {
    const { client, bodies } = fakeClient({
      responses: () => ({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: '{"text":"Ver' }],
          },
        ],
        usage: { input_tokens: 9, output_tokens: 64, total_tokens: 73 },
      }),
    });
    const result = await runSingleModelCall(
      { client, provider: provider("responses"), modelId: "gpt" },
      { ...REQUEST, verbosity: "low" },
    );
    expect(bodies[0]).toEqual({
      model: "gpt",
      instructions: "Translate to Norwegian.",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Hello" },
            { type: "input_image", image_url: "https://example.test/a.png", detail: "low" },
          ],
        },
        { role: "assistant", content: "Hei" },
        { role: "developer", content: "Be brief." },
        { role: "user", content: [{ type: "input_text", text: "World" }] },
      ],
      max_output_tokens: 64,
      temperature: 0.3,
      top_p: 0.8,
      reasoning: { effort: "low" },
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "translation",
          schema: { type: "object", properties: { text: { type: "string" } } },
          strict: true,
        },
      },
      store: false,
    });
    expect(result).toMatchObject({ text: '{"text":"Ver', finishReason: "length" });
  });

  test("Azure deployments omit store", async () => {
    const { client, bodies } = fakeClient({
      responses: () => ({ status: "completed", output: [] }),
    });
    await runSingleModelCall(
      { client, provider: provider("responses", "azure", "azure-openai"), modelId: "d" },
      { messages: [{ role: "user", content: "Hi" }] },
    );
    expect(bodies[0]).not.toHaveProperty("store");
  });

  test("subscription backends always stream and parse raw events", async () => {
    const { client, bodies } = fakeClient({
      responses: () =>
        iterate([
          { type: "response.created" },
          { type: "response.output_text.delta", delta: "Hei" },
          { type: "response.output_text.delta", delta: "!" },
          {
            type: "response.completed",
            response: { status: "completed", usage: { input_tokens: 4, output_tokens: 2 } },
          },
        ]),
    });
    const result = await runSingleModelCall(
      { client, provider: provider("responses", "codex-subscription"), modelId: "gpt-6-luna" },
      { messages: [{ role: "user", content: "Hi" }] },
    );
    expect(bodies[0]).toMatchObject({ stream: true });
    expect(result).toMatchObject({ text: "Hei!", finishReason: "stop" });
    expect(result.usage?.usage).toMatchObject({ inputTokens: 4, outputTokens: 2 });
  });

  test("a final-only stream still emits its text once", async () => {
    const { client } = fakeClient({
      responses: () =>
        iterate([
          {
            type: "response.completed",
            response: {
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "Ok" }],
                },
              ],
            },
          },
        ]),
    });
    const deltas: string[] = [];
    const result = await runSingleModelCall(
      { client, provider: provider("responses"), modelId: "m" },
      { messages: [{ role: "user", content: "Hi" }] },
      { onTextDelta: (delta) => void deltas.push(delta) },
    );
    expect(deltas).toEqual(["Ok"]);
    expect(result.text).toBe("Ok");
  });

  test("a failed response is a provider error", async () => {
    const { client } = fakeClient({
      responses: () =>
        iterate([{ type: "response.failed", response: { error: { message: "overloaded" } } }]),
    });
    await expect(
      runSingleModelCall(
        { client, provider: provider("responses", "codex-subscription"), modelId: "m" },
        { messages: [{ role: "user", content: "Hi" }] },
      ),
    ).rejects.toThrow(SingleModelCallProviderError);
  });

  test("stop sequences are refused before any request", async () => {
    const { client, bodies } = fakeClient({ responses: () => ({}) });
    const error = await runSingleModelCall(
      { client, provider: provider("responses"), modelId: "m" },
      { messages: [{ role: "user", content: "Hi" }], stop: ["x"] },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SingleModelCallUnsupportedError);
    expect((error as SingleModelCallUnsupportedError).parameter).toBe("stop");
    expect(bodies).toHaveLength(0);
  });
});

describe("runSingleModelCall on Agents SDK models", () => {
  function scripted(response: Partial<ModelResponse>) {
    const requests: ModelRequest[] = [];
    const model = {
      getResponse: async (request: ModelRequest) => {
        requests.push(request);
        return { output: [], usage: {}, ...response } as ModelResponse;
      },
      getStreamedResponse: async function* (request: ModelRequest) {
        requests.push(request);
        yield { type: "output_text_delta", delta: "Hei" };
        yield { type: "response_done", response: { ...response, output: [] } };
      },
    } as unknown as Model;
    return { model, requests };
  }

  test("maps the request onto a tool-free model request", async () => {
    const { model, requests } = scripted({
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hei" }],
        },
      ],
      providerData: { anthropic: { stopReason: "max_tokens" } },
    });
    const result = await runSingleModelCall({ model }, REQUEST);
    const request = requests[0]!;
    expect(request.systemInstructions).toBe("Translate to Norwegian.");
    expect(request.tools).toEqual([]);
    expect(request.toolsExplicitlyProvided).toBe(true);
    expect(request.modelSettings).toMatchObject({
      maxTokens: 64,
      temperature: 0.3,
      topP: 0.8,
      reasoning: { effort: "low" },
    });
    expect(request.outputType).toMatchObject({ type: "json_schema", name: "translation" });
    expect(result).toMatchObject({ text: "Hei", finishReason: "length" });
  });

  test("streams deltas from the model", async () => {
    const { model } = scripted({});
    const deltas: string[] = [];
    const result = await runSingleModelCall(
      { model },
      { messages: [{ role: "user", content: "Hi" }] },
      { onTextDelta: (delta) => void deltas.push(delta) },
    );
    expect(deltas).toEqual(["Hei"]);
    expect(result.text).toBe("Hei");
  });

  test("needs a non-system message", async () => {
    const { model } = scripted({});
    await expect(
      runSingleModelCall({ model }, { messages: [{ role: "system", content: "x" }] }),
    ).rejects.toThrow(SingleModelCallUnsupportedError);
  });
});

test("Claude Messages receives caller stop sequences", () => {
  const body = buildAnthropicRequest(
    {
      input: "Hi",
      modelSettings: { providerData: { stop_sequences: ["END"] } },
      tools: [],
      handoffs: [],
      outputType: "text",
      tracing: false,
    },
    "claude-haiku-5-5",
    { anthropic: { auth: "api-key", cacheTtl: "5m", maxOutputTokens: 128000 } } as never,
    false,
  );
  expect(body.stop_sequences).toEqual(["END"]);
});
