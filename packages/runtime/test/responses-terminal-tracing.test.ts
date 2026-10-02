import { expect, test } from "bun:test";
import {
  getOrCreateTrace,
  setTraceProcessors,
  setTracingDisabled,
  type TracingProcessor,
} from "@openai/agents-core";
import OpenAI from "openai";
import { OpenGeniResponsesModel } from "../src/model-provider-routing";
import { ResponsesStreamingTerminalError } from "../src/responses-terminal-error";

// This focused file runs in its own process, as required by test discovery.
// Replace the default exporter so this regression never contacts a provider.
const spans: unknown[] = [];
const processor: TracingProcessor = {
  async onTraceStart() {},
  async onTraceEnd() {},
  async onSpanStart() {},
  async onSpanEnd(span) {
    spans.push(span.toJSON());
  },
  async shutdown() {},
  async forceFlush() {},
};
setTraceProcessors([processor]);
setTracingDisabled(false);

for (const event of [
  {
    type: "response.failed",
    response: { error: { code: "server_error", message: "PRIVATE failure detail" } },
  },
  {
    type: "response.error",
    error: { code: "server_error", message: "PRIVATE parser error detail" },
  },
]) {
  test(`enabled SDK tracing excludes exact ${event.type} diagnostics`, async () => {
    spans.length = 0;
    const model = new OpenGeniResponsesModel(
      new OpenAI({
        apiKey: "fixture",
        fetch: async () =>
          new Response(`data: ${JSON.stringify(event)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
      }),
      "fixture",
      {
        id: "openai",
        label: "OpenAI",
        api: "responses",
        kind: "api-key",
        builtin: true,
      },
    );
    let observed: unknown;
    await getOrCreateTrace(async () => {
      try {
        for await (const _next of model.getStreamedResponse({
          input: "hello",
          modelSettings: {},
          tools: [],
          handoffs: [],
          outputType: "text",
          tracing: true,
        })) {
        }
      } catch (error) {
        observed = error;
      }
    });
    expect(observed).toBeInstanceOf(ResponsesStreamingTerminalError);
    expect((observed as ResponsesStreamingTerminalError).detail).toBe(
      event.error?.message ?? event.response?.error.message,
    );
    expect(spans.length).toBeGreaterThan(0);
    expect(JSON.stringify(spans)).toContain("Error streaming response");
    expect(JSON.stringify(spans)).not.toContain("PRIVATE");
  });
}
