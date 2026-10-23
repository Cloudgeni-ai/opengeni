import { describe, expect, test } from "bun:test";
import { Agent, Runner, tool, setTracingDisabled, type ModelRequest } from "@openai/agents";
import { z } from "zod";
import type { ResolvedModelProvider } from "@opengeni/config";
import {
  AnthropicMessagesModel,
  anthropicResponse,
  anthropicWritesProgressUpdates,
  buildAnthropicRequest,
} from "../src/anthropic-messages";
import {
  modelResponseHasProgressUpdate,
  modelResponseHasVisibleText,
} from "../src/input-wait-yield";
import { projectHistoryForProvider } from "../src/provider-history-adapter";
import { AssistantMessagePhaseTracker, normalizeSdkEvent } from "../src/run-events";

// Claude Opus 5.5 and Sonnet 5.5 can write a progress update before a tool
// call as its own signed `thinking` block. Under display "updates" reasoning
// comes back empty and only progress updates carry text, but that text is
// Anthropic's summary, not the words the model wrote. It must stay reasoning:
// shown as a thought, never as the agent's message or as a visible reply. In
// production such summaries claimed explanations the model never gave.

setTracingDisabled(true);
const provider: ResolvedModelProvider = {
  id: "claude",
  label: "Claude",
  kind: "api-key",
  api: "anthropic-messages",
  wireProfile: "openai",
  builtin: false,
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "test-key",
  credentialSource: { kind: "deployment", mechanism: "api_key" },
  billing: { upstreamPayer: "deployment", metering: "external" },
};
const request = (input: ModelRequest["input"] = "Plan the migration"): ModelRequest => ({
  input,
  systemInstructions: "Instructions",
  modelSettings: { reasoning: { effort: "medium" } },
  tools: [
    {
      type: "function",
      name: "wait_for_input",
      description: "Wait",
      parameters: { type: "object", properties: { reason: { type: "string" } } },
      strict: false,
    },
  ],
  handoffs: [],
  outputType: "text",
  tracing: false,
});
const response = (content: unknown[], stop = "tool_use") => ({
  id: "msg_progress",
  type: "message",
  role: "assistant",
  content,
  stop_reason: stop,
  usage: { input_tokens: 2, cache_read_input_tokens: 100, output_tokens: 7 },
});

const UPDATE =
  "Three things need your input before I start: the database, the rollout window and who owns it.";
// The shape of the rejected production responses: thinking, thinking, tool_use.
const reasoning = { type: "thinking", thinking: "", signature: "EqMBCkYICxIMreasoning" };
const progress = { type: "thinking", thinking: UPDATE, signature: "Es8CCkYICxIMprogress" };
const wait = {
  type: "tool_use",
  id: "toolu_wait",
  name: "wait_for_input",
  input: { reason: "Waiting for the three decisions." },
};
const updatesContent = [reasoning, progress, wait];
// The same response as display "summarized" returns it: both blocks carry text.
const summarizedContent = [
  { ...reasoning, thinking: "The person needs to decide three things; list them, then wait." },
  progress,
  wait,
];

function sse(frames: unknown[]) {
  return new Response(
    new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")),
    { headers: { "content-type": "text/event-stream", "request-id": "req_progress" } },
  );
}

/** The documented "updates" stream: reasoning streams one empty delta, the update streams text. */
function updatesStream(id = "msg_progress") {
  return sse([
    { type: "message_start", message: { ...response([], null as never), id } },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: reasoning.signature },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "thinking_delta", thinking: UPDATE.slice(0, 40) },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "thinking_delta", thinking: UPDATE.slice(40) },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "signature_delta", signature: progress.signature },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", id: wait.id, name: wait.name, input: {} },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(wait.input) },
    },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    { type: "message_stop" },
  ]);
}

const expectedOutput = [
  {
    type: "reasoning",
    id: "msg_progress:0",
    content: [],
    providerData: { anthropic: { block: reasoning } },
  },
  {
    type: "reasoning",
    id: "msg_progress:1",
    content: [{ type: "input_text", text: UPDATE }],
    // Marked so the wait guard asks for the verbatim reply argument.
    providerData: { anthropic: { block: progress, progressUpdate: true } },
  },
  {
    type: "function_call",
    id: "msg_progress:2",
    callId: "toolu_wait",
    name: "wait_for_input",
    arguments: JSON.stringify(wait.input),
    status: "completed",
  },
];

