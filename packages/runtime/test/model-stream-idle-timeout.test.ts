import { describe, expect, test } from "bun:test";
import { Agent, Runner } from "@openai/agents";
import { testSettings } from "@opengeni/testing";
import {
  buildOpenAIClientFromSettings,
  classifyModelStreamIdleTimeoutError,
  ModelStreamIdleTimeoutError,
  OpenGeniResponsesModel,
  streamIdleTimeoutModelFetch,
} from "../src/index";

const encoder = new TextEncoder();
const MODEL_URL = "https://provider.test/v1/responses";

function sse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const created = sse({
  type: "response.created",
  sequence_number: 0,
  response: {
    id: "resp_fixture",
    object: "response",
    status: "in_progress",
    output: [],
    created_at: 1,
    model: "fixture",
  },
});

type Script = Array<{ atMs: number; text?: string; close?: true }>;

function scriptedFetch(script: Script): typeof fetch {
  return (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const step of script) {
            setTimeout(() => {
              try {
                if (step.close) controller.close();
                else controller.enqueue(encoder.encode(step.text!));
              } catch {
                // Cancelled by the idle bound.
              }
            }, step.atMs);
          }
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch;
}

async function drain(response: Response): Promise<{ text: string; error: unknown }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return { text, error: null };
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    return { text, error };
  }
}

describe("generic model stream stall bounds", () => {
  test("a stream that stalls after its first bytes fails with a typed byte-idle error", async () => {
    const fetcher = streamIdleTimeoutModelFetch(
      "azure-fixture",
      { idleTimeoutMs: 100, progressTimeoutMs: 1_000 },
      scriptedFetch([{ atMs: 0, text: created }]),
    );
    const startedAt = performance.now();
    const { text, error } = await drain(await fetcher(MODEL_URL));
    const elapsed = performance.now() - startedAt;
    expect(text).toBe(created);
    expect(error).toBeInstanceOf(ModelStreamIdleTimeoutError);
    expect(error).toMatchObject({ kind: "bytes", idleTimeoutMs: 100, provider: "azure-fixture" });
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(1_000);
  });

  test("keepalive-only traffic cannot hide a wedged generation", async () => {
    const keepalives: Script = [];
    for (let at = 20; at < 2_000; at += 20) {
      keepalives.push({
        atMs: at,
        text: at % 40 === 0 ? ": keep-alive\n\n" : sse({ type: "keepalive", sequence_number: at }),
      });
    }
    const fetcher = streamIdleTimeoutModelFetch(
      "azure-fixture",
      { idleTimeoutMs: 100, progressTimeoutMs: 300 },
      scriptedFetch([{ atMs: 0, text: created }, ...keepalives]),
    );
    const startedAt = performance.now();
    const { error } = await drain(await fetcher(MODEL_URL));
    const elapsed = performance.now() - startedAt;
    expect(error).toMatchObject({ kind: "progress", idleTimeoutMs: 300 });
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(1_500);
  });

  test("steady progress and a slow consumer never trip the bounds", async () => {
    const deltas: Script = [];
    for (let at = 50; at <= 600; at += 50) {
      deltas.push({ atMs: at, text: sse({ type: "response.output_text.delta", delta: "x" }) });
    }
    const fetcher = streamIdleTimeoutModelFetch(
      "azure-fixture",
      { idleTimeoutMs: 100, progressTimeoutMs: 150 },
      scriptedFetch([{ atMs: 0, text: created }, ...deltas, { atMs: 650, close: true }]),
    );
    const progressing = await drain(await fetcher(MODEL_URL));
    expect(progressing.error).toBeNull();
    expect(progressing.text.split("output_text.delta").length - 1).toBe(12);

    // The consumer not reading is backpressure, not provider silence.
    const slow = await streamIdleTimeoutModelFetch(
      "azure-fixture",
      { idleTimeoutMs: 100, progressTimeoutMs: 100 },
      scriptedFetch([
        { atMs: 0, text: created },
        { atMs: 10, close: true },
      ]),
    )(MODEL_URL);
    await Bun.sleep(400);
    expect((await drain(slow)).error).toBeNull();
  });

  test("non-model requests and disabled bounds pass through untouched", async () => {
    const inner = scriptedFetch([{ atMs: 0, text: created }]);
    expect(streamIdleTimeoutModelFetch("p", { idleTimeoutMs: 0 }, inner)).toBe(inner);
    const response = await streamIdleTimeoutModelFetch(
      "p",
      { idleTimeoutMs: 50 },
      inner,
    )("https://provider.test/v1/files");
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const pending = await Promise.race([reader.read(), Bun.sleep(150).then(() => "still-open")]);
    expect(pending).toBe("still-open");
    await reader.cancel();
  });

  test("a stalled Azure Responses stream surfaces the typed error through the client and runner", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: () => {
        requests += 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(created));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      const client = buildOpenAIClientFromSettings(
        testSettings({
          openaiProvider: "azure",
          azureOpenaiBaseUrl: `${server.url}openai/v1`,
          azureOpenaiApiKey: "fixture",
          openaiMaxRetries: 2,
          modelStreamIdleTimeoutMs: 150,
          modelStreamProgressTimeoutMs: 150,
        }),
      );
      const model = new OpenGeniResponsesModel(client, "fixture", {
        id: "azure",
        label: "Azure",
        kind: "api-key",
        api: "responses",
        builtin: true,
      } as never);
      const agent = new Agent({ name: "fixture", instructions: "fixture", model });
      const result = await new Runner({ tracingDisabled: true }).run(agent, "hello", {
        stream: true,
      });
      const startedAt = performance.now();
      let failure: unknown;
      try {
        for await (const _event of result.toStream()) {
        }
      } catch (error) {
        failure = error;
      }
      expect(performance.now() - startedAt).toBeLessThan(2_000);
      expect(classifyModelStreamIdleTimeoutError(failure)).toMatchObject({
        kind: "bytes",
        idleTimeoutMs: 150,
      });
      // A mid-body stall is never replayed by the SDK; recovery owns the retry.
      expect(requests).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});
