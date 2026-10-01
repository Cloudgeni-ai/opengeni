import { expect, test } from "bun:test";
import OpenAI from "openai";
import { Agent, Runner } from "@openai/agents";
import {
  OpenGeniChatCompletionsModel,
  OpenGeniResponsesModel,
  projectHistoryForProvider,
  ResponsesStreamingTerminalError,
} from "../src/index";
import { finalReplyNudge } from "../../../apps/worker/src/activities/agent-turn/final-reply";
import {
  agentRunFailurePayload,
  classifyContextWindowOverflowError,
  providerRetryAfterMs,
} from "../../../apps/worker/src/activities/agent-turn/errors";

test("review: structured developer handoff uses Chat-native content on the wire", async () => {
  let wire: Record<string, unknown> | undefined;
  const client = new OpenAI({
    apiKey: "fixture",
    baseURL: "https://fixture.invalid/v1",
    maxRetries: 0,
    fetch: async (_url, init) => {
      wire = JSON.parse(String(init?.body));
      return Response.json({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: "fixture",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "done" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  await new Runner({ tracingDisabled: true }).run(
    new Agent({ name: "fixture", model: new OpenGeniChatCompletionsModel(client, "fixture") }),
    projectHistoryForProvider([finalReplyNudge("fixture-turn")], "chat") as never,
  );
  const messages = wire?.messages as Array<{ content: unknown }>;
  expect(messages).toHaveLength(1);
  expect(
    typeof messages[0]!.content === "string" ||
      (Array.isArray(messages[0]!.content) &&
        messages[0]!.content.every((part: { type?: string }) => part.type === "text")),
  ).toBe(true);
});

test("review: recognized safety diagnostic vetoes streamed server recovery", () => {
  const error = new ResponsesStreamingTerminalError("response.error", {
    code: "server_error",
    message: "This request was blocked by our safety systems.",
  });
  expect(agentRunFailurePayload(error)).toMatchObject({
    code: "provider_safety_refusal",
    retryable: false,
  });
});

test("review: diagnostic-only streamed context overflow remains recognizable", () => {
  const error = new ResponsesStreamingTerminalError("response.error", {
    code: "invalid_prompt",
    message: "Your input exceeds the context window of this model.",
  });
  expect(classifyContextWindowOverflowError(error)).not.toBeNull();
});

test("review: yielded Responses terminal retains HTTP Retry-After", async () => {
  const event = {
    type: "response.failed",
    response: {
      status: "failed",
      error: { code: "rate_limit_exceeded", message: "fixture rate limit" },
    },
  };
  const client = new OpenAI({
    apiKey: "fixture",
    baseURL: "https://fixture.invalid/v1",
    maxRetries: 0,
    fetch: async () =>
      new Response(`data: ${JSON.stringify(event)}\n\n`, {
        headers: { "content-type": "text/event-stream", "retry-after": "1800" },
      }),
  });
  const model = new OpenGeniResponsesModel(client, "fixture", {
    id: "azure",
    label: "Azure",
    kind: "api-key",
    api: "responses",
    builtin: true,
  });
  let failure: unknown;
  try {
    for await (const _event of model.getStreamedResponse({
      input: "hello",
      modelSettings: {},
      tools: [],
      handoffs: [],
      outputType: "text",
      tracing: false,
    })) {
    }
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ResponsesStreamingTerminalError);
  expect(providerRetryAfterMs(failure)).toBe(1_800_000);
  expect(agentRunFailurePayload(failure)).toMatchObject({
    code: "provider_quota_exhausted",
    retryable: false,
  });
});
