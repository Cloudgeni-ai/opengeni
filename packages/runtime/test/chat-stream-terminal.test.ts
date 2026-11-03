import { describe, expect, test } from "bun:test";
import { Agent, Runner, tool, type ModelRequest } from "@openai/agents";
import OpenAI from "openai";
import { z } from "zod";
import { OpenGeniChatCompletionsModel } from "../src/model-provider-routing";
import {
  isPreemptedModelResponse,
  preemptedResponseCutOffText,
  streamWithPreemption,
} from "../src/model-preemption";

const request: ModelRequest = {
  input: "fixture",
  modelSettings: {},
  tools: [],
  handoffs: [],
  outputType: "text",
  tracing: false,
};

function chunk(delta: Record<string, unknown>, finishReason: unknown = null, index = 0) {
  return {
    id: "chat-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: "fixture",
    choices: [{ index, delta, finish_reason: finishReason }],
  };
}

function reply(chunks: unknown[], done = false): Response {
  return new Response(
    chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") +
      (done ? "data: [DONE]\n\n" : ""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function modelFor(chunks: unknown[], done = false) {
  return new OpenGeniChatCompletionsModel(
    new OpenAI({ apiKey: "fixture", maxRetries: 0, fetch: async () => reply(chunks, done) }),
    "fixture",
  );
}

function abortableModel() {
  return new OpenGeniChatCompletionsModel(
    new OpenAI({
      apiKey: "fixture",
      maxRetries: 0,
      fetch: async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify(chunk({ content: "partial" }))}\n\n`,
                ),
              );
              const stop = () => controller.error(init?.signal?.reason);
              if (init?.signal?.aborted) stop();
              else init?.signal?.addEventListener("abort", stop, { once: true });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    }),
    "fixture",
  );
}

async function collect(model: OpenGeniChatCompletionsModel) {
  const events = [];
  let error: unknown;
  try {
    for await (const event of model.getStreamedResponse(request)) events.push(event);
  } catch (caught) {
    error = caught;
  }
  return { events, error };
}

describe("Chat stream completion evidence", () => {
  test("a caller abort retains its exact reason rather than becoming provider failure", async () => {
    const caller = new AbortController();
    const reason = new DOMException("fixture cancellation", "AbortError");
    const events = [];
    let error: unknown;
    try {
      for await (const event of abortableModel().getStreamedResponse({
        ...request,
        signal: caller.signal,
      })) {
        events.push(event);
        if (event.type === "output_text_delta") caller.abort(reason);
      }
    } catch (caught) {
      error = caught;
    }
    expect(error).toBe(reason);
    expect(events.some((event) => event.type === "response_done")).toBe(false);
  });

  test("actual Runner cancellation remains cancellation", async () => {
    const caller = new AbortController();
    const run = await new Runner({ tracingDisabled: true }).run(
      new Agent({ name: "fixture", model: abortableModel() }),
      "fixture",
      { stream: true, signal: caller.signal },
    );
    let error: unknown;
    try {
      for await (const event of run) {
        if (event.type === "raw_model_stream_event" && event.data.type === "output_text_delta")
          caller.abort();
      }
      await run.completed;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeUndefined();
    expect(caller.signal.aborted).toBe(true);
  });

  test("Steer keeps cut-off text display-only through the actual Chat adapter", async () => {
    const steer = new AbortController();
    const model = abortableModel();
    const events = [];
    for await (const event of streamWithPreemption(request, steer.signal, (input) =>
      model.getStreamedResponse(input),
    )) {
      events.push(event);
      if (event.type === "output_text_delta") steer.abort();
    }
    const done = events.at(-1);
    expect(isPreemptedModelResponse(done)).toBe(true);
    expect(preemptedResponseCutOffText(done)).toBe("partial");
    expect(done?.type === "response_done" && done.response.output).toEqual([]);
  });

  for (const done of [false, true]) {
    test(`partial text without a finish reason is not completed (DONE=${done})`, async () => {
      const result = await collect(modelFor([chunk({ content: "partial" })], done));
      expect(result.events.some((event) => event.type === "response_done")).toBe(false);
      expect(result.error).toMatchObject({ code: "provider_incomplete_response" });
    });
  }

  test("an empty stream is not a completed answer", async () => {
    const result = await collect(modelFor([]));
    expect(result.events.some((event) => event.type === "response_done")).toBe(false);
    expect(result.error).toMatchObject({ code: "provider_incomplete_response" });
  });

  test("another choice's finish reason does not complete the primary choice", async () => {
    const result = await collect(
      modelFor([chunk({ content: "partial" }), chunk({}, "stop", 1)], true),
    );
    expect(result.events.some((event) => event.type === "response_done")).toBe(false);
    expect(result.error).toMatchObject({ code: "provider_incomplete_response" });
  });

  for (const finishReason of ["", "   ", 42]) {
    test(`a non-reason ${JSON.stringify(finishReason)} is not completion evidence`, async () => {
      const result = await collect(modelFor([chunk({ content: "partial" }, finishReason)], true));
      expect(result.events.some((event) => event.type === "response_done")).toBe(false);
      expect(result.error).toMatchObject({ code: "provider_incomplete_response" });
    });
  }

  for (const done of [false, true]) {
    test(`a stop survives trailing usage-only chunks (DONE=${done})`, async () => {
      const result = await collect(
        modelFor(
          [
            chunk({ content: "complete" }, "stop"),
            {
              ...chunk({}),
              choices: [],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          ],
          done,
        ),
      );
      expect(result.error).toBeUndefined();
      expect(result.events.filter((event) => event.type === "response_done")).toHaveLength(1);
    });
  }

  test("an upstream error after reasoning keeps its original evidence", async () => {
    const message = "model returned malformed tool_call output; please retry";
    const result = await collect(
      modelFor([
        chunk({ reasoning: "synthetic" }),
        { error: { type: "invalid_response", message } },
      ]),
    );
    expect(result.events.some((event) => event.type === "response_done")).toBe(false);
    expect(result.error).toMatchObject({ message, type: "invalid_response" });
    expect((result.error as { code?: unknown }).code).not.toBe("provider_incomplete_response");
  });

  for (const complete of [false, true]) {
    test(`Runner executes tools only after completion evidence (complete=${complete})`, async () => {
      let executions = 0;
      let requests = 0;
      const marker = tool({
        name: "marker",
        description: "Increment an in-memory fixture counter",
        parameters: z.object({}),
        execute: async () => {
          executions++;
          return "fixture";
        },
      });
      const model = new OpenGeniChatCompletionsModel(
        new OpenAI({
          apiKey: "fixture",
          maxRetries: 0,
          fetch: async () => {
            requests++;
            return requests > 1
              ? reply([chunk({ content: "complete" }, "stop")], true)
              : reply([
                  chunk({
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-fixture",
                        type: "function",
                        function: { name: "marker", arguments: "{}" },
                      },
                    ],
                  }),
                  ...(complete ? [chunk({}, "tool_calls")] : []),
                ]);
          },
        }),
        "fixture",
      );
      const runner = new Runner({ tracingDisabled: true });
      const run = await runner.run(
        new Agent({ name: "fixture", model, tools: [marker] }),
        "fixture",
        { stream: true },
      );
      let error: unknown;
      try {
        for await (const _event of run) {
          /* Drain the actual Runner. */
        }
        await run.completed;
      } catch (caught) {
        error = caught;
      }
      expect(executions).toBe(complete ? 1 : 0);
      expect(requests).toBe(complete ? 2 : 1);
      if (complete) expect(error).toBeUndefined();
      else expect(error).toMatchObject({ code: "provider_incomplete_response" });
    });
  }
});
