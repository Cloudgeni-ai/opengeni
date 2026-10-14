import { expect, test } from "bun:test";
import { Agent, Runner, type Model, type ModelRequest } from "@openai/agents";
import { getOrCreateTrace } from "@openai/agents-core";
import { canonicalizePersistedHistoryItem } from "@opengeni/codex";
import type { ResolvedModelProvider } from "@opengeni/config";
import { AnthropicMessagesModel } from "../src/anthropic-messages";
import {
  OpenGeniChatCompletionsModel,
  OpenGeniResponsesModel,
} from "../src/model-provider-routing";
import { modelRequestPolicyForProvider } from "../src/model-provider-request-policy";
import { ReplayableJsonOpenAI, requestBodyText } from "../src/replayable-json-body";
import { sanitizeHistoryItemsForModel } from "../src/history-sanitizer";
import { stripProviderItemIdsFilter } from "../src/model-input";
import {
  projectHistoryForProvider,
  type HistoryProviderApi,
} from "../src/provider-history-adapter";

const summary = "Use the supplied total of 8.";
const base: Omit<ModelRequest, "input"> = {
  modelSettings: {},
  tools: [],
  handoffs: [],
  outputType: "text",
  tracing: false,
};

function wireReply(api: HistoryProviderApi, withHistory: boolean) {
  if (api === "chat")
    return {
      id: "reply-fixture",
      model: "fixture",
      created: 1,
      object: "chat.completion",
      choices: [
        { index: 0, finish_reason: "stop", message: { role: "assistant", content: "Done." } },
      ],
    };
  if (api === "anthropic-messages")
    return {
      id: "message-fixture",
      type: "message",
      role: "assistant",
      content: withHistory
        ? [
            { type: "thinking", thinking: summary, signature: "signature-fixture" },
            { type: "redacted_thinking", data: "opaque-fixture" },
            { type: "text", text: "Checking." },
            { type: "tool_use", id: "call-fixture", name: "lookup", input: {} },
          ]
        : [{ type: "text", text: "Done." }],
      stop_reason: withHistory ? "tool_use" : "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  return {
    id: "response-fixture",
    object: "response",
    status: "completed",
    output: withHistory
      ? [
          {
            id: "reason-fixture",
            type: "reasoning",
            summary: [{ type: "summary_text", text: summary }],
            encrypted_content: "ciphertext-fixture",
          },
          {
            id: "opaque-reason-fixture",
            type: "reasoning",
            summary: [],
            encrypted_content: "opaque-fixture",
          },
          {
            id: "message-fixture",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Checking.", annotations: [] }],
          },
          {
            id: "tool-fixture",
            type: "function_call",
            call_id: "call-fixture",
            name: "lookup",
            arguments: "{}",
            status: "completed",
          },
        ]
      : [
          {
            id: "message-fixture",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Done.", annotations: [] }],
          },
        ],
  };
}

function modelFor(
  api: HistoryProviderApi,
  withHistory: boolean,
  requests: Record<string, any>[],
): Model {
  const provider: ResolvedModelProvider = {
    id: "fixture",
    label: "Fixture",
    kind: "api-key",
    api,
    builtin: false,
    baseUrl: "https://example.test/v1",
    apiKey: "fixture-key",
  };
  const fetch = (async (_url, init) => {
    requests.push(JSON.parse(await requestBodyText(init?.body)));
    return Response.json(wireReply(api, withHistory));
  }) as typeof globalThis.fetch;
  if (api === "anthropic-messages")
    return new AnthropicMessagesModel(provider, "claude-fixture", fetch);
  const client = new ReplayableJsonOpenAI(
    { apiKey: "fixture-key", baseURL: provider.baseUrl, maxRetries: 0, fetch },
    {
      modelRequestPolicy: modelRequestPolicyForProvider(provider),
    },
  );
  return api === "responses"
    ? new OpenGeniResponsesModel(client, "fixture", provider)
    : new OpenGeniChatCompletionsModel(client, "fixture");
}