describe("Claude progress updates before a tool call", () => {
  test("only models that write progress updates ask for display updates", async () => {
    expect(anthropicWritesProgressUpdates("claude-opus-5-5")).toBe(true);
    expect(anthropicWritesProgressUpdates("claude-sonnet-5-5")).toBe(true);
    for (const model of ["claude-haiku-5-5", "claude-opus-5", "claude-opus-4-6", "claude-x"])
      expect(anthropicWritesProgressUpdates(model)).toBe(false);

    const sent: Array<{ body: any; betas: string[] }> = [];
    for (const model of ["claude-opus-5-5", "claude-opus-5"]) {
      const claude = new AnthropicMessagesModel(provider, model, (async (_url, init) => {
        sent.push({
          body: JSON.parse(String(init?.body)),
          betas: (new Headers(init?.headers).get("anthropic-beta") ?? "").split(","),
        });
        return Response.json(response([{ type: "text", text: "Done" }], "end_turn"));
      }) as typeof fetch);
      await claude.getResponse(request());
    }
    expect(sent[0]!.body.thinking).toEqual({ type: "adaptive", display: "updates" });
    expect(sent[0]!.betas).toContain("thinking-display-updates-2026-08-18");
    expect(sent[1]!.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(sent[1]!.betas).not.toContain("thinking-display-updates-2026-08-18");
  });

  test("thinking, thinking, tool_use: the summarized update stays reasoning, not a visible reply", async () => {
    const claude = new AnthropicMessagesModel(provider, "claude-opus-5-5", (async () =>
      Response.json(response(updatesContent))) as typeof fetch);
    const result = await claude.getResponse(request());
    expect(result.output).toEqual(expectedOutput as never);
    // The wait_for_input guard and every other visible-reply check read
    // messages: a summary must not satisfy them, so the model is asked again.
    expect(modelResponseHasVisibleText(result)).toBe(false);
    expect(result.output.some((item) => item.type === "message")).toBe(false);
  });

  test("streamed: the update streams as reasoning only, and empty reasoning streams nothing", async () => {
    const claude = new AnthropicMessagesModel(provider, "claude-opus-5-5", (async () =>
      updatesStream()) as typeof fetch);
    const events: any[] = [];
    for await (const event of claude.getStreamedResponse(request())) events.push(event);
    expect(events.some((event) => event.type === "output_text_delta")).toBe(false);
    expect(
      events
        .filter((event) => event.event?.type === "anthropic.thinking.delta")
        .map((event) => event.event.delta),
    ).toEqual([UPDATE.slice(0, 40), UPDATE.slice(40)]);
    expect(events.at(-1).response.output).toEqual(expectedOutput);
  });

  test("text the model wrote is kept verbatim, and a summarized update beside it never replaces it", async () => {
    const answer = [
      "Here is the full answer.",
      "",
      "**Routing.** A sub-agent can ask you or its parent.",
      "",
      "- Ask a person: a question form.",
      "- Ask its parent: a message.",
    ].join("\n");
    const claude = new AnthropicMessagesModel(provider, "claude-opus-5-5", (async () =>
      Response.json(
        response([reasoning, { type: "text", text: answer }, progress, wait]),
      )) as typeof fetch);
    const result = await claude.getResponse(request());
    const messages = result.output.filter((item) => item.type === "message");
    expect(messages).toEqual([
      {
        type: "message",
        role: "assistant",
        id: "msg_progress:1",
        status: "completed",
        content: [{ type: "output_text", text: answer }],
      },
    ] as never);
    expect(result.output.map((item) => item.type)).toEqual([
      "reasoning",
      "message",
      "reasoning",
      "function_call",
    ]);
    expect(modelResponseHasVisibleText(result)).toBe(true);
  });

  test("the df030716 13:13 UTC response: a whole reply returned as a summarized update, then the wait", async () => {
    // Opus 5.5 (high) wrote its answer, with three artifact images and a
    // table, before wait_for_input. Claude returned it as content index 1, a
    // signed thinking block whose only text is a one-paragraph summary: 915
    // output tokens, 801 of them thinking, so the words themselves never came
    // back. A worker without #5673 showed that summary as the agent's reply.
    const summary =
      "I confirmed the images weren't actually posted before (known bug #5673, fixed upstream but not in this release), so here are the actual before/A/B comparison pictures across devices and themes, along with a space-usage table. I'd lean toward option B for freeing up the most chat space, especially on phone — let me know which layout (A or B) you want so the worker can finish it, get it reviewed, and merge.\n\n";
    const update = { type: "thinking", thinking: summary, signature: "EpsEupdate" };
    const exactWait = {
      type: "tool_use",
      id: "toolu_01BmVpQSRzQAzEiBTn5vY3ah",
      name: "wait_for_input",
      input: {
        reason:
          "Waiting for your pick of A or B, and for the Site sidebar and live Site editing workers.",
        timeoutSeconds: 6900,
      },
    };
    const claude = new AnthropicMessagesModel(provider, "claude-opus-5-5", (async () =>
      Response.json({
        ...response([reasoning, update, exactWait]),
        id: "msg_011CgKEATPvLMvyNDMvWEjyi",
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 205_711,
          output_tokens: 915,
          output_tokens_details: { thinking_tokens: 801 },
        },
      })) as typeof fetch);
    const result = await claude.getResponse(request());
    expect(result.output.map((item) => item.type)).toEqual([
      "reasoning",
      "reasoning",
      "function_call",
    ]);
    expect(result.output[1]).toMatchObject({
      id: "msg_011CgKEATPvLMvyNDMvWEjyi:1",
      content: [{ type: "input_text", text: summary }],
      providerData: { anthropic: { block: update, progressUpdate: true } },
    });
    expect(result.usage.outputTokens).toBe(915);
    expect(result.usage.outputTokensDetails).toMatchObject([{ reasoning_tokens: 801 }]);
    // No message: nothing to show as the reply. The marker tells the wait
    // guard that what the model wrote for the person did not come back.
    expect(modelResponseHasVisibleText(result)).toBe(false);
    expect(modelResponseHasProgressUpdate(result)).toBe(true);
  });

  test("only display updates marks progress updates; reasoning summaries never are", async () => {
    const claude = new AnthropicMessagesModel(provider, "claude-opus-5", (async () =>
      Response.json(response(summarizedContent))) as typeof fetch);
    const result = await claude.getResponse(request());
    expect(modelResponseHasProgressUpdate(result)).toBe(false);
    // Empty reasoning under updates is not an update either.
    expect(
      modelResponseHasProgressUpdate({
        output: anthropicResponse(
          response([reasoning, wait]),
          undefined,
          undefined,
          undefined,
          [],
          null,
          {
            progressUpdates: true,
          },
        ).output,
      }),
    ).toBe(false);
  });

  test("a skipped (empty) progress update stays an empty reasoning item", () => {
    const output = anthropicResponse(
      response([reasoning, { ...progress, thinking: "" }, wait]),
      undefined,
      undefined,
      undefined,
      [],
      null,
    ).output;
    expect(output.map((item) => item.type)).toEqual(["reasoning", "reasoning", "function_call"]);
    expect(modelResponseHasVisibleText({ output })).toBe(false);
  });

  test("replay sends the signed blocks back byte-identical, in their original order", () => {
    const history: ModelRequest["input"] = [
      { role: "user", content: "Plan the migration" },
      ...(expectedOutput as never[]),
      {
        type: "function_call_result",
        name: "wait_for_input",
        callId: "toolu_wait",
        output: "Waiting",
      } as never,
    ];
    const before = JSON.stringify(history);
    const body = buildAnthropicRequest(request(history), "claude-opus-5-5", provider, true);
    const assistant = body.messages.find((message: any) => message.role === "assistant");
    expect(JSON.stringify(assistant.content)).toBe(JSON.stringify(updatesContent));
    expect(JSON.stringify(history)).toBe(before);

    // A later request keeps every earlier message byte-identical.
    const later = buildAnthropicRequest(
      request([
        ...history,
        { role: "assistant", content: "Noted." },
        { role: "user", content: "Postgres, Tuesday, me." },
      ]),
      "claude-opus-5-5",
      provider,
      true,
    );
    const strip = (messages: any[]) =>
      JSON.stringify(
        messages.map((message) => ({
          ...message,
          content: message.content.map(({ cache_control: _cache, ...block }: any) => block),
        })),
      );
    expect(strip(later.messages.slice(0, body.messages.length))).toBe(strip(body.messages));
  });

  test("earlier models and already-stored history keep their reasoning exactly as before", () => {
    // A model without progress updates: every thinking block is reasoning.
    const output = anthropicResponse(response(summarizedContent)).output;
    expect(output.map((item) => item.type)).toEqual(["reasoning", "reasoning", "function_call"]);
    expect(modelResponseHasVisibleText({ output })).toBe(false);

    // History recorded under "summarized" before this change replays unchanged
    // on the same model, now that it is requested with "updates".
    const stored: ModelRequest["input"] = [
      { role: "user", content: "Plan the migration" },
      ...(output as never[]),
      {
        type: "function_call_result",
        name: "wait_for_input",
        callId: "toolu_wait",
        output: "Waiting",
      } as never,
    ];
    const body = buildAnthropicRequest(request(stored), "claude-opus-5-5", provider, true);
    const assistant = body.messages.find((message: any) => message.role === "assistant");
    expect(JSON.stringify(assistant.content)).toBe(JSON.stringify(summarizedContent));
  });

  test("history stored while updates were assistant messages still replays the signed block", () => {
    // Between showing updates as messages and this fix, stored history holds
    // the summary as an assistant message carrying the signed block.
    const stored: ModelRequest["input"] = [
      { role: "user", content: "Plan the migration" },
      expectedOutput[0] as never,
      {
        type: "message",
        role: "assistant",
        id: "msg_progress:1",
        status: "completed",
        content: [
          { type: "output_text", text: UPDATE, providerData: { anthropic: { block: progress } } },
        ],
      } as never,
      expectedOutput[2] as never,
      {
        type: "function_call_result",
        name: "wait_for_input",
        callId: "toolu_wait",
        output: "Waiting",
      } as never,
    ];
    const body = buildAnthropicRequest(request(stored), "claude-opus-5-5", provider, true);
    const assistant = body.messages.find((message: any) => message.role === "assistant");
    expect(JSON.stringify(assistant.content)).toBe(JSON.stringify(updatesContent));
  });

  test("other providers see the update only as labelled historical reasoning, never the signed block", () => {
    const projected = projectHistoryForProvider(expectedOutput as never[], "responses");
    expect(projected[1]).toEqual({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: `[Historical reasoning from another model]\n${UPDATE}` },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain(progress.signature);
  });

  test("end to end: the update is a thought, never an agent message, and the tool loop replays it unchanged", async () => {
    const sent: any[] = [];
    const claude = new AnthropicMessagesModel(provider, "claude-opus-5-5", (async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return sent.length === 1
        ? updatesStream()
        : sse([
            {
              type: "message_start",
              message: { ...response([], null as never), id: "msg_final" },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 2 },
            },
            { type: "message_stop" },
          ]);
    }) as typeof fetch);
    const agent = new Agent({
      name: "Test",
      model: claude,
      modelSettings: { reasoning: { effort: "medium" } },
      tools: [
        tool({
          name: "wait_for_input",
          description: "Wait",
          parameters: z.object({ reason: z.string() }),
          execute: async () => "Waiting",
        }),
      ],
    });
    const run = await new Runner({ tracingDisabled: true }).run(agent, "Plan the migration", {
      stream: true,
    });
    const messagePhases = new AssistantMessagePhaseTracker();
    const normalized = [];
    for await (const event of run)
      normalized.push(...normalizeSdkEvent(event as never, { messagePhases }));
    await run.completed;
    expect(run.finalOutput).toBe("Done.");

    const visible = normalized.filter((event) => event.type.startsWith("agent.message"));
    expect(visible).toEqual([
      { type: "agent.message.delta", payload: { text: "Done.", messageId: "msg_final:0" } },
      {
        type: "agent.message.completed",
        payload: { text: "Done.", messageId: "msg_final:0", phase: "final_answer" },
      },
    ]);
    // The summary is shown only as a thought; empty reasoning adds nothing.
    expect(
      normalized
        .filter((event) => event.type === "agent.reasoning.delta")
        .map((event) => (event.payload as { text: string }).text),
    ).toEqual([UPDATE.slice(0, 40), UPDATE.slice(40)]);
    // The tool loop sent the first response back exactly as Claude produced it.
    const replayed = sent[1].messages.find((message: any) => message.role === "assistant");
    expect(JSON.stringify(replayed.content)).toBe(JSON.stringify(updatesContent));
  });
});
