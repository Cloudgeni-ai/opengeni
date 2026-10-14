import { expect, test } from "bun:test";
import { Agent, Runner, OpenAIChatCompletionsModel } from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";
import { OpenGeniChatCompletionsModel } from "../src/model-provider-routing";
import { modelRequestPolicyForProvider } from "../src/model-provider-request-policy";
import { ReplayableJsonOpenAI, requestBodyText } from "../src/replayable-json-body";

function policy(kind: ResolvedModelProvider["kind"] = "openrouter-workspace") {
  return modelRequestPolicyForProvider({
    id: "fixture",
    label: "Fixture",
    kind,
    api: "chat",
    builtin: false,
  });
}

for (const kind of [
  "openrouter-managed",
  "openrouter-workspace",
  "openrouter-organization",
] as const)
  for (const field of ["reasoning", "reasoning_content"] as const)
    for (const stream of [false, true]) {
      test(`OpenRouter Claude replays ${stream ? "streamed" : "legacy nonstreamed"} ${field}, ${kind}`, async () => {
        const requests: Record<string, any>[] = [];
        const client = new ReplayableJsonOpenAI(
          {
            apiKey: "fixture-key",
            baseURL: "https://example.test/v1",
            maxRetries: 0,
            fetch: async (_url, init) => {
              const body = JSON.parse(await requestBodyText(init?.body));
              requests.push(body);
              const common = { id: "reply-fixture", model: body.model, created: 1 };
              const message = {
                role: "assistant",
                content: "Fixture answer.",
                [field]: "Check the fixture.",
              };
              if (!body.stream)
                return Response.json({
                  ...common,
                  object: "chat.completion",
                  choices: [{ index: 0, message, finish_reason: "stop" }],
                });
              const chunks = [
                { delta: { [field]: "Check the fixture." }, finish_reason: null },
                { delta: { content: "Fixture answer." }, finish_reason: null },
                { delta: {}, finish_reason: "stop" },
              ].map((choice) => ({
                ...common,
                object: "chat.completion.chunk",
                choices: [{ index: 0, ...choice }],
              }));
              return new Response(
                chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
                  "data: [DONE]\n\n",
                { headers: { "content-type": "text/event-stream" } },
              );
            },
          },
          { modelRequestPolicy: policy(kind) },
        );
        const runner = new Runner({ tracingDisabled: true });
        const source = new Agent({
          name: "Fixture",
          model: stream
            ? new OpenGeniChatCompletionsModel(client, "fixture/source")
            : new OpenAIChatCompletionsModel(client, "fixture/source"),
        });
        let history;
        if (stream) {
          const run = await runner.run(source, "Start", { stream: true });
          for await (const _event of run) {
            /* consume SDK stream */
          }
          await run.completed;
          history = run.history;
        } else history = (await runner.run(source, "Start")).history;
        const persisted = JSON.parse(JSON.stringify(history));
        const before = JSON.stringify(persisted);
        const target = new Agent({
          name: "Fixture",
          model: new OpenGeniChatCompletionsModel(client, "anthropic/claude-fixture"),
        });
        await runner.run(target, [...persisted, { role: "user", content: "Continue" }]);
        const messages = requests.at(-1)!.messages;
        for (const message of messages) {
          expect(message.reasoning).toBeUndefined();
          expect(message.reasoning_content).toBeUndefined();
        }
        expect(JSON.stringify(messages).split("Check the fixture.")).toHaveLength(2);
        expect(JSON.stringify(messages)).toContain(
          "Historical reasoning without a provider signature",
        );
        expect(JSON.stringify(persisted)).toBe(before);
        expect(before).toContain("Check the fixture.");
      });
    }

const signed = {
  type: "reasoning.text",
  text: "Signed fixture.",
  signature: "signature-fixture",
  format: "anthropic-claude-v1",
};
const encrypted = {
  type: "reasoning.encrypted",
  data: "opaque-fixture",
  format: "anthropic-claude-v1",
};

