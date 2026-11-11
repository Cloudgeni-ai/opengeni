import { describe, expect, spyOn, test } from "bun:test";
import { Agent, Runner, tool } from "@openai/agents";
import OpenAI from "openai";
import { testSettings } from "@opengeni/testing/settings";
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
  // Azure CamelCase service codes and bare HTTP statuses some gateways send.
  ["ServiceUnavailable", "unavailable"],
  ["InternalServerError", "unavailable"],
  ["BadGateway", "unavailable"],
  ["GatewayTimeout", "unavailable"],
  ["500", "unavailable"],
  ["502", "unavailable"],
  ["503", "unavailable"],
  ["504", "unavailable"],
  ["TooManyRequests", "rate_limit"],
  ["400", "unknown"],
  ["403", "unknown"],
] as const;

describe("ordinary Responses streamed provider terminals", () => {
  test("a custom client without an HTTP receipt keeps streamed terminal classification", async () => {
    const client = new OpenAI({ apiKey: "fixture" });
    const create = spyOn(client.responses, "create").mockImplementation(
      () =>
        Promise.resolve(
          (async function* () {
            yield {
              type: "response.failed",
              response: {
                error: { code: "server_error", message: "custom-client diagnostic" },
              },
            };
          })(),
        ) as never,
    );
    try {
      const model = new OpenGeniResponsesModel(client, "fixture", {
        id: "openai",
        label: "OpenAI",
        kind: "api-key",
        api: "responses",
        builtin: true,
      });
      let failure: unknown;
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
        failure = error;
      }
      expect(failure).toMatchObject({
        category: "unavailable",
        detail: "custom-client diagnostic",
      });
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      create.mockRestore();
    }
  });

  test("yielded and parser-rejected terminals retain only HTTP retry headers", async () => {
    for (const eventType of ["response.failed", "response.error"] as const) {
      for (const parserRejected of [false, true]) {
        const providerError = { code: "rate_limit_exceeded", message: "exact rate diagnostic" };
        const event = parserRejected
          ? { type: eventType, error: providerError }
          : { type: eventType, response: { status: "failed", error: providerError } };
        const model = new OpenGeniResponsesModel(
          new OpenAI({
            apiKey: "fixture",
            fetch: async () =>
              new Response(`data: ${JSON.stringify(event)}\n\n`, {
                headers: {
                  "content-type": "text/event-stream",
                  "retry-after": "1800",
                  "set-cookie": "private-fixture-cookie",
                  "x-private-provider-header": "not retained",
                },
              }),
          }),
          "fixture",
          {
            id: "azure",
            label: "Azure",
            kind: "api-key",
            api: "responses",
            builtin: true,
          },
        );
        let failure: unknown;
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
          failure = error;
        }
        expect(failure).toBeInstanceOf(ResponsesStreamingTerminalError);
        const observed = failure as ResponsesStreamingTerminalError;
        expect(observed.retryAfterSeconds).toBe(1800);
        expect([...observed.headers]).toEqual([["retry-after", "1800"]]);
        expect(observed.detail).toBe(providerError.message);
        expect(JSON.stringify(observed)).not.toContain("private-fixture-cookie");
      }
    }
  });

  test("successful terminals retain the SDK request ID without enumerable transport data", async () => {
    const model = new OpenGeniResponsesModel(
      new OpenAI({
        apiKey: "fixture",
        fetch: async () =>
          new Response(
            'data: {"type":"response.completed","response":{"id":"resp_test","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}\n\n',
            { headers: { "content-type": "text/event-stream", "x-request-id": "request-fixture" } },
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
    let response: unknown;
    for await (const event of model.getStreamedResponse({
      input: "hello",
      modelSettings: {},
      tools: [],
      handoffs: [],
      outputType: "text",
      tracing: false,
    })) {
      if (event.type === "response_done") response = event.response;
    }
    expect(response).toMatchObject({ requestId: "request-fixture" });
    expect(JSON.stringify(response)).not.toContain("_request_id");
  });

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

  test("Azure's documented mid-stream error event classifies by its status type", async () => {
    // Azure: the stream is an HTTP 200 whose `error` event carries a closed
    // `type` naming the status (server_error = 500, too_many_requests = 429,
    // forbidden = 403, user_error = 400) beside an open-ended specific `code`.
    for (const [error, category] of [
      [{ type: "server_error", code: "unrecognized_azure_code" }, "unavailable"],
      [{ type: "too_many_requests", code: "no_capacity" }, "rate_limit"],
      [{ type: "forbidden", code: "unrecognized_azure_code" }, "unknown"],
      [{ type: "user_error", code: "unrecognized_azure_code" }, "unknown"],
    ] as const) {
      const event = {
        type: "error",
        error: { ...error, message: "Service Unavailable", param: null },
      };
      const client = new OpenAI({
        apiKey: "fixture",
        maxRetries: 2,
        fetch: async () =>
          new Response(`event: error\ndata: ${JSON.stringify(event)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
      });
      const model = new OpenGeniResponsesModel(client, "fixture", {
        id: "azure",
        label: "Azure OpenAI",
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
      } catch (failure) {
        observed = failure;
      }
      expect(observed).toBeInstanceOf(ResponsesStreamingTerminalError);
      expect(observed).toMatchObject({
        category,
        code: error.code,
        type: error.type,
        detail: "Service Unavailable",
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

  test("unknown codes defer only to a closed status type; wording never grants recovery", () => {
    expect(
      new ResponsesStreamingTerminalError("response.failed", {
        code: "unknown_failure",
        type: "server_error",
      }).category,
    ).toBe("unavailable");
    expect(
      new ResponsesStreamingTerminalError("response.failed", {
        code: "unknown_failure",
        type: "service_unavailable_error",
      }).category,
    ).toBe("unavailable");
    expect(
      new ResponsesStreamingTerminalError("response.failed", {
        code: "unknown_failure",
        type: "unknown_type",
        message: "Service Unavailable. Please try again.",
      }).category,
    ).toBe("unknown");
    expect(
      new ResponsesStreamingTerminalError("response.error", {
        message: "503 Service Unavailable",
      }).category,
    ).toBe("unknown");
    expect(
      new ResponsesStreamingTerminalError("response.error", { type: "server_error" }).category,
    ).toBe("unavailable");
    // A status type never overrides a recognized refusal or request code.
    for (const [code, category] of [
      ["content_filter", "safety"],
      ["context_length_exceeded", "request"],
    ] as const) {
      for (const type of ["server_error", "too_many_requests"]) {
        expect(new ResponsesStreamingTerminalError("error", { code, type }).category).toBe(
          category,
        );
      }
    }
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
