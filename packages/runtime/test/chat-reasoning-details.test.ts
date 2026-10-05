import { expect, test } from "bun:test";
import { Agent, Runner, tool } from "@openai/agents";
import { z } from "zod";
import { OpenGeniChatCompletionsModel } from "../src/model-provider-routing";
import { ReplayableJsonOpenAI, requestBodyText } from "../src/replayable-json-body";
import {
  modelRequestPolicyForProvider,
  chatModelRequestPolicy,
} from "../src/model-provider-request-policy";
import { normalizeSdkEvent } from "../src/run-events";
import { projectHistoryForProvider } from "../src/provider-history-adapter";
import {
  appendChatReasoningDetails,
  chatReasoningDetailsText,
  joinChatReasoningMessages,
} from "../src/chat-reasoning";

const readableDeltas = [
  {
    type: "reasoning.text",
    text: "Compare ",
    signature: null,
    id: "reason-fixture",
    index: 0,
    format: "anthropic-claude-v1",
  },
  {
    type: "reasoning.text",
    text: "the images.",
    signature: "signature-fixture",
    id: "reason-fixture",
    index: 0,
    format: "anthropic-claude-v1",
  },
];
const readable = [{ ...readableDeltas[1], text: "Compare the images." }];
const encrypted = {
  type: "reasoning.encrypted",
  data: "opaque-fixture",
  index: 0,
  format: "anthropic-claude-v1",
};