for (const sourceApi of ["responses", "anthropic-messages"] as const) {
  for (const targetApi of ["responses", "chat", "anthropic-messages"] as const) {
    test(`${sourceApi} -> ${targetApi}: readable context, native artifacts and paired tools survive persistence`, async () => {
      const source = modelFor(sourceApi, true, []);
      const reply = await getOrCreateTrace(() => source.getResponse({ ...base, input: "Start" }));
      const history = sanitizeHistoryItemsForModel(
        JSON.parse(
          JSON.stringify([
            { type: "message", role: "user", content: "Start" },
            ...reply.output,
            {
              type: "function_call_result",
              name: "lookup",
              callId: "call-fixture",
              output: "Found",
            },
            { type: "message", role: "user", content: "Continue" },
          ]),
        ).map(canonicalizePersistedHistoryItem),
      );
      const before = JSON.stringify(history);
      const requests: Record<string, any>[] = [];
      const runner = new Runner({
        tracingDisabled: true,
        callModelInputFilter: stripProviderItemIdsFilter,
      });
      const result = await runner.run(
        new Agent({ name: "Fixture", model: modelFor(targetApi, false, requests) }),
        history as never,
      );
      expect(result.finalOutput).toBe("Done.");
      expect(requests).toHaveLength(1);
      const wire = JSON.stringify(requests[0]);
      expect(wire.split(summary)).toHaveLength(2);
      expect(wire).toContain("Found");
      if (targetApi === sourceApi) {
        expect(wire).toContain("opaque-fixture");
        expect(wire).toContain(
          sourceApi === "responses" ? "ciphertext-fixture" : "signature-fixture",
        );
        expect(wire).not.toContain("Historical reasoning");
      } else {
        for (const field of [
          "signature-fixture",
          "opaque-fixture",
          "ciphertext-fixture",
          '"anthropic"',
          '"encrypted_content"',
        ])
          expect(wire).not.toContain(field);
        expect(wire).toContain("[Historical reasoning from another model]");
        expect(wire).toContain("[Historical reasoning from another model is unavailable.]");
      }
      const body = requests[0]!;
      if (targetApi === "responses") {
        expect(body.input.filter((item: any) => item.type?.startsWith("function_call"))).toEqual([
          { type: "function_call", call_id: "call-fixture", name: "lookup", arguments: "{}" },
          { type: "function_call_output", call_id: "call-fixture", output: "Found" },
        ]);
      } else if (targetApi === "chat") {
        const call = body.messages.findIndex((item: any) => item.tool_calls?.length);
        expect(body.messages[call].tool_calls[0]).toEqual({
          id: "call-fixture",
          type: "function",
          function: { name: "lookup", arguments: "{}" },
        });
        expect(body.messages[call + 1]).toEqual({
          role: "tool",
          tool_call_id: "call-fixture",
          content: "Found",
        });
        expect(
          body.messages
            .filter((item: any) => item.role === "assistant")
            .every((item: any) => item.content !== null || item.tool_calls?.length),
        ).toBe(true);
      } else {
        const call = body.messages.findIndex((item: any) =>
          item.content.some((block: any) => block.type === "tool_use"),
        );
        expect(body.messages[call].content.at(-1)).toMatchObject({
          type: "tool_use",
          id: "call-fixture",
          name: "lookup",
          input: {},
        });
        expect(body.messages[call + 1].content[0]).toMatchObject({
          type: "tool_result",
          tool_use_id: "call-fixture",
          content: [{ type: "text", text: "Found" }],
        });
      }
      expect(JSON.stringify(history)).toBe(before);
      const projected = projectHistoryForProvider(history, targetApi);
      expect(projectHistoryForProvider(projected, targetApi)).toBe(projected);
      // A later switch back always starts from canonical history, retaining the
      // signed/encrypted original rather than persisting its foreign text view.
      const back: Record<string, any>[] = [];
      await runner.run(
        new Agent({ name: "Fixture", model: modelFor(sourceApi, false, back) }),
        history as never,
      );
      expect(JSON.stringify(back[0])).toContain("opaque-fixture");
      expect(JSON.stringify(back[0])).not.toContain("Historical reasoning");
      expect(JSON.stringify(history)).toBe(before);
    });
  }
}
