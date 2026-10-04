import { withTrace } from "@openai/agents";
import { expect, test } from "bun:test";
import OpenAI from "openai";
import {
  OpenGeniResponsesModel,
  OpenGeniChatCompletionsModel,
} from "../src/model-provider-routing";
import { modelResponseUsageFromResponse } from "../src/run-events";
import { anthropicResponse } from "../src/anthropic-messages";

const request = {
  input: "hello",
  modelSettings: {},
  tools: [],
  handoffs: [],
  outputType: "text" as const,
  tracing: false as const,
};
const cases = [
  undefined,
  { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  { input_tokens: 10 },
  { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
];
for (const api of ["responses", "chat"] as const) {
  for (const streamed of [false, true]) {
    test.each(cases)(
      `${api} streamed=${streamed} preserves raw usage presence: %j`,
      async (usage) => {
        const expected = usage?.input_tokens !== undefined && usage?.output_tokens !== undefined;
        const chatUsage =
          usage === undefined
            ? undefined
            : {
                prompt_tokens: usage.input_tokens,
                completion_tokens: usage.output_tokens,
                total_tokens: usage.total_tokens,
              };
        const response =
          api === "responses"
            ? {
                id: "response-proof",
                object: "response",
                status: "completed",
                output: [],
                ...(usage ? { usage } : {}),
              }
            : {
                id: "chat-proof",
                object: "chat.completion",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "hello" },
                    finish_reason: "stop",
                  },
                ],
                ...(chatUsage ? { usage: chatUsage } : {}),
              };
        const events =
          api === "responses"
            ? [{ type: "response.completed", response }]
            : [
                {
                  id: "chat-proof",
                  object: "chat.completion.chunk",
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant", content: "hello" },
                      finish_reason: null,
                    },
                  ],
                },
                {
                  id: "chat-proof",
                  object: "chat.completion.chunk",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                },
                ...(chatUsage
                  ? [
                      {
                        id: "chat-proof",
                        object: "chat.completion.chunk",
                        choices: [],
                        usage: chatUsage,
                      },
                    ]
                  : []),
              ];
        const client = new OpenAI({
          apiKey: "fixture",
          fetch: async () =>
            new Response(
              streamed
                ? events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
                    "data: [DONE]\n\n"
                : JSON.stringify(response),
              { headers: { "content-type": streamed ? "text/event-stream" : "application/json" } },
            ),
        });
        const model =
          api === "responses"
            ? new OpenGeniResponsesModel(client, "fixture", {
                id: "openai",
                label: "OpenAI",
                kind: "api-key",
                api: "responses",
                builtin: true,
              })
            : new OpenGeniChatCompletionsModel(client, "fixture");
        if (!streamed) {
          expect(
            modelResponseUsageFromResponse(
              await withTrace("usage-evidence", () => model.getResponse(request)),
            )?.usage.providerUsageReported,
          ).toBe(expected);
        } else {
          let terminalSeen = false;
          for await (const event of model.getStreamedResponse(request)) {
            if (event.type !== "response_done") continue;
            terminalSeen = true;
            expect(
              modelResponseUsageFromResponse(event.response)?.usage.providerUsageReported,
            ).toBe(expected);
          }
          expect(terminalSeen).toBe(true);
        }
      },
    );
  }
}
test.each(cases)("Claude retains usage provenance: %j", (usage) => {
  const response = anthropicResponse({
    id: "claude-proof",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "hello" }],
    ...(usage ? { usage } : {}),
  });
  expect(modelResponseUsageFromResponse(response)?.usage.providerUsageReported).toBe(
    usage?.input_tokens !== undefined && usage?.output_tokens !== undefined,
  );
});