for (const stream of [false, true])
  for (const mode of [
    "alias",
    "details-only",
    "distinct",
    "summary",
    "encrypted-only",
    "empty",
  ] as const) {
    test(`Chat structured reasoning: stream=${stream}, ${mode}, parallel image tools and resumed history`, async () => {
      const summary = {
        type: "reasoning.summary",
        summary: "Compare the images.",
        index: 0,
        format: "openai-responses-v1",
      };
      const distinct = [
        { ...readable[0], text: "Compare ", id: "reason-first", signature: "signature-first" },
        { ...readable[0], text: "the images.", id: "reason-second", signature: "signature-second" },
      ];
      const details =
        mode === "empty"
          ? []
          : mode === "encrypted-only"
            ? [encrypted]
            : mode === "distinct"
              ? [...distinct, encrypted]
              : mode === "summary"
                ? [summary, encrypted]
                : [...readable, encrypted];
      const detailDeltas =
        mode === "distinct"
          ? [...distinct, encrypted]
          : mode === "summary"
            ? [
                { ...summary, summary: "Compare " },
                { ...summary, summary: "the images." },
                encrypted,
              ]
            : mode === "encrypted-only" || mode === "empty"
              ? details
              : [...readableDeltas, encrypted];
      const hasReadable = mode !== "encrypted-only" && mode !== "empty";
      const requests: Record<string, any>[] = [];
      const events: ReturnType<typeof normalizeSdkEvent> = [];
      let executions = 0;
      const fixture = tool({
        name: "image_fixture",
        description: "Return a fixture image",
        parameters: z.object({ label: z.string() }),
        execute: async ({ label }) => {
          executions++;
          return [
            { type: "text", text: `Fixture ${label}` },
            { type: "image", image: { url: `https://example.test/${label}.png` } },
          ];
        },
      });
      const provider = {
        id: "fixture",
        label: "Fixture",
        kind: "openrouter-workspace",
        api: "chat",
        builtin: false,
      } as const;
      const client = new ReplayableJsonOpenAI(
        {
          apiKey: "fixture-key",
          baseURL: "https://example.test/v1",
          maxRetries: 0,
          fetch: async (_url, init) => {
            const body = JSON.parse(await requestBodyText(init?.body));
            requests.push(body);
            const first = requests.length === 1;
            const common = {
              id: `reply-fixture-${requests.length}`,
              model: "fixture-chat",
              created: 1,
            };
            const calls = ["first", "second"].map((label) => ({
              id: `call-${label}`,
              type: "function",
              function: { name: "image_fixture", arguments: JSON.stringify({ label }) },
            }));
            const content = first ? (mode === "encrypted-only" ? null : "Checking.") : "Compared.";
            const finish_reason = first ? "tool_calls" : "stop";
            const message = {
              role: "assistant",
              content,
              ...(first
                ? {
                    reasoning_details: details,
                    tool_calls: calls,
                    ...(mode === "alias" ? { reasoning: "Compare the images." } : {}),
                  }
                : {}),
            };
            if (!body.stream)
              return Response.json({
                ...common,
                object: "chat.completion",
                choices: [{ index: 0, message, finish_reason }],
              });
            const deltas = first
              ? [
                  ...(mode === "empty" ? [{ reasoning_details: [] }] : []),
                  ...detailDeltas.map((detail) => ({
                    reasoning_details: [detail],
                    ...(mode === "alias" && detail.type === "reasoning.text"
                      ? { reasoning: detail.text }
                      : {}),
                  })),
                  ...(content ? [{ content }] : []),
                  { tool_calls: calls.map((call, index) => ({ ...call, index })) },
                ]
              : [{ role: "assistant", content }];
            return new Response(
              [
                ...deltas.map((delta) => ({
                  ...common,
                  object: "chat.completion.chunk",
                  choices: [{ index: 0, delta, finish_reason: null }],
                })),
                {
                  ...common,
                  object: "chat.completion.chunk",
                  choices: [{ index: 0, delta: {}, finish_reason }],
                },
              ]
                .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
                .join("") + "data: [DONE]\n\n",
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        },
        { modelRequestPolicy: modelRequestPolicyForProvider(provider) },
      );
      const agent = new Agent({
        name: "Fixture",
        model: new OpenGeniChatCompletionsModel(client, "fixture-chat"),
        tools: [fixture],
      });
      const runner = new Runner({ tracingDisabled: true });
      let history: unknown;
      if (stream) {
        const result = await runner.run(agent, "Compare fixture images", { stream: true });
        for await (const event of result) events.push(...normalizeSdkEvent(event));
        await result.completed;
        expect(result.finalOutput).toBe("Compared.");
        history = result.history;
        expect(
          events
            .filter((event) => event.type === "agent.reasoning.delta")
            .map((event) => event.payload.text)
            .join(""),
        ).toBe(hasReadable ? "Compare the images." : "");
        expect(JSON.stringify(events)).not.toContain("signature-fixture");
        expect(JSON.stringify(events)).not.toContain("opaque-fixture");
      } else {
        const result = await runner.run(agent, "Compare fixture images");
        expect(result.finalOutput).toBe("Compared.");
        history = result.history;
      }
      expect(executions).toBe(2);
      const persisted = JSON.parse(JSON.stringify(history));
      const before = JSON.stringify(persisted);
      if (mode !== "empty") expect(before).toContain("opaque-fixture");
      await runner.run(agent, [...persisted, { role: "user", content: "Continue" }]);
      expect(executions).toBe(2);
      for (const request of requests.slice(1)) {
        const assistant = request.messages.find((message: any) => message.tool_calls?.length);
        expect(assistant.reasoning_details).toEqual(details);
        expect(assistant.reasoning).toBe(mode === "alias" ? "Compare the images." : undefined);
        for (const part of assistant.content ?? []) expect(part.reasoning_details).toBeUndefined();
        const callIndex = request.messages.indexOf(assistant);
        expect(
          request.messages.slice(callIndex + 1, callIndex + 3).map((message: any) => message.role),
        ).toEqual(["tool", "tool"]);
        expect(request.messages[callIndex + 3].role).toBe("user");
        expect(
          request.messages[callIndex + 3].content.filter((part: any) => part.type === "image_url"),
        ).toHaveLength(2);
      }
      for (const api of ["responses", "anthropic-messages"] as const) {
        const foreign = JSON.stringify(projectHistoryForProvider(persisted, api));
        expect(foreign).not.toContain("opaque-fixture");
        expect(foreign).not.toContain("signature-fixture");
        expect(foreign).not.toContain("reasoning_details");
        if (hasReadable) expect(foreign.split("Compare the images.")).toHaveLength(2);
      }
      expect(JSON.stringify(persisted)).toBe(before);
    });
  }

test("stream details preserve type boundaries, late signatures, discrete opaque blocks and source objects", () => {
  const deltas = [
    { type: "reasoning.text", text: "Read ", index: 0 },
    { type: "reasoning.text", text: "fixture.", index: 0 },
    {
      type: "reasoning.text",
      signature: "signature-fixture",
      format: "anthropic-claude-v1",
      index: 0,
    },
    encrypted,
    encrypted,
    { type: "reasoning.summary", summary: "Check ", index: 0 },
    { type: "reasoning.summary", summary: "fixture.", index: 0 },
    { type: "unknown", data: "future-fixture", index: 0 },
    { type: "reasoning.text", text: "Separate block.", index: 0 },
  ];
  const before = JSON.stringify(deltas);
  const accumulated: Record<string, unknown>[] = [];
  for (const delta of deltas) appendChatReasoningDetails(accumulated, [delta]);
  expect(accumulated).toEqual([
    {
      type: "reasoning.text",
      text: "Read fixture.",
      index: 0,
      signature: "signature-fixture",
      format: "anthropic-claude-v1",
    },
    encrypted,
    encrypted,
    { type: "reasoning.summary", summary: "Check fixture.", index: 0 },
    { type: "unknown", data: "future-fixture", index: 0 },
    { type: "reasoning.text", text: "Separate block.", index: 0 },
  ]);
  expect(JSON.stringify(deltas)).toBe(before);
});

test("legacy structured details are lifted immutably; separate reasoning boundaries never merge", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Checking", reasoning_details: readable }],
      },
    ],
  };
  const before = JSON.stringify(body);
  const projected = chatModelRequestPolicy({ path: "/chat/completions", body })!;
  expect(projected.body?.messages).toEqual([
    {
      role: "assistant",
      content: [{ type: "text", text: "Checking" }],
      reasoning_details: readable,
    },
  ]);
  expect(JSON.stringify(body)).toBe(before);
  expect(
    chatModelRequestPolicy({ path: "/chat/completions", body: projected.body! }),
  ).toBeUndefined();
  const separate = [
    { role: "assistant", content: [], reasoning_details: readable },
    { role: "assistant", content: [], reasoning_details: readable },
  ];
  expect(joinChatReasoningMessages(separate)).toBe(separate);
  expect(
    chatReasoningDetailsText([
      encrypted,
      { type: "unknown", data: "opaque", text: "not readable" },
    ]),
  ).toBe("");
});

for (const type of ["reasoning.text", "reasoning.summary"]) {
  for (const key of ["id", "index", "signature", "format"]) {
    test(`streamed ${type} preserves distinct ${key} identities`, () => {
      const field = type === "reasoning.text" ? "text" : "summary";
      const first = { type, [field]: "First.", [key]: key === "index" ? 0 : "first" };
      const second = { type, [field]: "Second.", [key]: key === "index" ? 1 : "second" };
      const before = JSON.stringify([first, second]);
      const accumulated: Record<string, unknown>[] = [];
      appendChatReasoningDetails(accumulated, [first, second]);
      expect(accumulated).toEqual([first, second]);
      expect(JSON.stringify([first, second])).toBe(before);
    });
  }
}
