import { expect, test } from "bun:test";
import { OpenAIResponsesModel, type ModelRequest } from "@openai/agents";
import { configuredProviders } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import type OpenAI from "openai";
import { requestRemoteCompactionV2 } from "../src/index";

class WireModel extends OpenAIResponsesModel {
  wire(request: ModelRequest) {
    return this._buildResponsesCreateRequest(request, true).requestData;
  }
}

for (const tracing of [true, "enabled_without_data"] as const) {
  test(`standalone subscription compaction detaches runner tracing (${tracing}) without changing wire prefix`, async () => {
    const settings = testSettings();
    let sent: unknown;
    const client = {
      responses: {
        create: async (body: unknown) => {
          sent = body;
          return (async function* () {
            yield {
              type: "response.completed",
              response: {
                id: "r",
                status: "completed",
                output: [{ type: "compaction", encrypted_content: "opaque" }],
                usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
              },
            };
          })();
        },
      },
    } as unknown as OpenAI;
    const ordinary: ModelRequest = {
      systemInstructions: "stable",
      input: [{ role: "user", content: "continue" }],
      tools: [],
      handoffs: [],
      outputType: "text",
      modelSettings: {
        reasoning: { effort: "low" },
        providerData: { prompt_cache_key: "same-session" },
      },
      tracing,
    };
    const { input, ...preparedRequest } = ordinary;
    const result = await requestRemoteCompactionV2(
      settings,
      input as Array<Record<string, unknown>>,
      {
        client,
        provider: { ...configuredProviders(settings)[0]!, kind: "codex-subscription" },
        model: "gpt-6-astra",
        preparedRequest,
      },
    );
    expect(result).toMatchObject({ type: "compaction", encrypted_content: "opaque" });
    const wire = new WireModel(client, "gpt-6-astra").wire(ordinary);
    expect(sent).toEqual({
      ...wire,
      input: [...(wire.input as unknown[]), { type: "compaction_trigger" }],
    });
    expect(preparedRequest.tracing).toBe(tracing);
  });
}
