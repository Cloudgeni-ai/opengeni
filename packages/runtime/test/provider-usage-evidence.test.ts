import { Agent, Runner, protocol, withTrace } from "@openai/agents";
import { expect, test } from "bun:test";
import OpenAI from "openai";
import {
  OpenGeniResponsesModel,
  OpenGeniChatCompletionsModel,
} from "../src/model-provider-routing";
import { modelResponseUsageFromResponse, modelResponseUsageFromSdkEvent } from "../src/run-events";
import { anthropicResponse, AnthropicMessagesModel } from "../src/anthropic-messages";

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
              modelResponseUsageFromResponse(
                protocol.StreamEventResponseCompleted.parse(event).response,
              )?.usage.providerUsageReported,
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

// Exercise the actual Claude streaming parser and Runner, not just its response helper.
test.each(cases)("Claude Runner stream retains usage provenance: %j", async (usage) => {
  const events = [
    {
      type: "message_start",
      message: {
        id: "claude-proof",
        type: "message",
        role: "assistant",
        model: "claude",
        content: [],
        stop_reason: null,
        usage: usage ?? {},
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "hello" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
    { type: "message_stop" },
  ];
  const model = new AnthropicMessagesModel(
    {
      id: "claude",
      label: "Claude",
      kind: "api-key",
      api: "anthropic-messages",
      wireProfile: "openai",
      builtin: false,
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "fixture",
      credentialSource: { kind: "deployment", mechanism: "api_key" },
      billing: { upstreamPayer: "deployment", metering: "external" },
    },
    "claude",
    (async () =>
      new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      )) as typeof fetch,
  );
  const run = await new Runner({ tracingDisabled: true }).run(
    new Agent({ name: "Usage evidence", model }),
    "hello",
    { stream: true },
  );
  let terminalSeen = false;
  for await (const event of run) {
    const terminal = modelResponseUsageFromSdkEvent(event);
    if (!terminal) continue;
    terminalSeen = true;
    expect(terminal.usage.providerUsageReported).toBe(
      usage?.input_tokens !== undefined && usage?.output_tokens !== undefined,
    );
  }
  expect(terminalSeen).toBe(true);
});

for (const streamed of [false, true]) {
  test.each([undefined, ""])(
    `Responses streamed=${streamed} gives ID-less calls distinct stable identities: %j`,
    async (id) => {
      const response = {
        ...(id !== undefined ? { id } : {}),
        object: "response",
        status: "completed",
        output: [],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      };
      const client = new OpenAI({
        apiKey: "fixture",
        fetch: async () =>
          new Response(
            streamed
              ? `data: ${JSON.stringify({ type: "response.completed", response })}\n\ndata: [DONE]\n\n`
              : JSON.stringify(response),
            { headers: { "content-type": streamed ? "text/event-stream" : "application/json" } },
          ),
      });
      const model = new OpenGeniResponsesModel(client, "fixture", {
        id: "openai",
        label: "OpenAI",
        kind: "api-key",
        api: "responses",
        builtin: true,
      });
      const callIds: string[] = [];
      for (let call = 0; call < 2; call++) {
        if (!streamed) {
          const result = await withTrace("id-evidence", () => model.getResponse(request));
          expect(result.responseId).toBeTruthy();
          callIds.push(result.responseId!);
        } else {
          const ids: string[] = [];
          for await (const event of model.getStreamedResponse(request)) {
            if (event.type === "response_done") ids.push(event.response.id);
            else if (event.type === "model" && event.event.type === "response.completed")
              ids.push(event.event.response.id);
          }
          expect(ids).toHaveLength(2);
          expect(ids[0]).toBeTruthy();
          expect(ids[1]).toBe(ids[0]);
          callIds.push(ids[0]!);
        }
      }
      expect(callIds[1]).not.toBe(callIds[0]);
    },
  );
}

for (const streamed of [false, true]) {
  test.each([undefined, "", "FAKE_ID"])(
    `Chat streamed=${streamed} separates ID-less dispatches and preserves explicit IDs: %j`,
    async (id) => {
      const idFields = id === undefined ? {} : { id };
      const response = {
        ...idFields,
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      };
      const chunks = [
        {
          ...idFields,
          object: "chat.completion.chunk",
          choices: [
            { index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: "stop" },
          ],
          usage: response.usage,
        },
      ];
      const model = new OpenGeniChatCompletionsModel(
        new OpenAI({
          apiKey: "fixture",
          fetch: async () =>
            new Response(
              streamed
                ? chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
                    "data: [DONE]\n\n"
                : JSON.stringify(response),
              { headers: { "content-type": streamed ? "text/event-stream" : "application/json" } },
            ),
        }),
        "fixture",
      );
      const callIds: string[] = [];
      for (let call = 0; call < 2; call++) {
        if (!streamed) {
          const result = await withTrace("chat-id-evidence", () => model.getResponse(request));
          expect(result.responseId).toBeTruthy();
          callIds.push(result.responseId!);
        } else {
          for await (const event of model.getStreamedResponse(request)) {
            if (event.type === "response_done") {
              expect(event.response.id).toBeTruthy();
              callIds.push(event.response.id);
            }
          }
        }
      }
      expect(callIds).toHaveLength(2);
      if (id === "FAKE_ID") expect(callIds).toEqual([id, id]);
      else expect(callIds[1]).not.toBe(callIds[0]);
    },
  );
}
