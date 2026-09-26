import { afterEach, describe, expect, test } from "bun:test";
import OpenAI from "openai";
import {
  CODEX_MODEL_ID_PREFIX,
  CODEX_PROVIDER_BASE_URL,
  CODEX_PROVIDER_ID,
  codexRequestStorage,
  codexSubscriptionFetch,
  type CodexRequestContext,
} from "@opengeni/codex";
import { testSettings } from "@opengeni/testing";
import {
  buildModelInstance,
  buildOpenGeniAgent,
  resolveTurnModel,
  runAgentStream,
} from "../src/index";
import { requestBodyText } from "../src/replayable-json-body";

const CODEX_TURN_MODEL = `${CODEX_MODEL_ID_PREFIX}gpt-6-sol`;

function codexSettings() {
  return testSettings({
    sandboxBackend: "none",
    webSearchEnabled: false,
    openaiModel: CODEX_TURN_MODEL,
    modelProvidersJson: JSON.stringify([
      {
        kind: "codex-subscription",
        id: CODEX_PROVIDER_ID,
        label: "Codex (ChatGPT subscription)",
        api: "responses",
        baseUrl: CODEX_PROVIDER_BASE_URL,
        models: [
          {
            id: CODEX_TURN_MODEL,
            upstreamModelId: "gpt-6-sol",
            label: "gpt-6-sol",
            reasoningEffort: true,
          },
        ],
      },
    ]),
  });
}

function codexContext(): CodexRequestContext {
  const token = { accessToken: "test-token", chatgptAccountId: "test-account", isFedramp: false };
  return {
    clientVersion: "verbosity-test",
    getToken: async () => token,
    refresh: async () => token,
    resolveModel: (model) => model,
  };
}

/** Run one real agent turn over the Codex subscription wire and return each request body. */
async function codexWireBodies(textVerbosity?: "low"): Promise<Array<Record<string, unknown>>> {
  const settings = codexSettings();
  const resolved = resolveTurnModel(settings, CODEX_TURN_MODEL);
  if (!resolved) throw new Error("codex model did not resolve");
  const bodies: Array<Record<string, unknown>> = [];
  const client = new OpenAI({
    apiKey: "test-key",
    baseURL: CODEX_PROVIDER_BASE_URL,
    maxRetries: 0,
    fetch: codexSubscriptionFetch(async (_input, init) => {
      bodies.push(JSON.parse(await requestBodyText(init?.body)));
      const events = [
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            id: "message-1",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "Saturday.", annotations: [], logprobs: [] }],
          },
        },
        {
          type: "response.completed",
          response: { id: "response-1", status: "completed", output: [], usage: null },
        },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }),
  });
  const agent = buildOpenGeniAgent(settings, [], {
    model: buildModelInstance(resolved.provider, client, resolved.configured.upstreamModelId),
    hostedWebSearch: false,
    reasoningEffort: "medium",
    ...(textVerbosity ? { textVerbosity } : {}),
  });
  await codexRequestStorage.run(codexContext(), async () => {
    const result = await runAgentStream(agent, "What day is it?", settings);
    for await (const _event of result.toStream()) {
      /* drain */
    }
    await result.completed;
  });
  return bodies;
}

const AZURE_TURN_MODEL = "azure-verbosity/gpt-6-sol";

function azureSettings() {
  return testSettings({
    sandboxBackend: "none",
    webSearchEnabled: false,
    openaiModel: AZURE_TURN_MODEL,
    modelProvidersJson: JSON.stringify([
      {
        id: "azure-verbosity",
        label: "Azure OpenAI",
        api: "responses",
        wireProfile: "azure-openai",
        // Unique to this file so the process-wide provider client cache never
        // hands this stubbed transport to another test.
        baseUrl: "https://text-verbosity.openai.azure.com/openai/v1",
        apiKey: "azure-test-key",
        models: [{ id: AZURE_TURN_MODEL, upstreamModelId: "gpt-6-sol", label: "Sol" }],
      },
    ]),
  });
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Run one real agent turn through the Azure registry client and return each request body. */
async function azureWireBodies(): Promise<Array<Record<string, unknown>>> {
  const bodies: Array<Record<string, unknown>> = [];
  const message = {
    type: "message",
    id: "message-1",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "Saturday.", annotations: [], logprobs: [] }],
  };
  const usage = {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 2,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 12,
  };
  // The registry client captures the global transport when it is built.
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    bodies.push(JSON.parse(await requestBodyText(init?.body)));
    const events = [
      { type: "response.output_item.done", output_index: 0, item: message },
      {
        type: "response.completed",
        response: { id: "response-1", status: "completed", output: [message], usage },
      },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  const settings = azureSettings();
  const resolved = resolveTurnModel(settings, AZURE_TURN_MODEL);
  if (!resolved) throw new Error("azure model did not resolve");
  expect(resolved.provider.wireProfile).toBe("azure-openai");
  const agent = buildOpenGeniAgent(settings, [], {
    model: resolved.model,
    hostedWebSearch: false,
    reasoningEffort: "medium",
    textVerbosity: "low",
  });
  const result = await runAgentStream(agent, "What day is it?", settings);
  for await (const _event of result.toStream()) {
    /* drain */
  }
  await result.completed;
  return bodies;
}

describe("Responses text verbosity", () => {
  test("reaches the Codex subscription wire beside the unchanged reasoning summary", async () => {
    const [body] = await codexWireBodies("low");
    expect(body?.model).toBe("gpt-6-sol");
    expect(body?.text).toEqual({ verbosity: "low" });
    expect(body?.reasoning).toEqual({ effort: "medium", summary: "detailed" });
  });

  test("an omitted setting keeps the request free of text controls", async () => {
    const [body] = await codexWireBodies();
    expect(body).toBeDefined();
    expect(body).not.toHaveProperty("text");
    expect(body?.reasoning).toEqual({ effort: "medium", summary: "detailed" });
  });

  test("reaches the Azure OpenAI Responses wire through the Azure request policy", async () => {
    const [body] = await azureWireBodies();
    expect(body?.model).toBe("gpt-6-sol");
    expect(body?.text).toEqual({ verbosity: "low" });
    expect(body?.reasoning).toEqual({ effort: "medium", summary: "detailed" });
  });
});