test("Claude guard preserves signed/encrypted details, tool pairing, content extensions and empty signals", () => {
  const body = {
    model: "anthropic/claude-fixture",
    messages: [
      {
        role: "assistant",
        content: "Answer.",
        reasoning: "Signed fixture.",
        reasoning_details: [signed, encrypted],
      },
      { role: "user", content: "Next" },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Checking.",
            cache_control: { type: "ephemeral" },
            reasoning: "Unsigned fixture.",
          },
        ],
        reasoning_details: [],
        tool_calls: [
          { id: "call-fixture", type: "function", function: { name: "lookup", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call-fixture", content: "Result." },
    ],
  };
  const before = JSON.stringify(body);
  const projected = policy()({ path: "/chat/completions?fixture=1", body })!.body! as typeof body;
  expect(projected.messages[0]).toEqual(body.messages[0]);
  expect(projected.messages[2]?.reasoning_details).toEqual([]);
  expect(projected.messages[2]?.content).toEqual([
    {
      type: "text",
      text: "[Historical reasoning without a provider signature]\nUnsigned fixture.",
    },
    { type: "text", text: "Checking.", cache_control: { type: "ephemeral" } },
  ]);
  expect(projected.messages[2]?.tool_calls).toEqual(body.messages[2]?.tool_calls);
  expect(projected.messages[3]).toEqual(body.messages[3]);
  expect(JSON.stringify(body)).toBe(before);
  expect(policy()({ path: "/chat/completions", body: projected })).toBeUndefined();
});

test("Claude guard handles unsigned details without discarding distinct readable text", () => {
  for (const details of [
    undefined,
    [],
    [{ type: "reasoning.encrypted" }],
    [{ type: "reasoning.summary", summary: "Summary.", format: "openai-responses-v1" }],
    [{ type: "reasoning.text", text: "Other fixture.", signature: "" }],
  ]) {
    const body = {
      model: "anthropic/claude-fixture",
      messages: [
        {
          role: "assistant",
          content: null,
          reasoning: "Alias fixture.",
          reasoning_content: "Alias fixture.",
          reasoning_details: details,
        },
      ],
    };
    const before = JSON.stringify(body);
    const projected = policy()({ path: "/chat/completions", body })!.body!;
    const message = (projected.messages as Record<string, any>[])[0]!;
    expect(message.reasoning).toBeUndefined();
    expect(message.reasoning_content).toBeUndefined();
    expect(JSON.stringify(message.content)).toContain("Alias fixture.");
    if (details?.[0]?.type === "reasoning.text") {
      expect(JSON.stringify(message.content)).toContain("Other fixture.");
      expect(message.reasoning_details).toEqual([]);
    }
    expect(JSON.stringify(body)).toBe(before);
  }
});

test("mixed signed and unsigned details retain native blocks and project only unsigned text", () => {
  const unsigned = {
    type: "reasoning.text",
    text: "Unsigned fixture.",
    format: "anthropic-claude-v1",
  };
  const body = {
    model: "anthropic/claude-fixture",
    messages: [
      {
        role: "assistant",
        content: "Answer.",
        reasoning: "Signed fixture.Unsigned fixture.",
        reasoning_details: [signed, unsigned, encrypted],
      },
    ],
  };
  const message = (
    policy()({ path: "/chat/completions", body })!.body!.messages as Record<string, any>[]
  )[0]!;
  expect(message.reasoning_details).toEqual([signed, encrypted]);
  expect(message.reasoning).toBeUndefined();
  expect(JSON.stringify(message.content)).toContain("Unsigned fixture.");
  expect(JSON.stringify(message.content)).not.toContain("Signed fixture.");
  expect(JSON.stringify(message.content)).not.toContain("opaque-fixture");
});

test("guard leaves other models, providers, APIs and non-assistant messages unchanged", () => {
  const messages = [
    { role: "assistant", content: "Answer.", reasoning_content: "Native fixture." },
  ];
  for (const kind of ["openrouter-workspace", "api-key"] as const) {
    const body = {
      model: kind === "api-key" ? "anthropic/claude-fixture" : "deepseek/fixture",
      messages,
    };
    expect(policy(kind)({ path: "/chat/completions", body })).toBeUndefined();
  }
  const body = { model: "anthropic/claude-fixture", messages };
  expect(policy()({ path: "/responses", body })).toBeUndefined();
  expect(
    policy()({
      path: "/chat/completions",
      body: { ...body, messages: [{ ...messages[0], role: "user" }] },
    }),
  ).toBeUndefined();
});
