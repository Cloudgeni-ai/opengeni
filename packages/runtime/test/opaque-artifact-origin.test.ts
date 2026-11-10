import { expect, test } from "bun:test";
import { Agent, Runner, type ModelRequest } from "@openai/agents";
import { getOrCreateTrace } from "@openai/agents-core";
import { canonicalizePersistedHistoryItem } from "@opengeni/codex";
import type { ResolvedModelProvider } from "@opengeni/config";
import { OpenGeniResponsesModel } from "../src/model-provider-routing";
import { modelRequestPolicyForProvider } from "../src/model-provider-request-policy";
import { ReplayableJsonOpenAI, requestBodyText } from "../src/replayable-json-body";
import { sanitizeHistoryItemsForModel } from "../src/history-sanitizer";
import { stripProviderItemIdsFilter } from "../src/model-input";
import { ARTIFACT_ORIGIN_KEY, projectHistoryForProvider } from "../src/provider-history-adapter";

const summary = "Use the supplied total of 8.";
const ciphertext = "ciphertext-fixture";
const base: Omit<ModelRequest, "input"> = {
  modelSettings: {},
  tools: [],
  handoffs: [],
  outputType: "text",
  tracing: false,
};
const DECRYPT_REFUSAL = {
  error: {
    message:
      "Could not decrypt the provided encrypted_content. Ensure the value is the unmodified encrypted_content from a previous response.",
    type: "invalid_request_error",
    param: null,
    code: null,
  },
};

