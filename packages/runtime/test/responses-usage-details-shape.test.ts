import { describe, expect, test } from "bun:test";
import { OpenAIResponsesModel, withTrace, type ModelRequest } from "@openai/agents";
import { protocol } from "@openai/agents-core";
import type OpenAI from "openai";

// November 13, 2026: the Codex Responses backend sent an object-valued
// `cache_write_tokens_details` inside `input_tokens_details`. The SDK copied it
// verbatim into a Record<string, number> usage schema and failed the turn.
const providerUsage = {
  input_tokens: 1_000,
  input_tokens_details: {
    cached_tokens: 600,
    cache_write_tokens: 300,
    cache_write_tokens_details: { ephemeral_5m: 200, ephemeral_1h: 100, note: "x" },
    unknown_list: [1, 2],
    unknown_text: "ignored",
    unknown_null: null,
  },
  output_tokens: 50,
  output_tokens_details: { reasoning_tokens: 20, future_detail: { audio: 3 } },
  total_tokens: 1_050,
};

const expectedInputDetails = {
  cached_tokens: 600,
  cache_write_tokens: 300,
  "cache_write_tokens_details.ephemeral_5m": 200,
  "cache_write_tokens_details.ephemeral_1h": 100,
};
const expectedOutputDetails = { reasoning_tokens: 20, "future_detail.audio": 3 };

const completedResponse = {
  id: "resp_usage_shape",
  object: "response",
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    },
  ],
  usage: providerUsage,
};

function client(): OpenAI {
  return {
    responses: {
      create: async (body: { stream?: boolean }) => {
        if (!body.stream) return completedResponse;
        return (async function* () {
          yield { type: "response.created", response: { ...completedResponse, output: [] } };
          yield { type: "response.completed", response: completedResponse };
        })();
      },
    },
  } as unknown as OpenAI;
}

const request: ModelRequest = {
  systemInstructions: "stable",
  input: [{ role: "user", content: "hi" }],
  tools: [],
  handoffs: [],
  outputType: "text",
  modelSettings: {},
  tracing: false,
};

describe("Responses usage details with unexpected shapes", () => {
  test("a streamed response with object-valued detail fields still parses", async () => {
    const model = new OpenAIResponsesModel(client(), "gpt-6-astra");
    let done: unknown;
    for await (const event of model.getStreamedResponse(request)) {
      if (event.type === "response_done") done = event;
    }
    // The runner validates response_done with this schema; it threw before.
    const parsed = protocol.StreamEventResponseCompleted.parse(done);
    expect(parsed.response.usage.inputTokensDetails).toEqual(expectedInputDetails);
    expect(parsed.response.usage.outputTokensDetails).toEqual(expectedOutputDetails);
    const [entry] = parsed.response.usage.requestUsageEntries ?? [];
    expect(entry?.inputTokensDetails).toEqual(expectedInputDetails);
    expect(entry?.outputTokensDetails).toEqual(expectedOutputDetails);
    // Cost accounting reads the numeric counters, which are kept unchanged.
    expect(parsed.response.usage.inputTokens).toBe(1_000);
  });

  test("a non-streamed response keeps only numeric counters", async () => {
    const model = new OpenAIResponsesModel(client(), "gpt-6-astra");
    const response = await withTrace("usage-shape", () => model.getResponse(request));
    expect(response.usage.inputTokensDetails).toEqual([expectedInputDetails]);
    expect(response.usage.outputTokensDetails).toEqual([expectedOutputDetails]);
    expect(response.usage.requestUsageEntries?.[0]?.inputTokensDetails).toEqual(
      expectedInputDetails,
    );
  });
});
