import { describe, expect, test } from "bun:test";
import { type Permission, signDelegatedAccessToken } from "@opengeni/contracts";
import {
  ModelCallError,
  type ModelCallInput,
  type ModelCallOutput,
  type ModelCallService,
} from "@opengeni/core";
import { testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";

const SECRET = "chat-completions-route-secret";
const WORKSPACE = "00000000-0000-4000-8000-000000000011";
const ACCOUNT = "00000000-0000-4000-8000-000000000012";
const URL = `/v1/workspaces/${WORKSPACE}/chat/completions`;

const OUTPUT: ModelCallOutput = {
  model: "codex/gpt-6-luna",
  result: {
    text: "Hei verden",
    finishReason: "stop",
    usage: {
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        inputTokensDetails: { cached_tokens: 4 },
        outputTokensDetails: { reasoning_tokens: 1 },
      },
    },
  },
};

type Behavior = (input: ModelCallInput) => Promise<ModelCallOutput>;

function fakeService(behavior: Behavior = async () => OUTPUT) {
  const calls: ModelCallInput[] = [];
  const service: ModelCallService = {
    listModels: async () => [
      { id: "codex/gpt-6-luna", label: "GPT-6 Luna", providerLabel: "ChatGPT subscription" },
    ],
    call: async (input) => {
      calls.push(input);
      return await behavior(input);
    },
  };
  return { service, calls };
}

function app(service: ModelCallService | null) {
  return createApp({
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: SECRET,
      voiceInputProviderOrder: "",
    }),
    db: {} as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    transcription: null,
    modelCalls: service,
  });
}

async function bearer(permissions: Permission[] = ["sessions:create"]): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: ACCOUNT,
    workspaceId: WORKSPACE,
    subjectId: "tester",
    permissions,
    principalKind: "service",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
}