function reply(withReasoning: boolean, reasoning?: unknown[]) {
  return {
    id: "response-fixture",
    object: "response",
    status: "completed",
    output: [
      ...(reasoning ??
        (withReasoning
          ? [
              {
                id: "reason-fixture",
                type: "reasoning",
                summary: [{ type: "summary_text", text: summary }],
                encrypted_content: ciphertext,
              },
              {
                id: "opaque-reason-fixture",
                type: "reasoning",
                summary: [],
                encrypted_content: "x",
              },
            ]
          : [])),
      {
        id: "message-fixture",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Done.", annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
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

/** A Responses provider; `refuses` decides which request bodies it rejects. */
function responsesModel(
  providerId: string,
  requests: Record<string, any>[],
  options: {
    withReasoning?: boolean;
    reasoning?: unknown[];
    refuses?: (wire: string) => Response | null;
  } = {},
) {
  const provider: ResolvedModelProvider = {
    id: providerId,
    label: providerId,
    kind: "api-key",
    api: "responses",
    builtin: false,
    baseUrl: "https://example.test/v1",
    apiKey: "fixture-key",
  };
  const fetch = (async (_url, init) => {
    const text = await requestBodyText(init?.body);
    const body = JSON.parse(text);
    requests.push(body);
    const refusal = options.refuses?.(text);
    if (refusal) return refusal;
    const response = reply(options.withReasoning === true, options.reasoning);
    return body.stream ? sse(response) : Response.json(response);
  }) as typeof globalThis.fetch;
  const client = new ReplayableJsonOpenAI(
    { apiKey: "fixture-key", baseURL: provider.baseUrl, maxRetries: 0, fetch },
    { modelRequestPolicy: modelRequestPolicyForProvider(provider) },
  );
  return new OpenGeniResponsesModel(client, "fixture", provider);
}

function persisted(output: unknown[]): Array<Record<string, unknown>> {
  return sanitizeHistoryItemsForModel(
    JSON.parse(
      JSON.stringify([
        { type: "message", role: "user", content: "Start" },
        ...output,
        { type: "message", role: "user", content: "Continue" },
      ]),
    ).map(canonicalizePersistedHistoryItem),
  ) as Array<Record<string, unknown>>;
}

function withoutOrigins(history: Array<Record<string, unknown>>) {
  return history.map((item) => {
    const metadata = item.providerData as Record<string, unknown> | undefined;
    if (!metadata || !(ARTIFACT_ORIGIN_KEY in metadata)) return item;
    const { [ARTIFACT_ORIGIN_KEY]: _origin, ...providerData } = metadata;
    return { ...item, providerData };
  });
}

const runner = new Runner({
  tracingDisabled: true,
  callModelInputFilter: stripProviderItemIdsFilter,
});

async function wireFor(
  providerId: string,
  history: Array<Record<string, unknown>>,
  stream = false,
): Promise<string> {
  const requests: Record<string, any>[] = [];
  const agent = new Agent({ name: "Fixture", model: responsesModel(providerId, requests) });
  if (stream) {
    const result = await runner.run(agent, history as never, { stream: true });
    await result.completed;
  } else {
    await runner.run(agent, history as never);
  }
  expect(requests).toHaveLength(1);
  return JSON.stringify(requests[0]);
}

for (const stream of [false, true]) {
  test(`opaque reasoning goes back natively only to the provider that issued it (${stream ? "streamed" : "single"} reply)`, async () => {
    const issuer = responsesModel("origin-issuer", [], { withReasoning: true });
    let output: unknown[] = [];
    if (stream) {
      await getOrCreateTrace(async () => {
        for await (const event of issuer.getStreamedResponse({ ...base, input: "Start" }))
          if (event.type === "response_done") output = event.response.output;
      });
    } else {
      output = (await getOrCreateTrace(() => issuer.getResponse({ ...base, input: "Start" })))
        .output;
    }
    const history = persisted(output);
    const reasoning = history.filter((item) => item.type === "reasoning");
    expect(reasoning).toHaveLength(2);
    for (const item of reasoning)
      expect((item.providerData as Record<string, unknown>)[ARTIFACT_ORIGIN_KEY]).toBe(
        "origin-issuer",
      );
    expect(
      history.find((item) => item.type === "message" && item.role === "assistant"),
    ).not.toHaveProperty("providerData." + ARTIFACT_ORIGIN_KEY);

    // The issuing provider receives exactly the request it got before origins
    // were recorded: same ciphertext, same bytes, no origin record.
    const native = await wireFor("origin-issuer", history, stream);
    expect(native).toBe(await wireFor("origin-issuer", withoutOrigins(history), stream));
    expect(native).toContain(ciphertext);
    expect(native).not.toContain("artifact_origin");
    expect(native).not.toContain("Historical reasoning");

    // Any other Responses provider gets the readable summary, never ciphertext.
    const foreign = await wireFor("origin-other", history, stream);
    expect(foreign).not.toContain(ciphertext);
    expect(foreign).not.toContain("encrypted_content");
    expect(foreign).not.toContain("artifact_origin");
    expect(foreign).toContain(
      JSON.stringify(`[Historical reasoning from another model]\n${summary}`),
    );
    expect(foreign).toContain("[Historical reasoning from another model is unavailable.]");
  });
}

const legacyHistory = () =>
  persisted(
    reply(true).output.map((item) =>
      item.type === "reasoning"
        ? {
            type: "reasoning",
            id: item.id,
            content: (item.summary as Array<{ text: string }>).map(({ text }) => ({
              type: "input_text",
              text,
            })),
            providerData: { ...item, summary: undefined },
          }
        : item,
    ),
  );

for (const stream of [false, true]) {
  test(`a provider that cannot decrypt untagged reasoning gets its summary on the retry and afterwards (${stream ? "streamed" : "single"})`, async () => {
    const providerId = `origin-refusing-${stream ? "stream" : "single"}`;
    const history = legacyHistory();
    expect(JSON.stringify(history)).toContain(ciphertext);
    expect(JSON.stringify(history)).not.toContain("artifact_origin");
    const refuses = (wire: string) =>
      wire.includes("encrypted_content") ? Response.json(DECRYPT_REFUSAL, { status: 400 }) : null;
    const run = async (requests: Record<string, any>[]) => {
      const agent = new Agent({
        name: "Fixture",
        model: responsesModel(providerId, requests, { refuses }),
      });
      if (!stream) return (await runner.run(agent, history as never)).finalOutput;
      const result = await runner.run(agent, history as never, { stream: true });
      await result.completed;
      return result.finalOutput;
    };

    const first: Record<string, any>[] = [];
    expect(await run(first)).toBe("Done.");
    expect(first).toHaveLength(2);
    expect(JSON.stringify(first[0])).toContain(ciphertext);
    const retried = JSON.stringify(first[1]);
    expect(retried).not.toContain("encrypted_content");
    expect(retried).toContain(
      JSON.stringify(`[Historical reasoning from another model]\n${summary}`),
    );

    // A later run in this process sends the readable form directly.
    const later: Record<string, any>[] = [];
    expect(await run(later)).toBe("Done.");
    expect(later).toHaveLength(1);
    expect(JSON.stringify(later[0])).toBe(retried);

    // Another provider is unaffected and still receives the stored item.
    expect(await wireFor(`${providerId}-peer`, history, stream)).toContain(ciphertext);
  });
}

for (const code of ["invalid_encrypted_content", null]) {
  test(`Azure OpenAI's 'could not be verified' refusal of another issuer's ciphertext is recovered (code ${code})`, async () => {
    // Azure words the same refusal differently from api.openai.com.
    const refusal = {
      error: {
        message:
          "The encrypted content gAAA...aiQ= could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
        type: "invalid_request_error",
        param: null,
        code,
      },
    };
    const requests: Record<string, any>[] = [];
    const model = responsesModel(`origin-azure-wording-${code}`, requests, {
      refuses: (wire) =>
        wire.includes("encrypted_content") ? Response.json(refusal, { status: 400 }) : null,
    });
    const result = await runner.run(
      new Agent({ name: "Fixture", model }),
      legacyHistory() as never,
    );
    expect(result.finalOutput).toBe("Done.");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).not.toContain("encrypted_content");
  });
}

const rawThought = "Raw chain of thought from an open-weight model.";
// What OpenAI and Azure OpenAI answer for reasoning `content` they did not issue.
const rejectsRawReasoning = (wire: string) =>
  wire.includes("reasoning_text")
    ? Response.json(
        {
          error: {
            message:
              "Invalid 'input[2].content': array too long. Expected an array with maximum length 0, but got an array with length 1 instead.",
            type: "invalid_request_error",
            param: "input[2].content",
            code: "array_above_max_length",
          },
        },
        { status: 400 },
      )
    : null;

for (const stream of [false, true]) {
  test(`raw reasoning content goes back natively only to the provider that issued it (${stream ? "streamed" : "single"} reply)`, async () => {
    const issuer = responsesModel("raw-issuer", [], {
      reasoning: [
        {
          id: "raw-reason-fixture",
          type: "reasoning",
          summary: [],
          content: [{ type: "reasoning_text", text: rawThought }],
          encrypted_content: null,
        },
      ],
    });
    let output: unknown[] = [];
    if (stream) {
      await getOrCreateTrace(async () => {
        for await (const event of issuer.getStreamedResponse({ ...base, input: "Start" }))
          if (event.type === "response_done") output = event.response.output;
      });
    } else {
      output = (await getOrCreateTrace(() => issuer.getResponse({ ...base, input: "Start" })))
        .output;
    }
    const history = persisted(output);
    const reasoning = history.find((item) => item.type === "reasoning");
    expect(reasoning?.providerData).toHaveProperty([ARTIFACT_ORIGIN_KEY], "raw-issuer");

    const native = await wireFor("raw-issuer", history, stream);
    expect(native).toContain("reasoning_text");
    expect(native).not.toContain("artifact_origin");
    expect(native).not.toContain("Historical reasoning");

    const foreign = await wireFor("raw-other", history, stream);
    expect(foreign).not.toContain("reasoning_text");
    expect(foreign).not.toContain('"type":"reasoning"');
    expect(foreign).toContain(
      JSON.stringify(`[Historical reasoning from another model]\n${rawThought}`),
    );
  });
}

test("untagged raw reasoning from another provider is sent as readable text, never its content", async () => {
  // The stored shape of reasoning from a Responses-compatible custom provider
  // before origins covered raw reasoning: the raw text sits in providerData.
  const history = persisted([
    {
      id: "raw-legacy-fixture",
      type: "reasoning",
      content: [],
      providerData: {
        id: "raw-legacy-fixture",
        type: "reasoning",
        content: [{ type: "reasoning_text", text: rawThought }],
        encrypted_content: null,
      },
    },
    {
      id: "message-legacy-fixture",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Hello.", annotations: [] }],
    },
  ]);
  expect(JSON.stringify(history)).toContain("reasoning_text");
  const requests: Record<string, any>[] = [];
  const model = responsesModel("raw-legacy-receiver", requests, { refuses: rejectsRawReasoning });
  const result = await runner.run(new Agent({ name: "Fixture", model }), history as never);
  expect(result.finalOutput).toBe("Done.");
  expect(requests).toHaveLength(1);
  const wire = JSON.stringify(requests[0]);
  expect(wire).not.toContain("reasoning_text");
  expect(wire).toContain(
    JSON.stringify(`[Historical reasoning from another model]\n${rawThought}`),
  );
});

test("untagged raw reasoning becomes bounded readable text on every other route", () => {
  const longThought = "x".repeat(40_000);
  const untagged = (text: string, withCiphertext: boolean) => ({
    type: "reasoning",
    id: "rs_raw_fixture",
    content: [],
    providerData: {
      id: "rs_raw_fixture",
      type: "reasoning",
      content: [{ type: "reasoning_text", text }],
      encrypted_content: withCiphertext ? ciphertext : null,
    },
  });
  const user = { type: "message", role: "user", content: "Start" };

  // Raw content is refused for its shape, so ciphertext does not keep it native.
  const mixed = projectHistoryForProvider([user, untagged(rawThought, true)], "responses", {
    artifactScope: "raw-receiver",
  });
  const mixedWire = JSON.stringify(mixed);
  expect(mixedWire).not.toContain("reasoning_text");
  expect(mixedWire).not.toContain(ciphertext);
  expect(mixedWire).toContain(rawThought);

  for (const api of ["chat", "anthropic-messages"] as const) {
    const wire = JSON.stringify(
      projectHistoryForProvider([user, untagged(rawThought, false)], api),
    );
    expect(wire).not.toContain("reasoning_text");
    expect(wire).toContain(rawThought);
  }

  for (const api of ["responses", "chat", "anthropic-messages"] as const) {
    const wire = JSON.stringify(
      projectHistoryForProvider([user, untagged(longThought, false)], api, {
        artifactScope: "raw-receiver",
      }),
    );
    expect(wire).toContain("x".repeat(32_000));
    expect(wire).not.toContain("x".repeat(32_001));
  }
});

test("an unrelated bad request is not resent", async () => {
  const requests: Record<string, any>[] = [];
  const model = responsesModel("origin-unrelated", requests, {
    refuses: () =>
      Response.json(
        { error: { message: "Invalid value for 'input'.", type: "invalid_request_error" } },
        { status: 400 },
      ),
  });
  await expect(
    runner.run(new Agent({ name: "Fixture", model }), legacyHistory() as never),
  ).rejects.toThrow("Invalid value");
  expect(requests).toHaveLength(1);
});

test("the origin record is kept until a request names the receiving provider", () => {
  const tagged = {
    type: "reasoning",
    id: "rs_fixture",
    content: [{ type: "input_text", text: summary }],
    providerData: { id: "rs_fixture", type: "reasoning", encrypted_content: ciphertext },
  };
  tagged.providerData = { ...tagged.providerData, [ARTIFACT_ORIGIN_KEY]: "origin-a" } as never;
  const history = [{ type: "message", role: "user", content: "Start" }, tagged];

  // The worker's own projection does not know the provider and keeps the record.
  expect(projectHistoryForProvider(history, "responses")).toBe(history);

  const native = projectHistoryForProvider(history, "responses", { artifactScope: "origin-a" });
  expect(native[1]).toEqual({
    type: "reasoning",
    id: "rs_fixture",
    content: [{ type: "input_text", text: summary }],
    providerData: { id: "rs_fixture", type: "reasoning", encrypted_content: ciphertext },
  });
  // Repeated requests reuse the same projected object (append-only conversion).
  expect(projectHistoryForProvider(history, "responses", { artifactScope: "origin-a" })[1]).toBe(
    native[1],
  );

  const refused = projectHistoryForProvider(history, "responses", {
    artifactScope: "origin-a",
    isRejectedArtifact: () => true,
  });
  expect(JSON.stringify(refused[1])).not.toContain(ciphertext);

  for (const api of ["chat", "anthropic-messages"] as const)
    expect(JSON.stringify(projectHistoryForProvider(history, api))).not.toContain(ciphertext);
});
