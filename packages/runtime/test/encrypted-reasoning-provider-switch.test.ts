import { expect, test } from "bun:test";
import { Agent, Runner } from "@openai/agents";
import { canonicalizePersistedHistoryItem } from "@opengeni/codex";
import type { ResolvedModelProvider } from "@opengeni/config";
import { OpenGeniResponsesModel } from "../src/model-provider-routing";
import { modelRequestPolicyForProvider } from "../src/model-provider-request-policy";
import { ReplayableJsonOpenAI, requestBodyText } from "../src/replayable-json-body";
import { sanitizeHistoryItemsForModel } from "../src/history-sanitizer";
import { stripProviderItemIdsFilter } from "../src/model-input";

// A chat whose earlier turns ran on a Codex subscription continues on an
// Azure OpenAI deployment. Codex ciphertext was stored without an issuer
// record, and Azure refuses it with this exact production 400. The turn must
// continue with the readable reasoning instead of failing the session.
const CODEX_CIPHERTEXT = "gAAAAAcodex-issued-fixture-aiQ=";
const AZURE_REFUSAL = {
  error: {
    message:
      "The encrypted content gAAA...aiQ= could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
    type: "invalid_request_error",
    param: null,
    code: null,
  },
};
const summary = "**Reading adapter and actions**";

/** The stored shape of a Codex reasoning item recorded before issuer records existed. */
function storedHistory(): Array<Record<string, unknown>> {
  return sanitizeHistoryItemsForModel(
    [
      { type: "message", role: "user", content: "How does the agent perform actions?" },
      {
        type: "reasoning",
        id: "rs_codex_fixture",
        content: [{ type: "input_text", text: summary, providerData: { type: "summary_text" } }],
        providerData: {
          id: "rs_codex_fixture",
          type: "reasoning",
          content: [],
          encrypted_content: CODEX_CIPHERTEXT,
        },
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "It uses server actions." }],
      },
      { type: "message", role: "user", content: "Continue" },
    ].map(canonicalizePersistedHistoryItem),
  ) as Array<Record<string, unknown>>;
}

function sse(body: Record<string, unknown>): Response {
  const events = [
    { type: "response.created", response: { ...body, status: "in_progress", output: [] } },
    { type: "response.completed", response: body },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function azureModel(providerId: string, requests: string[]) {
  const provider: ResolvedModelProvider = {
    id: providerId,
    label: "GPT-6 Astra",
    kind: "api-key",
    api: "responses",
    wireProfile: "azure-openai",
    builtin: false,
    baseUrl: "https://azure.example.test/openai/v1",
    apiKey: "fixture-key",
  };
  const fetch = (async (_url, init) => {
    const text = await requestBodyText(init?.body);
    requests.push(text);
    if (text.includes(CODEX_CIPHERTEXT)) return Response.json(AZURE_REFUSAL, { status: 400 });
    const reply = {
      id: "resp_fixture",
      object: "response",
      status: "completed",
      output: [
        {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Done.", annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    return JSON.parse(text).stream ? sse(reply) : Response.json(reply);
  }) as typeof globalThis.fetch;
  const client = new ReplayableJsonOpenAI(
    { apiKey: "fixture-key", baseURL: provider.baseUrl, maxRetries: 0, fetch },
    { modelRequestPolicy: modelRequestPolicyForProvider(provider) },
  );
  return new OpenGeniResponsesModel(client, "gpt-6-astra", provider);
}

const runner = new Runner({
  tracingDisabled: true,
  callModelInputFilter: stripProviderItemIdsFilter,
});

for (const stream of [true, false]) {
  test(`a chat moved from Codex to Azure continues past the encrypted-content 400 (${stream ? "streamed" : "single"})`, async () => {
    const requests: string[] = [];
    const agent = new Agent({
      name: "Fixture",
      model: azureModel(`azure-astra-${stream ? "stream" : "single"}`, requests),
    });
    const history = storedHistory();
    let output: unknown;
    if (stream) {
      const result = await runner.run(agent, history as never, { stream: true });
      await result.completed;
      output = result.finalOutput;
    } else {
      output = (await runner.run(agent, history as never)).finalOutput;
    }

    expect(output).toBe("Done.");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain(CODEX_CIPHERTEXT);
    // The resent request keeps the reasoning as readable text, never ciphertext.
    expect(requests[1]).not.toContain("encrypted_content");
    expect(requests[1]).toContain("Reading adapter and actions");
  });
}