async function post(service: ModelCallService | null, body: unknown, permissions?: Permission[]) {
  return await app(service).request(URL, {
    method: "POST",
    headers: { authorization: await bearer(permissions), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const MESSAGES = [{ role: "user", content: "Translate to Norwegian: Hello world" }];

describe("chat completions route", () => {
  test("requires authentication and session-create access", async () => {
    const { service } = fakeService();
    const anonymous = await app(service).request(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x", messages: MESSAGES }),
    });
    expect(anonymous.status).toBe(401);
    const readOnly = await post(service, { model: "x", messages: MESSAGES }, ["sessions:read"]);
    expect(readOnly.status).toBe(403);
  });

  test("maps an OpenAI request onto one single model call", async () => {
    const { service, calls } = fakeService();
    const response = await post(service, {
      model: "codex/gpt-6-luna",
      messages: [
        { role: "developer", content: "Be brief." },
        { role: "system", content: [{ type: "text", text: "Answer in Norwegian." }] },
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "low" } },
          ],
        },
        { role: "assistant", content: null },
        { role: "user", content: "Thanks" },
      ],
      max_tokens: 100,
      max_completion_tokens: 50,
      temperature: 0.2,
      top_p: 0.9,
      stop: "END",
      reasoning_effort: "low",
      response_format: {
        type: "json_schema",
        json_schema: { name: "answer", schema: { type: "object" }, strict: true },
      },
      user: "ignored",
      seed: 1,
      parallel_tool_calls: true,
      store: false,
      n: 1,
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.model).toBe("codex/gpt-6-luna");
    expect(call.accountId).toBe(ACCOUNT);
    expect(call.workspaceId).toBe(WORKSPACE);
    expect(call.subjectId).toBe("tester");
    expect(call.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.request).toEqual({
      messages: [
        { role: "system", content: "Be brief." },
        { role: "system", content: "Answer in Norwegian." },
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image", url: "data:image/png;base64,AAAA", detail: "low" },
          ],
        },
        { role: "assistant", content: "" },
        { role: "user", content: "Thanks" },
      ],
      maxOutputTokens: 50,
      temperature: 0.2,
      topP: 0.9,
      stop: ["END"],
      reasoningEffort: "low",
      outputFormat: {
        type: "json_schema",
        name: "answer",
        schema: { type: "object" },
        strict: true,
      },
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      object: "chat.completion",
      model: "codex/gpt-6-luna",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hei verden", refusal: null },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    });
    expect(String(body.id)).toMatch(/^chatcmpl-[0-9a-f]{32}$/);
    expect(typeof body.created).toBe("number");
  });

  test("omitted model selects the workspace default", async () => {
    const { service, calls } = fakeService();
    expect((await post(service, { messages: MESSAGES })).status).toBe(200);
    expect(calls[0]!.model).toBeNull();
  });

  test.each([
    [{ tools: [{ type: "function", function: { name: "f" } }] }, "tools"],
    [{ tool_choice: "auto" }, "tool_choice"],
    [{ functions: [{ name: "f" }] }, "functions"],
    [{ web_search_options: { search_context_size: "low" } }, "web_search_options"],
    [{ audio: { voice: "alloy", format: "mp3" } }, "audio"],
    [{ logprobs: true }, "logprobs"],
    [{ n: 2 }, "n"],
    [{ store: true }, "store"],
    [{ frequency_penalty: 0.5 }, "frequency_penalty"],
    [{ modalities: ["text", "audio"] }, "modalities"],
    [{ response_format: { type: "json_object" } }, "response_format"],
  ])("refuses agentic or unsupported parameter %#", async (extra, param) => {
    const { service, calls } = fakeService();
    const response = await post(service, { model: "m", messages: MESSAGES, ...extra });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: "invalid_request_error", code: "unsupported_parameter", param },
    });
    expect(calls).toHaveLength(0);
  });

  test("refuses tool messages and non-text content", async () => {
    const { service } = fakeService();
    const tool = await post(service, {
      model: "m",
      messages: [...MESSAGES, { role: "tool", content: "x", tool_call_id: "1" }],
    });
    expect(await tool.json()).toMatchObject({ error: { param: "messages[1].role" } });
    const audio = await post(service, {
      model: "m",
      messages: [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }],
    });
    expect(audio.status).toBe(400);
    expect(await audio.json()).toMatchObject({
      error: { code: "unsupported_content", param: "messages[0].content[0]" },
    });
  });

  test("validates the request shape with OpenAI-style errors", async () => {
    const { service } = fakeService();
    const empty = await post(service, { model: "m", messages: [] });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({
      error: { type: "invalid_request_error", param: "messages" },
    });
    const systemOnly = await post(service, {
      model: "m",
      messages: [{ role: "system", content: "x" }],
    });
    expect(await systemOnly.json()).toMatchObject({ error: { param: "messages" } });
    const schema = await post(service, {
      model: "m",
      messages: MESSAGES,
      response_format: { type: "json_schema", json_schema: { name: "bad name!" } },
    });
    expect(schema.status).toBe(400);
    expect(await schema.json()).toMatchObject({
      error: { param: "response_format.json_schema.name" },
    });
    const temperature = await post(service, { model: "m", messages: MESSAGES, temperature: 3 });
    expect(await temperature.json()).toMatchObject({ error: { param: "temperature" } });
  });

  test("returns service refusals with their status and type", async () => {
    const { service } = fakeService(async () => {
      throw new ModelCallError({
        status: 402,
        type: "insufficient_quota",
        code: "insufficient_credits",
        message: "Insufficient Opengeni credits.",
      });
    });
    const response = await post(service, { model: "m", messages: MESSAGES });
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({
      error: {
        message: "Insufficient Opengeni credits.",
        type: "insufficient_quota",
        param: null,
        code: "insufficient_credits",
      },
    });
  });

  test("hides unexpected failures", async () => {
    const { service } = fakeService(async () => {
      throw new Error("database password=hunter2");
    });
    const response = await post(service, { model: "m", messages: MESSAGES });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("hunter2");
  });

  test("streams chunks, usage and the done marker", async () => {
    const { service } = fakeService(async (input) => {
      await input.onTextDelta?.("Hei");
      await input.onTextDelta?.(" verden");
      return OUTPUT;
    });
    const response = await post(service, {
      model: "codex/gpt-6-luna",
      messages: MESSAGES,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = (await response.text())
      .split("\n\n")
      .filter(Boolean)
      .map((event) => event.replace(/^data: /, ""));
    expect(events.at(-1)).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((event) => JSON.parse(event));
    expect(chunks.map((chunk) => chunk.choices[0]?.delta)).toEqual([
      { role: "assistant", content: "" },
      { content: "Hei" },
      { content: " verden" },
      {},
      undefined,
    ]);
    expect(chunks[3].choices[0].finish_reason).toBe("stop");
    expect(chunks[3].usage).toBeNull();
    expect(chunks[4]).toMatchObject({
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    });
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1);
  });

  test("a streamed call refused before any output is a plain JSON error", async () => {
    const { service } = fakeService(async () => {
      throw new ModelCallError({
        status: 404,
        type: "not_found_error",
        code: "model_not_found",
        param: "model",
        message: "missing",
      });
    });
    const response = await post(service, { model: "nope", messages: MESSAGES, stream: true });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "model_not_found" } });
  });

  test("a failure after output is reported in-band", async () => {
    const { service } = fakeService(async (input) => {
      await input.onTextDelta?.("partial");
      throw new ModelCallError({
        status: 502,
        type: "api_error",
        code: "provider_error",
        message: "The model request failed.",
      });
    });
    const response = await post(service, { model: "m", messages: MESSAGES, stream: true });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"content":"partial"');
    expect(text).toContain('"code":"provider_error"');
    expect(text).not.toContain("[DONE]");
  });

  test("lists workspace models in OpenAI format", async () => {
    const { service } = fakeService();
    const response = await app(service).request(`/v1/workspaces/${WORKSPACE}/models`, {
      headers: { authorization: await bearer() },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: "list",
      data: [
        {
          id: "codex/gpt-6-luna",
          object: "model",
          created: 0,
          owned_by: "ChatGPT subscription",
          name: "GPT-6 Luna",
        },
      ],
    });
  });

  test("reports an unavailable deployment", async () => {
    const response = await post(null, { model: "m", messages: MESSAGES });
    expect(response.status).toBe(503);
  });
});
