import { describe, expect, test } from "bun:test";
import OpenAI from "openai";
import type { ModelRequest, StreamEvent } from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";
import { AnthropicMessagesModel } from "../src/anthropic-messages";
import { OpenGeniResponsesModel } from "../src/model-provider-routing";
import { AssistantMessagePhaseTracker } from "../src/run-events";
import {
  ModelPreemption,
  isPreemptedModelResponse,
  preemptedResponseCutOffText,
  preemptedResponseDone,
  streamWithPreemption,
} from "../src/model-preemption";

const request = (): ModelRequest => ({
  input: "Hello",
  systemInstructions: "Instructions",
  modelSettings: {},
  tools: [],
  handoffs: [],
  outputType: "text",
  tracing: false,
});

/** An SSE body that sends `frames`, then stays open until the request aborts. */
function openStream(frames: string[], signal: AbortSignal | null | undefined, headers = {}) {
  const bytes = new TextEncoder().encode(frames.join(""));
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        const fail = () => controller.error(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      },
    }),
    { headers: { "content-type": "text/event-stream", ...headers } },
  );
}

/** Run until `cutWhen` sees an event, then preempt; collect everything. */
async function preemptAfter(
  open: (request: ModelRequest) => AsyncIterable<StreamEvent>,
  cutWhen: ((event: StreamEvent) => boolean) | { afterMs: number },
) {
  const preemption = new AbortController();
  const events: StreamEvent[] = [];
  const timer =
    typeof cutWhen === "function"
      ? undefined
      : setTimeout(() => preemption.abort(new ModelPreemption()), cutWhen.afterMs);
  for await (const event of streamWithPreemption(request(), preemption.signal, open)) {
    events.push(event);
    if (typeof cutWhen === "function" && cutWhen(event)) preemption.abort(new ModelPreemption());
  }
  clearTimeout(timer);
  const done = events.at(-1) as Extract<StreamEvent, { type: "response_done" }>;
  return { events, done };
}

describe("streamWithPreemption", () => {
  test("without a preemption signal it is a plain pass-through", async () => {
    const done = preemptedResponseDone({ output: [] });
    const seen: StreamEvent[] = [];
    for await (const event of streamWithPreemption(request(), undefined, async function* () {
      yield { type: "response_started" } as StreamEvent;
      yield { ...done, response: { ...done.response, providerData: {} } } as StreamEvent;
    }))
      seen.push(event);
    expect(seen).toHaveLength(2);
    expect(isPreemptedModelResponse(seen[1])).toBe(false);
  });

  test("a Steer before dispatch sends nothing and ends with an empty response", async () => {
    const preemption = new AbortController();
    preemption.abort(new ModelPreemption());
    let opened = false;
    const seen: StreamEvent[] = [];
    for await (const event of streamWithPreemption(
      request(),
      preemption.signal,
      async function* () {
        opened = true;
        yield { type: "response_started" } as StreamEvent;
      },
    ))
      seen.push(event);
    expect(opened).toBe(false);
    expect(seen).toHaveLength(1);
    expect(isPreemptedModelResponse(seen[0])).toBe(true);
    expect((seen[0] as any).response.output).toEqual([]);
  });

  test("a transport that throws on preemption still ends cleanly with its streamed text", async () => {
    const { done } = await preemptAfter(
      async function* (req) {
        yield { type: "output_text_delta", delta: "Half an ans", itemId: "m1" } as StreamEvent;
        await new Promise((_, reject) => {
          if (req.signal!.aborted) reject(req.signal!.reason);
          req.signal!.addEventListener("abort", () => reject(req.signal!.reason), { once: true });
        });
      },
      (event) => event.type === "output_text_delta",
    );
    expect(isPreemptedModelResponse(done)).toBe(true);
    expect(done.response.output).toEqual([]);
    expect(preemptedResponseCutOffText(done)).toBe("Half an ans");
  });

  test("the caller's own cancellation and ordinary failures still propagate", async () => {
    const caller = new AbortController();
    const preemption = new AbortController();
    const run = async () => {
      for await (const _ of streamWithPreemption(
        { ...request(), signal: caller.signal },
        preemption.signal,
        async function* (req) {
          yield { type: "response_started" } as StreamEvent;
          caller.abort(new Error("stopped"));
          req.signal!.throwIfAborted();
        },
      )) {
      }
    };
    await expect(run()).rejects.toThrow("stopped");
    const failing = async () => {
      for await (const _ of streamWithPreemption(request(), preemption.signal, async function* () {
        yield { type: "response_started" } as StreamEvent;
        throw new Error("provider down");
      })) {
      }
    };
    await expect(failing()).rejects.toThrow("provider down");
  });

  test("a kept message's streamed text beyond what was kept is reported as cut off", async () => {
    const { done } = await preemptAfter(
      async function* (req) {
        yield { type: "output_text_delta", delta: "Finished.", itemId: "m1" } as StreamEvent;
        yield { type: "output_text_delta", delta: " Unfinished", itemId: "m1" } as StreamEvent;
        await new Promise((resolve) => {
          if (req.signal!.aborted) resolve(undefined);
          req.signal!.addEventListener("abort", resolve, { once: true });
        });
        yield preemptedResponseDone({
          output: [
            {
              type: "message",
              role: "assistant",
              id: "m1",
              status: "completed",
              content: [{ type: "output_text", text: "Finished." }],
            },
          ],
        });
      },
      (event) => event.type === "output_text_delta" && (event as any).delta === " Unfinished",
    );
    expect(done.response.output).toHaveLength(1);
    expect(preemptedResponseCutOffText(done)).toBe(" Unfinished");
  });

  test("keeps only completed assistant messages, as plain text with their id and phase", () => {
    const done = preemptedResponseDone({
      id: "resp_1",
      output: [
        {
          type: "message",
          role: "assistant",
          id: "m1",
          status: "completed",
          phase: "commentary",
          content: [{ type: "output_text", text: "Checking", annotations: [], logprobs: [] }],
        },
        { type: "message", role: "assistant", id: "m2", status: "in_progress", content: [] },
        { type: "reasoning", id: "r1", summary: [], encrypted_content: "secret" },
        { type: "function_call", call_id: "c1", name: "run", arguments: "{}" },
      ],
    });
    expect(done.response.output).toEqual([
      {
        type: "message",
        role: "assistant",
        status: "completed",
        id: "m1",
        phase: "commentary",
        content: [{ type: "output_text", text: "Checking" }],
      } as any,
    ]);
  });
});

