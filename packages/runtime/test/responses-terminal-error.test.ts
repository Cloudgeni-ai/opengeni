import { describe, expect, spyOn, test } from "bun:test";
import { Agent, Runner, tool } from "@openai/agents";
import OpenAI from "openai";
import { testSettings } from "@opengeni/testing";
import {
  buildOpenAIClientFromSettings,
  OpenGeniResponsesModel,
  ResponsesStreamingTerminalError,
} from "../src/index";

const terminalCases = [
  ["server_error", "unavailable"],
  ["rate_limit_exceeded", "rate_limit"],
  ["overloaded", "unavailable"],
  ["invalid_request_error", "request"],
  ["content_policy_violation", "safety"],
  ["ResponsibleAIPolicyViolation", "safety"],
  ["unknown_provider_code", "unknown"],
] as const;

describe("ordinary Responses streamed provider terminals", () => {
  for (const providerId of ["openai", "azure"] as const) {
    for (const eventType of ["response.failed", "response.error"] as const) {
      for (const [code, category] of terminalCases) {
        test(`${providerId} ${eventType} classifies ${code} before SDK flattening`, async () => {
          // Keep non-transient diagnostic wording misleading: codes are authority.
          const diagnostic = `  exact ${code} diagnostic:\nservice unavailable / rate limit / overloaded  `;
          const providerError = { code, message: diagnostic };
          const event =
            eventType === "response.failed"
              ? { type: eventType, response: { status: "failed", error: providerError } }
              : { type: eventType, ...providerError };
          let requests = 0;
          const server = Bun.serve({
            port: 0,
            async fetch(request) {
              requests += 1;
              await request.text();
              return new Response(
                [
                  'data: {"type":"response.created","response":{"id":"resp_test"}}',
                  'data: {"type":"response.output_text.delta","delta":"partial"}',
                  `data: ${JSON.stringify(event)}`,
                  "",
                ].join("\n\n"),
                { headers: { "content-type": "text/event-stream" } },
              );
            },
          });
          const logs: unknown[] = [];
          const spies = (["log", "warn", "error", "debug"] as const).map((method) =>
            spyOn(console, method).mockImplementation((...args) => {
              logs.push(args);
            }),
          );
          try {
            const baseURL = `http://127.0.0.1:${server.port}/v1`;
            const client = buildOpenAIClientFromSettings(
              testSettings({
                openaiProvider: providerId,
                openaiApiKey: "fixture-key",
                openaiBaseUrl: baseURL,
                azureOpenaiApiKey: "fixture-key",
                azureOpenaiBaseUrl: baseURL,
                openaiMaxRetries: 2,
              }),
            );
            const model = new OpenGeniResponsesModel(client, "fixture", {
              id: providerId,
              label: providerId,
              kind: "api-key",
              api: "responses",
              builtin: true,
            });
            const events: Array<{ type: string }> = [];
            let failure: unknown;
            try {
              for await (const next of model.getStreamedResponse({
                input: "hello",
                modelSettings: {},
                tools: [],
                handoffs: [],
                outputType: "text",
                tracing: false,
              })) {
                events.push(next);
              }
            } catch (error) {
              failure = error;
            }
            expect(failure).toBeInstanceOf(ResponsesStreamingTerminalError);
            expect(failure).toMatchObject({ code, category, detail: diagnostic });
            expect((failure as Error).message).not.toContain(diagnostic);
            expect(events.some((value) => value.type === "output_text_delta")).toBe(true);
            expect(events.some((value) => value.type === "response_done")).toBe(false);
            expect(requests).toBe(1); // no SDK replay of an accepted stream
            expect(JSON.stringify(logs)).not.toContain(diagnostic);
          } finally {
            spies.forEach((spy) => spy.mockRestore());
            server.stop(true);
          }
        });
      }
    }
  }

  test("nested response.error and parser-intercepted top-level error preserve diagnostics", async () => {
    for (const event of [
      {
        type: "response.error",
        response: { error: { code: "server_error", message: "nested\n" } },
      },
      { type: "response.error", error: { code: "server_error", message: "top-level\n" } },
    ]) {
      const client = new OpenAI({
        apiKey: "fixture",
        maxRetries: 2,
        fetch: async () =>
          new Response(`data: ${JSON.stringify(event)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
      });
      const model = new OpenGeniResponsesModel(client, "fixture", {
        id: "openai",
        label: "OpenAI",
        kind: "api-key",
        api: "responses",
        builtin: true,
      });
      let observed: unknown;
      try {
        for await (const _event of model.getStreamedResponse({
          input: "hello",
          modelSettings: {},
          tools: [],
          handoffs: [],
          outputType: "text",
          tracing: false,
        })) {
        }
      } catch (error) {
        observed = error;
      }
      expect(observed).toMatchObject({
        category: "unavailable",
        detail: event.error?.message ?? event.response?.error.message,
      });
    }
  });

  test("diagnostics are exact through 4 KiB and UTF-8 bounded beyond it", () => {
    const exact = " 🧬\n".repeat(500);
    expect(new ResponsesStreamingTerminalError("response.failed", { message: exact }).detail).toBe(
      exact,
    );
    const oversized = " 🧬\n".repeat(2_000);
    const error = new ResponsesStreamingTerminalError("response.failed", {
      code: "a".repeat(1_000),
      message: oversized,
      ignored: "not retained",
    });
    expect(Buffer.byteLength(error.detail)).toBeLessThanOrEqual(4 * 1024);
    expect(Buffer.byteLength(error.code!)).toBeLessThanOrEqual(256);
    expect(error.detail).toEndWith("… [truncated]");
    expect(error.detail).not.toContain("�");
    expect(oversized.startsWith(error.detail.slice(0, -"… [truncated]".length))).toBe(true);
    expect(JSON.stringify(error)).not.toContain("not retained");
  });

  test("invalid request and safety codes outrank a conflicting server_error type", () => {
    for (const [code, category] of [
      ["invalid_request_error", "request"],
      ["content_policy_violation", "safety"],
    ]) {
      expect(
        new ResponsesStreamingTerminalError("response.failed", {
          code,
          type: "server_error",
          message: "overloaded",
        }).category,
      ).toBe(category);
    }
  });

  test("unknown codes are terminal even with a server type; type-only envelopes classify", () => {
    expect(
      new ResponsesStreamingTerminalError("response.failed", {
        code: "unknown_failure",
        type: "server_error",
      }).category,
    ).toBe("unknown");
    expect(
      new ResponsesStreamingTerminalError("response.error", { type: "server_error" }).category,
    ).toBe("unavailable");
  });

  test("a failed terminal cannot execute a tool call assembled in the same response", async () => {
    let toolCalls = 0;
    const model = new OpenGeniResponsesModel(
      new OpenAI({
        apiKey: "fixture",
        fetch: async () =>
          new Response(
            [
              'data: {"type":"response.created","response":{"id":"resp_tools"}}',
              'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_test","call_id":"call_test","name":"side_effect","arguments":"{}"}}',
              'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"exact tool failure"}}}',
              "",
            ].join("\n\n"),
            { headers: { "content-type": "text/event-stream" } },
          ),
      }),
      "fixture",
      {
        id: "openai",
        label: "OpenAI",
        kind: "api-key",
        api: "responses",
        builtin: true,
      },
    );
    const result = await new Runner().run(
      new Agent({
        name: "terminal-test",
        model,
        tools: [
          tool({
            name: "side_effect",
            description: "Count side effects.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            strict: false,
            execute: async () => {
              toolCalls += 1;
              return "done";
            },
          }),
        ],
      }),
      "hello",
      { stream: true },
    );
    let failure: unknown;
    try {
      for await (const _event of result.toStream()) {
      }
      await result.completed;
    } catch (error) {
      failure = error;
    }
    await result.completed.catch(() => {});
    expect(failure).toBeInstanceOf(ResponsesStreamingTerminalError);
    expect(toolCalls).toBe(0);
  });
});
