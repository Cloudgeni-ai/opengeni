import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "@openai/agents";
import { getOrCreateTrace } from "@openai/agents-core";
import type { ResolvedModelProvider } from "@opengeni/config";
import { AnthropicMessagesModel } from "../src/anthropic-messages";
import {
  OpenGeniChatCompletionsModel,
  OpenGeniResponsesModel,
} from "../src/model-provider-routing";
import { modelRequestPolicyForProvider } from "../src/model-provider-request-policy";
import { ReplayableJsonOpenAI, requestBodyText } from "../src/replayable-json-body";

// The one tool-name format every provider and gateway accepts.
const PORTABLE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
// References are assembled so no tool on the way resolves them.
const ref = (path: string) => `\u007B\u007Bsecret:${path}}}`;

const KNOWN = "server__lookup";
// History tool names no provider accepts, as stored by older code, an agent
// or a connector: each must reach every wire valid, and distinct names must
// stay distinct.
const HOSTILE = [
  "server.lookup",
  "server/lookup/v2",
  "ns:tool",
  "has space",
  "ünïcode_tööl",
  `long_${"x".repeat(80)}`,
  "dup.name",
  "dup:name",
  `server__${ref("Vault/db/password")}`,
];

const definition = (name: string) => ({
  type: "function" as const,
  name,
  description: `The ${name} tool`,
  parameters: { type: "object", properties: {}, additionalProperties: false },
  strict: false,
});

/** A user message, then a completed call and result for every hostile name. */
function history(withToolSearch: boolean): ModelRequest["input"] {
  const items: Array<Record<string, unknown>> = [
    { type: "message", role: "user", content: "Use the tools" },
  ];
  if (withToolSearch) {
    items.push(
      {
        type: "tool_search_call",
        call_id: "search",
        execution: "client",
        status: "completed",
        arguments: { query: "lookup" },
      },
      {
        type: "tool_search_output",
        call_id: "search",
        execution: "client",
        status: "completed",
        tools: HOSTILE.map(definition),
      },
    );
  }
  HOSTILE.forEach((name, index) => {
    items.push(
      {
        type: "function_call",
        callId: `call_${index}`,
        name,
        arguments: "{}",
        status: "completed",
      },
      {
        type: "function_call_result",
        callId: `call_${index}`,
        name,
        status: "completed",
        output: "done",
      },
    );
  });
  items.push({ type: "message", role: "user", content: "Continue" });
  return items as ModelRequest["input"];
}

function request(input: ModelRequest["input"]): ModelRequest {
  return {
    input,
    modelSettings: {},
    tools: [definition(KNOWN)],
    handoffs: [],
    outputType: "text",
    tracing: false,
  };
}

/** The name of every tool definition and tool call in a wire body, in order. */
function wireToolNames(body: unknown): { definitions: string[]; calls: string[] } {
  const definitions: string[] = [];
  const calls: string[] = [];
  const visit = (value: unknown, key: string | null) => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach((entry) => visit(entry, key));
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string") {
      if (record.type === "function_call" || record.type === "tool_use") calls.push(record.name);
      else if (key === "function" && "arguments" in record) calls.push(record.name);
      else if (record.type === "function" || key === "function" || key === "tools")
        definitions.push(record.name);
    }
    for (const [child, entry] of Object.entries(record)) visit(entry, child);
  };
  visit(body, null);
  return { definitions, calls };
}

function expectPortableNames(body: unknown): string[] {
  const { definitions, calls } = wireToolNames(body);
  for (const name of [...definitions, ...calls]) expect(name).toMatch(PORTABLE_TOOL_NAME);
  expect(calls).toHaveLength(HOSTILE.length);
  // The dotted form of the request's tool, and its stored masked form (the
  // one request tool that fits around the reference), bind to it.
  expect(calls[0]).toBe(KNOWN);
  expect(calls.at(-1)).toBe(KNOWN);
  // Every other name keeps one distinct name of its own, collisions included.
  const others = calls.slice(1, -1);
  expect(new Set(others).size).toBe(HOSTILE.length - 2);
  expect(others).not.toContain(KNOWN);
  return calls;
}

const responsesProvider: ResolvedModelProvider = {
  id: "fixture",
  label: "Fixture",
  kind: "api-key",
  api: "responses",
  builtin: false,
  baseUrl: "https://example.test/v1",
  apiKey: "fixture-key",
};

function openAIClient(provider: ResolvedModelProvider, reply: (body: any) => Response) {
  const bodies: any[] = [];
  const client = new ReplayableJsonOpenAI(
    {
      apiKey: "fixture-key",
      baseURL: "https://example.test/v1",
      maxRetries: 0,
      fetch: async (_url, init) => {
        const body = JSON.parse(await requestBodyText(init?.body));
        bodies.push(body);
        return reply(body);
      },
    },
    { modelRequestPolicy: modelRequestPolicyForProvider(provider) },
  );
  return { client, bodies };
}

describe("hostile history tool names reach every provider wire valid", () => {
  test("Responses: tool_search_output definitions and calls", async () => {
    const { client, bodies } = openAIClient(responsesProvider, () =>
      Response.json({
        id: "response-fixture",
        object: "response",
        status: "completed",
        output: [
          {
            id: "message-fixture",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Done.", annotations: [] }],
          },
        ],
      }),
    );
    const model = new OpenGeniResponsesModel(client, "fixture-responses", responsesProvider);
    await getOrCreateTrace(() => model.getResponse(request(history(true))));
    const calls = expectPortableNames(bodies[0]);
    const search = bodies[0].input.find((item: any) => item.type === "tool_search_output");
    // A definition and the calls that name it carry the same name.
    expect(search.tools.map((tool: { name: string }) => tool.name)).toEqual(calls);
  });

  test("Chat Completions (OpenRouter, gateways, Gemini): calls stay native tool calls", async () => {
    const provider: ResolvedModelProvider = { ...responsesProvider, api: "chat" };
    const { client, bodies } = openAIClient(provider, () =>
      Response.json({
        id: "reply-fixture",
        object: "chat.completion",
        created: 1,
        model: "fixture-model",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Done." },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    const model = new OpenGeniChatCompletionsModel(client, "google/gemini-fixture");
    await getOrCreateTrace(() => model.getResponse(request(history(false))));
    expectPortableNames(bodies[0]);
  });

  test("Claude Messages", async () => {
    const bodies: any[] = [];
    const model = new AnthropicMessagesModel(
      { ...responsesProvider, api: "anthropic-messages" },
      "claude-fixture",
      (async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(await requestBodyText(init?.body)));
        return Response.json({
          id: "message-fixture",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }) as typeof fetch,
    );
    await getOrCreateTrace(() => model.getResponse(request(history(false))));
    expectPortableNames(bodies[0]);
  });
});