describe("Responses transport preemption", () => {
  const sse = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`;
  const item = (id: string, text: string, status: string) => ({
    type: "message",
    id,
    role: "assistant",
    status,
    content: status === "completed" ? [{ type: "output_text", text, annotations: [] }] : [],
  });

  test("a Steer mid-stream keeps the message marked done and drops the rest", async () => {
    const frames = [
      sse({
        type: "response.created",
        sequence_number: 0,
        response: { id: "resp_cut", object: "response", status: "in_progress", output: [] },
      }),
      sse({
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 0,
        item: item("m1", "", "in_progress"),
      }),
      sse({
        type: "response.output_text.delta",
        sequence_number: 2,
        item_id: "m1",
        output_index: 0,
        content_index: 0,
        delta: "Checking the logs.",
      }),
      sse({
        type: "response.output_item.done",
        sequence_number: 3,
        output_index: 0,
        item: item("m1", "Checking the logs.", "completed"),
      }),
      sse({
        type: "response.output_item.added",
        sequence_number: 4,
        output_index: 1,
        item: item("m2", "", "in_progress"),
      }),
      sse({
        type: "response.output_text.delta",
        sequence_number: 5,
        item_id: "m2",
        output_index: 1,
        content_index: 0,
        delta: "Next I will",
      }),
    ];
    const client = new OpenAI({
      apiKey: "fixture",
      baseURL: "https://fixture.invalid/v1",
      maxRetries: 0,
      fetch: async (_url, init) => openStream(frames, init?.signal),
    });
    const model = new OpenGeniResponsesModel(client, "fixture", {
      id: "openai",
      label: "OpenAI",
      kind: "api-key",
      api: "responses",
      builtin: true,
    } as ResolvedModelProvider);
    const { done } = await preemptAfter(
      (req) => model.getStreamedResponse(req),
      (event) => event.type === "output_text_delta" && (event as any).delta === "Next I will",
    );
    expect(isPreemptedModelResponse(done)).toBe(true);
    expect(done.response.id).toBe("resp_cut");
    expect(done.response.output).toEqual([
      {
        type: "message",
        role: "assistant",
        status: "completed",
        id: "m1",
        content: [{ type: "output_text", text: "Checking the logs." }],
      } as any,
    ]);
    expect(preemptedResponseCutOffText(done)).toBe("Next I will");
    // Responses reports usage only on its terminal event.
    expect(done.response.usage.outputTokens).toBe(0);
  });
});

describe("Claude transport preemption", () => {
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
  } as ResolvedModelProvider;
  const sse = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\r\n\r\n`;

  test("keeps closed text blocks under their streamed ids and records input usage", async () => {
    const frames = [
      sse({
        type: "message_start",
        message: {
          id: "msg_cut",
          type: "message",
          role: "assistant",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 5, cache_read_input_tokens: 1_000, output_tokens: 1 },
        },
      }),
      sse({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
      sse({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "plan" },
      }),
      sse({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig" },
      }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      sse({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Looking now." },
      }),
      sse({ type: "content_block_stop", index: 1 }),
      sse({
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_x", name: "run", input: {} },
      }),
      sse({
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"cmd":' },
      }),
    ];
    const model = new AnthropicMessagesModel(provider, "claude", (async (_url, init) =>
      openStream(frames, init?.signal, { "request-id": "req_cut" })) as typeof fetch);

    // Cut while the text block is still streaming: nothing is kept, and the
    // streamed text is reported as cut off.
    const early = await preemptAfter(
      (req) => model.getStreamedResponse(req),
      (event) => event.type === "output_text_delta",
    );
    expect(isPreemptedModelResponse(early.done)).toBe(true);
    expect(early.done.response.output).toEqual([]);
    expect(preemptedResponseCutOffText(early.done)).toBe("Looking now.");

    // Cut after the text block closed, while a tool call is still streaming.
    const { done } = await preemptAfter((req) => model.getStreamedResponse(req), { afterMs: 100 });
    expect(isPreemptedModelResponse(done)).toBe(true);
    expect(done.response.requestId).toBe("req_cut");
    // Thinking and the unfinished tool call are dropped; the closed text keeps
    // the id its deltas used (`msg:1`), so the timeline does not repeat it.
    expect(done.response.output).toEqual([
      {
        type: "message",
        role: "assistant",
        status: "completed",
        id: "msg_cut:1",
        content: [{ type: "output_text", text: "Looking now." }],
      } as any,
    ]);
    expect(preemptedResponseCutOffText(done)).toBe("");
    expect(done.response.usage.inputTokens).toBe(1_005);
  });
});

test("a Claude message whose adjacent text block is still open is unfinished as a whole", async () => {
  const provider = {
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
  } as ResolvedModelProvider;
  const sse = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\r\n\r\n`;
  const frames = [
    sse({
      type: "message_start",
      message: {
        id: "msg_adj",
        type: "message",
        role: "assistant",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 3, output_tokens: 1 },
      },
    }),
    sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Finished." },
    }),
    sse({ type: "content_block_stop", index: 0 }),
    sse({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    sse({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: " Unfinished" },
    }),
  ];
  const model = new AnthropicMessagesModel(provider, "claude", (async (_url, init) =>
    openStream(frames, init?.signal)) as typeof fetch);
  const { done } = await preemptAfter((req) => model.getStreamedResponse(req), { afterMs: 100 });
  // Both blocks stream under one message id; keeping only its first block
  // would replace the text the person saw with less of it.
  expect(done.response.output).toEqual([]);
  expect(preemptedResponseCutOffText(done)).toBe("Finished. Unfinished");
});

describe("phase of a preempted response", () => {
  const message = {
    type: "message",
    role: "assistant",
    id: "m1",
    status: "completed",
    content: [{ type: "output_text", text: "Half done." }],
  };
  const phaseAfter = (done: unknown) => {
    const tracker = new AssistantMessagePhaseTracker();
    tracker.observe({
      type: "raw_model_stream_event",
      data: { type: "response_started" },
    } as never);
    tracker.observe({ type: "raw_model_stream_event", data: done } as never);
    return tracker.messageItemPhase(message);
  };

  test("what a Steer cut short is a progress note, never the final answer", () => {
    const preempted = preemptedResponseDone({ output: [message] });
    expect(phaseAfter(preempted)).toBe("commentary");
    const finished = { ...preempted, response: { ...preempted.response, providerData: {} } };
    expect(phaseAfter(finished)).toBe("final_answer");
  });
});
